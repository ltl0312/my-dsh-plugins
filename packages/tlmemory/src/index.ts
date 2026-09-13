import { Context } from 'cordis'
import Schema from 'schemastery'

// 1. 扩展 Cordis 上下文类型，注册宿主环境服务定义
declare module 'cordis' {
  interface Context {
    logger?: {
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    }
    tools?: {
      register: (tool: {
        name: string
        description?: string
        parameters?: unknown
        execute: (args: any) => Promise<any> | any
      }) => () => void
    }
  }
}

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
