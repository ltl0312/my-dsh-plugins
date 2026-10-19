// scripts/probe-dist.mjs
//
// 「产物的运行期依赖为零」的探针：在一个**没有 node_modules 的空目录**里被调用（由
// assert-build.mjs 拷进去后 spawn），加载同目录下的 dist 拷贝并检查关键契约。
//
// 用法：node probe.mjs <esm 文件名> <cjs 文件名>（相对当前工作目录）
// 输出：一行 JSON —— { steps: [[key, ...values], …] }，由 assert-build 断言。

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [esmName, cjsName] = process.argv.slice(2)
const mod = await import(pathToFileURL(resolve(esmName)).href)
const require = createRequire(import.meta.url)
const cjsMod = require(resolve(cjsName))

const out = { steps: [] }
const step = (key, ...values) => out.steps.push([key, ...values])

step('esm-import', typeof mod.apply === 'function' && typeof mod.Config === 'function')
step('cjs-import', typeof cjsMod.apply === 'function' && typeof cjsMod.Config === 'function')
step('name', mod.name)

const json = mod.Config.toJSON()
step('schema-type', json.type)

// schemastery 的 toJSON() 是**引用图**：{ uid, refs: { '<uid>': node } }，dict 的值是
// uid 数字。宿主设置页（dsh-settings `volatileForm`）读的也是这张引用图，所以断言必须
// 按同样的方式解析，不能假设 dict 里内联着节点。
const refs = json.refs ?? {}
const node = (entry) => (typeof entry === 'number' ? refs[String(entry)] : entry)
const root = node(json.uid) ?? json
const leaves = (parent) =>
  Object.entries(node(parent)?.dict ?? {}).map(([key, value]) => [key, node(value)])
const volatileKeys = leaves(root)
  .filter(([, child]) => child?.meta?.volatile === true)
  .map(([key]) => key)
const fallbackNode = node(node(root)?.dict?.fallback)
const fallbackLeaves = leaves(fallbackNode)
  .filter(([, child]) => child?.meta?.volatile === true)
  .map(([key]) => key)
step('volatile-top', volatileKeys.sort())
step('volatile-fallback', fallbackLeaves.sort())
step('fallback-node-volatile', fallbackNode?.meta?.volatile === true)
step('apiKey-role', node(node(root)?.dict?.apiKey)?.meta?.role)
step('fallback-apiKey-role', node(fallbackNode?.dict?.apiKey)?.meta?.role)

// 校验产物必须是「引用」：宿主 Loader 的 _commitVolatile 就是靠 volatileEntries()
// 认出这些引用、再 updateVolatile() 原地换值的。
const validated = mod.Config['~standard'].validate({ provider: 'tavily', apiKey: 'k', maxResults: 7 })
const value = validated.value ?? {}
const WRITE = Symbol.for('cosmokit.volatile.write')
const isRef = (input) =>
  typeof input === 'object' && input !== null && typeof input.get === 'function' && WRITE in input
step('issues-none', validated.issues === undefined)
step('ref-apiKey', isRef(value.apiKey), isRef(value.apiKey) ? value.apiKey.get() : null)
step('ref-maxResults', isRef(value.maxResults), isRef(value.maxResults) ? value.maxResults.get() : null)
step('ref-chain', isRef(value.chain), isRef(value.chain) ? value.chain.get() : null)
step('ref-fallback-leaf', isRef(value.fallback?.apiKey))

const runtime = mod.resolveRuntime(mod.unwrapVolatile(value))
step('resolved-backends', runtime.backends.map((backend) => backend.provider))
step('resolved-maxResults', runtime.maxResults)

// 无 key 降级：空配置也要能解析出「为什么不能用」，而不是抛异常。
const empty = mod.resolveRuntime({})
step('no-key-backends', empty.backends.map((backend) => backend.provider))
step('no-key-usable-error', Boolean(mod.usableError(empty.backends[0])))

console.log(JSON.stringify(out))
