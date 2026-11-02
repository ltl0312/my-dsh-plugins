#!/usr/bin/env node
/**
 * 客户端 bundle 的结构冒烟检查。
 *
 * 目的：在没有浏览器、没有真 React 的环境里，验证 client.js
 *   1) 能被 window.__ModuleLoader__.load({id,factory}) 正常注册；
 *   2) factory(require) 能求值出 {inject, apply, TlrpSettingsCard}；
 *   3) apply(ctx) 在 configForms 服务存在/缺失两种宿主下都不抛错；
 *   4) TlrpSettingsCard 在 summary / page 两种视图、四种快照状态
 *      （ready / loading / unavailable / 只读）下都能渲染出树，
 *      且写操作确实转发给 controller.set / unset。
 *
 * 这里故意用 React 桩（createElement 直接产对象、hooks 走假实现），
 * 所以结论只覆盖「结构正确、不抛错、文案与控件在位」，不覆盖真实
 * 视觉渲染 —— 后者只能在浏览器里由人眼确认。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client.js');
const source = readFileSync(clientPath, 'utf8');

let failures = 0;
const results = [];

/**
 * 记录一条断言。
 * @param {string} name - 断言名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败时的补充信息。
 */
function check(name, ok, detail) {
	if (ok) results.push(`  PASS  ${name}`);
	else {
		failures += 1;
		results.push(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
	}
}

/**
 * React 桩：只保证 createElement 与常用 hooks 的调用形状。
 * @returns {object} react 命名空间。
 */
function createReactStub() {
	const createElement = (type, props, ...children) => ({
		type,
		props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children }
	});
	return {
		createElement,
		Fragment: 'Fragment',
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useMemo: (factory) => factory(),
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial })
	};
}

/**
 * 展开渲染树里的函数组件（React 桩不会自己调用它们）。
 * @param {*} node - 渲染树节点。
 * @returns {*} 展开后的树。
 */
function expand(node) {
	if (node === undefined || node === null || node === false) return node;
	if (Array.isArray(node)) return node.map(expand);
	if (typeof node !== 'object' || node.props === undefined) return node;
	if (typeof node.type === 'function') return expand(node.type(node.props));
	return { type: node.type, props: { ...node.props, children: expand(node.props.children) } };
}

/**
 * 从渲染树里收集全部字符串节点。
 * @param {*} node - createElement 产物或标量。
 * @param {string[]} [acc] - 累积数组。
 * @returns {string[]} 文本节点。
 */
function collectText(node, acc = []) {
	if (node === undefined || node === null || node === false) return acc;
	if (typeof node === 'string' || typeof node === 'number') {
		acc.push(String(node));
		return acc;
	}
	if (Array.isArray(node)) {
		for (const item of node) collectText(item, acc);
		return acc;
	}
	if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, acc);
	return acc;
}

/**
 * 按谓词遍历渲染树。
 * @param {*} node - 渲染树根。
 * @param {(node: object) => boolean} predicate - 匹配条件。
 * @param {object[]} [acc] - 累积数组。
 * @returns {object[]} 命中的节点。
 */
function findAll(node, predicate, acc = []) {
	if (node === undefined || node === null || node === false) return acc;
	if (Array.isArray(node)) {
		for (const item of node) findAll(item, predicate, acc);
		return acc;
	}
	if (typeof node === 'object' && node.props !== undefined) {
		if (predicate(node)) acc.push(node);
		findAll(node.props.children, predicate, acc);
	}
	return acc;
}

/**
 * 加载客户端 bundle，返回注册载荷与模块导出。
 * @returns {{loaded: object, exports: object}} 加载结果。
 */
function loadClient() {
	let loaded;
	const window = {
		__ModuleLoader__: {
			load(payload) {
				loaded = payload;
			}
		}
	};
	const context = vm.createContext({
		window,
		document: {
			createElement: () => ({ setAttribute() {}, appendChild() {}, dataset: {} }),
			head: { appendChild() {} },
			querySelector: () => null
		},
		console
	});
	vm.runInContext(source, context, { filename: 'client.js' });
	if (loaded === undefined) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
	const react = createReactStub();
	const exports = loaded.factory((specifier) => {
		if (specifier === 'react') return react;
		throw new Error(`unexpected require(${specifier})`);
	});
	return { loaded, exports, react };
}

