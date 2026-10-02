// packages/tlnotify/tests/roundtrip.spec.ts
//
// 客户端拼出来的通道补丁 → 宿主真正的校验函数，串起来跑一遍。
//
// 这一层原本是个盲区：`client-logic.spec.ts` 只验客户端拼出什么，`rpc.spec.ts` /
// `channel-settings.spec.ts` 只用手写的补丁喂宿主，smoke 里的 `rpc.call` 又是个
// 不会校验的假通道。于是「客户端发了一个宿主白名单里没有的键」这种错，两边都是绿的，
// 实机上却表现成「点了按钮什么都没发生」。

import { describe, expect, it } from 'vitest'
import { createDraft, toChannelPatches } from '../src/client/draft.js'
import type { ClientContextLike } from '../src/client/host.js'
import { createClientRpc } from '../src/client/rpc.js'
import { defaultConfig } from '../src/config.js'
import { applyPatch } from '../src/rpc.js'

function globals() {
  const config = defaultConfig()
  return { events: config.events, content: config.content }
}

/** 只提供 `connection.rpc.call` 的假客户端 ctx，把每次调用的通道/端点/payload 记下来。 */
function captureClient(): {
  calls: { channel: string; endpoint: string; payload: unknown }[]
  rpc: ReturnType<typeof createClientRpc>
} {
  const calls: { channel: string; endpoint: string; payload: unknown }[] = []
  const ctx = {
    get: (name: string) =>
      name === 'connection'
        ? {
            rpc: {
              call: async (channel: string, endpoint: string, payload: unknown) => {
                calls.push({ channel, endpoint, payload })
                return { ok: true, value: {} }
              },
            },
          }
        : undefined,
  } as unknown as ClientContextLike
  return { calls, rpc: createClientRpc(ctx) }
}

describe('客户端补丁 → 宿主 applyPatch', () => {
  it('扫码接入：全新 QQ 通道的整表补丁必须被宿主接受', () => {
    const draft = createDraft('qq', [], globals())
    const patch = toChannelPatches([draft])
    const result = applyPatch(defaultConfig(), { channels: patch })
    if (!result.ok) {
      throw new Error(
        `宿主拒绝了客户端拼出来的补丁：${JSON.stringify(result.error)}\n` +
          `客户端发的键：${Object.keys(patch[0]).join(', ')}`,
      )
    }
    expect(result.ok).toBe(true)
    expect(result.value.next.channels).toHaveLength(1)
    expect(result.value.next.channels[0].id).toBe(draft.id)
    expect(result.value.channelsChanged).toBe(true)
  })

  it('手动添加：全新飞书通道的整表补丁也要被接受', () => {
    const draft = createDraft('feishu', [], globals())
    const patch = toChannelPatches([draft])
    const result = applyPatch(defaultConfig(), { channels: patch })
    if (!result.ok) {
      throw new Error(`宿主拒绝了飞书通道补丁：${JSON.stringify(result.error)}`)
    }
    expect(result.value.next.channels[0].type).toBe('feishu')
  })

  it('两个通道一起提交（整表替换）', () => {
    const first = createDraft('qq', [], globals())
    const second = createDraft('qq', [first.id], globals())
    const result = applyPatch(defaultConfig(), { channels: toChannelPatches([first, second]) })
    if (!result.ok) throw new Error(`宿主拒绝了双通道补丁：${JSON.stringify(result.error)}`)
    expect(result.value.next.channels.map((channel) => channel.id)).toEqual([first.id, second.id])
  })

  // 上面几条测的是「客户端拼出来的补丁对象」，还差一层：这条 RPC 的信封长什么样。
  // 实机踩到的正是这一层——客户端发 `{ patch: … }`，宿主却把整个 payload 当补丁，
  // 于是 `patch` 成了未知顶层键，设置页每一次写入都被白名单拒掉（页面上弹
  // 「patch 期望 以下之一：…」），而「扫码接入机器人」的第一步就是一次写入。
  it('patch 的信封 `{ patch }` 解包后必须被宿主收下', async () => {
    const { calls, rpc } = captureClient()
    const draft = createDraft('qq', [], globals())

    // 形状照抄设置页的调用点（`SettingsPage.tsx` 的 `patch()`）：`{ patch: next }`。
    // 包装是调用点加的，`createClientRpc` 只负责把 payload 原样送出去 —— 正因如此，
    // 「两边各自都有测试、合起来没人测」才会漏掉宿主那一侧的解包。
    const result = await rpc.call('patch', { patch: { channels: toChannelPatches([draft]) } })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].channel).toBe('/api')
    expect(calls[0].endpoint).toBe('tlnotify/patch')

    const payload = calls[0].payload as { patch?: unknown }
    expect(Object.keys(payload)).toEqual(['patch'])

    const applied = applyPatch(defaultConfig(), payload.patch)
    if (!applied.ok) {
      throw new Error(
        `宿主解包 payload.patch 之后仍然拒绝：${JSON.stringify(applied.error)}`,
      )
    }
    expect(applied.value.channelsChanged).toBe(true)
  })
})
