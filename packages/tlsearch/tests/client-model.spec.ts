// packages/tlsearch/tests/client-model.spec.ts
//
// 客户端表单模型 ↔ 服务端事实的一致性回归。
//
// 设置页跑在浏览器里，不能 import 服务端模块（会把 schemastery + cosmokit 塞进 bundle，
// 还牵着 `node:` 用法），所以 `src/client/model.ts` 复刻了一份字段表。复刻就有漂移风险：
// 服务端把 `maxResults` 上限从 10 改成 20、或给 exa 加一条必填项，页面会静默地显示错提示。
//
// 这里把「复刻」钉死：
//   1. 后端 id 集合、LIMITS 数值、默认值必须与服务端逐项相等；
//   2. 每个后端的必填项（页面用它判断「还缺什么」）必须与服务端 `usableError` 的判决一致
//      —— 填齐页面认为需要的字段后，服务端必须也认为可用；抽掉任意一项，服务端必须也
//      报不可用。这条比对着两张表看更结实：它验的是行为，不是字面量。

import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  LIMITS as CLIENT_LIMITS,
  PROVIDER_IDS as CLIENT_PROVIDER_IDS,
  formatChain,
  hasUsableBackend,
  normalizeValues,
  parseChain,
  verdicts,
} from '../src/client/model.js'
import { LIMITS as SERVER_LIMITS, PROVIDER_IDS as SERVER_PROVIDER_IDS } from '../src/providers.js'
import { resolveRuntime, usableError } from '../src/providers.js'
import type { BackendConfig, ProviderId } from '../src/types.js'

/** 页面认为每个后端需要哪些字段（model.ts 里的 REQUIREMENTS 的镜像）。 */
const REQUIRED: Record<ProviderId, Array<'apiKey' | 'baseUrl' | 'cx'>> = {
  tavily: ['apiKey'],
  brave: ['apiKey'],
  searxng: ['baseUrl'],
  google: ['apiKey', 'cx'],
  exa: ['apiKey'],
}

/** 造一个「该有的都填了」的后端。 */
function filled(provider: ProviderId): BackendConfig {
  return { provider, apiKey: 'k-test', baseUrl: 'https://example.test', cx: 'cx-test' }
}

describe('客户端模型与服务端字段表一致', () => {
  it('后端 id 集合相同（顺序可以不同，只影响下拉框观感）', () => {
    expect([...CLIENT_PROVIDER_IDS].sort()).toEqual([...SERVER_PROVIDER_IDS].sort())
  })

  it('LIMITS 的每个数值与服务端相等', () => {
    expect(CLIENT_LIMITS.minResults).toBe(SERVER_LIMITS.minResults)
    expect(CLIENT_LIMITS.maxResults).toBe(SERVER_LIMITS.maxResults)
    expect(CLIENT_LIMITS.minSnippetChars).toBe(SERVER_LIMITS.minSnippetChars)
    expect(CLIENT_LIMITS.maxSnippetChars).toBe(SERVER_LIMITS.maxSnippetChars)
    expect(CLIENT_LIMITS.minTimeoutMs).toBe(SERVER_LIMITS.minTimeoutMs)
    expect(CLIENT_LIMITS.maxTimeoutMs).toBe(SERVER_LIMITS.maxTimeoutMs)
  })

  it('表单空值与服务端默认解析结果一致', () => {
    const resolved = resolveRuntime({})
    expect(DEFAULTS.maxResults).toBe(resolved.maxResults)
    expect(DEFAULTS.maxSnippetChars).toBe(resolved.maxSnippetChars)
    expect(DEFAULTS.timeoutMs).toBe(resolved.timeoutMs)
    expect(DEFAULTS.outputFormat).toBe(resolved.outputFormat)
    expect(DEFAULTS.includeAnswer).toBe(resolved.includeAnswer)
    expect(DEFAULTS.provider).toBe(resolved.provider)
    // 默认值也必须与 schema 声明的一致（第三份拷贝：providers.ts 的 LIMITS.default*）
    expect(DEFAULTS.maxResults).toBe(SERVER_LIMITS.defaultResults)
    expect(DEFAULTS.maxSnippetChars).toBe(SERVER_LIMITS.defaultSnippetChars)
    expect(DEFAULTS.timeoutMs).toBe(SERVER_LIMITS.defaultTimeoutMs)
  })

  it('页面显示的「条数上限」与服务端钳制后的上限相等', () => {
    const resolved = resolveRuntime({ maxResults: 999 })
    expect(resolved.maxResults).toBe(CLIENT_LIMITS.maxResults)
    const tiny = resolveRuntime({ maxResults: 0 })
    expect(tiny.maxResults).toBe(CLIENT_LIMITS.minResults)
  })
})