/**
 * 造一个假宿主上下文。
 * @param {object} options - 配置项。
 * @param {object|null} options.formController - configForms 控制器（null 表示宿主没有该服务）。
 * @returns {object} 上下文与捕获记录。
 */
let dictionaryHost;

function createHost({ formController }) {
	const record = { slots: [], registrations: [], writes: [], dictionary: undefined };
	dictionaryHost = record;
	const locale = {
		register(namespace, dictionaries) {
			record.dictionary = { namespace, dictionaries };
			return () => {};
		},
		bind() {
			return (key, params) => {
				const raw = record.dictionary?.dictionaries.zh[key] ?? key;
				if (params === undefined) return raw;
				return Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), raw);
			};
		}
	};
	const ctx = {
		logger: { error() {} },
		effect(factory) {
			const disposer = factory();
			return typeof disposer === 'function' ? disposer : () => {};
		},
		locale,
		inject(names, callback) {
			if (formController === null) return () => {};
			// cordis 的 inject 交给回调的是子上下文，服务挂在 ctx.<name> 上。
			callback({
				configForms: {
					describe() {
						return {
							getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:tlrp' }, { ns: 'other' }] } }),
							subscribe: () => () => {},
							load: () => Promise.resolve()
						};
					},
					whileServed(namespaces, register) {
						record.servedNamespaces = namespaces;
						return register(new Set(['include:tlrp']));
					},
					get(namespace) {
						record.requestedNamespace = namespace;
						return {
							getSnapshot: () => formController.snapshot,
							subscribe: () => () => {},
							set(field, value) {
								record.writes.push({ op: 'set', field, value });
								return Promise.resolve({ ok: true });
							},
							unset(field) {
								record.writes.push({ op: 'unset', field });
								return Promise.resolve({ ok: true });
							}
						};
					}
				}
			});
			return () => {};
		},
		slots: {
			inject(name, factory) {
				record.slots.push(name);
				return factory();
			},
			register(definition, component) {
				record.registrations.push({ definition, component });
				return () => {};
			}
		}
	};
	return { ctx, record };
}

/** 一份典型 ready 快照。 */
const readyValue = {
	enabled: true,
	mode: 'work',
	activeCharacterId: 'firefly',
	customSceneOverride: '',
	blockShellToolsInRp: true,
	enableStatusFooter: true,
	workModeKeywords: '端口|报错|日志',
	characters: [
		{ id: 'firefly', name: '流萤 (Firefly)', userTitle: '开拓者' },
		{ id: 'sam_tactical', name: '萨姆 · 战术 (SAM)', userTitle: '指挥官' }
	],
	modes: [
		{ id: 'rp', name: '少女陪伴态', commandAliases: ['/rp'], autoKeywords: '想你', autoPriority: 10, toolPolicy: 'whitelist_only', allowedTools: 'tlmemory', injectCharacterPersona: true, enableStatusFooter: true, isDefaultFallback: true },
		{ id: 'work', name: '战术工作态', commandAliases: ['/work'], autoKeywords: '端口|报错', autoPriority: 50, toolPolicy: 'allow_all', injectCharacterPersona: false, enableStatusFooter: false },
		{ id: 'sam', name: '萨姆强袭态', commandAliases: ['/sam', '【萨姆】'], autoKeywords: '萨姆|机甲', autoPriority: 80, toolPolicy: 'allow_all', injectCharacterPersona: true, enableStatusFooter: true },
		{ id: 'sleep', name: '医疗舱微凉态', commandAliases: ['/sleep'], autoKeywords: '晚安', autoPriority: 60, toolPolicy: 'whitelist_only', allowedTools: 'tlmemory', injectCharacterPersona: true, enableStatusFooter: true },
		{ id: 'debug', name: '排障态', commandAliases: ['/debug', '【排障】'], autoKeywords: '堆栈|崩溃', autoPriority: 99, directivePrompt: '只输出根因。', toolPolicy: 'block_all', injectCharacterPersona: false, enableStatusFooter: false }
	],
	triggers: [
		{ id: 'oak-cake', enabled: true },
		{ id: 'glamoth', enabled: true },
		{ id: 'entropy', enabled: false }
	]
};

