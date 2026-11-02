// packages/tlmemory/src/partition.ts
// 四大物理分区（scope）与角色隔离（char_id）的单一事实来源。
//
// 为什么要独立成模块：分区的判定规则同时被
//   1. migrate() 的存量回填（UPDATE … SET scope = …）
//   2. upsertLeaf / createLeaf / ensureDirectory 的写入缺省值
//   3. tools.ts 的参数校验与 tlrp 的运行模式缺省过滤
// 三处消费。任何一处内联副本都会漂移（1.3.0 的路径净化正则就吃过这个亏），
// 因此这里只允许纯函数，且不 import 任何宿主或存储层符号。
//
// 分区语义（与 tlrp 的读写契约一一对应）：
//   core  用户核心画像与全局通用前提（原 global 树的自然归属）
//   work  技术运维、服务器状态、工程里程碑（原 repo:<hash> 树的自然归属）
//   rp    专为 tlrp 开辟的角色扮演动态记忆（羁绊 / 约会 / 剧情状态）
//   lore  专为 tlrp 开辟的角色静态设定切片（世界观 / 身世 / 语料）
//
// rp 与 lore 在树上都挂在 global（跨工程，不该跟着某个仓库走），
// 角色归属由路径第 2 段承载（/rp/firefly/…、/lore/firefly/…），并冗余进 char_id 列，
// 以便按角色做索引级隔离 —— 多角色共用同一个库也绝不串戏。

export type MemoryPartition = 'core' | 'work' | 'rp' | 'lore'

/** 合法分区的固定顺序（输出与统计用，保证可复现） */
export const PARTITIONS: readonly MemoryPartition[] = ['core', 'work', 'rp', 'lore'] as const

/** 分区判定所需的输入：只看树类型与物化路径 */
export interface PartitionSource {
  treeType: string
  /** 目录物化路径，形如 '/rp/firefly/羁绊/' */
  dirPath: string
  /** 叶子名称，形如 '橡木蛋糕卷' */
  name?: string
}

export interface PartitionIdentity {
  scope: MemoryPartition
  charId: string
  /** 补全后的完整路径（目录路径 + 名称），供审计与断言 */
  fullPath: string
}

/** 判定输入是否为合法分区名 */
export function isPartition(value: unknown): value is MemoryPartition {
  return typeof value === 'string' && (PARTITIONS as readonly string[]).includes(value)
}

/**
 * 分区路径前缀 → 分区名的映射。
 * 顺序即优先级：路径前缀优先于树类型，这样即使有人在 repo 树里手写 /rp/firefly/…，
 * 也会被正确归类（tlrp 的写入指引明确要求 rp/lore 走 global 树，但不靠调用方自觉）。
 */
const PREFIX_PARTITION: ReadonlyArray<readonly [string, MemoryPartition]> = [
  ['rp', 'rp'],
  ['lore', 'lore'],
  ['work', 'work'],
  ['core', 'core'],
] as const

/** 把任意形态的路径拼成 '/a/b/c' 并切分（容忍首尾斜杠与重复斜杠） */
export function splitPath(dirPath: string, name?: string): string[] {
  const raw = `${String(dirPath ?? '')}/${String(name ?? '')}`
  return raw
    .split('/')
    .map((seg) => seg.trim())
    .filter(Boolean)
}

/** 角色 id 归一化：小写、仅保留字母数字下划线与连字符；空则回空串 */
export function normalizeCharId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64)
}

/**
 * 由树类型 + 路径推导分区与角色（纯函数，幂等）。
 *
 * 存量回填与写入缺省值必须走同一个函数 —— 否则「老数据被重写时换了分区」
 * 这种漂移会在迁移后立刻出现，且没有审计痕迹。
 */
export function derivePartition(source: PartitionSource): PartitionIdentity {
  const segments = splitPath(source.dirPath, source.name)
  const fullPath = segments.length ? `/${segments.join('/')}` : '/'
  const head = segments[0] ?? ''

  for (const [prefix, scope] of PREFIX_PARTITION) {
    if (head === prefix) {
      // 角色归属只对 rp/lore 有意义：第二段就是角色 id。
      // work/core 路径下即便有第二段也不当作角色（避免 /work/firefly 这类
      // 项目目录名被误判成角色）。
      const charId = scope === 'rp' || scope === 'lore' ? normalizeCharId(segments[1] ?? '') : ''
      return { scope, charId, fullPath }
    }
  }

  // 无显式分区前缀时按树类型兜底：global 是跨工程的用户画像 → core；
  // repo:<hash> 是某个工程的技术结论 → work。
  const scope: MemoryPartition = String(source.treeType ?? '') === 'global' ? 'core' : 'work'
  return { scope, charId: '', fullPath }
}

/**
 * 分区过滤的默认策略：与 tlrp 的两种运行模式一一对应。
 *
 * 未显式声明分区时（工具调用最常见形态），检索范围由当前模式决定：
 *   RP    → rp + lore + core，且只收「本角色」或「无角色」的记录（char_id 隔离）
 *   WORK  → work + core
 * 这是「分区隔离」真正生效的地方：RP 态检索永远捞不到 work 里的服务器运维结论，
 * 反之亦然。
 */
export function defaultPartitionsForMode(mode: 'rp' | 'work' | string): MemoryPartition[] {
  return String(mode).toLowerCase() === 'rp' ? ['rp', 'lore', 'core'] : ['work', 'core']
}

/**
 * 角色可见性判定：记录要么属于本角色，要么不带角色（通用/无归属）。
 * 直接绑到 SQL 上会写成 (char_id = ? OR char_id = '')，这里给出同一口径的 JS 版，
 * 供 tlrp 的桥接层在内存里二次过滤时复用。
 */
export function isVisibleToCharacter(charId: string, activeCharId: string): boolean {
  const record = normalizeCharId(charId)
  if (!record) return true
  return record === normalizeCharId(activeCharId)
}
