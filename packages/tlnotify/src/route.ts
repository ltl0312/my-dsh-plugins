// packages/tlnotify/src/route.ts
//
// 回复路由（设计方案 §4.4）。这是整个插件最容易出错的地方——用户在 IM 里回一句
// 「继续」，我们必须准确知道这句话该送进哪个会话。
//
// 三层机制，**顺序不可颠倒**：
//
//   ① 按钮        —— value 里自带 sessionId，零歧义，永远优先。
//   ② 长按引用回复 —— QQ 给 ref_msg_idx、飞书给 parent_id/root_id，反查会话。
//                     最弱的一环：QQ 的入站事件里根本没有 message_reference
//                     字段，只能靠 ref_msg_idx 或**引用正文**反查。
//   ③ 显式前缀    —— `519cc141 继续`，用户自己写短会话 id。
//
// 兜底：默认发给**最新一条通知**的会话；该会话已经不存在则退到「最近一次需要人
// 介入的会话」；都没有则明确回一句「没有可投递的会话」，**绝不猜**。
//
// 路由表带 TTL（默认 7 天）且落盘，重启不丢——用户完全可能晚上看到通知、第二天
// 早上才长按引用回复。

import { createHash } from 'node:crypto'
import { toPlainText } from './markdown.js'
import type { ActionValue, RouteEntry, RouteState } from './types.js'

/** 显式前缀：短会话 id（4-12 位十六进制）或完整 `session-<uuid>`，后跟正文。 */
const PREFIX_RE = /^(?:session-)?([0-9a-fA-F]{4,12})[\s:：,，]+([\s\S]+)$/

/** 内存里保留多少条最近发出的通知正文，供引用正文的模糊反查。 */
const RECENT_TEXT_LIMIT = 120

/**
 * 引用正文反查用的规范化。
 *
 * 两边对不上的原因有两个，都必须抹掉：
 *   1. 我们登记的是**自己拼出来的**文本，平台回传的是**它渲染出来的**文本——
 *      QQ 现在发的是 `msg_type: 2` 原生 Markdown（`**标题**\n\n正文`），飞书发的是
 *      `标题\n正文`，而登记的只有一份。
 *   2. 平台会把长引用截断，换行也可能被并掉。
 * 所以比较之前先各自压成纯文本、再把所有空白折成一个空格。
 */
function normalizeForMatch(text: string): string {
  return toPlainText(text).replace(/\s+/g, ' ').trim()
}

export interface RouteRecordInput {
  messageId: string
  sessionId: string
  /** 这条通知发送时的完整文本（标题+正文），用于引用正文反查。 */
  text?: string
  /** 平台侧的引用索引（QQ 的 `ext_info.ref_idx`）。 */
  refIdx?: string
  /** 话题根 id（飞书的 root_id）。 */
  threadId?: string
  /** 是否属于「需要人介入」的事件。 */
  intervention?: boolean
}

export interface ResolveInput {
  text: string
  /** 被引用消息的平台 id。 */
  quotedMessageId?: string
  /** 被引用消息的正文（QQ 没有 message_reference，只能靠这个）。 */
  quotedText?: string
  /** 话题根 id（飞书）。 */
  threadId?: string
}

export type RouteSource =
  | 'action'
  | 'quoted-id'
  | 'quoted-text'
  | 'prefix'
  | 'fallback-latest'
  | 'fallback-intervention'
  | 'none'

export interface RouteResolution {
  sessionId?: string
  source: RouteSource
  /** 剥离了前缀之后的正文（前缀命中时）。 */
  text: string
  /** 供回显用的目标描述，如 `DSH · 519cc141`。 */
  label?: string
  /** 前缀命中的短 id（回显用）。 */
  shortId?: string
}

export interface RouteTableOptions {
  ttlDays?: number
  /** 会话是否还活着——兜底前必须确认，否则消息会掉进黑洞。 */
  isLive?: (sessionId: string) => boolean
  /** 会话标签，用于回显「已发给 X」。 */
  labelOf?: (sessionId: string) => string
  now?: () => number
}

interface RecentText {
  sessionId: string
  text: string
  time: number
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** 短 id 命中判定：取会话 id 去掉 `session-` 前缀后的前 8 位做前缀匹配。 */
export function matchesShortId(sessionId: string, candidate: string): boolean {
  const trimmed = sessionId.replace(/^session-/, '')
  const lower = candidate.toLowerCase()
  return trimmed.toLowerCase().startsWith(lower) || sessionId.toLowerCase() === lower
}

export class RouteTable {
  #state: RouteState = {
    byMessage: {},
    byThread: {},
    byRefIdx: {},
    byContent: {},
  }
  #recent: RecentText[] = []
  readonly #ttlMs: number
  readonly #isLive: ((sessionId: string) => boolean) | undefined
  readonly #labelOf: ((sessionId: string) => string) | undefined
  readonly #now: () => number