/**
 * 用给定快照渲染一次卡片。
 * @param {object} args - 组件与快照。
 * @returns {*} 渲染树。
 */
function render({ component, registration, snapshot, view }) {
	const face = typeof registration.definition.inject === 'function' ? registration.definition.inject() : registration.definition.inject;
	const t = (key, params) => {
		const raw = dictionaryHost?.dictionary?.dictionaries.zh?.[key] ?? {
			title: '角色扮演与双态路由',
			mode: '当前模式',
			modeAuto: '自动',
			modeRp: '陪伴态',
			modeWork: '工作态',
			character: '激活角色',
			scene: '当前情景',
			triggers: '关键词触发器',
			triggersCount: '已启用 {count} 组',
			loading: '正在读取 tlrp 配置…',
			unavailable: '本部署没有服出 tlrp 的设置命名空间，配置卡暂时不可用。',
			readOnly: '本部署的设置为只读。',
			apply: '应用',
			clear: '清空'
		}[key] ?? key;
		return params === undefined ? raw : Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), raw);
	};
	return expand(component({
		view,
		t,
		useTlrp: (selector) => selector(snapshot),
		...face
	}));
}

// ── 1. 加载与导出面 ────────────────────────────────────────────────
const { loaded, exports } = loadClient();
check('window.__ModuleLoader__.load 被调用', loaded !== undefined);
check('注册 id 是 dsh-plugin-tlrp', loaded?.id === 'dsh-plugin-tlrp', String(loaded?.id));
check('exports.inject 含 slots 与 locale', Array.isArray(exports.inject) && exports.inject.includes('slots') && exports.inject.includes('locale'), JSON.stringify(exports.inject));
check('exports.apply 是函数', typeof exports.apply === 'function');
check('exports.TlrpSettingsCard 是函数', typeof exports.TlrpSettingsCard === 'function');

// ── 2. 正常宿主：注册配置卡 ───────────────────────────────────────
const readySnapshot = { status: 'ready', value: readyValue, revision: 7, writable: true };
const host = createHost({ formController: { snapshot: readySnapshot } });
let applyThrew;
try {
	exports.apply(host.ctx);
} catch (error) {
	applyThrew = error;
}
check('apply(ctx) 在正常宿主上不抛错', applyThrew === undefined, applyThrew?.message);
check('注册了字典命名空间 settings.tlrp', host.record.dictionary?.namespace === 'settings.tlrp', String(host.record.dictionary?.namespace));
check('字典含 zh 与 en 且键集一致', (() => {
	const zh = host.record.dictionary?.dictionaries.zh;
	const en = host.record.dictionary?.dictionaries.en;
	if (zh === undefined || en === undefined) return false;
	const zhKeys = Object.keys(zh).sort().join(',');
	const enKeys = Object.keys(en).sort().join(',');
	return zhKeys === enKeys;
})());
check('请求了三种槽位（bundle / 行配置 / 设置栏目）', host.record.slots.includes('plugins.bundle.config') && host.record.slots.includes('plugins.row.config') && host.record.slots.includes('settings.section'), JSON.stringify(host.record.slots));
const registration = host.record.registrations.find((item) => item.definition.name === 'plugins.row.config');
const sectionRegistration = host.record.registrations.find((item) => item.definition.name === 'settings.section');
check('两处配置槽 + 一处设置栏目各注册一次', host.record.registrations.length === 3, String(host.record.registrations.length));
check('行配置槽键为 dsh-plugin-tlrp#tlrp', registration?.definition.key === 'dsh-plugin-tlrp#tlrp', String(registration?.definition.key));
check('bundle 槽键为包名', host.record.registrations.some((item) => item.definition.name === 'plugins.bundle.config' && item.definition.key === 'dsh-plugin-tlrp'), JSON.stringify(host.record.registrations.map((item) => item.definition.key)));
check('键控槽位不再传 id/order', registration?.definition.id === undefined && registration?.definition.order === undefined, JSON.stringify({ id: registration?.definition.id, order: registration?.definition.order }));
check('设置栏目 id 为 tlrp', sectionRegistration?.definition.id === 'tlrp', String(sectionRegistration?.definition.id));
check('设置栏目 order 为 45', sectionRegistration?.definition.order === 45, String(sectionRegistration?.definition.order));
check('设置栏目 label 是 thunk 且不抛错', (() => {
	if (typeof sectionRegistration?.definition.label !== 'function') return false;
	try {
		return typeof sectionRegistration.definition.label() === 'string';
	} catch {
		return false;
	}
})());
check('设置栏目自带 locale 与 inject 面', sectionRegistration?.definition.locale === 'settings.tlrp' && typeof sectionRegistration?.definition.inject === 'function');
check('设置栏目挂的是包装组件', sectionRegistration?.component === exports.TlrpSettingsSection);
check('候选命名空间命中 include:tlrp', host.record.requestedNamespace === 'include:tlrp', String(host.record.requestedNamespace));

