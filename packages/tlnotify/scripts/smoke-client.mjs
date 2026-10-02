// scripts/smoke-client.mjs
//
// 客户端 bundle 的冒烟测试：**真的把它当成宿主来加载一次**。
//
// 只跑 tsc 是不够的：`tsc` 看不出 `window.__ModuleLoader__.load` 的 `id` 写错了、
// `factory` 忘了 return、或者 `external: ['react']` 被误删导致 React 被打了两份
// （后者要到运行时才炸在「invalid hook call」上，而且报错完全指不到这里）。
//
// 做法：jsdom 里造一个 `window.__ModuleLoader__`，eval 产物拿到注册项，然后
//   ① 校验注册协议与插槽选项；
//   ② 用一个假 ctx（假 RPC）真渲染一遍设置页，断言关键文案与真实数据出现；
//   ③ 点两下（重新读取 / 启用通知），断言真的发出了 rpc 调用。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const pkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
const BUNDLE = join(pkgRoot, 'web', 'client.js')

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

// ── 1. 造一个最小宿主环境 ────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html lang="zh"><head></head><body></body></html>', {
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom

function installGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
installGlobal('window', window)
installGlobal('document', window.document)
installGlobal('navigator', window.navigator)
installGlobal('MutationObserver', window.MutationObserver)
installGlobal('HTMLElement', window.HTMLElement)
installGlobal('Node', window.Node)
installGlobal('Event', window.Event)
installGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const require = createRequire(import.meta.url)
const React = require('react')
const ReactDOMClient = require('react-dom/client')
// React 18.3 起 `act` 直接挂在 React 上；`react-dom/test-utils` 那份已经标记废弃。
let act = typeof React.act === 'function' ? React.act : null
if (!act) {
  try {
    ;({ act } = require('react-dom/test-utils'))
  } catch {
    act = null
  }
}
const flush = async (ms = 80) => {
  await new Promise((done) => setTimeout(done, ms))
}

// ── 2. 按宿主协议加载产物 ────────────────────────────────────────────────────
let captured = null
window.__ModuleLoader__ = {
  load(entry) {
    if (captured) throw new Error('客户端模块被注册了两次')
    captured = entry
  },
}

const code = readFileSync(BUNDLE, 'utf8')
window.eval(code)

let mod = null
check('产物遵守 __ModuleLoader__.load 协议', () => {
  assert.ok(captured, 'web/client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, pkgJson.name, 'id 必须等于包名，否则宿主的依赖图对不上号')
  assert.equal(typeof captured.factory, 'function')
})

check('factory 在只有 react 可 require 的环境下能解析', () => {
  const required = []
  mod = captured.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`产物 require 了未预期的运行时模块: ${name}`)
  })
  assert.ok(mod, 'factory 必须返回 exports（漏了 return 就会是 undefined）')
  assert.equal(typeof mod.apply, 'function', 'exports.apply 必须是函数')
  assert.ok(Array.isArray(mod.inject), 'exports.inject 必须是数组')
  // esbuild 的 IIFE 包装让每个 import 语句各 require 一次，所以 react 会重复出现；
  // 唯一要守住的是「除了 react 没有别的裸说明符」。
  assert.deepEqual([...new Set(required)], ['react'], `产物只能 require react，实际 require 了 ${required.join(', ')}`)
})

check('只注入 slots：connection 是软依赖，改为 ctx.get 现取', () => {
  // 注意：inject 数组来自 jsdom realm，它的原型是 window.Array.prototype，
  // 直接 deepEqual 会因为原型不同而报「same structure but not reference-equal」。
  assert.deepEqual(Array.from(mod.inject), ['slots'])
})

