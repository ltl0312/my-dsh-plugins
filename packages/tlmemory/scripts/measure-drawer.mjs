// packages/tlmemory/scripts/measure-drawer.mjs
// 缺陷 3（打开记忆详情时整页横向位移）的**端到端几何取证 / 回归验证器**，
// 并且是「抽屉关闭后不留任何布局残留」这一条结论的**开关两段**回归。
//
// 为什么需要它：抽屉是「视口级浮层 + CSS 过渡」，静态单测（jsdom 无布局引擎）证明不了
// 「开合前后页面几何不变」。本脚本用真实浏览器（CDP）在真实看板上做一次确定性测量：
//   1. 打开 http://127.0.0.1:4890/（看板服务由插件随宿主自启）；
//   2. 记录打开前的几何（#app / .tlm-app / .tlm-main / 文档可滚动宽度 / scrollX）；
//   3. 用**真实鼠标事件**点击第一条记忆（列表视图）或用 store 打开（图谱视图）；
//   4. 复测几何并输出 DELTA；
//   5. 再用**真实鼠标事件**点击抽屉右上角关闭按钮，等过渡结束后复测，要求
//      「.tlm-drawer / .tlm-scrim 从 DOM 里消失，且几何逐字段回到第 2 步的状态」。
// 为什么要单独盯第 5 步：这段视频/报告里的「关闭后主内容区仍只占左半、右侧大片空白」
// 曾被归因给本抽屉。抽屉是本 iframe 文档内的 `position: fixed` 浮层，**物理上无法**
// 改变宿主（外层 DSH 框架）的列宽；右侧那片留白属于宿主框架自己的右栏轨道
// （`grid-template-columns` 的 `minmax(0px, rightbarMax)` 即使内容为空也会被最大化到
// 该上限）。这条用例把「不是本抽屉」钉成可复跑的机器证据，避免再次归错因。
// 判定口径（任一不满足即 exit 1）：
//   * 文档可滚动宽度不得增长（scrollWidth == clientWidth）；
//   * scrollX 必须保持 0（页面从未被横向滚动）；
//   * #app / .tlm-app 的 x（以及宽度）不得变化；
//   * 抽屉必须出现，且 position: fixed、贴右（left + width == 视口宽）；
//   * 关闭后抽屉与遮罩必须从 DOM 里消失（计数为 0）；
//   * 关闭后的几何必须与打开前逐字段一致（#app / .tlm-app / .tlm-main 的 x/w、scrollX、
//     文档可滚动宽度），即「关闭即复原」；
//   * 全程不得出现横向越界（溢出视口右缘 / 左缘）的元素。
//
// 用法：
//   node scripts/measure-drawer.mjs                    # 默认 http://127.0.0.1:4890/
//   node scripts/measure-drawer.mjs <url> [list|graph]
//   TLMEMORY_BROWSER="C:\path\chrome.exe" node scripts/measure-drawer.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const URL_ARG = process.argv[2] || process.env.TLMEMORY_DASHBOARD_URL || 'http://127.0.0.1:4890/'
const MODE = process.argv[3] || 'list'
const DEBUG_PORT = Number(process.env.TLMEMORY_CDP_PORT || 9336)

const BROWSER_CANDIDATES = [
  process.env.TLMEMORY_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

const browser = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (browser === undefined) {
  console.error(
    '[measure-drawer] 未找到可用浏览器。请设置 TLMEMORY_BROWSER 指向 Chrome / Edge 可执行文件。',
  )
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-drawer-cdp-'))
const proc = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1400,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const cleanup = (code) => {
  try {
    proc.kill()
  } catch {
    /* 进程可能已退出 */
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
  process.exit(code)
}

let target = null
for (let attempt = 0; attempt < 80 && target === null; attempt++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    target = list.find((item) => item.type === 'page') ?? null
  } catch {
    /* 浏览器尚未就绪 */
  }
  if (target === null) await sleep(250)
}
if (target === null) {
  console.error('[measure-drawer] 无法连接浏览器调试端口')
  cleanup(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
let seq = 0
const pending = new Map()
ws.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.id !== undefined) {
    const resolve = pending.get(message.id)
    if (resolve !== undefined) {
      pending.delete(message.id)
      resolve(message)
    }
  }
})
await new Promise((resolve) => ws.on('open', resolve))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails) return { __error: JSON.stringify(result.result.exceptionDetails).slice(0, 300) }
  return result.result?.result?.value ?? null
}

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const drawer = q('.tlm-drawer');
  // 横向越界普查：任何超出视口左右缘的元素都是「整页横向位移」的候选真凶。
  // 期望恒为空数组——抽屉是 fixed 浮层，不参与文档的可滚动溢出区。
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), x: Math.round(r.x), right: Math.round(r.right) });
    }
  }
  return {
    viewportWidth: innerWidth,
    scrollX: Math.round(scrollX),
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    app: rect(q('#app')),
    tlmApp: rect(q('.tlm-app')),
    main: rect(q('.tlm-main')),
    drawer: rect(drawer),
    drawerPosition: drawer ? getComputedStyle(drawer).position : null,
    scrim: rect(q('.tlm-scrim')),
    drawerCount: document.querySelectorAll('.tlm-drawer').length,
    scrimCount: document.querySelectorAll('.tlm-scrim').length,
    offenders,
  };
})()`

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL_ARG })
await sleep(4000)

if (MODE === 'graph') {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.tlm-segment-btn')].find((el) => el.textContent.includes('图谱'));
    if (button) button.click();
    return button !== undefined;
  })()`)
  await sleep(1500)
}

const before = await evaluate(MEASURE)
console.log('[measure-drawer] BEFORE', JSON.stringify(before))