describe('必填项：页面的判断与服务端 usableError 一致', () => {
  for (const provider of SERVER_PROVIDER_IDS) {
    it(`${provider}：填齐页面要求的字段后服务端也认为可用`, () => {
      const missingFields = REQUIRED[provider]
      const backend: BackendConfig = { provider, apiKey: '', baseUrl: '', cx: '' }
      for (const field of missingFields) {
        if (field === 'apiKey') backend.apiKey = 'k-test'
        if (field === 'baseUrl') backend.baseUrl = 'https://example.test'
        if (field === 'cx') backend.cx = 'cx-test'
      }
      expect(usableError(backend)).toBeNull()

      // 反向：抽掉任意一项必填，服务端必须报不可用
      for (const field of missingFields) {
        const broken: BackendConfig = { ...backend, [field]: '' }
        expect(usableError(broken)).not.toBeNull()
      }
    })

    it(`${provider}：页面把「全空」判成缺第一项必填，与服务端一致`, () => {
      const values = normalizeValues({ provider })
      const [first] = verdicts(values)
      expect(first.provider).toBe(provider)
      expect(first.missing).toBe(REQUIRED[provider][0])
      // 服务端分歧则报错（空配置必然不可用）
      expect(usableError({ provider, apiKey: '', baseUrl: '', cx: '' })).not.toBeNull()
    })
  }

  it('一个都填不齐时 hasUsableBackend 为假，填一条即转真', () => {
    const empty = normalizeValues({ provider: 'tavily' })
    expect(hasUsableBackend(verdicts(empty))).toBe(false)
    const withKey = normalizeValues({ provider: 'tavily', apiKey: 'k-test' })
    expect(hasUsableBackend(verdicts(withKey))).toBe(true)
  })

  it('备用后端与后端链都会进判定列表，none 不进', () => {
    const values = normalizeValues({
      provider: 'tavily',
      apiKey: 'k-test',
      fallback: { provider: 'none' },
      chain: [{ provider: 'brave', apiKey: 'k-chain' }, { provider: 'google' }],
    })
    const list = verdicts(values)
    expect(list.map((entry) => entry.provider)).toEqual(['tavily', 'brave', 'google'])
    // google 缺两项时只报第一项（apiKey），填了它才会轮到 cx
    expect(list.map((entry) => entry.missing)).toEqual([null, null, 'apiKey'])
  })
})

describe('后端链的文本编辑', () => {
  it('空链序列化成 []，空文本解析成 []', () => {
    expect(formatChain([])).toBe('[]')
    expect(parseChain('')).toEqual({ ok: true, items: [] })
    expect(parseChain('   ')).toEqual({ ok: true, items: [] })
  })

  it('格式化后能原样解析回来', () => {
    const items = [{ provider: 'brave', apiKey: 'k-chain' }, { provider: 'exa' }]
    const parsed = parseChain(formatChain(items))
    expect(parsed).toEqual({ ok: true, items })
  })

  it('未知后端被拒绝，并指出第几项', () => {
    const parsed = parseChain('[{"provider":"tavily"},{"provider":"bing"}]')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.index).toBe(1)
      expect(parsed.error).toContain('bing')
    }
  })

  it('不是数组 / 元素不是对象都被拒绝', () => {
    expect(parseChain('{}').ok).toBe(false)
    expect(parseChain('[1]').ok).toBe(false)
    expect(parseChain('[[]]').ok).toBe(false)
  })

  it('未知键原样保留（不抹掉未来版本的字段）', () => {
    const parsed = parseChain('[{"provider":"tavily","futureField":42}]')
    expect(parsed).toEqual({ ok: true, items: [{ provider: 'tavily', futureField: 42 }] })
  })
})

describe('宿主回传值的归一化', () => {
  it('缺字段 / 类型错乱都收敛成可渲染的值', () => {
    const values = normalizeValues({ maxResults: 'many', includeAnswer: 'yes', outputFormat: 'xml' })
    expect(values.maxResults).toBe(DEFAULTS.maxResults)
    expect(values.includeAnswer).toBe(false)
    expect(values.outputFormat).toBe('markdown')
    expect(values.chain).toEqual([])
    expect(values.fallback.provider).toBe('none')
  })

  it('数字字符串按数字处理并钳到范围内', () => {
    const values = normalizeValues({ maxResults: '99', maxSnippetChars: '10', timeoutMs: '1' })
    expect(values.maxResults).toBe(CLIENT_LIMITS.maxResults)
    expect(values.maxSnippetChars).toBe(CLIENT_LIMITS.minSnippetChars)
    expect(values.timeoutMs).toBe(CLIENT_LIMITS.minTimeoutMs)
  })

  it('小数被四舍五入成整数（服务端还要再钳一次）', () => {
    expect(normalizeValues({ maxResults: 4.6 }).maxResults).toBe(5)
  })

  it('整页值能被服务端解析（归一化产物是合法配置）', () => {
    const values = normalizeValues({
      provider: 'searxng',
      baseUrl: 'http://127.0.0.1:8888',
      maxResults: 7,
      chain: [{ provider: 'brave', apiKey: 'k' }],
    })
    const resolved = resolveRuntime(values)
    expect(resolved.maxResults).toBe(7)
    expect(resolved.backends.map((backend) => backend.provider)).toEqual(['searxng', 'brave'])
  })
})