  constructor(options: RouteTableOptions = {}) {
    this.#ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000
    this.#isLive = options.isLive
    this.#labelOf = options.labelOf
    this.#now = options.now ?? (() => Date.now())
  }

  static fromJSON(raw: unknown, options: RouteTableOptions = {}): RouteTable {
    const table = new RouteTable(options)
    if (typeof raw === 'object' && raw !== null) {
      const state = raw as Partial<RouteState>
      table.#state = {
        byMessage: { ...(state.byMessage ?? {}) },
        byThread: { ...(state.byThread ?? {}) },
        byRefIdx: { ...(state.byRefIdx ?? {}) },
        byContent: { ...(state.byContent ?? {}) },
        ...(state.latest ? { latest: state.latest } : {}),
        ...(state.lastIntervention ? { lastIntervention: state.lastIntervention } : {}),
      }
    }
    table.prune()
    return table
  }

  toJSON(): RouteState {
    return {
      byMessage: { ...this.#state.byMessage },
      byThread: { ...this.#state.byThread },
      byRefIdx: { ...this.#state.byRefIdx },
      byContent: { ...this.#state.byContent },
      ...(this.#state.latest ? { latest: this.#state.latest } : {}),
      ...(this.#state.lastIntervention ? { lastIntervention: this.#state.lastIntervention } : {}),
    }
  }

  /** 一条通知发出去之后立刻登记，供后续三层反查。 */
  record(input: RouteRecordInput): void {
    const time = this.#now()
    const entry: RouteEntry = { sessionId: input.sessionId, time }
    if (input.messageId) this.#state.byMessage[input.messageId] = entry
    if (input.refIdx) this.#state.byRefIdx[input.refIdx] = entry
    if (input.threadId) this.#state.byThread[input.threadId] = entry
    if (input.text) {
      // 登记与反查用同一套规范化（见 normalizeForMatch），否则两边永远对不上。
      const normalized = normalizeForMatch(input.text)
      if (normalized) {
        const hash = hashText(normalized)
        this.#state.byContent[hash] = entry
        this.#recent.push({ sessionId: input.sessionId, text: normalized, time })
        if (this.#recent.length > RECENT_TEXT_LIMIT) this.#recent.shift()
      }
    }
    this.#state.latest = entry
    if (input.intervention) this.#state.lastIntervention = entry
  }

  /** 按钮路径：value 里自带 sessionId，直接采信。 */
  fromAction(value: ActionValue): RouteResolution {
    const sessionId = value.sessionId
    return {
      sessionId,
      source: 'action',
      text: value.text ?? '',
      ...(this.#labelOf ? { label: this.#labelOf(sessionId) } : {}),
    }
  }

  /**
   * 三层解析 + 兜底。`allowPrefix` 为 false 时跳过第三层。
   */
  resolve(input: ResolveInput, options: { allowPrefix?: boolean; fallback?: 'latest' | 'intervention' | 'none' } = {}): RouteResolution {
    const now = this.#now()
    const rawText = input.text ?? ''

    // ── ② 长按引用回复 ────────────────────────────────────────────────────
    const quoted = this.#resolveQuoted(input, now)
    if (quoted) return { ...quoted, text: rawText }

    // ── ③ 显式前缀 ────────────────────────────────────────────────────────
    if (options.allowPrefix !== false) {
      const match = PREFIX_RE.exec(rawText.trim())
      if (match) {
        const [, candidate, rest] = match
        const target = this.#findByShortId(candidate!, now)
        if (target) {
          return {
            sessionId: target,
            source: 'prefix',
            text: rest!.trim(),
            shortId: candidate,
            ...(this.#labelOf ? { label: this.#labelOf(target) } : {}),
          }
        }
        // 前缀长得像会话 id 但查不到——不当作正文，免得把「1234abc 你好」
        // 整句发进某个无辜的会话。交给调用方决定怎么回。
        return { source: 'none', text: rawText, shortId: candidate }
      }
    }

    // ── 兜底 ──────────────────────────────────────────────────────────────
    const fallback = options.fallback ?? 'latest'
    if (fallback === 'none') return { source: 'none', text: rawText }

    // `latest` 与 `intervention` 的差别只在**谁先**：设计方案 §4.4 的默认兜底是
    // 「最新一条通知的会话，该会话不存在再退到最近一次需要人介入的会话」，
    // 而把 fallback 显式配成 `intervention` 就是反过来优先找人需要介入的那个。
    // 两条链都保留，只是顺序不同——所以任何一侧为空都能自动落到另一侧。
    const chain: [RouteEntry | undefined, RouteSource][] =
      fallback === 'intervention'
        ? [
            [this.#state.lastIntervention, 'fallback-intervention'],
            [this.#state.latest, 'fallback-latest'],
          ]
        : [
            [this.#state.latest, 'fallback-latest'],
            [this.#state.lastIntervention, 'fallback-intervention'],
          ]
    for (const [entry, source] of chain) {
      const target = this.#liveEntry(entry, now)
      if (!target) continue
      return {
        sessionId: target,
        source,
        text: rawText,
        ...(this.#labelOf ? { label: this.#labelOf(target) } : {}),
      }
    }
    return { source: 'none', text: rawText }
  }

  #resolveQuoted(input: ResolveInput, now: number): { sessionId: string; source: RouteSource; label?: string } | undefined {
    const { quotedMessageId, quotedText, threadId } = input
    if (quotedMessageId) {
      const direct = this.#liveEntry(this.#state.byMessage[quotedMessageId], now)
      if (direct) return this.#hit(direct, 'quoted-id')
      const byRef = this.#liveEntry(this.#state.byRefIdx[quotedMessageId], now)
      if (byRef) return this.#hit(byRef, 'quoted-id')
    }
    if (threadId) {
      const byThread = this.#liveEntry(this.#state.byThread[threadId], now)
      if (byThread) return this.#hit(byThread, 'quoted-id')
    }
    if (quotedText) {
      // 平台回传的引用正文可能是渲染后的纯文本，也可能是原始 Markdown（QQ 的
      // `msg_type: 2` 就是原文），所以两边都先规范化再比。
      const normalizedQuoted = normalizeForMatch(quotedText)
      const exact = this.#liveEntry(this.#state.byContent[hashText(normalizedQuoted)], now)
      if (exact) return this.#hit(exact, 'quoted-text')
      // 平台会把长引用截断，所以再做一次前缀匹配（从新到旧，优先最近发的）。
      const normalized = normalizedQuoted.slice(0, 80)
      if (normalized.length >= 8) {
        for (let i = this.#recent.length - 1; i >= 0; i -= 1) {
          const entry = this.#recent[i]!
          if (now - entry.time > this.#ttlMs) continue
          if (entry.text.startsWith(normalized) || normalized.startsWith(entry.text.slice(0, 80))) {
            if (this.#isLive && !this.#isLive(entry.sessionId)) continue
            return this.#hit(entry.sessionId, 'quoted-text')
          }
        }
      }
    }
    return undefined
  }

  #hit(sessionId: string, source: RouteSource): { sessionId: string; source: RouteSource; label?: string } {
    return {
      sessionId,
      source,
      ...(this.#labelOf ? { label: this.#labelOf(sessionId) } : {}),
    }
  }

  #findByShortId(candidate: string, _now: number): string | undefined {
    const seen = new Set<string>()
    for (const entry of Object.values(this.#state.byMessage)) {
      if (seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      if (!matchesShortId(entry.sessionId, candidate)) continue
      if (this.#isLive && !this.#isLive(entry.sessionId)) continue
      return entry.sessionId
    }
    return undefined
  }

  /** 取一条还在 TTL 内、且（如果知道存活情况的话）还活着的记录。 */
  #liveEntry(entry: RouteEntry | undefined, now: number): string | undefined {
    if (!entry) return undefined
    if (now - entry.time > this.#ttlMs) return undefined
    if (this.#isLive && !this.#isLive(entry.sessionId)) return undefined
    return entry.sessionId
  }

  /** 清掉过期条目；返回是否有改动。 */
  prune(now = this.#now()): boolean {
    const cutoff = now - this.#ttlMs
    let changed = false
    const pruneMap = (map: Record<string, RouteEntry>): void => {
      for (const [key, entry] of Object.entries(map)) {
        if (entry.time < cutoff) {
          delete map[key]
          changed = true
        }
      }
    }
    pruneMap(this.#state.byMessage)
    pruneMap(this.#state.byThread)
    pruneMap(this.#state.byRefIdx)
    pruneMap(this.#state.byContent)
    if (this.#state.latest && this.#state.latest.time < cutoff) {
      delete this.#state.latest
      changed = true
    }
    if (this.#state.lastIntervention && this.#state.lastIntervention.time < cutoff) {
      delete this.#state.lastIntervention
      changed = true
    }
    const before = this.#recent.length
    this.#recent = this.#recent.filter((entry) => entry.time >= cutoff)
    if (this.#recent.length !== before) changed = true
    return changed
  }

  /** 测试与 `/mode` 展示用。 */
  get knownSessions(): string[] {
    const set = new Set<string>()
    for (const entry of Object.values(this.#state.byMessage)) set.add(entry.sessionId)
    if (this.#state.latest) set.add(this.#state.latest.sessionId)
    if (this.#state.lastIntervention) set.add(this.#state.lastIntervention.sessionId)
    return [...set]
  }

  clear(): void {
    this.#state = { byMessage: {}, byThread: {}, byRefIdx: {}, byContent: {} }
    this.#recent = []
  }
}