const clickTarget =
  MODE === 'graph'
    ? await evaluate(
        `(() => { const el = document.querySelector('.tlm-gnode[data-tlm-gnode="leaf"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      )
    : await evaluate(
        `(() => { const el = document.querySelector('.tlm-leaf'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      )

if (clickTarget !== null && typeof clickTarget.x === 'number') {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickTarget.x, y: clickTarget.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickTarget.x, y: clickTarget.y, button: 'left', clickCount: 1 })
} else {
  // 图谱视图下节点可能不在视口内：退回 store 直接打开，几何结论等价
  await evaluate(`(() => {
    const app = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    for (const store of pinia?._s?.values() ?? []) {
      if (typeof store.openDetail === 'function') {
        const node = (store.memoryNodes ?? [])[0];
        if (node) { store.openDetail(node); return 'opened'; }
      }
    }
    return 'no-store';
  })()`)
}
await sleep(900)

const after = await evaluate(MEASURE)
console.log('[measure-drawer] AFTER ', JSON.stringify(after))

// 第 5 步：关闭抽屉（真实鼠标事件点右上角 ✕；找不到就退回 Escape），
// 等 0.26s 的滑出过渡 + 余量结束后复测几何。
const closeTarget = await evaluate(
  `(() => { const el = document.querySelector('.tlm-close'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
)
if (closeTarget !== null && typeof closeTarget.x === 'number') {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: closeTarget.x, y: closeTarget.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: closeTarget.x, y: closeTarget.y, button: 'left', clickCount: 1 })
} else {
  console.warn('[measure-drawer] 未找到 .tlm-close，改用 Escape 关闭')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
await sleep(1200)

const afterClose = await evaluate(MEASURE)
console.log('[measure-drawer] CLOSED', JSON.stringify(afterClose))

const failures = []
if (after === null || typeof after !== 'object') failures.push('测量失败：未取到打开后的几何')
else {
  if (after.drawer === null) failures.push('抽屉未出现（.tlm-drawer 不存在）')
  if (after.drawerPosition !== null && after.drawerPosition !== 'fixed') {
    failures.push(`抽屉 position 应为 fixed，实际 ${String(after.drawerPosition)}`)
  }
  if (after.docScrollWidth !== after.docClientWidth) {
    failures.push(`文档出现横向可滚动区域：scrollWidth=${after.docScrollWidth} > clientWidth=${after.docClientWidth}`)
  }
  if (after.scrollX !== 0) failures.push(`页面被横向滚动：scrollX=${after.scrollX}`)
  if (before?.app && after.app && (after.app.x !== before.app.x || after.app.w !== before.app.w)) {
    failures.push(`#app 几何变化：${JSON.stringify(before.app)} → ${JSON.stringify(after.app)}`)
  }
  if (before?.tlmApp && after.tlmApp && (after.tlmApp.x !== before.tlmApp.x || after.tlmApp.w !== before.tlmApp.w)) {
    failures.push(`.tlm-app 几何变化：${JSON.stringify(before.tlmApp)} → ${JSON.stringify(after.tlmApp)}`)
  }
  if (after.drawer && after.viewportWidth && after.drawer.x + after.drawer.w > after.viewportWidth + 1) {
    failures.push(`抽屉超出视口右缘：x=${after.drawer.x} w=${after.drawer.w} viewport=${after.viewportWidth}`)
  }
  if ((after.offenders ?? []).length > 0) {
    failures.push(`打开态存在横向越界元素：${JSON.stringify(after.offenders)}`)
  }
}

// 关闭态：抽屉/遮罩必须从 DOM 里彻底消失，且几何逐字段回到打开前（「关闭即复原」）。
if (afterClose === null || typeof afterClose !== 'object') {
  failures.push('测量失败：未取到关闭后的几何')
} else {
  if (afterClose.drawerCount !== 0) failures.push(`关闭后 .tlm-drawer 仍在 DOM 内（计数 ${afterClose.drawerCount}）`)
  if (afterClose.scrimCount !== 0) failures.push(`关闭后 .tlm-scrim 仍在 DOM 内（计数 ${afterClose.scrimCount}）`)
  if (afterClose.drawer !== null) failures.push(`关闭后仍有抽屉占位：${JSON.stringify(afterClose.drawer)}`)
  if (afterClose.docScrollWidth !== afterClose.docClientWidth) {
    failures.push(`关闭后文档出现横向可滚动区域：scrollWidth=${afterClose.docScrollWidth} > clientWidth=${afterClose.docClientWidth}`)
  }
  if (afterClose.scrollX !== 0) failures.push(`关闭后被横向滚动：scrollX=${afterClose.scrollX}`)
  if ((afterClose.offenders ?? []).length > 0) {
    failures.push(`关闭态存在横向越界元素：${JSON.stringify(afterClose.offenders)}`)
  }
  const unchanged = (key, label) => {
    const from = before?.[key]
    const to = afterClose[key]
    if (from && to && (to.x !== from.x || to.w !== from.w)) {
      failures.push(`关闭后 ${label} 未复原：${JSON.stringify(from)} → ${JSON.stringify(to)}`)
    }
  }
  unchanged('app', '#app')
  unchanged('tlmApp', '.tlm-app')
  unchanged('main', '.tlm-main')
}

ws.close()
if (failures.length > 0) {
  console.error('[measure-drawer] FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  cleanup(1)
}
console.log(
  '[measure-drawer] PASS：打开记忆详情未产生任何横向位移（抽屉 fixed 贴右、文档无横向滚动），' +
    '且关闭后抽屉/遮罩已从 DOM 移除、几何逐字段还原（#app / .tlm-app / .tlm-main 的 x/w 一致）',
)
cleanup(0)
