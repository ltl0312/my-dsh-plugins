/**
 * QQ 入站正文的提取规则。
 *
 * 为什么单独测它：上层的 `#onInbound` 拿到空文本会**静默返回**，所以「用户说他回了、
 * 插件说没收到」这件事在日志里完全没有痕迹（qq-2 的 08:55 现场）。平台的 `content`
 * 在两类消息上是空的：图片 / 文件本来就没正文，以及部分客户端上的「引用回复」会把被
 * 引用的原文塞进 `msg_elements[].content`。只认 `content` 就会把这些消息丢掉。
 */
import { describe, expect, it } from 'vitest'

import { inboundText } from '../src/channels/qq.js'

describe('inboundText：从入站载荷里取出正文', () => {
  it('优先用 content', () => {
    expect(inboundText({ content: '已允许' })).toBe('已允许')
  })

  it('content 是空白时退回 msg_elements[].content', () => {
    expect(
      inboundText({
        content: '   ',
        msgElements: [{ msg_idx: '1', content: '被引用的原文' }],
      }),
    ).toBe('被引用的原文')
  })

  it('多个 element 用空格拼起来', () => {
    expect(
      inboundText({
        content: '',
        msgElements: [{ content: '方案甲' }, { content: '方案乙' }],
      }),
    ).toBe('方案甲 方案乙')
  })

  it('全是空的就返回空串（调用方要把它当成「没有正文」记一条 warn）', () => {
    expect(inboundText({ content: '', msgElements: [{ content: '  ' }, {}] })).toBe('')
    expect(inboundText({ content: '' })).toBe('')
  })

  it('content 有正文时忽略 msg_elements（引用回复的正文不该盖掉用户的话）', () => {
    expect(
      inboundText({ content: '选方案乙', msgElements: [{ content: '被引用的原文' }] }),
    ).toBe('选方案乙')
  })
})