// ── 3. summary 视图 ──────────────────────────────────────────────
let summary;
try {
	summary = render({ component: registration.component, registration, snapshot: readySnapshot, view: 'summary' });
} catch (error) {
	summary = error;
}
check('summary 视图渲染不抛错', !(summary instanceof Error), summary?.message);
check('summary 视图有输出', collectText(summary).join('').length > 0, JSON.stringify(collectText(summary)));

// ── 4. page 视图：控件在位 ────────────────────────────────────────
let page;
try {
	page = render({ component: registration.component, registration, snapshot: readySnapshot, view: 'page' });
} catch (error) {
	page = error;
}
check('page 视图渲染不抛错', !(page instanceof Error), page?.message);
const pageText = collectText(page).join(' ');
check('page 根节点带 tlrp-root', findAll(page, (n) => n.props.className === 'tlrp-root').length === 1);
check('四个分区都在位', findAll(page, (n) => n.props.className === 'tlrp-section').length === 4,
	String(findAll(page, (n) => n.props.className === 'tlrp-section').length));
check(
	'切换栏按 modes 动态渲染（含自动路由与全部形态名）',
	['自动路由 (auto)', '少女陪伴态', '战术工作态', '萨姆强袭态', '医疗舱微凉态'].every((label) => pageText.includes(label)),
	pageText.slice(0, 240)
);
check('自定义第 5 个形态也出现在切换栏', pageText.includes('排障态'));
check(
	'形态 CRUD 按钮齐全',
	['新建形态', '复制当前形态', '删除当前形态', '设为 Auto 默认兜底形态', '保存形态修改'].every((label) => pageText.includes(label)),
	['新建形态', '复制当前形态', '删除当前形态', '设为 Auto 默认兜底形态', '保存形态修改'].filter((label) => !pageText.includes(label)).join(',')
);
check(
	'形态编辑器字段齐全（准则 / 状态栏覆盖 / 工具策略）',
	['聊天触发指令别名', '工具放行策略', '该形态专属行为准则', '该形态专属状态栏模板覆盖'].every((label) => pageText.includes(label))
);
const activeMode = findAll(page, (n) => n.type === 'button' && n.props["data-active"] === 'true');
check('当前模式 work 高亮', activeMode.length === 1, `active=${activeMode.length}`);
const optionValues = findAll(page, (n) => n.type === 'option').map((n) => n.props.value);
check('角色下拉含内置两角色', optionValues.includes('firefly') && optionValues.includes('sam_tactical'), JSON.stringify(optionValues));
check('情景输入框在位', findAll(page, (n) => n.props.placeholder === '例如：现实宇宙·星舰医疗舱外').length === 1,
	String(findAll(page, (n) => n.props.placeholder === '例如：现实宇宙·星舰医疗舱外').length));
check('三个开关在位', findAll(page, (n) => n.type === 'input' && n.props.type === 'checkbox').length >= 3,
	String(findAll(page, (n) => n.type === 'input' && n.props.type === 'checkbox').length));
