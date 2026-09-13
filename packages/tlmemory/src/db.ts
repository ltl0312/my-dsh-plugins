// packages/tlmemory/src/db.ts
// SQLite 物化路径（Materialized Path）与 FTS5 Trigram 索引存储引擎。
// 安全基线：
// 1. 数据库物理路径默认强制收敛至 os.homedir()/.dsh/tlmemory.db，杜绝路径穿越。
// 2. 所有树状路径分段必须通过白名单正则 ^[a-zA-Z0-9_\u4e00-\u9fa5\-]+$ 校验净化。
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import Database from 'better-sqlite3'
import type { MemoryNode, SearchOptions, SearchResult } from './types.js'

/** 路径分段白名单正则：仅允许字母、数字、下划线、中文与连字符 */
const SEGMENT_WHITELIST = /[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g

function sanitizeSegment(seg: unknown): string {
  return String(seg ?? '').replace(SEGMENT_WHITELIST, '').trim()
}

/** LIKE 通配符转义，防止恶意前缀绕过 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export class MemoryDB {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = dbPath && dbPath !== ':memory:' ? dbPath : path.join(os.homedir(), '.dsh', 'tlmemory.db')
    if (resolvedPath !== ':memory:') {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    }
    this.db = new Database(resolvedPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_type TEXT NOT NULL,
        parent_id INTEGER REFERENCES nodes(id),
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_leaf INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        keywords TEXT,
        reinforce_count INTEGER NOT NULL DEFAULT 1,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tree_type, path, name)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_tree_path ON nodes(tree_type, path);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        tree_type, path, name, content, keywords,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS trg_nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO memory_fts(rowid, tree_type, path, name, content, keywords)
        VALUES (new.id, new.tree_type, new.path, new.name, new.content, new.keywords);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_nodes_ad AFTER DELETE ON nodes BEGIN
        DELETE FROM memory_fts WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_nodes_au AFTER UPDATE ON nodes BEGIN
        DELETE FROM memory_fts WHERE rowid = old.id;
        INSERT INTO memory_fts(rowid, tree_type, path, name, content, keywords)
        VALUES (new.id, new.tree_type, new.path, new.name, new.content, new.keywords);
      END;
    `)
  }

  /**
   * 沿物化路径递归构建目录节点并在末端挂载/强化原子断言叶子。
   * 同 (tree_type, path, name) 冲突时执行强化：reinforce_count + 1 并更新内容与关键词。
   */
  public upsertLeaf(
    treeType: string,
    pathSegments: string[],
    name: string,
    content: string,
    keywords: string[],
  ): MemoryNode {
    const cleanSegments = (Array.isArray(pathSegments) ? pathSegments : [])
      .map(sanitizeSegment)
      .filter(Boolean)
    const fallbackSegments = cleanSegments.length > 0 ? cleanSegments : ['未分类']
    const cleanName = sanitizeSegment(name) || '未命名规则'
    const cleanContent = String(content ?? '').trim().slice(0, 80)
    const cleanKeywords = (Array.isArray(keywords) ? keywords : [])
      .map((k) => sanitizeSegment(k))
      .filter(Boolean)
      .join(' ')

    let parentId: number | null = null
    let fullPath = ''
    for (const seg of fallbackSegments) {
      fullPath += `/${seg}`
      parentId = this.upsertDirectory(treeType, parentId, `${fullPath}/`, seg)
    }

    return this.upsertNode(treeType, parentId, `${fullPath}/`, cleanName, 1, cleanContent, cleanKeywords)
  }

  private upsertDirectory(treeType: string, parentId: number | null, dirPath: string, name: string): number {
    const row = this.upsertNode(treeType, parentId, dirPath, name, 0, null, null)
    return Number(row.id)
  }

  private upsertNode(
    treeType: string,
    parentId: number | null,
    nodePath: string,
    name: string,
    isLeaf: number,
    content: string | null,
    keywords: string | null,
  ): MemoryNode {
    const now = Date.now()
    const result = this.db
      .prepare(`
        INSERT INTO nodes (tree_type, parent_id, path, name, is_leaf, content, keywords, reinforce_count, is_pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
        ON CONFLICT(tree_type, path, name) DO UPDATE SET
          content = excluded.content,
          keywords = excluded.keywords,
          reinforce_count = reinforce_count + 1,
          updated_at = excluded.updated_at
        RETURNING *
      `)
      .get(treeType, parentId, nodePath, name, isLeaf, content, keywords, now, now) as Record<string, unknown>
    return this.rowToNode(result)
  }

  /** FTS5 Trigram 全文检索：BM25 排序，输出 score（越高越相关）与 bm25_rank */
  public search(query: string, options: SearchOptions = {}): SearchResult[] {
    const cleanQuery = String(query ?? '').trim()
    if (!cleanQuery) return []

    const { treeType, pathPrefix, limit = 5 } = options
    // 将查询包裹为短语查询，规避 FTS5 语法注入并兼容中英文混排 Trigram 匹配
    const matchQuery = `"${cleanQuery.replace(/"/g, '""')}"`

    const where: string[] = ['memory_fts MATCH ?']
    const params: unknown[] = [matchQuery]
    if (treeType) {
      where.push('n.tree_type = ?')
      params.push(treeType)
    }
    if (pathPrefix) {
      where.push(`n.path LIKE ? ESCAPE '\\'`)
      params.push(`${escapeLikePattern(pathPrefix)}%`)
    }
    params.push(limit)

    const rows = this.db
      .prepare(`
        SELECT n.*, bm25(memory_fts) AS bm25_score
        FROM memory_fts
        JOIN nodes n ON n.id = memory_fts.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY bm25(memory_fts)
        LIMIT ?
      `)
      .all(...params) as Array<Record<string, unknown>>

    return rows.map((row, index) => {
      const node = this.rowToNode(row)
      const bm25 = Number(row.bm25_score ?? 0)
      return {
        ...node,
        score: Math.round(-bm25 * 100) / 100,
        bm25_rank: index + 1,
      } satisfies SearchResult
    })
  }

  public getAllNodes(treeType?: string): MemoryNode[] {
    const rows = treeType
      ? this.db.prepare('SELECT * FROM nodes WHERE tree_type = ? ORDER BY tree_type, path, name').all(treeType)
      : this.db.prepare('SELECT * FROM nodes ORDER BY tree_type, path, name').all()
    return (rows as Array<Record<string, unknown>>).map((row) => this.rowToNode(row))
  }

  public deleteNode(id: string): boolean {
    const result = this.db.prepare('DELETE FROM nodes WHERE id = ?').run(Number(id))
    return result.changes > 0
  }

  public close(): void {
    if (this.db.open) this.db.close()
  }

  private rowToNode(row: Record<string, unknown>): MemoryNode {
    return {
      id: String(row.id),
      tree_type: String(row.tree_type),
      parent_id: row.parent_id == null ? null : String(row.parent_id),
      path: String(row.path),
      name: String(row.name),
      is_leaf: Number(row.is_leaf ?? 0),
      content: row.content == null ? null : String(row.content),
      keywords: row.keywords == null ? null : String(row.keywords),
      reinforce_count: Number(row.reinforce_count ?? 0),
      is_pinned: Number(row.is_pinned ?? 0),
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0),
    }
  }
}
