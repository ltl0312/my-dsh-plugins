// packages/tlmemory/src/tools.ts
//
// 工具注册与**返回契约收敛层**。
//
// 事故复盘（content.some is not a function，会话不可恢复崩溃）：
// DSH 宿主的工具流水线（@deepseek-ai/dsh-tools 的 createSuccessResult）按固定次序消费工具：
//   1. snapshotToolValue(name, candidate)      —— 快照 execute 的返回值；
//   2. validateJsonSchemaValue(output.schema)  —— 按本文件声明的 output.schema 校验；
//   3. tool.output.render(exec.arguments, value) —— **双参**调用，产出 content；
//   4. 宿主随后对 content 执行 `.some(block => ...)`。
// 旧实现把 render 写成 `(result) => result?.message ?? JSON.stringify(result)`：第一个形参
// 实际接到的是 exec.arguments（不是工具结果），`args.message` 恒为 undefined，于是恒定走
// JSON.stringify 分支返回**裸字符串**；宿主把它当 ContentBlock[] 使用，在 `.some(...)` 处抛出
// `TypeError: content.some is not a function`，工具调用链整体崩溃且无法恢复。
//
// 本文件的契约（三层同时钉死，见 tests/tools-contract.spec.ts）：
//   A. execute 返回值恒为 MCP/DSH 规范信封 `{ content: [{ type: 'text', text }] }`；
//   B. 该信封恒满足 output.schema（宿主第 2 步校验）；
//   C. output.render(args, value) 恒返回合法文本块数组，且对畸形输入（字符串 / 裸对象 /
//      裸值 / null）与旧宿主的单位调用形态都做兜底归一 —— 任何情况下都不再吐出非数组。
import type { Context } from "cordis";
import { sanitizeSegment } from "./db.js";
import type { MemoryDB } from "./db.js";
import { expandQueryCandidates } from "./query-expand.js";
import type { SearchResult } from "./types.js";

/** MCP 规范文本内容块（与 dsh-llm 的 TextBlock 逐字段一致） */
export interface ToolTextBlock {
  type: "text";
  text: string;
}

/** MCP/DSH 规范工具返回信封：content 恒为数组 */
export interface ToolResultEnvelope {
  content: ToolTextBlock[];
}

/**
 * 单个文本块的字符上限。工具返回值要经宿主 JSON 快照 + 落盘，超长正文既无助于模型
 * 理解又会拖慢工具调用环，这里做一次确定性截断（截断标记本身也计入上限之外）。
 */
const MAX_TOOL_TEXT_CHARS = 60_000;

/** 截断超长文本，保证 text 字段恒为可安全落盘的字符串 */
function clampText(text: string): string {
  return text.length > MAX_TOOL_TEXT_CHARS
    ? `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n…（内容过长，已截断）`
    : text;
}

/** JSON 序列化兜底：循环引用 / BigInt / undefined 等一律退化为 String()，绝不抛错 */
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 文本块判型守卫：宿主侧只认 { type: 'text', text: string } */
function isTextBlock(value: unknown): value is ToolTextBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/**
 * 把任意 execute 产出规范化为 MCP/DSH 规范信封。
 *
 * 这是全插件唯一的工具返回出口：content 恒为「至少一个 text 块」的数组，
 * text 恒为字符串（字符串原样透传，其余类型 JSON 序列化）。
 */
export function toToolResult(result: unknown): ToolResultEnvelope {
  return {
    content: [
      {
        type: "text",
        text: typeof result === "string" ? result : safeStringify(result),
      },
    ],
  };
}

/** 从候选值中提取文本块（信封 / 块数组 / 裸字符串 / 带 message 的对象），无果返回空数组 */
function extractTextBlocks(candidate: unknown): ToolTextBlock[] {
  if (typeof candidate === "string") return [{ type: "text", text: clampText(candidate) }];
  if (Array.isArray(candidate)) {
    return candidate.filter(isTextBlock).map((block) => ({
      type: "text" as const,
      text: clampText(block.text),
    }));
  }
  if (typeof candidate === "object" && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    // 规范信封优先（宿主 render 的正规输入）
    if (Array.isArray(record.content)) return extractTextBlocks(record.content);
    // 旧实现遗留形态兜底：{ message } / { text }
    if (typeof record.message === "string") return [{ type: "text", text: clampText(record.message) }];
    if (typeof record.text === "string") return [{ type: "text", text: clampText(record.text) }];
  }
  return [];
}

/**
 * 最终护栏：把任何候选值收敛为合法 ContentBlock[]（宿主 render 的返回类型契约）。
 *
 * 无论输入是信封、块数组、裸字符串、裸对象、null 还是畸形结构，返回值恒为
 * 非空数组且元素恒为 { type: 'text', text: string } —— 从根上杜绝宿主
 * `content.some is not a function`。
 */
export function toContentBlocks(candidate: unknown): ToolTextBlock[] {
  const blocks = extractTextBlocks(candidate);
  if (blocks.length > 0) return blocks;
  return [{ type: "text", text: clampText(safeStringify(candidate)) }];
}

/**
 * 兼容宿主 render 的双参契约 (args, value) 与历史单位调用 (value)：
 * value 为 undefined（旧宿主把结果塞进第一个形参）时退回 args。
 */