check('角色工作室 11 个字段全部可编辑', findAll(page, (n) => n.props.className === 'tlrp-field').length >= 11,
	String(findAll(page, (n) => n.props.className === 'tlrp-field').length));
check('触发器数量按启用数计算', pageText.includes('共 3 条') && pageText.includes('启用 2 条'), pageText.slice(0, 240));
check('角色工作室四个操作按钮在位', ['新建空白角色', '复制当前角色', '删除当前角色', '保存角色修改'].every((label) => pageText.includes(label)), pageText.slice(0, 240));
check('触发词映射区有新增与删除按钮', pageText.includes('新增触发词映射') && pageText.includes('删除此条'), pageText.slice(0, 240));
check('导入导出与预览区在位', pageText.includes('从 JSON 导入角色/触发器') && pageText.includes('预览当前合成 Prompt'), pageText.slice(0, 240));

// ── 4b. 设置栏目整页 ──────────────────────────────────────────────
let section;
try {
	section = render({ component: exports.TlrpSettingsSection, registration: sectionRegistration, snapshot: readySnapshot, view: undefined });
} catch (error) {
	section = error;
}
check('设置栏目渲染不抛错', !(section instanceof Error), section?.message);
check('设置栏目外层是 tlrp-root', !(section instanceof Error) && findAll(section, (n) => n.props.className === 'tlrp-root').length === 1);
check('设置栏目里有四个分区', !(section instanceof Error) && findAll(section, (n) => n.props.className === 'tlrp-section').length === 4,
	String(findAll(section, (n) => n.props.className === 'tlrp-section').length));
check('设置栏目有标题文本', !(section instanceof Error) && collectText(section).join(' ').includes('TLRP 角色与双态引擎'));

// ── 5. 写操作确实转发 ────────────────────────────────────────────
const face = typeof registration.definition.inject === 'function' ? registration.definition.inject() : registration.definition.inject;
face.set('mode', 'rp');
face.unset('customSceneOverride');
check('set 转发到 controller', host.record.writes.some((w) => w.op === 'set' && w.field === 'mode' && w.value === 'rp'), JSON.stringify(host.record.writes));
check('unset 转发到 controller', host.record.writes.some((w) => w.op === 'unset' && w.field === 'customSceneOverride'), JSON.stringify(host.record.writes));

// ── 6. 其它快照状态 ──────────────────────────────────────────────
const states = [
	['loading', { status: 'loading', writable: false }],
	['unavailable', { status: 'unavailable', writable: false }],
	['ready-但只读', { status: 'ready', value: readyValue, writable: false }]
];
for (const [label, snapshot] of states) {
	for (const view of ['summary', 'page']) {
		let thrown;
		try {
			render({ component: registration.component, registration, snapshot, view });
		} catch (error) {
			thrown = error;
		}
		check(`${label} 快照的 ${view} 视图不抛错`, thrown === undefined, thrown?.message);
	}
}
const readOnlyPage = render({ component: registration.component, registration, snapshot: { status: 'ready', value: readyValue, writable: false }, view: 'page' });
check('只读快照下控件被禁用', findAll(readOnlyPage, (n) => n.props.disabled === true).length > 0);
check('只读快照给出提示', collectText(readOnlyPage).join(' ').includes('只读'), collectText(readOnlyPage).join(' ').slice(0, 160));

// ── 7. 旧宿主：没有 configForms 服务 ─────────────────────────────
const legacy = createHost({ formController: null });
let legacyThrew;
try {
	exports.apply(legacy.ctx);
} catch (error) {
	legacyThrew = error;
}
check('没有 configForms 时 apply 仍然不抛错', legacyThrew === undefined, legacyThrew?.message);
check('没有 configForms 时不注册卡片', legacy.record.registrations.length === 0, String(legacy.record.registrations.length));

// ── 输出 ─────────────────────────────────────────────────────────
console.log(results.join('\n'));
console.log(failures === 0 ? `\nRESULT: ALL PASS (${results.length} checks)` : `\nRESULT: ${failures} FAILED of ${results.length} checks`);
process.exitCode = failures === 0 ? 0 : 1;
