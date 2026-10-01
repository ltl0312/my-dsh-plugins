// packages/tlnotify/src/log.ts
//
// 极简文件日志：$DSH_HOME/tlnotify/plugin.log。
//
// 为什么不用宿主 logger 就够：IM 通道是长连接，掉线/重连/限流都发生在
// **用户不在终端前**的时候，宿主 logger 的输出会随进程生命周期消失。落一份
// 文件日志是唯一能在事后回答「昨晚为什么没收到通知」的手段。
//
// 设计取舍：
//   - 单文件 + 按大小轮转（默认 1 MiB，保留 1 份 .1 备份），不引入日志库；
//   - 写失败**绝不抛出**——日志写不进去不能连累通知主流程；
//   - 同时镜像到宿主 logger（如果传了），这样终端里也能看见。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChannelLogger } from './types.js'

const MAX_BYTES = 1024 * 1024
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const

export type LogLevel = keyof typeof LEVEL_ORDER

export interface HostLogger {
  info?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
  error?: (message: string, error?: unknown) => void
  debug?: (message: string) => void
}

export class FileLogger implements ChannelLogger {
  #path: string
  #level: number
  #levelName: LogLevel
  #host?: HostLogger
  #broken = false
  #prefix: string

  constructor(path: string, level: LogLevel = 'info', host?: HostLogger, prefix = '') {
    this.#path = path
    this.#levelName = LEVEL_ORDER[level] === undefined ? 'info' : level
    this.#level = LEVEL_ORDER[this.#levelName]
    this.#host = host
    this.#prefix = prefix
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {
      this.#broken = true
    }
  }

  get path(): string {
    return this.#path
  }

  /**
   * 带前缀的子 logger，用于区分「哪条通道说了什么」。
   *
   * 刻意让子 logger 共享同一个文件句柄语义（每次 append 自己打开），代价是
   * 轮转判定会各自做一次——轮转本身是幂等的，重复判定无害。
   */
  child(prefix: string): ChannelLogger {
    const joined = this.#prefix ? `${this.#prefix}${prefix}` : prefix
    return new FileLogger(this.#path, this.#levelName, this.#host, joined.length > 0 ? `${joined} ` : '')
  }

  setLevel(level: LogLevel): void {
    this.#levelName = LEVEL_ORDER[level] === undefined ? 'info' : level
    this.#level = LEVEL_ORDER[this.#levelName]
  }

  debug(message: string): void {
    if (this.#level > LEVEL_ORDER.debug) return
    this.#write('DEBUG', message)
  }

  info(message: string): void {
    if (this.#level > LEVEL_ORDER.info) return
    this.#write('INFO ', message)
    this.#host?.info?.(message)
  }

  warn(message: string, error?: unknown): void {
    if (this.#level > LEVEL_ORDER.warn) return
    this.#write('WARN ', withError(message, error))
    this.#host?.warn?.(message, error)
  }

  error(message: string, error?: unknown): void {
    this.#write('ERROR', withError(message, error))
    this.#host?.error?.(message, error)
  }

  #write(level: string, message: string): void {
    if (this.#broken) return
    try {
      this.#rotate()
      appendFileSync(this.#path, `${new Date().toISOString()} ${level} ${this.#prefix}${message}\n`, 'utf8')
    } catch {
      // 日志写失败是**非致命**的：一次只标记一次，之后静默放弃文件写入。
      this.#broken = true
    }
  }

  #rotate(): void {
    if (!existsSync(this.#path)) return
    const size = statSync(this.#path).size
    if (size < MAX_BYTES) return
    const backup = `${this.#path}.1`
    try {
      if (existsSync(backup)) renameSync(backup, `${backup}.tmp`)
      renameSync(this.#path, backup)
      // 备份成功后再删掉临时文件；失败也无所谓，下次轮转覆盖它。
      if (existsSync(`${backup}.tmp`)) {
        try {
          renameSync(`${backup}.tmp`, `${this.#path}.discard`)
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      // 轮转失败时直接把当前文件清空，保证不无限增长。
      try {
        appendFileSync(this.#path, '', 'utf8')
      } catch {
        /* 忽略 */
      }
    }
  }
}

function withError(message: string, error: unknown): string {
  if (error === undefined) return message
  if (error instanceof Error) return `${message}: ${error.message}`
  if (typeof error === 'string') return `${message}: ${error}`
  try {
    return `${message}: ${JSON.stringify(error)}`
  } catch {
    return `${message}: [unserializable]`
  }
}

/** 给单元测试用的空实现。 */
export const NULL_LOGGER: ChannelLogger = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
})

export function joinLog(dataDir: string): string {
  return join(dataDir, 'plugin.log')
}
