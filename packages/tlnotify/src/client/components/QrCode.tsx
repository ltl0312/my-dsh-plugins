// packages/tlnotify/src/client/components/QrCode.tsx
//
// 二维码的**绘制**：只借 `qr.ts` 编出来的 0/1 点阵，自己出 SVG。
//
// 不走 `innerHTML` 注入库生成的 SVG 字符串：那是一条不必要的富文本注入通道，
// 而这里需要的只是几百个方块。一条 path 画完，重渲染与缩放都便宜。

import React from 'react'
import { buildQrMatrix, matrixToPath } from '../qr.js'
import { Note } from './ui.js'

export interface QrCodeProps {
  text: string
  /** 边的像素长度；实际是按 viewBox 缩放，与清晰度无关。 */
  size?: number
}

/** QR 规范要求的静区宽度（模块数）。没有静区很多扫码器会认不出来。 */
const QUIET_ZONE = 4

export function QrCode(props: QrCodeProps): React.ReactElement {
  const size = props.size ?? 208

  const built = React.useMemo(() => {
    try {
      const matrix = buildQrMatrix(props.text)
      return { matrix, path: matrixToPath(matrix) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [props.text])

  if ('error' in built) {
    return <Note tone="error">二维码生成失败：{built.error}</Note>
  }

  const view = built.matrix.size + QUIET_ZONE * 2

  return (
    <div className="tln-qr-canvas">
      <svg
        viewBox={`0 0 ${view} ${view}`}
        width={size}
        height={size}
        role="img"
        aria-label="QR"
        shapeRendering="crispEdges"
      >
        <rect x={0} y={0} width={view} height={view} fill="#ffffff" />
        <path transform={`translate(${QUIET_ZONE} ${QUIET_ZONE})`} d={built.path} fill="#000000" />
      </svg>
    </div>
  )
}
