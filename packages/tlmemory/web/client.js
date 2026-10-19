// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: packages/tlmemory/src/client/*  |  Build: pnpm build:client
// DSH client-module boot registration protocol (see dsh-client-modules).
window.__ModuleLoader__.load({
  id: "dsh-plugin-tlmemory",
  factory: (require) => {
    "use strict";
    var __tlmemory_client_exports = (() => {
      var __create = Object.create;
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __getProtoOf = Object.getPrototypeOf;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
      var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
      var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
        get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
      }) : x)(function(x) {
        if (typeof require !== "undefined") return require.apply(this, arguments);
        throw Error('Dynamic require of "' + x + '" is not supported');
      });
      var __export = (target, all) => {
        for (var name in all)
          __defProp(target, name, { get: all[name], enumerable: true });
      };
      var __copyProps = (to, from, except, desc) => {
        if (from && typeof from === "object" || typeof from === "function") {
          for (let key of __getOwnPropNames(from))
            if (!__hasOwnProp.call(to, key) && key !== except)
              __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        }
        return to;
      };
      var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
        // If the importer is in node compatibility mode or this is not an ESM
        // file that has been converted to a CommonJS file using a Babel-
        // compatible transform (i.e. "__esModule" has not been set), then set
        // "default" to the CommonJS "module.exports" for node compatibility.
        isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
        mod
      ));
      var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
      var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
    
      // src/client/entry.ts
      var entry_exports = {};
      __export(entry_exports, {
        apply: () => apply,
        inject: () => inject
      });
    
      // src/client/index.tsx
      var import_react2 = __toESM(__require("react"), 1);
      var import_client = __require("react-dom/client");
    
      // src/client/logic.ts
      function resolveInjectedPort() {
        if (typeof __TLMEMORY_SERVER_PORT__ === "number" && Number.isFinite(__TLMEMORY_SERVER_PORT__)) {
          return __TLMEMORY_SERVER_PORT__;
        }
        return 4890;
      }
      var DASHBOARD_SERVER_PORT = resolveInjectedPort();
      var DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_SERVER_PORT}`;
      var DASHBOARD_LABEL = "\u8BB0\u5FC6\u770B\u677F";
      var BACK_TO_CONVERSATION_LABEL = "\u8FD4\u56DE\u4F1A\u8BDD";
      var PLUGIN_ID = "tlmemory";
      var ENTRY_ATTRIBUTE = "data-dsh-tlmemory-entry";
      var ENTRY_SELECTOR = `[${ENTRY_ATTRIBUTE}]`;
      var VIEW_ATTRIBUTE = "data-dsh-tlmemory-view";
      var VIEW_SELECTOR = `[${VIEW_ATTRIBUTE}]`;
      var STYLE_ID = "dsh-plugin-tlmemory/client-view.css";
      var ACTIVE_ATTRIBUTE = "data-dsh-tlmemory-active";
      var SIBLING_ACTIVE_ATTRIBUTES = [
        "data-dsh-taskboard-active",
        "data-dsh-ssh-active"
      ];
      var PANEL_ACTIVATE_EVENT = "dsh-panel-activate";
      var PANEL_NAME = "tlmemory";
      var SIBLING_PANEL_NAMES = ["taskboard", "ssh"];
      var SIDEBAR_FAMILY_SELECTORS = [
        "[data-dsh-taskboard-entry]",
        "[data-dsh-ssh-entry]",
        "[data-dsh-skill-explorer-entry]",
        `[${ENTRY_ATTRIBUTE}]`
      ];
      var CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]';
      var SIDEBAR_SESSION_ROW_SELECTOR = [
        '[class*="sessionRow"]',
        '[class*="projectRow"]',
        '[class*="searchResultRow"]',
        '[class*="searchResultWorkspace"]',
        '[class*="newSession"]'
      ].join(", ");
      var PROBE_TIMEOUT_MS = 2500;
      var PROBE_INTERVAL_MS = 15e3;
      function dashboardUrl(origin = DASHBOARD_ORIGIN) {
        return `${origin.replace(/\/+$/, "")}/`;
      }
      async function probeDashboardHealth(origin = DASHBOARD_ORIGIN, timeoutMs = PROBE_TIMEOUT_MS, fetcher = (url, init) => fetch(url, init)) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetcher(`${origin.replace(/\/+$/, "")}/api/health`, { signal: controller.signal });
          return res.status >= 200 && res.status < 300;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      }
      function createPanelState(initial = false) {
        let open = initial;
        const listeners = /* @__PURE__ */ new Set();
        const notify = () => {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch {
            }
          }
        };
        return {
          isOpen: () => open,
          setOpen: (next) => {
            if (open === next) return;
            open = next;
            notify();
          },
          toggle: () => {
            open = !open;
            notify();
          },
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          }
        };
      }
      function activationBroadcasts() {
        return [...SIBLING_PANEL_NAMES, PANEL_NAME];
      }
      var PANEL_ACTIVATE_ORIGIN_KEY = "__dshPanelActivateOrigin";
      function markPanelActivation(event) {
        ;
        event[PANEL_ACTIVATE_ORIGIN_KEY] = PANEL_NAME;
      }
      function isSelfActivation(event) {
        return event[PANEL_ACTIVATE_ORIGIN_KEY] === PANEL_NAME;
      }
      function shouldRelinquishColumn(event) {
        if (isSelfActivation(event)) return false;
        const detail = event.detail;
        return typeof detail === "string" && SIBLING_PANEL_NAMES.includes(detail);
      }
      var THEME_MESSAGE_TYPE = "dsh-tlmemory:theme";
      var THEME_CHANGE_MESSAGE_TYPE = "dsh-theme-change";
      var READY_MESSAGE_TYPE = "dsh-tlmemory:ready";
      var DARK_THEME_ATTRIBUTE = "data-ds-dark-theme";
      var LIGHT_THEME_ATTRIBUTE = "data-ds-light-theme";
      var THEME_VALUE_ATTRIBUTES = ["data-theme", "data-dsw-theme"];
      var THEME_WATCH_ATTRIBUTES = [
        DARK_THEME_ATTRIBUTE,
        LIGHT_THEME_ATTRIBUTE,
        ...THEME_VALUE_ATTRIBUTES,
        "class",
        "style"
      ];
      var THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";
      var THEME_CLASS_DARK = "dark";
      var THEME_CLASS_LIGHT = "light";
      function legacyThemeMessage(mode) {
        return { type: THEME_MESSAGE_TYPE, mode };
      }
      function themeMessage(mode) {
        return { type: THEME_CHANGE_MESSAGE_TYPE, theme: mode };
      }
      function parseDashboardMessage(data) {
        if (typeof data !== "object" || data === null) return void 0;
        const type = data.type;
        if (type !== READY_MESSAGE_TYPE) return void 0;
        return { type };
      }
      function isDashboardOrigin(origin, expected = DASHBOARD_ORIGIN) {
        return origin === expected.replace(/\/+$/, "");
      }
    
      // src/client/sidebar-entry.ts
      var ENTRY_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="3.9" rx="5.2" ry="2.15"/><path d="M2.8 3.9v8.2c0 1.19 2.33 2.15 5.2 2.15s5.2-0.96 5.2-2.15V3.9"/><path d="M2.8 8c0 1.19 2.33 2.15 5.2 2.15s5.2-0.96 5.2-2.15"/></svg>';
      var SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]';
      var ENTRY_PART_ATTRIBUTES = {
        icon: "data-dsh-tlmemory-icon",
        label: "data-dsh-tlmemory-label"
      };
      var RECHECK_INTERVAL_MS = 2e3;
      function sidebarRoot(doc) {
        const column = doc.querySelector(SIDEBAR_COLUMN_SELECTOR);
        if (column === null) return void 0;
        const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
        return logoOwner ?? column.firstElementChild;
      }
      function newSessionButton(root) {
        const nested = root.querySelector('button[class*="newSession"]');
        if (nested !== null) return nested;
        for (const child of Array.from(root.children)) {
          if (child.tagName === "BUTTON") return child;
        }
        return void 0;
      }
      function resolveEntryAnchor(root, button, options) {
        const row = button.closest('[class*="logoRow"]');
        const base = row !== null && row.parentElement === root ? row : button;
        const family = Array.from(root.children).filter(
          (el) => el instanceof HTMLElement && el.matches(options.familySelectors.join(", "))
        );
        if (family.length === 0) return base.nextElementSibling;
        return options.position === "before" ? family[0] : family[family.length - 1].nextElementSibling;
      }
      function createEntry(options) {
        const doc = options.doc ?? document;
        const entry = doc.createElement("button");
        entry.type = "button";
        entry.setAttribute(options.rowAttribute, "");
        entry.setAttribute("data-dsh-plugin", options.plugin);
        entry.setAttribute("data-dsh-part", "sidebar-entry");
        const iconSpan = doc.createElement("span");
        iconSpan.setAttribute(ENTRY_PART_ATTRIBUTES.icon, "");
        iconSpan.innerHTML = options.icon;
        const labelSpan = doc.createElement("span");
        labelSpan.setAttribute(ENTRY_PART_ATTRIBUTES.label, "");
        entry.append(iconSpan, labelSpan);
        const applyLabel = () => {
          const label = options.label();
          entry.setAttribute("aria-label", label);
          entry.setAttribute("title", options.tooltip === void 0 ? label : options.tooltip());
          labelSpan.textContent = label;
        };
        applyLabel();
        entry.addEventListener("click", () => {
          options.onToggle();
        });
        return entry;
      }
      function placeEntry(root, entry, options) {
        const button = newSessionButton(root);
        if (button === void 0) return false;
        if (entry.parentElement !== root) {
          root.insertBefore(entry, resolveEntryAnchor(root, button, options));
        }
        return true;
      }
      function mountSidebarEntry(options) {
        const doc = options.doc ?? document;
        if (doc.querySelector(options.rowSelector) !== null) return () => {
        };
        const entry = createEntry(options);
        let root;
        let placed = false;
        const rootObserver = new MutationObserver(() => {
          if (root === void 0 || !root.isConnected) {
            placed = false;
            tryPlace();
            return;
          }
          if (!root.contains(entry)) placed = placeEntry(root, entry, options);
        });
        let observeTarget;
        const armWaitObserver = (target) => {
          if (observeTarget === target) return;
          observeTarget = target;
          waitObserver.disconnect();
          waitObserver.observe(target, { childList: true, subtree: true });
        };
        const armBodyWaitObserver = () => {
          armWaitObserver(doc.body ?? doc.documentElement);
        };
        const tryPlace = () => {
          if (root !== void 0 && !root.isConnected) {
            rootObserver.disconnect();
            root = void 0;
            placed = false;
          }
          if (placed) {
            if (entry.isConnected) return;
            rootObserver.disconnect();
            root = void 0;
            placed = false;
          }
          root ?? (root = sidebarRoot(doc));
          if (root === void 0) {
            armBodyWaitObserver();
            return;
          }
          placed = placeEntry(root, entry, options);
          if (placed) {
            rootObserver.observe(root, { childList: true, subtree: true });
            armWaitObserver(root.parentElement ?? doc.body ?? doc.documentElement);
          }
        };
        const waitObserver = new MutationObserver(() => {
          tryPlace();
        });
        armBodyWaitObserver();
        const recheckTimer = setInterval(() => {
          if (entry.isConnected) return;
          armBodyWaitObserver();
          tryPlace();
        }, RECHECK_INTERVAL_MS);
        const syncActive = () => {
          if (options.state.isOpen()) entry.setAttribute("data-active", "");
          else entry.removeAttribute("data-active");
        };
        const unsubscribeActive = options.state.subscribe(syncActive);
        syncActive();
        tryPlace();
        return () => {
          clearInterval(recheckTimer);
          waitObserver.disconnect();
          rootObserver.disconnect();
          unsubscribeActive();
          entry.remove();
        };
      }
    
      // src/client/panel-mount.ts
      var RECHECK_INTERVAL_MS2 = 2e3;
      function conversationColumn(doc) {
        return doc.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
      }
      function mountCenterPanel(options) {
        const doc = options.doc ?? document;
        let unmount;
        let container;
        const disposeContainer = () => {
          try {
            unmount?.();
          } catch {
          }
          unmount = void 0;
          container?.remove();
          container = void 0;
        };
        const ensure = () => {
          if (container !== void 0) {
            if (container.isConnected) return;
            disposeContainer();
          }
          const column = conversationColumn(doc);
          if (column === void 0) {
            armBodyWaitObserver();
            return;
          }
          container = doc.createElement("div");
          container.dataset[options.viewDatasetKey] = "";
          container.setAttribute("data-dsh-plugin", options.plugin);
          column.append(container);
          try {
            unmount = options.mount(container);
          } catch {
            unmount = void 0;
          }
          armWaitObserver(column.parentElement ?? doc.body ?? doc.documentElement);
        };
        const waitObserver = new MutationObserver(() => {
          ensure();
        });
        let observeTarget;
        const armWaitObserver = (target) => {
          if (observeTarget === target) return;
          observeTarget = target;
          waitObserver.disconnect();
          waitObserver.observe(target, { childList: true, subtree: true });
        };
        const armBodyWaitObserver = () => {
          armWaitObserver(doc.body ?? doc.documentElement);
        };
        armBodyWaitObserver();
        const recheckTimer = setInterval(() => {
          if (container !== void 0 && container.isConnected) return;
          armBodyWaitObserver();
          ensure();
        }, RECHECK_INTERVAL_MS2);
        const applyActive = () => {
          if (options.state.isOpen()) {
            for (const attribute of SIBLING_ACTIVE_ATTRIBUTES) {
              doc.documentElement.removeAttribute(attribute);
            }
            doc.documentElement.setAttribute(ACTIVE_ATTRIBUTE, "");
            for (const detail of activationBroadcasts()) {
              const event = new CustomEvent(PANEL_ACTIVATE_EVENT, { detail });
              markPanelActivation(event);
              doc.dispatchEvent(event);
            }
          } else {
            doc.documentElement.removeAttribute(ACTIVE_ATTRIBUTE);
          }
        };
        const onOtherActivate = (event) => {
          if (!options.state.isOpen()) return;
          if (shouldRelinquishColumn(event)) options.state.setOpen(false);
        };
        const onClickSidebarRow = (event) => {
          if (!options.state.isOpen()) return;
          const target = event.target;
          if (target === null) return;
          if (target.closest(SIDEBAR_SESSION_ROW_SELECTOR) !== null) options.state.setOpen(false);
        };
        doc.addEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
        doc.addEventListener("click", onClickSidebarRow, true);
        const unsubscribeState = options.state.subscribe(applyActive);
        const unsubscribeRefresh = options.refresh?.(() => {
          if (container === void 0) return;
          disposeContainer();
          ensure();
        });
        applyActive();
        ensure();
        return () => {
          doc.removeEventListener(PANEL_ACTIVATE_EVENT, onOtherActivate);
          doc.removeEventListener("click", onClickSidebarRow, true);
          clearInterval(recheckTimer);
          waitObserver.disconnect();
          unsubscribeRefresh?.();
          unsubscribeState();
          doc.documentElement.removeAttribute(ACTIVE_ATTRIBUTE);
          disposeContainer();
        };
      }
    
      // src/client/frame.ts
      var TRANSPARENT_BACKGROUND = "transparent";
      function applyFrameTransparency(frame) {
        frame.setAttribute("allowtransparency", "true");
        frame.setAttribute("background", TRANSPARENT_BACKGROUND);
        frame.style.background = TRANSPARENT_BACKGROUND;
        frame.style.backgroundColor = TRANSPARENT_BACKGROUND;
      }
    
      // src/client/theme.ts
      var OBSERVED_ATTRIBUTES = [...THEME_WATCH_ATTRIBUTES];
      function modeFromThemeAttributes(element) {
        if (element.hasAttribute(DARK_THEME_ATTRIBUTE)) return "dark";
        if (element.hasAttribute(LIGHT_THEME_ATTRIBUTE)) return "light";
        return void 0;
      }
      function modeFromThemeValueAttributes(element) {
        for (const name of THEME_VALUE_ATTRIBUTES) {
          const value = element.getAttribute(name);
          if (value === "dark" || value === "light") return value;
        }
        return void 0;
      }
      function modeFromInlineColorScheme(element) {
        if (!(element instanceof HTMLElement) || element.style === void 0) return void 0;
        const inlineScheme = element.style.colorScheme;
        if (inlineScheme === "dark") return "dark";
        if (inlineScheme === "light") return "light";
        return void 0;
      }
      function modeFromClassTokens(element) {
        try {
          if (element.classList.contains(THEME_CLASS_DARK)) return "dark";
          if (element.classList.contains(THEME_CLASS_LIGHT)) return "light";
        } catch {
        }
        return void 0;
      }
      function detectThemeMode(doc) {
        const elements = [doc.body, doc.documentElement];
        const layers = [
          modeFromThemeAttributes,
          modeFromThemeValueAttributes,
          modeFromInlineColorScheme,
          modeFromClassTokens
        ];
        for (const layer of layers) {
          for (const element of elements) {
            if (element === null) continue;
            const mode = layer(element);
            if (mode !== void 0) return mode;
          }
        }
        const query = doc.defaultView?.matchMedia?.(THEME_MEDIA_QUERY);
        return query?.matches === true ? "dark" : "light";
      }
      function watchThemeMode(doc, listener) {
        let current = detectThemeMode(doc);
        const sync = () => {
          const next = detectThemeMode(doc);
          if (next === current) return;
          current = next;
          try {
            listener(next);
          } catch {
          }
        };
        const observer = new MutationObserver(sync);
        const targets = [doc.documentElement];
        if (doc.body !== null) targets.push(doc.body);
        for (const target of targets) {
          observer.observe(target, { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
        }
        const query = doc.defaultView?.matchMedia?.(THEME_MEDIA_QUERY);
        const media = query;
        if (media?.addEventListener !== void 0) media.addEventListener("change", sync);
        else media?.addListener?.(sync);
        return () => {
          observer.disconnect();
          if (media?.removeEventListener !== void 0) media.removeEventListener("change", sync);
          else media?.removeListener?.(sync);
        };
      }
    
      // src/client/styles.ts
      var ENTRY_ICON_ATTRIBUTE = "data-dsh-tlmemory-icon";
      var ENTRY_LABEL_ATTRIBUTE = "data-dsh-tlmemory-label";
      var CLIENT_CSS = `
    /* --- \u4E2D\u5FC3\u5217\u63A5\u7BA1\uFF08\u5168\u5C40\u89C4\u5219\uFF0C\u6309\u5C5E\u6027\u4F5C\u7528\u57DF\u9650\u5B9A\uFF09 ------------------------------- */
    
    [data-pane='conversation'],
    [class*='centerCol'] {
      position: relative;
    }
    
    /* \u9762\u677F\u5BB9\u5668\u4F5C\u4E3A\u4E2D\u5FC3\u5217\u7684\u5C3E\u90E8\u5B50\u8282\u70B9\uFF1B\u672A\u6FC0\u6D3B\u65F6\u5B8C\u5168\u4E0D\u53C2\u4E0E\u5E03\u5C40\u3002 */
    [${VIEW_ATTRIBUTE}] {
      position: absolute;
      inset: 0;
      display: none;
      /* \u9AD8\u4E8E\u4F1A\u8BDD\u8F93\u5165\u5361\uFF080.1.2 shell \u4E2D z-index: 7\uFF09\uFF0C\u8BA9\u9762\u677F\u4E0E\u5176\u5F39\u5C42\u5B8C\u6574\u8986\u76D6\u3002 */
      z-index: 60;
      overflow: hidden;
      /* \u900F\u660E\u5E95\uFF1A\u672C\u5BB9\u5668\u4E0D\u50CF\u4F1A\u8BDD\u5185\u5BB9\u90A3\u6837\u81EA\u5E26\u5E95\u8272\uFF0C\u5BBF\u4E3B\u7684\u4E3B\u9898\u80CC\u666F\u7531\u6B64\u7A7F\u900F\u5230\u770B\u677F\u4E4B\u4E0B\uFF0C
         \u770B\u677F\u4E0D\u518D\u662F\u4E00\u5757\u4E0E\u5BBF\u4E3B\u4E3B\u9898\u8131\u8282\u7684\u8865\u4E01\u3002\u4F1A\u8BDD\u5185\u5BB9\u4E0D\u900F\u51FA\u7531\u4E0B\u65B9\u90A3\u6761
         'display: none !important' \u89C4\u5219\u4FDD\u8BC1\uFF0C\u4E0D\u4F9D\u8D56\u5E95\u8272\u906E\u6321\u3002 */
      background: transparent;
    }
    
    /* \u4E2D\u5FC3\u5217\u5355\u5360\uFF1A\u4EC5\u5F53\u5144\u5F1F\u9762\u677F\uFF08\u4EFB\u52A1\u770B\u677F / SSH\uFF09\u90FD\u672A\u6FC0\u6D3B\u65F6\u624D\u663E\u793A\u672C\u9762\u677F\uFF0C
       \u4E09\u8005\u7684\u6FC0\u6D3B\u6807\u8BB0\u540C\u65F6\u5B58\u5728\u65F6\u4E0D\u4F1A\u4E92\u76F8\u62A2\u663E\u793A\u3002 */
    html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [${VIEW_ATTRIBUTE}] {
      display: block;
    }
    
    /* \u672C\u9762\u677F\u6FC0\u6D3B\u671F\u95F4\u9690\u85CF\u4F1A\u8BDD\u5185\u5BB9\uFF08\u5B50\u6811\u4FDD\u6301\u6302\u8F7D\u4E0E\u72B6\u6001\uFF0C\u53EA\u662F\u4E0D\u53C2\u4E0E\u663E\u793A\uFF09\u3002 */
    html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([${VIEW_ATTRIBUTE}]),
    html[${ACTIVE_ATTRIBUTE}]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([${VIEW_ATTRIBUTE}]) {
      display: none !important;
    }
    
    /* --- \u4FA7\u680F\u5165\u53E3\u884C\uFF08\u4E0E\u4EFB\u52A1\u770B\u677F / SSH / \u6280\u80FD\u4E2D\u5FC3\u5E76\u5217\u5E38\u9A7B\uFF09 ---------------------- */
    
    [${ENTRY_ATTRIBUTE}] {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 36px;
      padding: 0 10px;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: var(--dsw-alias-label-secondary, inherit);
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      line-height: 20px;
      text-align: left;
      white-space: nowrap;
      transition: background-color 120ms ease, color 120ms ease;
    }
    
    [${ENTRY_ATTRIBUTE}]:hover {
      background: var(--dsw-alias-interactive-bg-hover);
      color: var(--dsw-alias-label-primary, inherit);
    }
    
    [${ENTRY_ATTRIBUTE}][data-active] {
      background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));
      color: var(--dsw-alias-label-primary, inherit);
      font-weight: 600;
    }
    
    [${ENTRY_ATTRIBUTE}]:focus-visible {
      outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
      outline-offset: 2px;
    }
    
    /* \u56FE\u6807\u76D2\u56FA\u5B9A 24\xD724\u3001SVG 18\xD718\uFF1A\u4E0E shell \u4FA7\u680F\u5BFC\u822A\u56FE\u6807\u7684\u51E0\u4F55\u4E00\u81F4\uFF0C
       \u6362\u56FE\u6807\u6216 SVG \u56FA\u6709\u5C3A\u5BF8\u53D8\u5316\u90FD\u4E0D\u4F1A\u8BA9\u57FA\u7EBF\u504F\u79FB\u3002 */
    [${ENTRY_ATTRIBUTE}] [${ENTRY_ICON_ATTRIBUTE}] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 24px;
      height: 24px;
    }
    
    [${ENTRY_ATTRIBUTE}] [${ENTRY_ICON_ATTRIBUTE}] > svg {
      display: block;
      width: 18px;
      height: 18px;
    }
    
    [${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}] {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    /* \u6298\u53E0\u8F68\uFF0856px rail\uFF09\uFF1A\u53EA\u663E\u56FE\u6807\u3001\u5706\u5F62\u5C45\u4E2D\uFF0C\u4E0E shell \u7684 rail \u6309\u94AE\u4E00\u81F4\u3002 */
    [data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}],
    [data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] {
      justify-content: center;
      padding: 0;
      width: 36px;
      min-height: 36px;
      margin: 0 auto 12px;
      border-radius: 50%;
    }
    
    [data-dsh-frame][data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}],
    [data-sidebar-collapsed] [${ENTRY_ATTRIBUTE}] [${ENTRY_LABEL_ATTRIBUTE}] {
      display: none;
    }
    
    /* --- \u9762\u677F\u5185\u90E8\uFF08\u900F\u660E\u900F\u4F20 + \u6807\u51C6\u56DE\u9000\u5934 + \u5168\u5E45 iframe\uFF09 ---------------------- */
    
    /* \u9762\u677F\u5916\u6846\u900F\u660E\uFF1A\u80CC\u666F\u4EA4\u7531\u5BBF\u4E3B\u4E2D\u5FC3\u5217\u63D0\u4F9B\uFF0C\u914D\u8272\u7531\u770B\u677F\u5185\u90E8\u7684\u4E3B\u9898\u4EE4\u724C\u5C42\u8D1F\u8D23
       \uFF08\u770B\u677F\u662F\u8DE8\u6E90 iframe\uFF0C\u65E0\u6CD5\u7EE7\u627F\u5BBF\u4E3B\u7684 CSS \u53D8\u91CF\uFF0C\u9760 postMessage \u540C\u6B65 light/dark\uFF09\u3002 */
    .tlmemory-panel {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      padding: 14px 16px 16px;
      gap: 12px;
      background: transparent;
      color: var(--dsw-alias-label-primary, inherit);
      font-family: var(--dsw-font-family, inherit);
    }
    
    /* \u6807\u9898\u680F\uFF1A\u5DE6\u4FA7\u300C\u56DE\u9000 + \u6807\u9898\u7EC4\u300D\uFF0C\u53F3\u4FA7\u6574\u6BB5\u7559\u7A7A\u3002
       padding-right \u662F**\u5BBF\u4E3B\u5B89\u5168\u533A** \u2014\u2014 \u4E2D\u5FC3\u5217\u6574\u5E45\u63A5\u7BA1\u65F6\uFF0C\u9762\u677F\u53F3\u4E0A\u89D2\u4E0E\u5BBF\u4E3B\u53F3\u4E0A\u89D2\u7684
       \u62BD\u5C49\u6298\u53E0\u6309\u94AE\u91CD\u53E0\uFF0C\u4EFB\u4F55\u8D34\u53F3\u7684\u63A7\u4EF6\u90FD\u4F1A\u76D6\u4F4F\u5BBF\u4E3B\u81EA\u5DF1\u7684\u56FE\u6807\u3002\u8FD9\u91CC\u4FDD\u7559 48px
       \uFF08\u53E0\u52A0 .tlmemory-panel \u7684 16px \u53F3\u5185\u8FB9\u8DDD\uFF0C\u5B9E\u9645\u79BB\u89C6\u53E3\u53F3\u7F18 64px\uFF09\uFF0C
       \u6240\u6709\u63A7\u4EF6\u4E00\u5F8B\u5DE6\u5BF9\u9F50\u6392\u5E03\uFF0C\u7EDD\u4E0D\u4F7F\u7528 margin-left:auto / \u8D34\u53F3\u5B9A\u4F4D\u3002 */
    .tlmemory-header {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: none;
      padding-right: 48px;
    }
    
    /* \u6807\u9898\u7EC4\uFF1A\u6807\u9898 + \u72B6\u6001\u80F6\u56CA + \uFF08\u79BB\u7EBF\u65F6\uFF09\u91CD\u8BD5\u6309\u94AE\uFF0C\u540C\u4E00\u57FA\u51C6\u7EBF\u5DE6\u5BF9\u9F50\u3002
       \u95F4\u9699\u7528 gap \u7EDF\u4E00\u7ED9 8px\uFF08\u7B49\u4EF7\u4E8E\u72B6\u6001\u80F6\u56CA\u7684 margin-left: 8px \u4E14\u4E0D\u4F1A\u4E0E\u91CD\u8BD5\u6309\u94AE\u91CD\u590D\u53E0\u52A0\uFF09\u3002 */
    .tlmemory-heading {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    
    .tlmemory-title {
      margin: 0;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 16px;
      font-weight: 700;
      color: var(--dsw-alias-label-primary, inherit);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .tlmemory-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex: none;
      padding: 5px 12px;
      font-family: inherit;
      font-size: 12px;
      color: var(--dsw-alias-label-primary, inherit);
      background: transparent;
      border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 120ms ease;
    }
    
    .tlmemory-back:hover {
      background: var(--dsw-alias-interactive-bg-hover);
    }
    
    .tlmemory-back:focus-visible,
    .tlmemory-retry:focus-visible {
      outline: 2px solid var(--dsw-alias-state-business-primary, #3b82f6);
      outline-offset: 2px;
    }
    
    /* \u72B6\u6001\u6307\u793A\u5668\uFF1A\u7D27\u51D1\u6B21\u7EA7\u80F6\u56CA\uFF0C\u7D27\u8DDF\u6807\u9898\u4E4B\u540E\uFF08\u5DE6\u5BF9\u9F50\uFF09\uFF0C\u4E0D\u518D\u8D34\u53F3\u7AEF\u3002
       \u534A\u900F\u660E\u5E95 + \u4EE4\u724C\u8272\uFF0C\u968F light / dark / skin \u81EA\u52A8\u8DDF\u968F\uFF1B\u4E0D\u5199\u6B7B\u7EAF\u8272\u3002 */
    .tlmemory-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: none;
      max-width: 100%;
      box-sizing: border-box;
      padding: 2px 8px;
      border-radius: 9999px;
      background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
      color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
      font-size: 12px;
      line-height: 18px;
      white-space: nowrap;
    }
    
    /* \u6587\u6848\u8FC7\u957F\uFF08\u7A84\u9762\u677F\uFF09\u65F6\u53EA\u622A\u65AD\u6587\u5B57\uFF0C\u80F6\u56CA\u672C\u8EAB\u4E0D\u6491\u7834\u6807\u9898\u7EC4 */
    .tlmemory-status-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .tlmemory-dot {
      flex: none;
      font-size: 10px;
      line-height: 1;
    }
    
    .tlmemory-retry {
      flex: none;
      padding: 3px 10px;
      font-family: inherit;
      font-size: 12px;
      color: var(--dsw-alias-label-primary, inherit);
      background: transparent;
      border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
      border-radius: 6px;
      cursor: pointer;
    }
    
    .tlmemory-retry:hover {
      background: var(--dsw-alias-interactive-bg-hover);
    }
    
    /* iframe \u627F\u8F7D\u533A\uFF1A\u7236\u7EA7\u5DF2\u6709\u786E\u5B9A\u9AD8\u5EA6\uFF08\u5BB9\u5668 absolute inset:0\uFF09\uFF0C
       \u56E0\u6B64 flex:1 + min-height:0 \u5373\u53EF\u81EA\u9002\u5E94\uFF0C\u4E0D\u9700\u8981\u4EFB\u4F55 vh \u4F30\u7B97\u3002 */
    .tlmemory-body {
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: transparent;
    }
    
    /* iframe \u81EA\u8EAB\u900F\u660E\uFF1A\u6D4F\u89C8\u5668\u9ED8\u8BA4\u7ED9 iframe \u4E00\u5C42\u4E0D\u900F\u660E\u767D\u5E95\uFF0C\u4F1A\u76D6\u4F4F\u5BBF\u4E3B\u80CC\u666F\uFF1B
       allowtransparency / background \u5C5E\u6027\u4E0E inline style \u7531 frame.ts \u5728\u6302\u8F7D\u65F6\u8865\u9F50
       \uFF08\u5185\u8054\u6837\u5F0F\u4F18\u5148\u7EA7\u9AD8\u4E8E\u672C\u8868\uFF0C\u6545\u8FD9\u91CC\u53EA\u9700\u515C\u4F4F\u9ED8\u8BA4\u503C\uFF09\u3002
       \u2605 color-scheme \u5FC5\u987B\u663E\u5F0F normal\uFF1Aiframe \u5143\u7D20\u4E0A\u4EFB\u4F55\u975E normal \u503C\uFF08\u542B light dark /
       dark\uFF0C\u542B\u4ECE .tlmemory-panel \u7EE7\u627F\u6765\u7684\u503C\uFF09\u90FD\u4F1A\u8BA9 Chromium \u628A iframe \u753B\u5E03\u6D82\u6210
       \u4E0D\u900F\u660E\u767D\uFF08\u77E9\u9635\u5B9E\u9A8C\u5B9E\u8BC1\uFF1Anone/normal = \u900F\u4F20\uFF0Clight dark/dark = (255,255,255)\uFF09\uFF0C
       \u5BBF\u4E3B\u7684\u4E3B\u9898\u80CC\u666F\u4ECE\u6B64\u518D\u4E5F\u900F\u4E0D\u4E0A\u6765\u3002\u6EDA\u52A8\u6761 / \u8868\u5355\u63A7\u4EF6\u7684\u914D\u8272\u7531 iframe \u6587\u6863\u5185\u90E8\u7684
       .tlm-app / .tlm-drawer \u5728\u5143\u7D20\u7EA7\u58F0\u660E\uFF08\u5B9E\u9A8C\u8BC1\u660E\u4E0D\u5F71\u54CD\u753B\u5E03\uFF09\u3002 */
    .tlmemory-frame {
      display: block;
      width: 100%;
      height: 100%;
      flex: 1;
      min-height: 0;
      border: none;
      background: transparent !important;
      color-scheme: normal;
    }
    
    .tlmemory-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      background: var(--dsw-alias-bg-base, #ffffff);
      color: var(--dsw-alias-label-secondary, inherit);
      font-size: 13px;
    }
    
    .tlmemory-overlay-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      max-width: 420px;
    }
    
    .tlmemory-overlay-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--dsw-alias-label-primary, inherit);
    }
    
    .tlmemory-overlay-hint {
      font-size: 12px;
      line-height: 1.6;
      color: var(--dsw-alias-label-tertiary, inherit);
    }
    
    .tlmemory-spinner {
      width: 18px;
      height: 18px;
      flex: none;
      border: 2px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.45));
      border-top-color: var(--dsw-alias-state-business-primary, #3b82f6);
      border-radius: 50%;
      animation: tlmemory-spin 800ms linear infinite;
    }
    
    @keyframes tlmemory-spin {
      to { transform: rotate(360deg); }
    }
    
    /* \u89E6\u5C4F\u5C3A\u5BF8\uFF1A\u5165\u53E3\u4E0E\u56DE\u9000\u6309\u94AE\u62AC\u5230 44px \u53EF\u70B9\u533A\u3002 */
    @media (max-width: 768px) {
      [${ENTRY_ATTRIBUTE}] {
        min-height: 44px;
      }
    
      .tlmemory-back,
      .tlmemory-retry {
        min-height: 32px;
      }
    }
    
    @media (prefers-reduced-motion: reduce) {
      [${ENTRY_ATTRIBUTE}],
      .tlmemory-back {
        transition: none;
      }
    
      .tlmemory-spinner {
        animation: none;
      }
    }
    `;
      var STYLE_SELECTOR = `style[data-plugin-css="${STYLE_ID}"]`;
      function ensureClientStyles(doc = document) {
        if (doc.querySelector(STYLE_SELECTOR) !== null) return false;
        const tag = doc.createElement("style");
        tag.dataset.plugin = "dsh-plugin-tlmemory";
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = CLIENT_CSS;
        doc.head.appendChild(tag);
        return true;
      }
      function removeClientStyles(doc = document) {
        doc.querySelector(STYLE_SELECTOR)?.remove();
      }
    
      // src/client/settings.tsx
      var import_react = __toESM(__require("react"), 1);
    
      // src/client/settings-logic.ts
      var SETTINGS_NS = "dsh-plugin-tlmemory";
      var SETTINGS_NS_HINT = "tlmemory";
      function isRecord(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
      }
      function unwrap(response) {
        if (isRecord(response) && "ok" in response) {
          if (response.ok === true) {
            return { ok: true, value: response.value };
          }
          const error = response.error;
          const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
          const code = isRecord(error) && typeof error.code === "string" ? error.code : void 0;
          return { ok: false, message: message === "" ? "settings request rejected" : message, code };
        }
        return { ok: true, value: response };
      }
      function pickNamespace(view, preferred = SETTINGS_NS) {
        const namespaces = isRecord(view) && Array.isArray(view.namespaces) ? view.namespaces : [];
        const exact = namespaces.find((ns) => ns?.ns === preferred);
        if (exact !== void 0) return exact;
        const candidates = namespaces.filter(
          (ns) => typeof ns?.ns === "string" && ns.ns.toLowerCase().includes(SETTINGS_NS_HINT)
        );
        return candidates.length === 1 ? candidates[0] : void 0;
      }
      function rootNode(schema) {
        if (!isRecord(schema)) return void 0;
        const refs = isRecord(schema.refs) ? schema.refs : void 0;
        const uid = typeof schema.uid === "number" ? schema.uid : void 0;
        if (refs !== void 0 && uid !== void 0) {
          const root = refs[String(uid)];
          if (isRecord(root)) return root;
        }
        return typeof schema.type === "string" ? schema : void 0;
      }
      function resolveDictNode(schema, entry) {
        if (isRecord(entry) && typeof entry.type === "string") return entry;
        if (typeof entry !== "number") return void 0;
        const refs = isRecord(schema) && isRecord(schema.refs) ? schema.refs : void 0;
        const node = refs?.[String(entry)];
        return isRecord(node) ? node : void 0;
      }
      function textOf(value) {
        return typeof value === "string" && value !== "" ? value : void 0;
      }
      function normalize(type, raw) {
        if (type === "boolean") return raw === true;
        if (raw === void 0 || raw === null) return "";
        if (type === "number") return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : String(raw);
        return String(raw);
      }
      function fieldsFromView(view) {
        const root = rootNode(view?.schema);
        const dict = isRecord(root) && isRecord(root.dict) ? root.dict : void 0;
        if (dict === void 0) return [];
        const values = isRecord(view) && isRecord(view.value) ? view.value : {};
        const fields = [];
        for (const [key, entry] of Object.entries(dict)) {
          const node = resolveDictNode(view?.schema, entry);
          const type = node?.type;
          if (type !== "string" && type !== "number" && type !== "boolean") continue;
          const meta = isRecord(node) && isRecord(node.meta) ? node.meta : {};
          const declared = meta.default;
          const raw = values[key] !== void 0 ? values[key] : declared;
          const defaultText = declared === void 0 || declared === null ? void 0 : normalize(type, declared) === "" ? void 0 : String(normalize(type, declared));
          fields.push({
            key,
            type,
            value: normalize(type, raw),
            defaultText,
            hint: textOf(meta.description)
          });
        }
        return fields;
      }
      function draftOf(fields) {
        const draft = {};
        for (const field of fields) draft[field.key] = field.value;
        return draft;
      }
      function isDirty(fields, draft) {
        for (const field of fields) {
          if ((draft[field.key] ?? field.value) !== field.value) return true;
        }
        return false;
      }
      function buildSavePlan(fields, draft) {
        const patch = {};
        const unset = [];
        for (const field of fields) {
          const next = draft[field.key] ?? field.value;
          if (next === field.value) continue;
          if (field.type === "boolean") {
            patch[field.key] = next === true;
            continue;
          }
          const text = String(next).trim();
          if (field.type === "string") {
            if (text === "") unset.push(field.key);
            else patch[field.key] = text;
            continue;
          }
          const parsed = Number(text);
          if (text === "" || !Number.isFinite(parsed)) return { patch: {}, unset: [], invalid: field.key };
          patch[field.key] = parsed;
        }
        return { patch, unset };
      }
      function resetField(field, draft) {
        const next = { ...draft };
        if (field.defaultText !== void 0) next[field.key] = field.type === "boolean" ? field.defaultText === "true" : field.defaultText;
        else next[field.key] = field.type === "boolean" ? false : "";
        return next;
      }
      var SettingsPanelController = class {
        constructor(transport) {
          __publicField(this, "transport");
          __publicField(this, "listeners", /* @__PURE__ */ new Set());
          __publicField(this, "snapshot", {
            status: "loading",
            writable: false,
            fields: [],
            draft: {},
            dirty: false,
            busy: false,
            messageKey: null,
            messageKind: "info"
          });
          __publicField(this, "disposed", false);
          /** 写入串行化：并发点击保存不会互相踩 revision */
          __publicField(this, "tail", Promise.resolve());
          this.transport = transport;
        }
        getSnapshot() {
          return this.snapshot;
        }
        subscribe(listener) {
          this.listeners.add(listener);
          return () => {
            this.listeners.delete(listener);
          };
        }
        dispose() {
          this.disposed = true;
          this.listeners.clear();
        }
        emit(patch) {
          this.snapshot = { ...this.snapshot, ...patch };
          for (const listener of this.listeners) listener(this.snapshot);
        }
        /** 重新从宿主读取 schema 与当前值 */
        async load() {
          if (this.disposed) return;
          this.emit({ status: "loading", busy: true });
          const outcome = unwrap(await this.transport.describe());
          if (this.disposed) return;
          if (!outcome.ok) {
            this.emit({ status: "error", busy: false, messageKey: "loadFailed", messageKind: "error" });
            return;
          }
          const view = pickNamespace(outcome.value);
          if (view === void 0) {
            this.emit({
              status: "unavailable",
              busy: false,
              ns: void 0,
              fields: [],
              draft: {},
              dirty: false,
              messageKey: "unavailable",
              messageKind: "error"
            });
            return;
          }
          const fields = fieldsFromView(view);
          this.emit({
            status: "ready",
            busy: false,
            ns: view.ns,
            revision: typeof view.revision === "number" ? view.revision : void 0,
            writable: outcome.value?.writable !== false,
            fields,
            draft: draftOf(fields),
            dirty: false,
            messageKey: null,
            messageKind: "info"
          });
        }
        setDraft(key, value) {
          if (this.disposed) return;
          const draft = { ...this.snapshot.draft, [key]: value };
          this.emit({ draft, dirty: isDirty(this.snapshot.fields, draft) });
        }
        resetFieldToDefault(key) {
          if (this.disposed) return;
          const field = this.snapshot.fields.find((candidate) => candidate.key === key);
          if (field === void 0) return;
          const draft = resetField(field, this.snapshot.draft);
          this.emit({ draft, dirty: isDirty(this.snapshot.fields, draft) });
        }
        /** 保存：先 unset（清空字段）再 update（值字段），每一步都带当前 revision */
        save() {
          const run = this.tail.then(async () => {
            if (this.disposed) return;
            const { ns, fields, draft, revision } = this.snapshot;
            if (ns === void 0) return;
            const plan = buildSavePlan(fields, draft);
            if (plan.invalid !== void 0) {
              this.emit({ messageKey: "invalidNumber", messageKind: "error" });
              return;
            }
            if (plan.unset.length === 0 && Object.keys(plan.patch).length === 0) {
              this.emit({ messageKey: "noChanges", messageKind: "info" });
              return;
            }
            this.emit({ busy: true, messageKey: "saving", messageKind: "info" });
            let expected = revision;
            if (plan.unset.length > 0) {
              const ops = plan.unset.map((key) => ({ op: "unset", path: [key] }));
              const written = unwrap(await this.transport.mutate(ns, ops, expected));
              if (!written.ok) {
                await this.fail(written.message, written.code);
                return;
              }
              expected = written.value?.revision ?? expected;
            }
            if (Object.keys(plan.patch).length > 0) {
              const written = unwrap(await this.transport.update(ns, plan.patch, expected));
              if (!written.ok) {
                await this.fail(written.message, written.code);
                return;
              }
            }
            await this.load();
            if (this.disposed) return;
            this.emit({ messageKey: "saved", messageKind: "info" });
          });
          this.tail = run.then(
            () => {
            },
            () => {
            }
          );
          return run;
        }
        /** 写入失败的统一收尾：重读宿主状态，冲突给出可操作提示 */
        async fail(message, code) {
          await this.load();
          if (this.disposed) return;
          this.emit({
            messageKey: code === "settings/conflict" ? "conflict" : "saveFailed",
            messageKind: "error",
            busy: false
          });
          if (code !== "settings/conflict") {
            console.warn("[tlmemory] \u4FDD\u5B58\u8BBE\u7F6E\u5931\u8D25\uFF1A", message);
          }
        }
      };
    
      // src/client/settings.tsx
      var SETTINGS_LOCALE_NS = "settings.tlmemory";
      var SETTINGS_SECTION_ID = "tlmemory";
      var SETTINGS_SECTION_ORDER = 30;
      var FIELD_LABEL_KEYS = {
        dbPath: "field.dbPath",
        serverPort: "field.serverPort",
        maxRecallCount: "field.maxRecallCount",
        enableAutoReflection: "field.enableAutoReflection",
        compactionInterval: "field.compactionInterval",
        enableAutoMerge: "field.enableAutoMerge"
      };
      var FIELD_HINT_KEYS = {
        dbPath: "hint.dbPath",
        serverPort: "hint.serverPort",
        maxRecallCount: "hint.maxRecallCount",
        enableAutoReflection: "hint.enableAutoReflection",
        compactionInterval: "hint.compactionInterval",
        enableAutoMerge: "hint.enableAutoMerge"
      };
      var zh = {
        nav: "\u8BB0\u5FC6",
        title: "TLMemory \u957F\u671F\u8BB0\u5FC6",
        description: "\u914D\u7F6E\u8BB0\u5FC6\u5E93\u4F4D\u7F6E\u4E0E\u53EC\u56DE\u884C\u4E3A\u3002\u4FDD\u5B58\u540E\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
        "field.dbPath": "\u6570\u636E\u5E93\u8DEF\u5F84",
        "field.serverPort": "\u770B\u677F\u670D\u52A1\u7AEF\u53E3",
        "field.maxRecallCount": "\u5355\u8F6E\u53EC\u56DE\u6761\u6570",
        "field.enableAutoReflection": "\u81EA\u52A8\u63D0\u70BC\u8BB0\u5FC6",
        "field.compactionInterval": "\u81EA\u52A8\u63D0\u70BC\u95F4\u9694\uFF08\u8F6E\uFF09",
        "field.enableAutoMerge": "\u81EA\u52A8\u5F52\u5E76\u76F8\u8FD1\u8BB0\u5FC6",
        "hint.dbPath": "\u7559\u7A7A\u5219\u4F7F\u7528\u9ED8\u8BA4\u8DEF\u5F84 ~/.dsh/tlmemory.db\uFF1B\u9996\u6B21\u542F\u52A8\u81EA\u52A8\u5EFA\u5E93\u5EFA\u8868\u3002",
        "hint.serverPort": "\u8BB0\u5FC6\u770B\u677F\u670D\u52A1\u76D1\u542C\u7684\u672C\u5730\u7AEF\u53E3\uFF08\u4EC5\u56DE\u73AF\u5730\u5740\uFF09\u3002",
        "hint.maxRecallCount": "\u6BCF\u8F6E\u5BF9\u8BDD\u6700\u591A\u6CE8\u5165\u51E0\u6761\u76F8\u5173\u8BB0\u5FC6\u3002",
        "hint.enableAutoReflection": "\u5F00\u542F\u540E\uFF0C\u5BF9\u8BDD\u7ED3\u675F\u4F1A\u540E\u53F0\u63D0\u70BC\u53EF\u590D\u7528\u7684\u4E8B\u5B9E\u4E0E\u504F\u597D\u3002",
        "hint.compactionInterval": "\u6BCF\u7D2F\u8BA1\u591A\u5C11\u8F6E\u5BF9\u8BDD\u89E6\u53D1\u4E00\u6B21\u540E\u53F0\u63D0\u70BC\u3002",
        "hint.enableAutoMerge": "\u628A\u540C\u4E00\u4E3B\u9898\u7684\u591A\u6761\u77ED\u8BB0\u5FC6\u6298\u53E0\u6210\u4E00\u6761\u6458\u8981\uFF0C\u539F\u53E5\u4FDD\u7559\u5728\u5E93\u91CC\u53EF\u56DE\u6EDA\u3002",
        defaultText: "\u9ED8\u8BA4\u503C",
        emptyText: "\u672A\u8BBE\u7F6E",
        reset: "\u6062\u590D\u9ED8\u8BA4",
        save: "\u4FDD\u5B58",
        saving: "\u4FDD\u5B58\u4E2D\u2026",
        discard: "\u653E\u5F03\u6539\u52A8",
        saved: "\u5DF2\u4FDD\u5B58\uFF0C\u65B0\u914D\u7F6E\u7ACB\u5373\u751F\u6548\u3002",
        noChanges: "\u6CA1\u6709\u9700\u8981\u4FDD\u5B58\u7684\u6539\u52A8\u3002",
        invalidNumber: "\u8BF7\u586B\u5199\u6570\u5B57\uFF0C\u6216\u70B9\u300C\u6062\u590D\u9ED8\u8BA4\u300D\u3002",
        conflict: "\u914D\u7F6E\u521A\u88AB\u5176\u5B83\u7A97\u53E3\u6539\u52A8\uFF0C\u5DF2\u91CD\u65B0\u8F7D\u5165\u6700\u65B0\u503C\uFF0C\u8BF7\u786E\u8BA4\u540E\u518D\u4FDD\u5B58\u3002",
        saveFailed: "\u5BBF\u4E3B\u6CA1\u6709\u63A5\u53D7\u8FD9\u6B21\u4FEE\u6539\uFF0C\u5DF2\u91CD\u65B0\u8F7D\u5165\u6700\u65B0\u503C\u3002",
        loadFailed: "\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
        unavailable: "\u672A\u5728\u5F53\u524D profile \u4E2D\u627E\u5230\u672C\u63D2\u4EF6\u7684\u914D\u7F6E\u547D\u540D\u7A7A\u95F4\uFF0C\u6682\u65F6\u65E0\u6CD5\u5728\u6B64\u914D\u7F6E\u3002",
        readOnly: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002",
        retry: "\u91CD\u65B0\u8BFB\u53D6",
        loading: "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026",
        namespace: "\u547D\u540D\u7A7A\u95F4",
        revision: "\u7248\u672C"
      };
      var en = {
        nav: "Memory",
        title: "TLMemory long-term memory",
        description: "Configure where memories live and how they are recalled. Changes apply immediately.",
        "field.dbPath": "Database path",
        "field.serverPort": "Dashboard port",
        "field.maxRecallCount": "Recall limit per turn",
        "field.enableAutoReflection": "Auto-distill memories",
        "field.compactionInterval": "Auto-distill interval (turns)",
        "field.enableAutoMerge": "Auto-merge similar memories",
        "hint.dbPath": "Leave blank to use ~/.dsh/tlmemory.db; the database and tables are created on first start.",
        "hint.serverPort": "Loopback port serving the memory dashboard.",
        "hint.maxRecallCount": "How many related memories may be injected into one turn.",
        "hint.enableAutoReflection": "When enabled, reusable facts and preferences are distilled after a turn.",
        "hint.compactionInterval": "Turns accumulated before a background distillation runs.",
        "hint.enableAutoMerge": "Fold same-topic short memories into one summary; originals stay recoverable.",
        defaultText: "Default",
        emptyText: "Not set",
        reset: "Reset to default",
        save: "Save",
        saving: "Saving\u2026",
        discard: "Discard",
        saved: "Saved; the new configuration is active now.",
        noChanges: "Nothing to save.",
        invalidNumber: "Enter a number, or reset the field to its default.",
        conflict: "Another window changed the configuration; the latest values were reloaded.",
        saveFailed: "The host rejected the change; the latest values were reloaded.",
        loadFailed: "Could not read the configuration. Please retry.",
        unavailable: "This plugin has no configuration namespace in the current profile.",
        readOnly: "This deployment stores settings read-only.",
        retry: "Reload",
        loading: "Reading configuration\u2026",
        namespace: "Namespace",
        revision: "Revision"
      };
      var S = {
        root: { display: "flex", flexDirection: "column", gap: "18px", padding: "4px 0 8px" },
        head: { display: "flex", flexDirection: "column", gap: "6px" },
        title: { margin: 0, fontSize: "16px", fontWeight: 600 },
        description: { margin: 0, fontSize: "13px", lineHeight: 1.6, opacity: 0.72 },
        field: { display: "flex", flexDirection: "column", gap: "6px" },
        labelRow: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
        label: { fontSize: "13px", fontWeight: 500 },
        hint: { fontSize: "12px", lineHeight: 1.55, opacity: 0.66 },
        defaultTag: { fontSize: "11px", opacity: 0.55 },
        input: {
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 10px",
          fontSize: "13px",
          borderRadius: "8px",
          border: "1px solid rgba(128,128,128,0.38)",
          background: "transparent",
          color: "inherit",
          font: "inherit"
        },
        checkboxRow: { display: "flex", alignItems: "center", gap: "8px" },
        linkButton: {
          border: "none",
          background: "transparent",
          color: "inherit",
          opacity: 0.62,
          fontSize: "12px",
          cursor: "pointer",
          padding: 0,
          textDecoration: "underline"
        },
        footer: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
        message: { fontSize: "12px", lineHeight: 1.5 },
        primaryButton: {
          padding: "7px 16px",
          fontSize: "13px",
          borderRadius: "8px",
          border: "1px solid rgba(128,128,128,0.4)",
          background: "rgba(128,128,128,0.16)",
          color: "inherit",
          cursor: "pointer",
          font: "inherit"
        },
        meta: { fontSize: "11px", opacity: 0.45, fontFamily: "ui-monospace, Menlo, Consolas, monospace" }
      };
      function disabledStyle(disabled) {
        return disabled ? { ...S.linkButton, opacity: 0.3, cursor: "default" } : { ...S.linkButton };
      }
      function TlmemorySettingsSection(props) {
        const { controller, t } = props;
        const [snapshot, setSnapshot] = import_react.default.useState(() => controller.getSnapshot());
        import_react.default.useEffect(() => controller.subscribe((next) => setSnapshot(next)), [controller]);
        const readOnly = !snapshot.writable || snapshot.status !== "ready";
        const busy = snapshot.busy;
        const canSave = snapshot.dirty && !readOnly && !busy;
        const header = import_react.default.createElement(
          "div",
          { style: { ...S.head } },
          import_react.default.createElement("h3", { style: { ...S.title } }, t("title")),
          import_react.default.createElement("p", { style: { ...S.description } }, t("description"))
        );
        if (snapshot.status === "loading" && snapshot.fields.length === 0) {
          return import_react.default.createElement(
            "div",
            { style: { ...S.root }, "data-tlmemory-settings": "loading" },
            header,
            import_react.default.createElement("p", { style: { ...S.hint } }, t("loading"))
          );
        }
        if (snapshot.status === "unavailable" || snapshot.status === "error") {
          return import_react.default.createElement(
            "div",
            { style: { ...S.root }, "data-tlmemory-settings": snapshot.status },
            header,
            import_react.default.createElement(
              "p",
              { style: { ...S.hint } },
              t(snapshot.messageKey ?? (snapshot.status === "error" ? "loadFailed" : "unavailable"))
            ),
            import_react.default.createElement(
              "div",
              { style: { ...S.footer } },
              import_react.default.createElement("button", { type: "button", style: { ...S.primaryButton }, onClick: () => void controller.load() }, t("retry"))
            )
          );
        }
        const rows = snapshot.fields.map((field) => renderField(field, snapshot, controller, t, readOnly || busy));
        const message = snapshot.messageKey === null ? null : import_react.default.createElement(
          "span",
          {
            style: {
              ...S.message,
              color: snapshot.messageKind === "error" ? "#e5686d" : "inherit",
              opacity: snapshot.messageKind === "error" ? 1 : 0.66
            },
            role: "status",
            "aria-live": "polite"
          },
          t(snapshot.messageKey)
        );
        const meta = snapshot.ns === void 0 ? null : import_react.default.createElement(
          "span",
          { style: { ...S.meta } },
          `${t("namespace")}: ${snapshot.ns}`,
          snapshot.revision === void 0 ? "" : ` \xB7 ${t("revision")}: ${String(snapshot.revision)}`
        );
        return import_react.default.createElement(
          "div",
          { style: { ...S.root }, "data-tlmemory-settings": "ready" },
          header,
          ...rows,
          import_react.default.createElement(
            "div",
            { style: { ...S.footer } },
            import_react.default.createElement(
              "button",
              {
                type: "button",
                style: canSave ? { ...S.primaryButton } : { ...S.primaryButton, opacity: 0.45, cursor: "default" },
                disabled: !canSave,
                onClick: () => {
                  void controller.save();
                }
              },
              busy ? t("saving") : t("save")
            ),
            snapshot.dirty && !busy ? import_react.default.createElement(
              "button",
              { type: "button", style: disabledStyle(readOnly), disabled: readOnly, onClick: () => void controller.load() },
              t("discard")
            ) : null,
            message
          ),
          readOnly ? import_react.default.createElement("p", { style: { ...S.hint } }, t("readOnly")) : null,
          meta
        );
      }
      function renderField(field, snapshot, controller, t, disabled) {
        const labelKey = FIELD_LABEL_KEYS[field.key];
        const hintKey = FIELD_HINT_KEYS[field.key];
        const label = t(labelKey ?? field.key);
        const hint = hintKey === void 0 ? field.hint : t(hintKey);
        const draftValue = snapshot.draft[field.key] ?? field.value;
        const defaultText = field.defaultText === void 0 ? t("emptyText") : `${t("defaultText")}: ${field.defaultText}`;
        const labelRow = import_react.default.createElement(
          "div",
          { style: { ...S.labelRow } },
          import_react.default.createElement("span", { style: { ...S.label } }, label),
          import_react.default.createElement("span", { style: { ...S.defaultTag } }, defaultText),
          import_react.default.createElement(
            "button",
            {
              type: "button",
              style: disabledStyle(disabled),
              disabled,
              title: t("reset"),
              onClick: () => {
                controller.resetFieldToDefault(field.key);
              }
            },
            t("reset")
          )
        );
        const control = field.type === "boolean" ? import_react.default.createElement(
          "label",
          { style: { ...S.checkboxRow } },
          import_react.default.createElement("input", {
            type: "checkbox",
            checked: draftValue === true,
            disabled,
            onChange: (event) => {
              controller.setDraft(field.key, event.target?.checked === true);
            }
          }),
          import_react.default.createElement("span", { style: { ...S.hint } }, hint ?? "")
        ) : import_react.default.createElement("input", {
          type: field.type === "number" ? "number" : "text",
          style: { ...S.input, opacity: disabled ? 0.6 : 1 },
          value: typeof draftValue === "string" ? draftValue : String(draftValue),
          placeholder: field.type === "number" ? field.defaultText ?? "" : "",
          disabled,
          spellcheck: false,
          onChange: (event) => {
            controller.setDraft(field.key, event.target?.value ?? "");
          }
        });
        return import_react.default.createElement(
          "div",
          { style: { ...S.field }, "data-tlmemory-field": field.key },
          labelRow,
          control,
          field.type === "boolean" ? null : import_react.default.createElement("span", { style: { ...S.hint } }, hint ?? "")
        );
      }
      function registerSettingsSection(ctx) {
        const disposers = [];
        const remoteSettings = ctx.remote?.settings;
        if (remoteSettings === void 0 || typeof remoteSettings.describe !== "function") {
          console.warn("[tlmemory] \u5BBF\u4E3B\u672A\u63D0\u4F9B remote.settings\uFF0C\u8DF3\u8FC7\u8BBE\u7F6E\u9762\u677F\u6CE8\u518C");
          return () => {
          };
        }
        const t = ctx.locale.bind(SETTINGS_LOCALE_NS);
        disposers.push(ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en }));
        const controller = new SettingsPanelController(remoteSettings);
        disposers.push(() => controller.dispose());
        void controller.load();
        disposers.push(
          ctx.remote.$on("settings/document-updated", () => {
            void controller.load();
          })
        );
        disposers.push(
          ctx.slots.inject(
            "settings.section",
            () => ctx.slots.register(
              {
                name: "settings.section",
                id: SETTINGS_SECTION_ID,
                order: SETTINGS_SECTION_ORDER,
                label: () => t("nav"),
                locale: SETTINGS_LOCALE_NS,
                inject: () => ({ controller, t })
              },
              TlmemorySettingsSection
            )
          )
        );
        const dispose = () => {
          for (const entry of disposers.splice(0)) {
            try {
              entry();
            } catch (error) {
              console.warn("[tlmemory] \u8BBE\u7F6E\u9762\u677F\u56DE\u6536\u5931\u8D25\uFF1A", error);
            }
          }
        };
        ctx.effect(() => dispose, "tlmemory: settings section");
        return dispose;
      }
    
      // src/client/index.tsx
      var inject = ["slots", "locale", "remote", "remote.settings"];
      var VIEW_DATASET_KEY = "dshTlmemoryView";
      var DOT_COLOR = {
        probing: "var(--dsw-alias-state-warn-primary, #eab308)",
        online: "var(--dsw-alias-state-success-primary, #22c55e)",
        offline: "var(--dsw-alias-state-error-primary, #ef4444)"
      };
      function useThemeMode() {
        const [mode, setMode] = import_react2.default.useState(
          () => typeof document === "undefined" ? "light" : detectThemeMode(document)
        );
        import_react2.default.useEffect(() => {
          if (typeof document === "undefined") return void 0;
          setMode(detectThemeMode(document));
          return watchThemeMode(document, (next) => {
            setMode(next);
          });
        }, []);
        return mode;
      }
      function MemoryDashboardPanel(props) {
        const { state } = props;
        const [health, setHealth] = import_react2.default.useState("probing");
        const [frameLoaded, setFrameLoaded] = import_react2.default.useState(false);
        const [reloadNonce, setReloadNonce] = import_react2.default.useState(0);
        const healthRef = import_react2.default.useRef("probing");
        const frameRef = import_react2.default.useRef(null);
        const theme = useThemeMode();
        const themeRef = import_react2.default.useRef(theme);
        import_react2.default.useEffect(() => {
          healthRef.current = health;
        }, [health]);
        import_react2.default.useEffect(() => {
          themeRef.current = theme;
        }, [theme]);
        const pushTheme = import_react2.default.useCallback(() => {
          const target = frameRef.current?.contentWindow;
          if (target === null || target === void 0) return;
          try {
            target.postMessage(themeMessage(themeRef.current), DASHBOARD_ORIGIN);
            target.postMessage(legacyThemeMessage(themeRef.current), DASHBOARD_ORIGIN);
          } catch {
          }
        }, []);
        import_react2.default.useEffect(() => {
          const frame = frameRef.current;
          if (frame === null || frame === void 0) return;
          applyFrameTransparency(frame);
        }, [reloadNonce]);
        import_react2.default.useEffect(() => {
          if (frameLoaded) pushTheme();
        }, [frameLoaded, theme, pushTheme]);
        import_react2.default.useEffect(() => {
          if (typeof window === "undefined") return void 0;
          const onMessage = (event) => {
            if (!isDashboardOrigin(event.origin)) return;
            if (parseDashboardMessage(event.data) === void 0) return;
            pushTheme();
          };
          window.addEventListener("message", onMessage);
          return () => {
            window.removeEventListener("message", onMessage);
          };
        }, [pushTheme]);
        const applyHealth = import_react2.default.useCallback((ok) => {
          const wasOffline = healthRef.current === "offline";
          const next = ok ? "online" : "offline";
          healthRef.current = next;
          setHealth(next);
          if (!ok) {
            setFrameLoaded(false);
            return;
          }
          if (wasOffline) {
            setFrameLoaded(false);
            setReloadNonce((value) => value + 1);
          }
        }, []);
        const probe = import_react2.default.useCallback(() => {
          void probeDashboardHealth(DASHBOARD_ORIGIN).then((ok) => {
            applyHealth(ok);
          });
        }, [applyHealth]);
        import_react2.default.useEffect(() => {
          probe();
          const timer = setInterval(probe, PROBE_INTERVAL_MS);
          return () => {
            clearInterval(timer);
          };
        }, [probe]);
        import_react2.default.useEffect(
          () => state.subscribe(() => {
            if (state.isOpen()) probe();
          }),
          [probe, state]
        );
        const retry = () => {
          setFrameLoaded(false);
          setReloadNonce((value) => value + 1);
          probe();
        };
        const statusText = health === "probing" ? "\u8FDE\u63A5\u4E2D" : health === "online" ? "\u670D\u52A1\u5728\u7EBF" : "\u670D\u52A1\u672A\u542F\u52A8";
        const showOverlay = health === "offline" || !frameLoaded;
        const overlay = !showOverlay ? null : health === "offline" ? import_react2.default.createElement(
          "div",
          { className: "tlmemory-overlay" },
          import_react2.default.createElement(
            "div",
            { className: "tlmemory-overlay-card" },
            import_react2.default.createElement("span", { className: "tlmemory-overlay-title" }, "\u8BB0\u5FC6\u770B\u677F\u670D\u52A1\u672A\u542F\u52A8"),
            import_react2.default.createElement(
              "span",
              { className: "tlmemory-overlay-hint" },
              `\u672A\u80FD\u8FDE\u63A5 ${DASHBOARD_ORIGIN}\u3002\u8BF7\u786E\u8BA4 DSH \u5BBF\u4E3B\u5DF2\u542F\u52A8\uFF08\u770B\u677F\u670D\u52A1\u968F\u5BBF\u4E3B\u81EA\u52A8\u5F00\u542F\uFF0C\u7AEF\u53E3\u88AB\u5360\u7528\u65F6\u5DF2\u81EA\u52A8\u987A\u5EF6\uFF09\u3002`
            ),
            import_react2.default.createElement("button", { type: "button", className: "tlmemory-retry", onClick: retry }, "\u91CD\u8BD5")
          )
        ) : import_react2.default.createElement(
          "div",
          { className: "tlmemory-overlay" },
          import_react2.default.createElement(
            "div",
            { className: "tlmemory-overlay-card" },
            import_react2.default.createElement("span", { className: "tlmemory-spinner" }),
            import_react2.default.createElement("span", { className: "tlmemory-overlay-hint" }, "\u6B63\u5728\u52A0\u8F7D\u8BB0\u5FC6\u770B\u677F\u2026")
          )
        );
        return import_react2.default.createElement(
          "div",
          { className: "tlmemory-panel", "data-dsh-plugin": PLUGIN_ID, "data-theme": theme },
          // 标题栏布局（右上角安全区）：
          //   [‹ 返回会话] [记忆看板] [● 服务在线] [重试?] ………右侧整段留空………
          // 状态指示器与标题同基准线紧邻成一个左对齐标题组，**不再推到最右端** ——
          // 中心列整幅接管时，面板右上角与宿主右上角的抽屉折叠按钮是同一块区域，
          // 任何贴右的控件都会盖住宿主自己的图标。安全区由 .tlmemory-header 的
          // padding-right 保证（见 styles.ts）。
          import_react2.default.createElement(
            "header",
            { className: "tlmemory-header" },
            import_react2.default.createElement(
              "button",
              {
                type: "button",
                className: "tlmemory-back",
                // 家族协议：中心视图回退控件的共享钩子（skin / 移动端适配据此定位）。
                "data-dsh-center-view-back": "",
                "aria-label": BACK_TO_CONVERSATION_LABEL,
                title: BACK_TO_CONVERSATION_LABEL,
                onClick: () => {
                  state.setOpen(false);
                }
              },
              import_react2.default.createElement("span", { "aria-hidden": "true" }, "\u2039"),
              import_react2.default.createElement("span", null, BACK_TO_CONVERSATION_LABEL)
            ),
            import_react2.default.createElement(
              "div",
              { className: "tlmemory-heading" },
              import_react2.default.createElement("h2", { className: "tlmemory-title" }, DASHBOARD_LABEL),
              import_react2.default.createElement(
                "span",
                {
                  className: "tlmemory-status",
                  "data-dsh-part": "panel-status",
                  title: statusText,
                  role: "status",
                  "aria-live": "polite"
                },
                import_react2.default.createElement("span", { className: "tlmemory-dot", style: { color: DOT_COLOR[health] } }, "\u25CF"),
                import_react2.default.createElement("span", { className: "tlmemory-status-text" }, statusText)
              ),
              health === "offline" ? import_react2.default.createElement("button", { type: "button", className: "tlmemory-retry", onClick: retry }, "\u91CD\u8BD5") : null
            )
          ),
          import_react2.default.createElement(
            "div",
            { className: "tlmemory-body" },
            // 透明底：iframe 自身不铺底色（透明属性在 effect 里经 ref 落到真实元素上，
            // 不依赖 React 对不同版本的遗留属性白名单），宿主背景得以穿透到看板之下。
            import_react2.default.createElement("iframe", {
              key: reloadNonce,
              ref: frameRef,
              className: "tlmemory-frame",
              src: dashboardUrl(DASHBOARD_ORIGIN),
              title: DASHBOARD_LABEL,
              onLoad: () => {
                setFrameLoaded(true);
              }
            }),
            overlay
          )
        );
      }
      function apply(ctx) {
        try {
          registerSettingsSection(ctx);
        } catch (error) {
          console.warn("[tlmemory] \u8BBE\u7F6E\u9762\u677F\u6CE8\u518C\u5931\u8D25\uFF1A", error);
        }
        if (typeof document === "undefined") return;
        if (document.querySelector(ENTRY_SELECTOR) !== null) return;
        if (document.querySelector(VIEW_SELECTOR) !== null) return;
        const stylesCreated = ensureClientStyles();
        const state = createPanelState(false);
        const disposers = [];
        try {
          disposers.push(
            mountSidebarEntry({
              rowAttribute: ENTRY_ATTRIBUTE,
              rowSelector: ENTRY_SELECTOR,
              plugin: PLUGIN_ID,
              icon: ENTRY_ICON,
              label: () => DASHBOARD_LABEL,
              tooltip: () => DASHBOARD_LABEL,
              position: "after",
              familySelectors: SIDEBAR_FAMILY_SELECTORS,
              state,
              onToggle: () => {
                state.toggle();
              }
            })
          );
          disposers.push(
            mountCenterPanel({
              state,
              plugin: PANEL_NAME,
              viewDatasetKey: VIEW_DATASET_KEY,
              mount: (container) => {
                const root = (0, import_client.createRoot)(container);
                root.render(import_react2.default.createElement(MemoryDashboardPanel, { state }));
                return () => {
                  root.unmount();
                };
              }
            })
          );
        } catch (error) {
          console.warn("[tlmemory] \u5BA2\u6237\u7AEF\u754C\u9762\u6302\u8F7D\u5931\u8D25\uFF1A", error);
        }
        ctx.effect(
          () => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose();
              } catch {
              }
            }
            if (stylesCreated) removeClientStyles();
          },
          "tlmemory: client mounts"
        );
      }
      return __toCommonJS(entry_exports);
    })();
    
    return __tlmemory_client_exports;
  }
});