// ── 3. 假装是宿主，调一次 apply ──────────────────────────────────────────────
const rpcCalls = []
function stateValue() {
  return {
    config: {
      enabled: true,
      mode: 'global',
      defaultChannelId: 'qq-main',
      logLevel: 'info',
      dataDir: 'C:/tmp/tlnotify',
      channels: [
        {
          id: 'qq-main',
          type: 'qq',
          enabled: true,
          label: '主机器人',
          sessionScope: 'filter',
          sessionId: '',
          sessionFilter: ['abcdef12-0000-0000-0000-000000000000'],
          historyTurns: 0,
          appId: '102000000',
          targetChatId: 'OPENID_XYZ',
          mode: 'active',
          bindUrl: '',
          feishuAppId: '',
          feishuReceiveId: '',
          feishuReceiveIdType: 'open_id',
          overrideEvents: true,
          events: {
            onTurnEnd: true,
            onError: true,
            onAborted: true,
            onPending: true,
            onMaxTokens: true,
            includeSubagent: false,
          },
          overrideContent: true,
          content: { includeMetadata: true, includeUserPrompt: false, maxBodyChars: 2000 },
          appSecret: { configured: true, hint: '••••abcd' },
          feishuAppSecret: { configured: false, hint: '' },
        },
      ],
      events: {
        onTurnEnd: true,
        onError: true,
        onAborted: true,
        onPending: true,
        onMaxTokens: true,
        includeSubagent: false,
      },
      content: { includeMetadata: true, includeUserPrompt: false, maxBodyChars: 2000 },
      routing: { allowPrefix: true, fallback: 'latest', tableTtlDays: 7, echoTarget: true },
      session: {
        targetSessionId: '519cc141-0000-0000-0000-000000000000',
        context: {
          includeAssistant: true,
          includeTools: true,
          includeTiming: true,
          previousTurns: 2,
          includeUserPrompt: true,
        },
      },
      global: {
        verbosity: 'brief',
        includeSessionLabel: true,
        includeSummaryLine: true,
        includeSubagent: false,
      },
    },
    status: {
      running: true,
      enabled: true,
      mode: 'global',
      detailSessions: [],
      pushed: 3,
      startedAt: Date.now() - 60_000,
      dataDir: 'C:/tmp/tlnotify',
      configPath: 'C:/tmp/tlnotify/config.json',
      statePath: 'C:/tmp/tlnotify/state.json',
      channels: [{ id: 'qq-main', type: 'qq', enabled: true, connected: true, sent: 3, failed: 0 }],
    },
  }
}