function pickProjectionCandidate(args: unknown, value: unknown): unknown {
  return value === undefined ? args : value;
}

/** 工具 output.schema：宿主在 render 之前会用它校验 execute 的返回值 */
const TOOL_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", description: "内容块类型，恒为 text" },
          text: { type: "string", description: "供模型读取的文本内容" },
        },
        required: ["type", "text"],
      },
      description: "MCP 规范内容块数组，至少含一个 text 块",
    },
  },
  required: ["content"],
};

/**
 * 工具 output 段：schema 钉死信封结构，render 把信封（或任何兜底形态）投影为文本块数组。
 * render 必须用剩余参数接收 —— 宿主以 (args, value) 双参调用，历史宿主以 (value) 单参调用。
 */
function toolOutput(): { schema: Record<string, unknown>; render: (...params: unknown[]) => ToolTextBlock[] } {
  return {
    schema: TOOL_RESULT_SCHEMA,
    render: (...params: unknown[]) =>
      toContentBlocks(pickProjectionCandidate(params[0], params[1])),
  };
}

/**
 * 工程作用域解析器：给定宿主会话对象（可能为 undefined）返回写入用的 tree_type。
 *
 * v0.6.6 作用域防漂移：解析实现由插件装配层（src/index.ts）提供，必须完成
 * 「会话工作区 → 白名单校验 → 降级合法工作区」的完整防线；本文件只负责把
 * 宿主 execute 上下文里的 session 线索提取出来交给它，绝不自行猜测 scope。
 */
export type ScopeResolver = (session?: unknown) => string

/**
 * 从宿主 execute 的第二参（exec 执行上下文）防御式提取 session 对象。
 * 宿主上下文结构未在官方契约中冻结，这里按常见形态做鸭子类型探测：
 * `exec.session` → `exec.context.session`，全部不命中返回 undefined。
 */
function extractExecSession(exec: unknown): unknown {
  if (!exec || typeof exec !== 'object') return undefined
  const record = exec as Record<string, unknown>
  const direct = record.session
  if (direct && typeof direct === 'object') return direct
  const nested = record.context
  if (nested && typeof nested === 'object') {
    const inner = (nested as Record<string, unknown>).session
    if (inner && typeof inner === 'object') return inner
  }
  return undefined
}

export function registerMemoryTools(
  ctx: Context,
  db: MemoryDB,
  resolveCurrentScope?: ScopeResolver,
): () => void {
  // 第三参缺省（嵌入式最小用法）：回退 global —— 绝不回退 process.cwd()，
  // 那正是「记忆误存进终端启动目录」的事故根源。
  const resolveScope: ScopeResolver = resolveCurrentScope ?? (() => 'global')
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
    output: toolOutput(),
    async execute(
      args: {
        tree_scope: "global" | "project";
        path_segments: string[];
        rule_name: string;
        content: string;
        keywords: string[];
      },
      exec?: unknown,
    ) {
      // v0.6.6 作用域防漂移：宿主 exec 上下文携带 session 时按会话解析工程作用域，
      // 多 workspace 宿主下记忆归属不再退化为进程启动目录（ZhuanZ 事故根因）
      const targetTree =
        args.tree_scope === "global" ? "global" : resolveScope(extractExecSession(exec));
      // P2-12：净化统一复用 db.ts 的 sanitizeSegment（此前内联正则缺连字符
      // `-`，含连字符的规则名经工具链路会被剥成连写词）
      const sanitizedSegments = args.path_segments.map((s) => sanitizeSegment(s));
      const sanitizedName = sanitizeSegment(args.rule_name);
      const boundedContent = args.content.slice(0, 80);

      const node = db.upsertLeaf(
        targetTree,
        sanitizedSegments,
        sanitizedName,
        boundedContent,
        args.keywords || [sanitizedName],
        // P0 修复（行为检测取证）：显式声明 source，不再依赖缺省值。
        // 工具是**模型显式调用**的手工写入，必须落 'manual' —— 落 'auto' 会让它
        // 与 turn/end 后台提炼链路在库中无法区分，直接毁掉 source='auto' 这个
        // 「自动记录」判定标记。显式传参也让此处语义不随 db 缺省值变动而漂移。
        { source: 'manual' },
      );

      // 契约 A：恒返回 MCP 信封，绝不返回裸对象
      return toToolResult(
        `记忆已成功入库 [${node.tree_type}]: ${node.path}${node.name}`,
      );
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
    output: toolOutput(),
    async execute(
      args: {
        query: string;
        scope?: "all" | "global" | "project";
        limit?: number;
      },
      exec?: unknown,
    ) {
      const currentScope = resolveScope(extractExecSession(exec));
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

      // 契约 A：同样收敛为信封；文本沿用人类可读列表（零命中给确定性提示，
      // 不返回空串、更不返回空数组）
      const text =
        results.length === 0
          ? "未检索到相关的长期记忆。"
          : results
              .map(
                (r) =>
                  `* [${r.tree_type === "global" ? "全局偏好" : "当前工程"}] ${r.path}${r.name}: ${r.content ?? ""} (得分: ${r.score.toFixed(1)})`,
              )
              .join("\n");

      return toToolResult(text);
    },
  });

  return () => {
    unregisterSave();
    unregisterQuery();
  };
}
