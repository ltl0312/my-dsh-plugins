// packages/tlmemory/src/db.ts
// SQLite 物化路径（Materialized Path）与 FTS5 Trigram 索引存储引擎。
// 安全基线：
// 1. 数据库物理路径默认强制收敛至 os.homedir()/.dsh/tlmemory.db，杜绝路径穿越。
// 2. 所有树状路径分段必须通过白名单正则 ^[a-zA-Z0-9_\u4e00-\u9fa5\-]+$ 校验净化。
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import type { MemoryNode, ProjectSummary, SearchOptions, SearchResult } from './types.js'

/** 工程清单自愈维护的改动明细（供日志与测试断言） */
export interface ProjectMaintenance {
  /** 被清理掉的工程 scope（含「零记忆工程」与「不属于宿主合法工作区的孤儿工程」） */
  purgedScopes: string[]
  /** 因与其他工程重名而被改名的工程 */
  renamed: Array<{ scope: string; from: string; to: string }>
}

/**
 * 工程清理的判定选项。
 *
 * `isScopeAllowed` 是宿主工作区白名单的投影：传 null 表示「无从判定」（宿主登记表
 * 不可读）→ 关闭白名单过滤，只按「零记忆」清理；传入判定函数时，**不在名单里的
 * 作用域一律无条件清理**（哪怕它有记忆、哪怕它正是宿主当前工程）—— 这正是
 * 「以用户主目录 `/home` 启动产生的临时工程」「宿主已删除的历史废弃目录」的清除路径。
 */
export interface ProjectPruneOptions {
  keepScope?: string | null
  isScopeAllowed?: ((scope: string) => boolean) | null
}

/** 由 scope 导出的稳定短标识：同名工程去重后缀（repo:<hash> 取 hash 前 6 位） */
function scopeTag(scope: string): string {
  const hashStyle = /^repo:([0-9a-fA-F]{6,})$/.exec(scope)
  if (hashStyle) return hashStyle[1].slice(0, 6).toLowerCase()
  return crypto.createHash('sha256').update(scope).digest('hex').slice(0, 6)
}