const fakeRpc = {
  async call(channel, endpoint, payload) {
    // 宿主侧的路由是 `connection.fetch.register` 挂的 `POST /api/tlnotify/<method>`，
    // 浏览器侧就是 `rpc.call('/api', 'tlnotify/<method>', payload)`。
    const method = String(endpoint).replace(/^tlnotify\//, '')
    rpcCalls.push({ channel, endpoint, method, payload })
    if (method === 'state') return { ok: true, value: stateValue() }
    if (method === 'sessions.list') {
      return {
        ok: true,
        value: {
          sessions: [
            {
              id: 'abcdef12-0000-0000-0000-000000000000',
              title: '修设置页',
              project: 'my-dsh-plugins',
              cwd: 'D:/Code/my-dsh-plugins',
              subagent: false,
              updatedAt: 1_760_000_000_000,
              running: true,
            },
            {
              id: '12345678-0000-0000-0000-000000000000',
              title: '写文档',
              project: 'notes',
              cwd: 'D:/notes',
              subagent: false,
              updatedAt: 1_759_000_000_000,
              running: false,
            },
          ],
        },
      }
    }
    if (method === 'patch') {
      return { ok: true, value: { applied: 'hot', changed: ['enabled'], config: stateValue().config } }
    }
    // 「扫码创建机器人」：`begin` 会一直挂到第一张码就绪才返回，这里直接给一张。
    if (method === 'provision.begin' || method === 'provision.poll') {
      return {
        ok: true,
        value: {
          attemptId: 'attempt-1',
          channelId: payload.channelId,
          type: 'qq',
          state: 'waiting',
          qrText: 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=demo',
          expiresAt: Date.now() + 300_000,
          pollIntervalMs: 1000,
        },
      }
    }
    if (method === 'provision.cancel') {
      return {
        ok: true,
        value: { attemptId: payload.attemptId, channelId: payload.channelId, type: 'qq', state: 'cancelled', pollIntervalMs: 1000 },
      }
    }
    return { ok: false, error: { code: 'not-stubbed', message: `未打桩的端点: ${endpoint}`, details: {} } }
  },
}

const registrations = []
// 忠实模仿真实的客户端 ctx：`dsh-cordis-client-runner` 把 ctx 包成**白名单代理**，
// 没写进 `inject` 的服务名**一读就抛**（`lib/client.js:331` 的 `service "x" is not
// declared by your plugin`，且 `?.` 挡不住）。所以 `connection` 与 `logger` 在这里
// 都定义成**会抛的 getter**，只有 `ctx.get(name)` 这条路走得通。
// 谁把代码改回 `ctx.connection`，下面「初始加载会调用 state 端点」会立刻失败——
// 这正是实机上「页面永远停在正在读取配置…」的成因。
const fakeCtx = {
  slots: {
    inject(name, callback) {
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get(name) {
    return name === 'connection' ? { rpc: fakeRpc } : undefined
  },
  get connection() {
    throw new Error('service "connection" is not declared by your plugin')
  },
  get logger() {
    throw new Error('dynamic ctx does not expose "logger"')
  },
}

check('apply 不抛错，并注册 settings.section', () => {
  mod.apply(fakeCtx)
  assert.equal(registrations.length, 1, '应当恰好注册一个设置页席位')
  const { options } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'tlnotify')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function', 'label 必须是 thunk，否则语言变化后不会更新')
  assert.equal(options.label(), '通知助手')
})

check('apply 会注入自己的样式表', () => {
  assert.ok(window.document.getElementById('dsh-tlnotify-client-styles'), '样式表没有注入')
})

check('宿主没有 slots 服务时 apply 只警告、不抛错', () => {
  const warns = []
  mod.apply({ logger: { warn: (message) => warns.push(message) } })
  assert.equal(warns.length, 1)
  assert.match(warns[0], /slots/)
})

// ── 4. 真渲染一遍 ────────────────────────────────────────────────────────────
const container = window.document.createElement('div')
window.document.body.appendChild(container)
const root = ReactDOMClient.createRoot(container)
const Section = registrations[0].component

const renderInto = async (targetRoot, Component) => {
  const element = React.createElement(Component, { close: () => {} })
  if (act) {
    await act(async () => {
      targetRoot.render(element)
    })
    await act(async () => {
      await flush()
    })
    return
  }
  targetRoot.render(element)
  await flush()
}
await renderInto(root, Section)

const text = () => container.textContent ?? ''

/** 点一下并等 React 把状态刷完；没装 `act` 的环境退回裸派发。 */
const clickOnce = async (element) => {
  if (!element) return
  const dispatch = () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  if (act) {
    await act(async () => {
      dispatch()
    })
    await act(async () => {
      await flush()
    })
    return
  }
  dispatch()
  await flush()
}

check('初始加载会调用 state 端点', () => {
  assert.ok(
    rpcCalls.some((call) => call.channel === '/api' && call.method === 'state'),
    `没有发出 state 调用，实际: ${JSON.stringify(rpcCalls)}`,
  )
})

check('渲染出标题、状态栏与真实数据', () => {
  // 「519cc141」以前来自顶部「运行模式」Section 的绑定会话行；那一整块已经删掉
  // （会话范围改成每台机器人各自决定），现在这一屏的真相由通道卡片承担。
  for (const needle of ['通知助手', '运行中', '主机器人', 'qq-main', '启用通知']) {
    assert.ok(text().includes(needle), `页面里没有出现「${needle}」`)
  }
})

check('协议形状的字段没有被原样倒进 DOM', () => {
  // 页面上只该出现给人看的文案；`configured` / `appSecret` 这种协议键漏出来就说明
  // 有人把整个对象塞进了 JSX。
  for (const leak of ['configured', 'appSecret', 'feishuAppSecret', '[object Object]']) {
    assert.ok(!text().includes(leak), `页面里泄漏了协议字段「${leak}」`)
  }
})

{
  const before = rpcCalls.filter((call) => call.method === 'state').length
  const reloadBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '重新读取')
  check('找得到「重新读取」按钮', () => assert.ok(reloadBtn, '状态栏里没有重新读取按钮'))
  if (reloadBtn) {
    if (act) {
      await act(async () => {
        reloadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await flush()
      })
    } else {
      reloadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await flush()
    }
    const after = rpcCalls.filter((call) => call.method === 'state').length
    check('重新读取真的重新拉了状态', () => assert.ok(after > before, `state 调用次数没有增加 (${before} → ${after})`))
  }
}

{
  const row = [...container.querySelectorAll('.tln-row')].find((item) =>
    item.querySelector('.tln-row-label')?.textContent?.includes('启用通知'),
  )
  const checkbox = row?.querySelector('input[type="checkbox"]')
  check('找得到「启用通知」开关', () => assert.ok(checkbox, '通用区里没有启用开关'))
  if (checkbox) {
    const click = () => checkbox.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    if (act) {
      await act(async () => {
        click()
      })
      await act(async () => {
        await flush()
      })
    } else {
      click()
      await flush()
    }
    const patched = rpcCalls.filter((call) => call.method === 'patch')
    check('切换总开关会发出 patch', () => {
      assert.ok(patched.length > 0, '没有发出 patch 调用')
      assert.equal(patched[0].payload.patch.enabled, false)
    })
  }
}

// ── 5. 每机器人设置：卡片折叠、接入向导、扫码接入 ────────────────────────────
{
  const card = container.querySelector('.tln-botCard')
  const toggle = card?.querySelector('.tln-botCard-toggle')
  check('机器人以卡片形式列出来', () => assert.ok(toggle, '通道栏里没有机器人卡片'))
  await clickOnce(toggle)

  const wizardBtn = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '接入向导')
  check('卡片里能找到「接入向导」', () => assert.ok(wizardBtn, '卡片里没有接入手册按钮'))
  await clickOnce(wizardBtn)

  const stepHeads = [...(card?.querySelectorAll('.tln-step-head') ?? [])]
  check('向导渲染出四步', () => {
    assert.equal(card.querySelectorAll('.tln-step').length, 4, '向导步数不对')
    const joined = stepHeads.map((el) => el.textContent ?? '').join(' | ')
    for (const label of ['第 1 步', '第 2 步', '第 3 步', '第 4 步']) {
      assert.ok(joined.includes(label), `向导里缺少「${label}」：${joined}`)
    }
  })

  // 初始打开的是「第一个没做完的步骤」，密钥掩码在第 2 步里，得自己点开。
  await clickOnce(stepHeads[1])
  check('第 2 步展开后能看到密钥掩码', () => {
    assert.ok(card.textContent.includes('••••abcd'), `第 2 步里没有掩码：${(card.textContent ?? '').slice(0, 200)}`)
  })
}

