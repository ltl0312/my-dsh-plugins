// packages/tlmemory/src/index.ts
// 插件入口与装配中心：集中导出阶段一交付的原子化反思提取引擎与主动记忆工具箱。
// Cordis 上下文声明合并统一收敛于 types.ts，此处严禁重复声明以免属性签名冲突。
import { Context } from 'cordis'
import Schema from 'schemastery'

export { MemoryExtractor } from './extractor.js'
export { registerMemoryTools } from './tools.js'

export type {
  MemoryNode,
  MemoryScope,
  MemoryCategory,
  SearchOptions,
  SearchResult,
  RawReflectionItem,
  ReflectionResponse,
  SaveMemoryArgs,
  QueryMemoryArgs,
} from './types.js'

export const name = 'tlmemory'
export const inject = ['tools']

export interface Config {
  dbPath?: string
}

export const Config: Schema<Config> = Schema.object({
  dbPath: Schema.string().default('./data/tlmemory.db').description('记忆数据库存储路径'),
})

export function apply(ctx: Context, config: Config) {
  ctx.logger?.info?.(`[${name}] 插件已就绪，数据库路径: ${config.dbPath}`)

  ctx.tools?.register({
    name: 'tlmemory_ping',
    description: '测试 TL 记忆插件连通性',
    parameters: Schema.object({}),
    async execute() {
      return { status: 'ok', timestamp: Date.now() }
    },
  })
}
