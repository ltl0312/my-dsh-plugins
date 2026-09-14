// packages/tlmemory/src/turn-tracker.ts
// 会话轮次生命周期跟踪器（无感静默沉淀的输入侧）。
// 职责：把 DSH `session/event` firehose 中分散的 turn/start、user/message、
// assistant/message、turn/end 事件折叠为「单轮人类输入 + 单轮助手可见文本」素材。
// 安全基线：
// 1. 仅采集 source.kind === 'user' 的真实人类输入，插件注入上下文与工具结果不进入素材；
// 2. 缓冲严格封顶（默认 8000 字符），杜绝长会话无界内存膨胀；
// 3. 仅 reason.kind === 'completed' 的轮次允许结算产出，异常/中断轮次一律丢弃；
// 4. 纯同步零 I/O、零网络，任何畸形输入均以防御式分支静默收敛，绝不抛错。
import type { TurnTrackItem } from './types.js'

/** 单轮缓冲字符封顶：超过部分截断丢弃，防止恶意长文本打爆内存 */
export const MAX_TURN_BUFFER_CHARS = 8000

/** 结算产出最低门槛：人类输入与助手文本均需具备可提炼量 */
export const MIN_USER_TEXT_CHARS = 10
export const MIN_ASSISTANT_TEXT_CHARS = 5

/**
 * 从 DSH ContentBlock[] 中提取全部可见文本块（仅 type === 'text'，
 * 跳过 reasoning / image / tool-call / tool-result）。
 */
export function extractTextFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 追加进有界缓冲：超限从尾部截断（保留头部语义，尾部多为渲染噪声） */
function appendBounded(buffer: string, chunk: string, max: number): string {
  const next = buffer ? `${buffer}\n${chunk}` : chunk
  if (next.length <= max) return next
  return next.slice(0, max)
}

export class TurnTracker {
  private currentTurn: number | null = null
  private userTexts = ''
  private assistantTexts = ''
  private readonly maxBufferChars: number

  constructor(maxBufferChars: number = MAX_TURN_BUFFER_CHARS) {
    this.maxBufferChars = maxBufferChars
  }

  /** 轮次开启：记录当前 turn；若上一个轮次未正常结算，防御式清空残留缓冲 */
  onTurnStart(turn: number): void {
    if (this.currentTurn !== null && this.currentTurn !== turn) {
      this.userTexts = ''
      this.assistantTexts = ''
    }
    this.currentTurn = turn
  }

  /**
   * 人类输入进入本轮缓冲。sourceKind 必须为 'user'，其余来源一律忽略
   * （保证注入上下文/系统通知不会被误当作待沉淀的用户意图）。
   */
  addUserMessage(content: unknown, sourceKind: unknown): void {
    if (sourceKind !== 'user') return
    const text = extractTextFromBlocks(content).trim()
    if (!text) return
    this.userTexts = appendBounded(this.userTexts, text, this.maxBufferChars)
  }

  /** 助手可见文本进入本轮缓冲（assistant/message 事件驱动） */
  addAssistantMessage(content: unknown): void {
    const text = extractTextFromBlocks(content).trim()
    if (!text) return
    this.assistantTexts = appendBounded(this.assistantTexts, text, this.maxBufferChars)
  }

  /**
   * 轮次结算：仅 reason.kind === 'completed' 且素材达到最低门槛时产出
   * TurnTrackItem；其余结局（aborted/error/blocked/max-tokens/interrupted）
   * 一律清空缓冲返回 null —— 中断轮次不具备沉淀价值，严禁半成品入记忆库。
   * 无论产出与否，调用后缓冲必然清空，保证下一轮从零开始。
   */
  endTurn(turn: number, reasonKind: string): TurnTrackItem | null {
    const userText = this.userTexts.trim()
    const assistantText = this.assistantTexts.trim()

    this.currentTurn = null
    this.userTexts = ''
    this.assistantTexts = ''

    if (reasonKind !== 'completed') return null
    if (userText.length < MIN_USER_TEXT_CHARS || assistantText.length < MIN_ASSISTANT_TEXT_CHARS) {
      return null
    }
    return { turn, userText, assistantText }
  }

  /** 插件卸载 / 会话翻篇时的兜底清理 */
  reset(): void {
    this.currentTurn = null
    this.userTexts = ''
    this.assistantTexts = ''
  }
}