{
  const scanBtn = [...container.querySelectorAll('.tln-panel-head button')].find(
    (b) => b.textContent === '扫码接入机器人',
  )
  check('通道栏里有「扫码接入机器人」入口', () => assert.ok(scanBtn, '没有扫码创建的按钮'))
  await clickOnce(scanBtn)
  await flush(20)

  const beginCalls = rpcCalls.filter((call) => call.method === 'provision.begin')
  check('扫码入口先保存通道、再向宿主申请二维码', () => {
    const table = rpcCalls.filter((call) => call.method === 'patch').pop()
    assert.ok(table, '没有发出 patch')
    assert.ok((table.payload.patch.channels ?? []).length >= 2, 'patch 里没有带上新通道')
    assert.equal(beginCalls.length, 1, '没有调用 provision.begin')
    assert.equal(beginCalls[0].payload.channelId, 'qq-1')
  })

  // 新卡片默认是折叠的：二维码在展开后的卡片体内。
  const newCard = container.querySelector('[data-bot-id="qq-1"]')
  check('新机器人出现在列表里', () => assert.ok(newCard, '列表里没有新通道'))
  await clickOnce(newCard?.querySelector('.tln-botCard-toggle'))
  check('宿主给的 qrText 被画成二维码', () => {
    assert.ok(newCard?.querySelector('.tln-qr-img svg'), '没有渲染二维码')
    assert.ok(newCard.textContent.includes('用手机 QQ 扫码创建机器人'), '没有显示扫码标题')
  })
}

