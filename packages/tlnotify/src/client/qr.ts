// packages/tlnotify/src/client/qr.ts
//
// 二维码**编码**（只编码，不画）。
//
// 为什么用 `qrcode` 而不是自己写编码器：QR 的版本选择、纠错码生成、掩码评分是
// 一大坨容易「看起来对、扫不出来」的细节，而一个扫不出来的码比没有码更浪费时间。
// 宿主与工作区都没有现成的 QR 工具，所以这里把 `qrcode`（MIT）作为**构建期**依赖
// 由 esbuild 打进客户端 bundle —— 运行时不 require 它，宿主不需要装。
//
// 只借它拿到 0/1 点阵，画的部分由 `components/QrCode.tsx` 自己出 SVG：这样既避开
// 把库生成的 SVG 字符串塞进 innerHTML，也能让码跟随主题色。

import QRCode from 'qrcode'

export interface QrMatrix {
  /** 边长（模块数），不含静区。 */
  readonly size: number
  /** 行优先的 0/1 点阵，长度 = size * size。 */
  readonly bits: Uint8Array
}

/**
 * 把一段文本编码成点阵。
 *
 * 纠错等级固定 M：约 15% 冗余，在「手机屏对着显示器扫」这种场景下够用，又不会把
 * 版本推高到点太密。绑定链接只有几十个字符，实际版本很低、点很粗，很好扫。
 *
 * @throws 文本过长（超出 QR 容量）时抛出——由调用方转成一句人话。
 */
export function buildQrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = qr.modules.size
  const source = qr.modules.data
  const bits = new Uint8Array(size * size)
  for (let index = 0; index < bits.length; index += 1) {
    bits[index] = source[index] ? 1 : 0
  }
  return { size, bits }
}

/** 点阵是否在 (x, y) 处为暗色。越界一律算亮色，省得调用方自己边界检查。 */
export function isDark(matrix: QrMatrix, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return false
  return matrix.bits[y * matrix.size + x] === 1
}

/**
 * 把点阵折成 SVG path 的 `d`，每段一个 1×1 的方块。
 *
 * 用一条 path 而不是几百个 `<rect>`：同一个二维码在浏览器里就是几百个 DOM 节点，
 * 而 path 只有一个，重渲染与缩放都便宜得多。
 */
export function matrixToPath(matrix: QrMatrix): string {
  const parts: string[] = []
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (isDark(matrix, x, y)) parts.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  return parts.join('')
}
