// packages/tlmemory/src/tools.ts
import type { Context } from "cordis";
import type { MemoryDB } from "./db.js";
import { expandQueryCandidates } from "./query-expand.js";
import type { SearchResult } from "./types.js";

export function registerMemoryTools(
  ctx: Context,
  db: MemoryDB,
  resolveCurrentScope: () => string,
): () => void {
  if (!ctx.tools?.register) {
    ctx.logger?.warn?.("[tlmemory] ctx.tools 未就绪，跳过工具注册");
    return () => {};
  }

  const unregisterSave = ctx.tools.register({
    name: "tlmemory_save",
    description:
      "显式将重要用户规范、技术架构约束或踩坑避坑断言持久化至长期记忆树中",
    parameters: {
      type: "object",
      properties: {
        tree_scope: {
          type: "string",
          enum: ["global", "project"],
          description:
            "作用域：global 属于跨工程全局偏好，project 属于当前仓库专属规约",
        },
        path_segments: {
          type: "array",
          items: { type: "string" },
          description: '树形分类路径段，例如 ["工程化", "包管理"]',
        },
        rule_name: {
          type: "string",
          description: '规则简述标题，例如 "pnpm依赖构建放行"',
        },
        content: {
          type: "string",
          description:
            "原子断言文本，严格限制在40至80字符以内，禁止包含多余代码块",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "检索关键词列表",
        },
      },
      required: [
        "tree_scope",
        "path_segments",
        "rule_name",
        "content",
        "keywords",
      ],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string", description: "执行状态" },
          message: { type: "string", description: "详细提示信息" },
          node_id: { type: "string", description: "记忆节点唯一标识" },
        },
        required: ["status", "message", "node_id"],
      },
      render: (result: any) => result?.message ?? JSON.stringify(result),
    },
    async execute(args: {
      tree_scope: "global" | "project";
      path_segments: string[];
      rule_name: string;
      content: string;
      keywords: string[];
    }) {
      const targetTree =
        args.tree_scope === "global" ? "global" : resolveCurrentScope();
      const sanitizedSegments = args.path_segments.map((s) =>
        s.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, ""),
      );
      const sanitizedName = args.rule_name.replace(
        /[^a-zA-Z0-9_\u4e00-\u9fa5]/g,
        "",
      );
      const boundedContent = args.content.slice(0, 80);

      const node = db.upsertLeaf(
        targetTree,
        sanitizedSegments,
        sanitizedName,
        boundedContent,
        args.keywords || [sanitizedName],
      );

      return {
        status: "success",
        message: `记忆已成功入库 [${node.tree_type}]: ${node.path}${node.name}`,
        node_id: node.id,
      };
    },
  });

  const unregisterQuery = ctx.tools.register({
    name: "tlmemory_query",
    description:
      "通过 FTS5 Trigram 全文索引检索与当前任务紧密相关的长期记忆断言",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "查询文本或技术关键字",
        },
        scope: {
          type: "string",
          enum: ["all", "global", "project"],
          description: "查询范围，默认 all 覆盖全局与当前工程",
        },
        limit: {
          type: "number",
          description: "最大检索结果数，默认 5",
        },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "string", description: "执行状态" },
          hits_count: { type: "number", description: "命中条数" },
          memories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tree: { type: "string" },
                path: { type: "string" },
                content: { type: "string" },
                score: { type: "number" },
              },
            },
            description: "命中的记忆列表",
          },
        },
        required: ["status", "hits_count", "memories"],
      },
      render: (result: any) => {
        if (!result.memories || result.memories.length === 0) {
          return "未检索到相关的长期记忆。";
        }
        return result.memories
          .map(
            (m: any) =>
              `* [${m.tree}] ${m.path}: ${m.content} (得分: ${m.score.toFixed(1)})`,
          )
          .join("\n");
      },
    },
    async execute(args: {
      query: string;
      scope?: "all" | "global" | "project";
      limit?: number;
    }) {
      const currentScope = resolveCurrentScope();
      let treeType: string | undefined;
      if (args.scope === "global") treeType = "global";
      if (args.scope === "project") treeType = currentScope;

      const maxCount = args.limit || 5;
      const rawQuery = String(args.query ?? "").trim();

      // P1-4 查询展开：LLM 传入的自然语言长句（最常见形态）走严格 Trigram 短语匹配
      // 几乎必然零命中，这里复用与召回引擎同一套候选展开（<3 字符时 db.search
      // 内部自动降级 LIKE 兜底），跨候选取最高分去重合并。
      const candidates = expandQueryCandidates(rawQuery);
      const merged = new Map<string, SearchResult>();
      for (const candidate of candidates) {
        for (const hit of db.search(candidate, { treeType, limit: maxCount })) {
          const key = `${hit.tree_type}:${hit.path}${hit.name}`;
          const prev = merged.get(key);
          if (!prev || hit.score > prev.score) merged.set(key, hit);
        }
      }
      const results = Array.from(merged.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCount);

      return {
        status: "success",
        hits_count: results.length,
        memories: results.map((r) => ({
          tree: r.tree_type === "global" ? "全局偏好" : "当前工程",
          path: `${r.path}${r.name}`,
          content: r.content ?? "",
          score: r.score,
        })),
      };
    },
  });

  return () => {
    unregisterSave();
    unregisterQuery();
  };
}