// ── 5.5 每机器人的会话范围：三档 + 从列表里点选（而不是手打 id） ──────────────
{
  const listCalls = rpcCalls.filter((call) => call.method === 'sessions.list')
  check('设置页加载时就拉了会话清单（走宿主 RPC，不自己读 ctx.sessions）', () => {
    assert.ok(listCalls.length > 0, '没有调用 sessions.list')
    assert.equal(listCalls[0].channel, '/api')
    assert.equal(listCalls[0].endpoint, 'tlnotify/sessions.list')
  })

  const card = container.querySelector('[data-bot-id="qq-main"]')
  const more = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '更多设置')
  check('卡片里能找到「更多设置」', () => assert.ok(more, '没有更多设置按钮'))
  await clickOnce(more)

  const sessionTab = [...container.querySelectorAll('.tln-tabs button')].find((b) => b.textContent === '会话过滤')
  check('子页里有「会话过滤」页签', () => assert.ok(sessionTab, '没有会话页签'))
  await clickOnce(sessionTab)

  const rows = () => [...container.querySelectorAll('.tln-session-item')]
  check('会话按标题列出来（带项目与最近活动，不是裸 id）', () => {
    assert.equal(rows().length, 2, `会话行数不对：${rows().length}`)
    const joined = rows().map((el) => el.textContent ?? '').join(' | ')
    assert.ok(joined.includes('修设置页'), `列表里没有标题：${joined}`)
    assert.ok(joined.includes('my-dsh-plugins'), `列表里没有项目名：${joined}`)
  })

  check('已勾选的会话被标出来（数据里存的是完整 id，不是短 id）', () => {
    const active = rows().filter((el) => el.getAttribute('data-active') === 'true')
    assert.equal(active.length, 1, `选中行数不对：${active.length}`)
    assert.ok((active[0]?.textContent ?? '').includes('修设置页'), '选中的不是夹具里那条')
  })

  // 切到「只关心一个会话」：列表变单选，此时还没绑定 → 页面必须明说「谁都不推」。
  const singleSeg = [...container.querySelectorAll('.tln-seg button')].find((b) => b.textContent === '只关心一个会话')
  check('会话范围是三档，其中包含「只关心一个会话」', () => assert.ok(singleSeg, '没有单会话档'))
  await clickOnce(singleSeg)

  check('还没绑定会话时明说「什么都不会推」', () => {
    assert.ok(text().includes('还没选会话'), `没有未绑定提醒：${text().slice(-260)}`)
  })

  const second = rows().find((el) => (el.textContent ?? '').includes('写文档'))
  check('单会话档下能点选另一条会话', () => assert.ok(second, '没有第二条会话'))
  await clickOnce(second)

  const channelPatch = () =>
    rpcCalls
      .filter((call) => call.method === 'patch')
      .map((call) => (call.payload.patch.channels ?? [])[0])
      .filter(Boolean)
      .pop()
  check('点一条会话就发出「这份草稿」的 patch（sessionScope + 完整 sessionId）', () => {
    const sent = channelPatch()
    assert.ok(sent, '没有发出通道 patch')
    assert.equal(sent.sessionScope, 'single')
    assert.equal(sent.sessionId, '12345678-0000-0000-0000-000000000000')
  })

  // 历史轮数：夹具给的是 0（显式「不带」），点「跟随全局」要发出 null（删除覆盖）。
  const followSeg = [...container.querySelectorAll('.tln-seg button')].find((b) => b.textContent === '跟随全局')
  check('历史轮数有「跟随全局 / 自定义」两档', () => assert.ok(followSeg, '没有跟随全局档'))
  await clickOnce(followSeg)
  check('切回「跟随全局」发出 historyTurns: null（而不是 0）', () => {
    const sent = channelPatch()
    assert.ok(sent, '没有发出通道 patch')
    assert.equal(sent.historyTurns, null)
  })
}

// ── 6. 拿不到 connection 时也必须给出结论，而不是永远转圈 ────────────────────
{
  const registrations2 = []
  const offlineCtx = {
    slots: {
      inject(name, callback) {
        return callback()
      },
      register(options, component) {
        registrations2.push({ options, component })
        return () => {}
      },
    },
    get() {
      return undefined
    },
    get connection() {
      throw new Error('service "connection" is not declared by your plugin')
    },
    get logger() {
      throw new Error('dynamic ctx does not expose "logger"')
    },
  }
  mod.apply(offlineCtx)
  const container2 = window.document.createElement('div')
  window.document.body.appendChild(container2)
  const root2 = ReactDOMClient.createRoot(container2)
  await renderInto(root2, registrations2[0].component)
  const offlineText = container2.textContent ?? ''
  check('拿不到 connection 时进只读态（不再停在「正在读取配置…」）', () => {
    assert.ok(!offlineText.includes('正在读取配置'), `页面仍停在加载态：${offlineText.slice(0, 200)}`)
    assert.match(offlineText, /只能看，不能改/, '没有出现只读提示')
  })
  if (act) {
    await act(async () => {
      root2.unmount()
    })
  } else {
    root2.unmount()
  }
}

// 失败路径上的日志本身也不能再抛：真实 ctx 里 `logger` 同样不在白名单里。
check('logger 一读就抛时，apply 走警告分支也只是安静降级', () => {
  mod.apply({
    get() {
      return undefined
    },
    get connection() {
      throw new Error('service "connection" is not declared by your plugin')
    },
    get logger() {
      throw new Error('dynamic ctx does not expose "logger"')
    },
  })
})

// unmount 会同步触发一批 effect 清理与状态更新；不包 act 的话 React 会打一条
// 「update not wrapped in act」告警，会把真正的失败淹掉。
if (act) {
  await act(async () => {
    root.unmount()
  })
} else {
  root.unmount()
}
dom.window.close()

console.log('')
if (failures.length > 0) {
  console.error(`[smoke-client] ${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('[smoke-client] 全部通过')
}