/** 路径分段白名单正则：仅允许字母、数字、下划线、中文与连字符 */
const SEGMENT_WHITELIST = /[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g

/** P1-3 强化计数的打分权重：score + min(count, CAP) * WEIGHT */
const REINFORCE_WEIGHT = 0.1
/** 强化计数打分封顶：超过 10 次强化不再继续加权，防止单条记忆权重失控 */
const REINFORCE_SCORE_CAP = 10
/** 短词 LIKE 回退检索的固定基线分（LIKE 无相关性排序语义，取正值小基线） */
const LIKE_FALLBACK_SCORE = 1

/**
 * P2-12 统一路径分段净化函数（单一事实来源）：
 * 仅允许字母、数字、下划线、中文与连字符，拦截路径穿越与通配符注入。
 * tools.ts（tlmemory_save 工具链路）与 extractor.ts（静默沉淀链路）必须复用本函数，
 * 严禁再各自内联正则 —— 此前 tools.ts 的副本缺连字符 `-`，含连字符的规则名
 * 经工具链路会被剥成连写词，且三份正则必然漂移。
 */
export function sanitizeSegment(seg: unknown): string {
  return String(seg ?? '').replace(SEGMENT_WHITELIST, '').trim()
}

/** LIKE 通配符转义，防止恶意前缀绕过 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * 手工录入名称净化（编辑 / 新建入口专用）：剥离路径分隔符、控制字符与反斜杠，
 * 折叠空白；与沉淀链路的严格白名单不同，这里保留空格等常规可读字符，
 * 避免「客户端深浅主题切换规程」这类标题被静默改写成不可读形态。
 */
function sanitizeManualName(input: unknown): string {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * 解析手工输入的目录路径串（如 '/DSH客户端插件/样式优化/'）为净化后的分段数组；
 * 同时兼容字符串数组形态（逐段以 '/' 拼接后再解析）。
 */
function parsePathSegments(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String).join('/') : String(input ?? '')
  return raw
    .split('/')
    .map((seg) => sanitizeManualName(seg))
    .filter(Boolean)
}

export class MemoryDB {
  private db: Database.Database

  constructor(dbPath?: string) {
    // 显式 ':memory:' 必须直达 SQLite 内存库，禁止落入默认磁盘路径分支
    const resolvedPath = dbPath === ':memory:' ? ':memory:' : dbPath ?? path.join(os.homedir(), '.dsh', 'tlmemory.db')
    if (resolvedPath !== ':memory:') {
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    }
    this.db = new Database(resolvedPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    // P1-2 多宿主共享同一 SQLite 文件（GUI 宿主 + 常驻服务宿主）时的并发写保护：
    // better-sqlite3 默认 busy_timeout 为 0，另一宿主持有写锁时本侧立刻抛 SQLITE_BUSY，
    // 静默沉淀链路会因此丢记忆。设 5s 忙等重试；synchronous=NORMAL 是 WAL 模式下的
    // 推荐搭配（事务提交不再强制 fsync 全量 WAL，兼顾性能与崩溃安全）。
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
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
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tree_type, path, name)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_tree_path ON nodes(tree_type, path);

      -- 工程作用域登记表：把不可读的 repo:<hash> 反解为「可读工程名 + 根目录」。
      -- is_manual=1 表示用户在看板上手工命名过，自动登记（宿主启动时按 .git 根目录
      -- 写入）不得覆盖它，否则用户命名每次重启都会被冲掉。
      CREATE TABLE IF NOT EXISTS projects (
        scope TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT,
        is_manual INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

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

    // M1 增量迁移：既有库（schema v1，无 source/status 列）平滑补列，
    // 全部存量节点回填为 manual 来源 + confirmed 状态（历史数据视为已确认）。
    const columns = (this.db.pragma('table_info(nodes)') as Array<{ name: string }>).map((c) => c.name)
    if (!columns.includes('source')) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
    }
    if (!columns.includes('status')) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'")
    }
  }

  /**
   * P1-7 事务包裹辅助：多语句写序列（建目录链 + 建叶子 + 后代重写 + 剪枝）必须是
   * 单一原子单元 —— better-sqlite3 单条语句原子，但语句序列不原子，
   * 「自身已改 path、后代未重写」的间隙崩溃会永久断裂物化路径链且无自愈手段。
   * 仅顶层写入口（upsertLeaf / createLeaf / updateNode）使用，内部辅助方法
   * 不得再套用（better-sqlite3 事务不允许嵌套）。
   */
  private withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
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
    options: { source?: string; status?: string } = {},
  ): MemoryNode {
    return this.withTransaction(() => {
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
        // P2-6：目录创建走 ensureDirectory（已存在即复用，不递增强化计数）。
        // 此前走 upsertDirectory → upsertNode 的 ON CONFLICT 分支，每次沉淀
        // 都让目录 reinforce_count 无意义地虚增，还会用 NULL 覆盖 content 字段。
        parentId = this.ensureDirectory(treeType, parentId, `${fullPath}/`, seg, 'auto')
      }

      return this.upsertNode(
        treeType,
        parentId,
        `${fullPath}/`,
        cleanName,
        1,
        cleanContent,
        cleanKeywords,
        options.source ?? 'auto',
        options.status ?? 'confirmed',
      )
    })
  }

  /**
   * 手工新增记忆叶子（看板「新建记忆」表单提交入口）。
   * 与 upsertLeaf（静默沉淀链路）的三点差异：
   * 1. content 保留完整 Markdown 原文，不做 80 字原子化截断；
   * 2. 名称 / 路径分段走 sanitizeManualName（保留空格等可读字符）而非严格白名单；
   * 3. 同 (tree_type, path, name) 冲突时覆盖内容但不递增强化计数（手工纠错语义）。
   * 空标题 / 空正文 / 空作用域直接抛错，由服务端转译为 400。
   */
  public createLeaf(
    treeType: string,
    pathSegments: string[] | string,
    name: string,
    content: string,
    keywords: string[] = [],
  ): MemoryNode {
    const cleanType = String(treeType ?? '').trim()
    if (!cleanType) throw new Error('记忆作用域（scope/project）不能为空')
    const cleanName = sanitizeManualName(name)
    if (!cleanName) throw new Error('记忆标题不能为空')
    const cleanContent = String(content ?? '').trim()
    if (!cleanContent) throw new Error('记忆正文不能为空')
    const cleanKeywords = (Array.isArray(keywords) ? keywords : [])
      .map((k) => sanitizeManualName(k))
      .filter(Boolean)
      .join(' ')

    const segments = parsePathSegments(pathSegments)
    const fallbackSegments = segments.length > 0 ? segments : ['未分类']

    return this.withTransaction(() => {
      let parentId: number | null = null
      let fullPath = ''
      for (const seg of fallbackSegments) {
        fullPath += `/${seg}`
        parentId = this.ensureDirectory(cleanType, parentId, `${fullPath}/`, seg, 'manual')
      }

      const now = Date.now()
      const result = this.db
        .prepare(`
          INSERT INTO nodes (tree_type, parent_id, path, name, is_leaf, content, keywords, reinforce_count, is_pinned, source, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 'manual', 'confirmed', ?, ?)
          ON CONFLICT(tree_type, path, name) DO UPDATE SET
            content = excluded.content,
            keywords = excluded.keywords,
            updated_at = excluded.updated_at
          RETURNING *
        `)
        .get(cleanType, parentId, `${fullPath}/`, cleanName, cleanContent, cleanKeywords, now, now) as Record<string, unknown>
      return this.rowToNode(result)
    })
  }

  /**
   * 查找或创建分类目录节点（不递增强化计数）。
   * 与 upsertDirectory 的差异：目录已存在时直接复用，避免手工编辑路径
   * 反复触发 ON CONFLICT 强化分支导致目录 reinforce_count 虚增。
   */
  private ensureDirectory(
    treeType: string,
    parentId: number | null,
    dirPath: string,
    name: string,
    source: string = 'manual',
  ): number {
    const existing = this.db
      .prepare('SELECT id FROM nodes WHERE tree_type = ? AND path = ? AND name = ?')
      .get(treeType, dirPath, name) as { id: number } | undefined
    if (existing) return Number(existing.id)

    const now = Date.now()
    const result = this.db
      .prepare(`
        INSERT INTO nodes (tree_type, parent_id, path, name, is_leaf, content, keywords, reinforce_count, is_pinned, source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, NULL, NULL, 1, 0, ?, 'confirmed', ?, ?)
      `)
      .run(treeType, parentId, dirPath, name, source, now, now)
    return Number(result.lastInsertRowid)
  }

  private upsertNode(
    treeType: string,
    parentId: number | null,
    nodePath: string,
    name: string,
    isLeaf: number,
    content: string | null,
    keywords: string | null,
    source: string = 'auto',
    status: string = 'confirmed',
  ): MemoryNode {
    const now = Date.now()
    const result = this.db
      .prepare(`
        INSERT INTO nodes (tree_type, parent_id, path, name, is_leaf, content, keywords, reinforce_count, is_pinned, source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
        ON CONFLICT(tree_type, path, name) DO UPDATE SET
          -- P2-6：同步 is_leaf。叶子与既有目录同名同路径冲突（LLM 生成分段与
          -- 名称撞车）时，INSERT 走冲突更新后该行必须转为叶子，否则内容写进去了
          -- 但看板/召回永远把它当目录。
          is_leaf = excluded.is_leaf,
          content = excluded.content,
          keywords = excluded.keywords,
          reinforce_count = reinforce_count + 1,
          updated_at = excluded.updated_at
          -- M1：冲突更新不动 source / status —— 既有行的审核结论（含 pending
          -- 待确认）不被后续重沉淀无声改写。
        RETURNING *
      `)
      .get(treeType, parentId, nodePath, name, isLeaf, content, keywords, source, status, now, now) as Record<string, unknown>
    return this.rowToNode(result)
  }

  /**
   * FTS5 Trigram 全文检索：BM25 排序，输出 score（越高越相关）与 bm25_rank。
   * P1-3 打分模型：
   *   - is_pinned = 1 的记忆在 SQL 层强制排在未置顶记忆之前（置顶语义落地）；
   *   - reinforce_count 纳入最终得分（score + min(count, 10) * REINFORCE_WEIGHT），
   *     让「召回即强化」的高频记忆在长期使用中自然获得更高权重，
   *     召回侧的每轮 reinforce 写入从此有了真实的排序收益。
   */
  public search(query: string, options: SearchOptions = {}): SearchResult[] {
    const cleanQuery = String(query ?? '').trim()
    if (!cleanQuery) return []

    const { treeType, pathPrefix, limit = 5 } = options

    // FTS5 Trigram 最小检索粒度为 3 字符，1–2 字关键词会静默零命中：
    // 短词降级为 LIKE 模糊匹配（name / content / keywords 三列）兜底
    if (cleanQuery.length < 3) {
      return this.searchByLike(cleanQuery, options)
    }

    // 将查询包裹为短语查询，规避 FTS5 语法注入并兼容中英文混排 Trigram 匹配
    const matchQuery = `"${cleanQuery.replace(/"/g, '""')}"`

    // M1 待确认区隔离：pending 记忆不参与任何检索召回（切断脏记忆自我强化的
    // 注入通道）；看板的树读取（getNodes*）不受影响，由看板展示待确认徽标。
    const where: string[] = ["memory_fts MATCH ?", "n.status <> 'pending'"]
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
        ORDER BY n.is_pinned DESC, bm25(memory_fts)
        LIMIT ?
      `)
      .all(...params) as Array<Record<string, unknown>>

    return rows.map((row, index) => {
      const node = this.rowToNode(row)
      const bm25 = Number(row.bm25_score ?? 0)
      const reinforceBonus = Math.min(node.reinforce_count, REINFORCE_SCORE_CAP) * REINFORCE_WEIGHT
      return {
        ...node,
        score: Math.round((-bm25 + reinforceBonus) * 100) / 100,
        bm25_rank: index + 1,
      } satisfies SearchResult
    })
  }

  /**
   * 短词（<3 字符）LIKE 回退检索：Trigram 索引无法命中的最小粒度问题在此兜底。
   * score 给固定基线（LIKE 无相关性排序语义），按强化计数与更新时间排序。
   */
  private searchByLike(cleanQuery: string, options: SearchOptions): SearchResult[] {
    const { treeType, pathPrefix, limit = 5 } = options
    const like = `%${escapeLikePattern(cleanQuery)}%`

    // M1 待确认区隔离：与 FTS 路径一致，pending 不进 LIKE 兜底召回
    const where: string[] = ['(n.name LIKE ? OR n.content LIKE ? OR n.keywords LIKE ?)', "n.status <> 'pending'"]
    const params: unknown[] = [like, like, like]
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
        SELECT n.* FROM nodes n
        WHERE ${where.join(' AND ')}
        ORDER BY n.is_pinned DESC, n.reinforce_count DESC, n.updated_at DESC
        LIMIT ?
      `)
      .all(...params) as Array<Record<string, unknown>>

    return rows.map((row, index) => {
      const node = this.rowToNode(row)
      const reinforceBonus = Math.min(node.reinforce_count, REINFORCE_SCORE_CAP) * REINFORCE_WEIGHT
      return {
        ...node,
        score: Math.round((LIKE_FALLBACK_SCORE + reinforceBonus) * 100) / 100,
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

  /** 精确作用域取节点（scope 即 tree_type 原文，例如 'global' / 'repo:1a2b3c4d5e6f'） */
  public getNodesByScope(scope: string): MemoryNode[] {
    return this.getAllNodes(scope)
  }

  /**
   * 取工程树节点。传入 scope 时收敛到该工程；省略时返回**全部非全局**作用域，
   * 由调用方（看板下拉框）自行聚焦到所选工程。
   */
  public getProjectNodes(scope?: string): MemoryNode[] {
    if (scope) return this.getAllNodes(scope)
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE tree_type <> 'global' ORDER BY tree_type, path, name")
      .all()
    return (rows as Array<Record<string, unknown>>).map((row) => this.rowToNode(row))
  }

  /**
   * 工程名唯一性查询：返回除 excludeScope 之外**占用该工程名**（忽略大小写）的工程。
   *
   * 为什么必须唯一：看板下拉框以工程名作为人的唯一线索，两个同名工程在界面上完全
   * 无法区分；且 findProjectScope 按名字解析时只能取其一（重名即歧义）。因此
   * 「注册」「重命名」两条写路径都必须先过这道闸。
   */
  public findProjectNameOwner(name: string, excludeScope?: string): { scope: string; name: string } | null {
    const key = String(name ?? '').trim()
    if (!key) return null
    const row = this.db
      .prepare('SELECT scope, name FROM projects WHERE lower(name) = lower(?) AND scope <> ? LIMIT 1')
      .get(key, excludeScope ?? '') as { scope: string; name: string } | undefined
    return row ?? null
  }

  /** 登记表里是否存在该 scope（用于「当前活跃工程登记项是否在位」的判定） */
  public hasProject(scope: string): boolean {
    const key = String(scope ?? '').trim()
    if (!key) return false
    return this.db.prepare('SELECT 1 AS ok FROM projects WHERE scope = ?').get(key) !== undefined
  }

  /**
   * 为工程作用域解析**不与他人重名**的工程名。
   *
   * 场景：两个不同路径的仓库目录同名（两台机器上的 TLToolBox、monorepo 里多个
   * 同名子包、目录改名后遗留的旧 scope），basename 天然撞车。此时给后来者追加
   * scope 短标识（如 `TLToolBox (a1b2c3)`），既保住人类可读前缀，又保证全局唯一。
   *
   * 自愈性：短标识是按需追加的 —— 冲突方被清理后再次调用会自动摘掉后缀，
   * 因此本函数幂等，可安全地在每次登记/兜底时重算。
   */
  private resolveUniqueProjectName(base: string, scope: string): string {
    const cleanBase = String(base ?? '').trim() || scope
    if (this.findProjectNameOwner(cleanBase, scope) === null) return cleanBase
    const tag = scopeTag(scope)
    const tagged = `${cleanBase} (${tag})`
    if (this.findProjectNameOwner(tagged, scope) === null) return tagged
    for (let i = 2; i < 100; i++) {
      const candidate = `${cleanBase} (${tag}-${i})`
      if (this.findProjectNameOwner(candidate, scope) === null) return candidate
    }
    // 理论不可达：兜底退化为以 scope 原文命名（scope 是主键，必然唯一）
    return scope
  }

  /**
   * 自动登记工程作用域（宿主装配时调用）。
   * 1. 若该 scope 已被用户手工命名（is_manual=1），保留用户命名不覆盖；
   * 2. 自动命名必须全局唯一 —— 与他人重名时自动追加 scope 短标识（见 resolveUniqueProjectName）。
   */
  public registerProject(scope: string, name: string, root?: string | null): void {
    const cleanScope = String(scope ?? '').trim()
    if (!cleanScope) return
    const cleanName = String(name ?? '').trim() || cleanScope
    const now = Date.now()
    const existing = this.db.prepare('SELECT is_manual FROM projects WHERE scope = ?').get(cleanScope) as
      | { is_manual: number }
      | undefined
    // 手工命名过的工程不参与自动重命名（名字由用户定），写入值会被下面的 CASE 忽略
    const autoName =
      existing?.is_manual === 1 ? cleanName : this.resolveUniqueProjectName(cleanName, cleanScope)
    this.db
      .prepare(`
        INSERT INTO projects (scope, name, root, is_manual, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          name = CASE WHEN projects.is_manual = 1 THEN projects.name ELSE excluded.name END,
          root = COALESCE(excluded.root, projects.root),
          updated_at = excluded.updated_at
      `)
      .run(cleanScope, autoName, root ?? null, now, now)
  }

  /**
   * 手工命名工程作用域：把历史遗留的 repo:<hash> 改成可读名字。
   * 置 is_manual=1 后自动登记不再覆盖。
   * **唯一性闸门**：目标名字若已被其它工程占用则拒绝（返回 false），
   * 由服务端转译为 409 并带上占用者名字，杜绝「看板出现两个同名工程」。
   */
  public renameProject(scope: string, name: string): boolean {
    const cleanScope = String(scope ?? '').trim()
    const cleanName = String(name ?? '').trim()
    if (!cleanScope || !cleanName) return false
    if (this.findProjectNameOwner(cleanName, cleanScope) !== null) return false
    const now = Date.now()
    const result = this.db
      .prepare(`
        INSERT INTO projects (scope, name, root, is_manual, created_at, updated_at)
        VALUES (?, ?, NULL, 1, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          name = excluded.name,
          is_manual = 1,
          updated_at = excluded.updated_at
      `)
      .run(cleanScope, cleanName, now, now)
    return result.changes > 0
  }

  /**
   * 清理「没有任何记忆文件」的工程（看板里不再堆积历史遗留的空工程）。
   *
   * 判定的四个关键点：
   * 1. 以**叶子节点**（is_leaf=1，即真正的记忆文件）为准，而不是 nodes 总行数 ——
   *    删除最后一条记忆时 deleteNode 只删子树、不剪父目录，若按 nodes 计数，
   *    该工程会残留一串空目录骨架而永远不算「空」，看板里就会留下一个
   *    只有空目录、没有任何记忆的工程；
   * 2. 清理是**连带**的：既然该工程已无记忆，其空目录骨架与登记项一并删除，
   *    否则 listProjects 仍会从 nodes 里把它们聚合回清单（删了等于没删）；
   * 3. **豁免 keepScope（宿主当前正在打开的合法工作区）**：它是「当前工程就绪、可随时
   *    新建沉淀」的心智锚点 —— 看板需要它常驻下拉框（标记为 0 条）以便随时切入空树后
   *    新建，因此零记忆也不清理（见 server 的 GET /api/projects 展示保证）；
   * 4. 除当前工程外的历史遗留（路径漂移产生的无用 scope、只登记过没写过的目录等）
   *    依然彻底清理；
   * 5. **宿主工作区白名单**（isScopeAllowed，见 ProjectPruneOptions）：名单外的作用域
   *    一律无条件清理（含其记忆节点与登记项），且**不因它是宿主当前工程而豁免** ——
   *    「当前工程」这块免死金牌只发给合法工作区。
   *
   * 候选集取「登记表 scope ∪ nodes 里出现过的 scope」的并集，覆盖
   * 「只登记过没写过」与「只写过没登记过（历史库）」两种遗留形态。
   * 返回被清理的 scope 列表；幂等，可安全重复调用。
   */
  public pruneEmptyProjects(options: ProjectPruneOptions = {}): string[] {
    const keep = String(options.keepScope ?? '').trim()
    const isScopeAllowed = options.isScopeAllowed ?? null
    // 候选集：登记表 ∪ 节点表（排除 global —— 全局偏好树永远不属于任何工作区）
    const candidates = this.db
      .prepare(`
        SELECT scope FROM (
          SELECT scope FROM projects WHERE scope <> 'global'
          UNION
          SELECT DISTINCT tree_type AS scope FROM nodes WHERE tree_type <> 'global'
        )
      `)
      .all() as Array<{ scope: string }>
    if (candidates.length === 0) return []
    // 有真实记忆（叶子节点）的作用域：白名单外者照样清理，白名单内者除非零记忆否则保留
    const withLeaf = new Set(
      (this.db.prepare('SELECT DISTINCT tree_type AS scope FROM nodes WHERE is_leaf = 1').all() as Array<{
        scope: string
      }>).map((row) => row.scope),
    )

    const doomed: string[] = []
    for (const row of candidates) {
      const scope = String(row.scope ?? '').trim()
      if (!scope || scope === 'global') continue
      // 白名单优先：不在宿主合法工作区列表内 → 无条件剔除（含当前工程）
      if (isScopeAllowed !== null && !isScopeAllowed(scope)) {
        doomed.push(scope)
        continue
      }
      // 名单内：豁免宿主当前活跃工程（零记忆也留作看板锚点），其余零记忆者清理
      if (keep && scope === keep) continue
      if (withLeaf.has(scope)) continue
      doomed.push(scope)
    }
    if (doomed.length === 0) return []
    // 叶子删除经 trg_nodes_ad 触发器同步清理 FTS5 索引，不留孤立句柄
    const removeNodes = this.db.prepare('DELETE FROM nodes WHERE tree_type = ?')
    const removeRegistry = this.db.prepare('DELETE FROM projects WHERE scope = ?')
    this.withTransaction(() => {
      for (const scope of doomed) {
        removeNodes.run(scope)
        removeRegistry.run(scope)
      }
    })
    return doomed
  }

  /**
   * 同名工程自愈：历史库可能已存在重名（新登记已由 registerProject 拦截）。
   * 同一名字（忽略大小写）被多个 scope 持有时，按
   * 「手工命名 > 记忆条数多 > 最近更新」选出保留原名者，其余追加 scope 短标识。
   * 返回改动明细；幂等（重名消失后不再改动）。
   */
  public normalizeDuplicateNames(): Array<{ scope: string; from: string; to: string }> {
    const rows = this.db
      .prepare(`
        SELECT p.scope AS scope,
               p.name AS name,
               p.is_manual AS is_manual,
               p.updated_at AS updated_at,
               (SELECT COUNT(*) FROM nodes n WHERE n.tree_type = p.scope AND n.is_leaf = 1) AS leaf_count
        FROM projects p
      `)
      .all() as Array<{ scope: string; name: string; is_manual: number; updated_at: number; leaf_count: number }>

    const groups = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = row.name.trim().toLowerCase()
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }

    // 名字占用计数：改名过程中实时维护，保证生成的新名字本身也不与他人冲突
    const held = new Map<string, number>()
    const bump = (name: string, delta: number): void => {
      const key = name.trim().toLowerCase()
      const next = (held.get(key) ?? 0) + delta
      if (next <= 0) held.delete(key)
      else held.set(key, next)
    }
    for (const row of rows) bump(row.name, 1)

    const changes: Array<{ scope: string; from: string; to: string }> = []
    const update = this.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE scope = ?')
    this.withTransaction(() => {
      for (const bucket of groups.values()) {
        if (bucket.length < 2) continue
        const ranked = [...bucket].sort(
          (a, b) =>
            b.is_manual - a.is_manual ||
            Number(b.leaf_count ?? 0) - Number(a.leaf_count ?? 0) ||
            b.updated_at - a.updated_at ||
            a.scope.localeCompare(b.scope),
        )
        const winner = ranked[0]
        for (const loser of ranked.slice(1)) {
          const baseName = winner.name.trim() || winner.scope
          const tag = scopeTag(loser.scope)
          bump(loser.name, -1)
          let candidate = `${baseName} (${tag})`
          let i = 2
          while (held.has(candidate.trim().toLowerCase())) {
            candidate = `${baseName} (${tag}-${i})`
            i += 1
          }
          bump(candidate, 1)
          update.run(candidate, Date.now(), loser.scope)
          changes.push({ scope: loser.scope, from: loser.name, to: candidate })
        }
      }
    })
    return changes
  }

  /**
   * 工程清单自愈维护：先清理零记忆工程与白名单外的孤儿工程（豁免宿主当前活跃的**合法**
   * 工作区），再消除同名工程。幂等，可在插件启动与每次清单读取前安全重复调用。
   * keepScope 传宿主当前工程 scope；isScopeAllowed 传宿主工作区白名单判定。
   */
  public maintainProjects(options: ProjectPruneOptions = {}): ProjectMaintenance {
    return {
      purgedScopes: this.pruneEmptyProjects(options),
      renamed: this.normalizeDuplicateNames(),
    }
  }

  /**
   * 列出所有工程作用域：以「库里真实存在的记忆记录」为准（按 tree_type 去重聚合），
   * 并补上仅在登记表中存在、尚无记忆的已登记工程（含宿主当前工程）。
   *
   * `workspaceNames` 是宿主工作区白名单的「scope → 工作区标题」投影，用于给每条
   * 清单项带上 `workspaceName`，让看板能显示「工程名 [工作区名] (N条)」；传 null
   * 表示无从判定（宿主登记表不可读），此时 workspaceName 一律为 null。
   *
   * 注意：本方法只做聚合、不改数据。看板 GET /api/projects 会先调用
   * maintainProjects() 清理白名单外与零记忆工程、收敛同名工程，再调用本方法取净化清单。
   */
  public listProjects(workspaceNames: ReadonlyMap<string, string> | null = null): ProjectSummary[] {
    const rows = this.db
      .prepare(`
        SELECT tree_type AS scope,
               COUNT(*) AS node_count,
               SUM(CASE WHEN is_leaf = 1 THEN 1 ELSE 0 END) AS leaf_count,
               MAX(updated_at) AS updated_at
        FROM nodes
        WHERE tree_type <> 'global'
        GROUP BY tree_type
      `)
      .all() as Array<{ scope: string; node_count: number; leaf_count: number; updated_at: number }>

    const registry = this.db.prepare('SELECT scope, name, root FROM projects').all() as Array<{
      scope: string
      name: string
      root: string | null
    }>
    const registryMap = new Map(registry.map((r) => [r.scope, r]))

    const merged = new Map<string, ProjectSummary>()
    for (const row of rows) {
      const meta = registryMap.get(row.scope)
      merged.set(row.scope, {
        scope: row.scope,
        name: meta?.name || row.scope,
        root: meta?.root ?? null,
        workspaceName: workspaceNames?.get(row.scope) ?? null,
        nodeCount: Number(row.node_count ?? 0),
        leafCount: Number(row.leaf_count ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
      })
    }
    for (const meta of registry) {
      if (merged.has(meta.scope)) continue
      merged.set(meta.scope, {
        scope: meta.scope,
        name: meta.name || meta.scope,
        root: meta.root ?? null,
        workspaceName: workspaceNames?.get(meta.scope) ?? null,
        nodeCount: 0,
        leafCount: 0,
        updatedAt: 0,
      })
    }

    return Array.from(merged.values()).sort((a, b) => {
      if (b.leafCount !== a.leafCount) return b.leafCount - a.leafCount
      return a.name.localeCompare(b.name)
    })
  }

  /**
   * 把「工程名或 scope 原文」解析为确定的 scope。
   * 依次尝试：scope 原文命中登记表 → scope 原文在 nodes 中存在 → 登记名匹配（忽略大小写）。
   * 解析不出来返回 null，由调用方决定 404 还是回退全量。
   */
  public findProjectScope(nameOrScope: string): string | null {
    const key = String(nameOrScope ?? '').trim()
    if (!key) return null

    const byScope = this.db.prepare('SELECT scope FROM projects WHERE scope = ?').get(key) as
      | { scope: string }
      | undefined
    if (byScope) return byScope.scope

    const inNodes = this.db.prepare('SELECT 1 AS ok FROM nodes WHERE tree_type = ? LIMIT 1').get(key)
    if (inNodes) return key

    const byName = this.db
      .prepare('SELECT scope FROM projects WHERE lower(name) = lower(?) ORDER BY updated_at DESC LIMIT 1')
      .get(key) as { scope: string } | undefined
    return byName ? byName.scope : null
  }

  /**
   * 人工剪枝：删除指定节点并级联移除其全部后代（沿 parent_id 外键链递归收敛），
   * 每行删除均经 trg_nodes_ad 触发器同步清理 FTS5 索引，杜绝孤立句柄残留。
   * P2-8：非法 id（非整数 / 非正数）直接返回 false —— 此前 Number('abc') 为
   * NaN，better-sqlite3 绑定 NaN 抛异常被服务端转成 500，错误语义失真。
   */
  public deleteNode(id: string): boolean {
    const numericId = Number(id)
    if (!Number.isInteger(numericId) || numericId <= 0) return false
    const result = this.db
      .prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
        )
        DELETE FROM nodes WHERE id IN (SELECT id FROM subtree)
      `)
      .run(numericId)
    return result.changes > 0
  }

  /** 读取单个节点（编辑保存回显与服务端 404 判定共用） */
  public getNode(id: string): MemoryNode | null {
    const numericId = Number(id)
    if (!Number.isInteger(numericId) || numericId <= 0) return null
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(numericId) as
      | Record<string, unknown>
      | undefined
    return row ? this.rowToNode(row) : null
  }

  /**
   * 在线编辑记忆节点（看板详情抽屉「保存」入口）。
   * 支持 title（标题）、content（正文）与 path（目录迁移）的任意组合；
   * 更新语句命中 trg_nodes_au 触发器，FTS5 分词索引自动同步重建。
   * 目录迁移时同步修正全部后代节点的物化路径前缀，并剪枝遗留的空目录链。
   * 返回更新后的完整节点；目标 id 不存在返回 null；同目录同名冲突抛 Error。
   */
  public updateNode(
    id: string,
    patch: { title?: string; content?: string; path?: string },
  ): MemoryNode | null {
    const numericId = Number(id)
    if (!Number.isInteger(numericId) || numericId <= 0) return null
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(numericId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const current = this.rowToNode(row)

    const newName = patch.title !== undefined ? sanitizeManualName(patch.title) : current.name
    if (!newName) throw new Error('记忆标题不能为空')
    const newContent = patch.content !== undefined ? String(patch.content ?? '').trim() : current.content
    if (current.is_leaf === 1 && String(newContent ?? '').trim() === '') {
      throw new Error('记忆正文不能为空')
    }

    let targetPath = current.path
    let targetParentId: string | null = current.parent_id
    const originalPath = current.path
    const originalParentId = current.parent_id

    if (patch.path !== undefined) {
      const segments = parsePathSegments(patch.path)
      const fallbackSegments = segments.length > 0 ? segments : ['未分类']
      let parentId: number | null = null
      let fullPath = ''
      for (const seg of fallbackSegments) {
        fullPath += `/${seg}`
        parentId = this.ensureDirectory(current.tree_type, parentId, `${fullPath}/`, seg)
      }
      targetPath = `${fullPath}/`
      targetParentId = parentId == null ? null : String(parentId)
    }

    // P1-7 事务包裹：「更新自身 → 重写后代 path → 剪枝空目录」三步必须在同一
    // 原子单元内完成，中途失败/断电由事务回滚兜底，物化路径链不再可能断裂。
    return this.withTransaction(() => {
      // UNIQUE(tree_type, path, name) 冲突前置显式检查，给出可读错误而非 SQLite 原生报错
      const conflict = this.db
        .prepare('SELECT id FROM nodes WHERE tree_type = ? AND path = ? AND name = ? AND id <> ?')
        .get(current.tree_type, targetPath, newName, numericId) as { id: number } | undefined
      if (conflict) throw new Error('同目录下已存在同名记忆，请换一个标题')

      this.db
        .prepare('UPDATE nodes SET parent_id = ?, path = ?, name = ?, content = ?, updated_at = ? WHERE id = ?')
        .run(
          targetParentId == null ? null : Number(targetParentId),
          targetPath,
          newName,
          newContent,
          Date.now(),
          numericId,
        )

      // 目录迁移：沿旧物化路径前缀重写全部后代节点（FTS 由触发器自动重索引）
      if (targetPath !== originalPath) {
        this.db
          .prepare(
            `UPDATE nodes SET path = ? || substr(path, ?)
             WHERE tree_type = ? AND path LIKE ? ESCAPE '\\' AND id <> ?`,
          )
          .run(
            targetPath,
            originalPath.length + 1,
            current.tree_type,
            `${escapeLikePattern(originalPath)}%`,
            numericId,
          )
        // 旧目录链空壳剪枝（自原父节点向上逐层收敛，仅删除零子代的目录）
        this.pruneEmptyDirectoryChain(originalParentId)
      }

      const updated = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(numericId) as Record<string, unknown>
      return this.rowToNode(updated)
    })
  }

  /** 自底向上剪枝零子代目录链：迁移 / 重命名遗留的空目录逐层收敛删除 */
  private pruneEmptyDirectoryChain(parentId: string | null): void {
    let cursor: string | null = parentId
    while (cursor !== null) {
      const row = this.db.prepare('SELECT id, parent_id, is_leaf FROM nodes WHERE id = ?').get(Number(cursor)) as
        | { id: number; parent_id: number | null; is_leaf: number }
        | undefined
      if (!row || Number(row.is_leaf) === 1) break
      const hasChild = this.db.prepare('SELECT 1 AS ok FROM nodes WHERE parent_id = ? LIMIT 1').get(row.id)
      if (hasChild) break
      this.db.prepare('DELETE FROM nodes WHERE id = ?').run(row.id)
      cursor = row.parent_id == null ? null : String(row.parent_id)
    }
  }

  /**
   * M1 待确认区审核：把节点状态在 confirmed / pending 之间切换（看板「确认 /
   * 拒绝」入口），语义校验不通过的沉淀条目经用户确认后重新进入召回。
   * 非法状态值与不存在的 id 返回 false（→ 服务端 400 / 404 语义）。
   */
  public setStatus(id: string, status: string): boolean {
    if (status !== 'confirmed' && status !== 'pending') return false
    const numericId = Number(id)
    if (!Number.isInteger(numericId) || numericId <= 0) return false
    const result = this.db
      .prepare('UPDATE nodes SET status = ? WHERE id = ?')
      .run(status, numericId)
    return result.changes > 0
  }

  /**
   * 召回强化：命中的记忆叶子断言计数 +1（记忆被检索调用即视为被强化）。
   * 供召回引擎在最终命中集合上调用；非法 id 自动过滤，全非法输入零开销返回。
   */
  public reinforceByIds(ids: Array<string | number>): void {
    const numericIds = [...new Set(ids.map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0))]
    if (numericIds.length === 0) return
    const placeholders = numericIds.map(() => '?').join(', ')
    this.db
      .prepare(`UPDATE nodes SET reinforce_count = reinforce_count + 1, updated_at = ? WHERE id IN (${placeholders})`)
      .run(Date.now(), ...numericIds)
  }

  /**
   * M3 强化衰减：长期未被命中（updated_at 早于衰减窗口）的叶子记忆
   * reinforce_count 减半（下限 1）。updated_at 由召回强化与沉淀写入共同刷新，
   * 因此该条件等价于「超过衰减窗口没有任何触碰」。返回受影响行数。
   */
  public decayStaleReinforce(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    const result = this.db
      .prepare(`
        UPDATE nodes
        SET reinforce_count = MAX(1, CAST(reinforce_count / 2 AS INTEGER))
        WHERE is_leaf = 1 AND reinforce_count > 1 AND updated_at < ?
      `)
      .run(cutoff)
    return result.changes
  }

  /**
   * M3 矛盾检测批量取数：取指定时间点之后入库的 auto 来源、confirmed 状态的
   * 记忆叶子（compaction 的「本批新记忆」）。
   */
  public listLeavesCreatedSince(sinceTs: number, limit = 10): MemoryNode[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM nodes
        WHERE is_leaf = 1 AND source = 'auto' AND status = 'confirmed' AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(sinceTs, limit) as Array<Record<string, unknown>>
    return rows.map((row) => this.rowToNode(row))
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
      source: String(row.source ?? 'manual'),
      status: String(row.status ?? 'confirmed'),
      created_at: Number(row.created_at ?? 0),
      updated_at: Number(row.updated_at ?? 0),
    }
  }
}
