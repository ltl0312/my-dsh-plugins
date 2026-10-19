// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: packages/tlsearch/src/client/*  |  Build: pnpm build:client
// DSH client-module boot registration protocol (see dsh-client-modules).
window.__ModuleLoader__.load({
  id: "dsh-plugin-tlsearch",
  factory: (require) => {
    "use strict";
    var __tlsearch_client_exports = (() => {
      var __create = Object.create;
      var __defProp = Object.defineProperty;
      var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
      var __getOwnPropNames = Object.getOwnPropertyNames;
      var __getProtoOf = Object.getPrototypeOf;
      var __hasOwnProp = Object.prototype.hasOwnProperty;
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
    
      // src/client/entry.ts
      var entry_exports = {};
      __export(entry_exports, {
        apply: () => apply,
        inject: () => inject
      });
    
      // src/client/index.tsx
      var import_react2 = __toESM(__require("react"), 1);
    
      // src/client/SettingsPage.tsx
      var import_react = __toESM(__require("react"), 1);
    
      // src/client/model.ts
      var CLIENT_NAMESPACE = "dsh-plugin-tlsearch";
      var PROVIDER_IDS = ["tavily", "brave", "searxng", "google", "exa"];
      var PROVIDER_LABELS = {
        tavily: "Tavily",
        brave: "Brave Search",
        searxng: "SearXNG",
        google: "Google",
        exa: "Exa"
      };
      var LIMITS = {
        minResults: 1,
        maxResults: 10,
        minSnippetChars: 40,
        maxSnippetChars: 2e3,
        minTimeoutMs: 1e3,
        maxTimeoutMs: 6e4
      };
      var DEFAULTS = {
        provider: "tavily",
        apiKey: "",
        baseUrl: "",
        cx: "",
        fallback: { provider: "none", apiKey: "", baseUrl: "", cx: "" },
        chain: [],
        maxResults: 5,
        maxSnippetChars: 250,
        timeoutMs: 15e3,
        language: "",
        includeAnswer: false,
        outputFormat: "markdown"
      };
      function asRecord(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
      }
      function asString(value) {
        if (typeof value === "string") return value;
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
        return "";
      }
      function asBoolean(value) {
        return value === true;
      }
      function asNumberInRange(value, fallback, min, max) {
        const parsed = typeof value === "number" ? value : Number(asString(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
      }
      function normalizeValues(raw) {
        const source = asRecord(raw);
        const fallback = asRecord(source.fallback);
        const chain = Array.isArray(source.chain) ? source.chain.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
        const format = asString(source.outputFormat);
        return {
          provider: asString(source.provider) || DEFAULTS.provider,
          apiKey: asString(source.apiKey),
          baseUrl: asString(source.baseUrl),
          cx: asString(source.cx),
          fallback: {
            provider: asString(fallback.provider) || "none",
            apiKey: asString(fallback.apiKey),
            baseUrl: asString(fallback.baseUrl),
            cx: asString(fallback.cx)
          },
          chain,
          maxResults: asNumberInRange(source.maxResults, DEFAULTS.maxResults, LIMITS.minResults, LIMITS.maxResults),
          maxSnippetChars: asNumberInRange(
            source.maxSnippetChars,
            DEFAULTS.maxSnippetChars,
            LIMITS.minSnippetChars,
            LIMITS.maxSnippetChars
          ),
          timeoutMs: asNumberInRange(source.timeoutMs, DEFAULTS.timeoutMs, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs),
          language: asString(source.language),
          includeAnswer: asBoolean(source.includeAnswer),
          outputFormat: format === "json" ? "json" : "markdown"
        };
      }
      function backendOf(values, which) {
        if (which === "fallback") return values.fallback;
        return { provider: values.provider, apiKey: values.apiKey, baseUrl: values.baseUrl, cx: values.cx };
      }
      function isProviderId(value) {
        return typeof value === "string" && PROVIDER_IDS.includes(value);
      }
      function formatChain(items) {
        if (items.length === 0) return "[]";
        return JSON.stringify(items, null, 2);
      }
      function parseChain(text) {
        const trimmed = text.trim();
        if (trimmed === "") return { ok: true, items: [] };
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          return { ok: false, index: -1, error: error instanceof Error ? error.message : String(error) };
        }
        if (!Array.isArray(parsed)) return { ok: false, index: -1, error: "expected a JSON array" };
        const items = [];
        for (const [index, entry] of parsed.entries()) {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return { ok: false, index, error: "expected an object" };
          }
          const record = entry;
          if (record.provider !== void 0 && !isProviderId(record.provider)) {
            return { ok: false, index, error: `unknown provider ${JSON.stringify(record.provider)}` };
          }
          items.push(record);
        }
        return { ok: true, items };
      }
      var REQUIREMENTS = {
        tavily: ["apiKey"],
        brave: ["apiKey"],
        exa: ["apiKey"],
        searxng: ["baseUrl"],
        google: ["apiKey", "cx"]
      };
      function verdictFor(label, backend) {
        if (backend.provider === "none" || !isProviderId(backend.provider)) return void 0;
        const required = REQUIREMENTS[backend.provider];
        const missing = required.find((field) => backend[field].trim() === "") ?? null;
        return { label, provider: backend.provider, missing };
      }
      function verdicts(values) {
        const list = [];
        const primary = verdictFor(PROVIDER_LABELS[values.provider ?? "tavily"] ?? values.provider, backendOf(values, "primary"));
        if (primary) list.push(primary);
        const fallback = verdictFor(values.fallback.provider, values.fallback);
        if (fallback) list.push(fallback);
        for (const [index, item] of values.chain.entries()) {
          const provider = asString(item.provider);
          const label = `${provider || "tavily"} #${index + 1}`;
          const verdict = verdictFor(label, {
            provider: provider || "tavily",
            apiKey: asString(item.apiKey),
            baseUrl: asString(item.baseUrl),
            cx: asString(item.cx)
          });
          if (verdict) list.push(verdict);
        }
        return list;
      }
      function hasUsableBackend(list) {
        return list.some((verdict) => verdict.missing === null);
      }
    
      // src/client/store.ts
      var NAMESPACE_HINT = "tlsearch";
      var INITIAL = {
        status: "loading",
        values: DEFAULTS,
        writable: false,
        secrets: []
      };
      function asRecord2(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
      }
      function namespaceList(value) {
        if (Array.isArray(value)) return value.map(asRecord2);
        const inner = asRecord2(value).namespaces;
        return Array.isArray(inner) ? inner.map(asRecord2) : [];
      }
      function secretSlots(value) {
        if (!Array.isArray(value)) return [];
        return value.flatMap((entry) => {
          const record = asRecord2(entry);
          const path = Array.isArray(record.path) ? record.path.map((segment) => String(segment)) : [];
          return path.length === 0 ? [] : [{ path, set: record.set === true }];
        });
      }
      function envelopeError(response) {
        const error = asRecord2(response).error;
        if (typeof error === "string") return error;
        const message = asRecord2(error).message;
        return typeof message === "string" ? message : void 0;
      }
      function isConflict(message) {
        if (!message) return false;
        return message.includes("changed since it was read") || message.includes("SETTINGS_CONFLICT");
      }
      function fromDescriptor(view, writable) {
        const revision = typeof view.revision === "number" ? view.revision : void 0;
        return {
          status: "ready",
          values: normalizeValues(view.value),
          ...revision === void 0 ? {} : { revision },
          writable,
          ...typeof view.applies === "string" ? { applies: view.applies } : {},
          secrets: secretSlots(view.secrets)
        };
      }
      function pickView(namespaces) {
        const exact = namespaces.find((entry) => entry.ns === CLIENT_NAMESPACE);
        if (exact !== void 0) return exact;
        const candidates = namespaces.filter(
          (entry) => typeof entry.ns === "string" && entry.ns.toLowerCase().includes(NAMESPACE_HINT)
        );
        return candidates.length === 1 ? candidates[0] : void 0;
      }
      function createConfigStore(remote) {
        let snapshot = INITIAL;
        let disposed = false;
        const listeners = /* @__PURE__ */ new Set();
        const emit = () => {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch {
            }
          }
        };
        const commit = (next) => {
          if (disposed) return;
          snapshot = next;
          emit();
        };
        const settings = () => {
          const services = remote?.settings;
          return services && typeof services.describe === "function" ? services : void 0;
        };
        let pickedNs;
        const load = async () => {
          const api = settings();
          if (!api) {
            commit({ ...INITIAL, status: "unavailable", writable: false });
            return;
          }
          try {
            const response = await api.describe();
            if (!response || response.ok === false) {
              commit({ ...INITIAL, status: "error", error: envelopeError(response) ?? "settings/describe failed" });
              return;
            }
            const holder = asRecord2(response.value);
            const writable = holder.writable === true;
            const view = pickView(namespaceList(response.value));
            if (!view) {
              pickedNs = void 0;
              commit({ ...INITIAL, status: "unavailable", writable });
              return;
            }
            pickedNs = typeof view.ns === "string" ? view.ns : CLIENT_NAMESPACE;
            commit(fromDescriptor(view, writable));
          } catch (error) {
            commit({
              ...INITIAL,
              status: "error",
              error: error instanceof Error ? error.message : String(error)
            });
          }
        };
        void load();
        let off;
        const subscribed = remote?.$on?.("settings/document-updated", (namespace) => {
          if (namespace === void 0 || namespace === CLIENT_NAMESPACE || namespace === pickedNs) void load();
        });
        if (typeof subscribed === "function") off = subscribed;
        return {
          getSnapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async mutate(ops) {
            if (ops.length === 0) return { ok: true };
            const api = settings();
            if (!api || typeof api.mutate !== "function") return { ok: false, error: "no settings bridge" };
            try {
              const response = await api.mutate(pickedNs ?? CLIENT_NAMESPACE, ops, snapshot.revision);
              if (!response || response.ok === false) {
                const message = envelopeError(response) ?? "settings/mutate failed";
                const conflict = isConflict(message);
                if (conflict) {
                  await load();
                  return { ok: false, error: message, conflict: true };
                }
                return { ok: false, error: message };
              }
              const view = asRecord2(response.value);
              if (view.ns === CLIENT_NAMESPACE || view.revision !== void 0) {
                commit(fromDescriptor(view, snapshot.writable));
              } else {
                await load();
              }
              return { ok: true };
            } catch (error) {
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          },
          reload: load,
          dispose() {
            disposed = true;
            listeners.clear();
            try {
              off?.();
            } catch {
            }
          }
        };
      }
      function setOp(path, value) {
        return { op: "set", path, value };
      }
    
      // src/client/SettingsPage.tsx
      function Row(props) {
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-row" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-row-label" }, props.label), /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-row-body" }, props.children, props.hint ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, props.hint) : null));
      }
      function Section(props) {
        return /* @__PURE__ */ import_react.default.createElement("section", { className: "tls-section" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-section-head" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-section-title" }, props.title), props.hint ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, props.hint) : null), props.children);
      }
      function TextField(props) {
        return /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            key: props.fieldKey,
            className: `tls-input${props.secret ? " tls-input-secret" : ""}`,
            type: "text",
            defaultValue: props.value,
            placeholder: props.placeholder,
            disabled: props.disabled,
            spellCheck: false,
            autoComplete: "off",
            onBlur: (event) => {
              const next = event.currentTarget.value;
              if (next === props.value) return;
              props.onCommit(next);
            },
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.blur();
            }
          }
        );
      }
      function NumberField(props) {
        return /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            key: props.fieldKey,
            className: "tls-input tls-input-num",
            type: "number",
            min: props.min,
            max: props.max,
            step: 1,
            defaultValue: String(props.value),
            disabled: props.disabled,
            onBlur: (event) => {
              const raw = event.currentTarget.value.trim();
              if (raw === "" || !Number.isFinite(Number(raw))) {
                props.onReject();
                return;
              }
              const next = asNumberInRange(raw, props.value, props.min, props.max);
              if (next === props.value) {
                props.onReject();
                return;
              }
              props.onCommit(next);
            },
            onKeyDown: (event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.blur();
            }
          }
        );
      }
      function SelectField(props) {
        return /* @__PURE__ */ import_react.default.createElement(
          "select",
          {
            className: "tls-select",
            value: props.value,
            disabled: props.disabled,
            onChange: (event) => props.onChange(event.currentTarget.value)
          },
          props.options.map((option) => /* @__PURE__ */ import_react.default.createElement("option", { key: option.value, value: option.value }, option.label))
        );
      }
      function providerOptions(t, withNone) {
        const list = PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] }));
        return withNone ? [{ value: "none", label: t("providerNone") }, ...list] : list;
      }
      function secretAt(secrets, path) {
        const key = path.join(".");
        return secrets.some((slot) => slot.set && slot.path.join(".") === key);
      }
      function ChainEditor(props) {
        const [text, setText] = import_react.default.useState(() => formatChain(props.values.chain));
        const [error, setError] = import_react.default.useState(void 0);
        const committed = import_react.default.useRef(text);
        import_react.default.useEffect(() => {
          if (committed.current === text) return;
          setText(formatChain(props.values.chain));
          committed.current = formatChain(props.values.chain);
          setError(void 0);
        }, [props.revisionKey]);
        const submit = () => {
          if (text === committed.current) return;
          const parsed = parseChain(text);
          if (!parsed.ok) {
            setError(
              parsed.index >= 0 ? `${props.t("chainInvalid")} #${parsed.index + 1} \u2014 ${parsed.error}` : `${props.t("chainInvalid")} \u2014 ${parsed.error}`
            );
            return;
          }
          setError(void 0);
          committed.current = text;
          props.onCommit(parsed.items);
        };
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-row-body" }, /* @__PURE__ */ import_react.default.createElement(
          "textarea",
          {
            className: `tls-textarea${error ? " tls-textarea-bad" : ""}`,
            value: text,
            disabled: props.disabled,
            spellCheck: false,
            onChange: (event) => setText(event.currentTarget.value),
            onBlur: submit
          }
        ), error ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-flash tls-flash-bad" }, error) : props.values.chain.length === 0 ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, props.t("chainEmpty")) : null);
      }
      function SettingsPage(props) {
        const { t, store } = props;
        const snapshot = import_react.default.useSyncExternalStore(
          (listener) => store.subscribe(listener),
          () => store.getSnapshot()
        );
        const [flash, setFlash] = import_react.default.useState(void 0);
        const [busy, setBusy] = import_react.default.useState(0);
        const [nonce, setNonce] = import_react.default.useState(0);
        const flashTimer = import_react.default.useRef(void 0);
        const showFlash = import_react.default.useCallback((next) => {
          setFlash(next);
          if (flashTimer.current !== void 0) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(void 0), 4e3);
        }, []);
        import_react.default.useEffect(
          () => () => {
            if (flashTimer.current !== void 0) clearTimeout(flashTimer.current);
          },
          []
        );
        const commit = import_react.default.useCallback(
          (ops) => {
            setBusy((count) => count + 1);
            void store.mutate(ops).then((result) => {
              if (result.ok) {
                showFlash({ kind: "ok", text: t("saved") });
                return;
              }
              if (result.conflict) {
                showFlash({ kind: "bad", text: t("conflict") });
                setNonce((value) => value + 1);
                return;
              }
              showFlash({ kind: "bad", text: `${t("saveFailed")}: ${result.error ?? ""}` });
              setNonce((value) => value + 1);
            }).finally(() => setBusy((count) => Math.max(0, count - 1)));
          },
          [store, showFlash, t]
        );
        const revisionKey = `${snapshot.revision ?? "x"}:${nonce}`;
        const values = snapshot.values;
        const ready = snapshot.status === "ready";
        const disabled = !ready || !snapshot.writable || busy > 0;
        const readOnly = ready && !snapshot.writable;
        const verdictList = verdicts(values);
        const usable = hasUsableBackend(verdictList);
        const head = /* @__PURE__ */ import_react.default.createElement("header", { className: "tls-head" }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-title" }, t("title")), /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-subtitle" }, t("subtitle")), /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, t("hintEveryChangeLive")));
        const statusBar = /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-actions" }, busy > 0 ? /* @__PURE__ */ import_react.default.createElement("span", { className: "tls-flash" }, t("saving")) : null, flash ? /* @__PURE__ */ import_react.default.createElement("span", { className: `tls-flash ${flash.kind === "ok" ? "tls-flash-ok" : "tls-flash-bad"}` }, flash.text) : null, /* @__PURE__ */ import_react.default.createElement("span", { className: "tls-spacer" }), /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            className: "tls-btn tls-btn-sm",
            disabled: snapshot.status === "loading",
            onClick: () => {
              void store.reload();
            }
          },
          t("reload")
        ));
        if (!ready) {
          const message = snapshot.status === "loading" ? t("loading") : snapshot.status === "error" ? `${t("saveFailed")}: ${snapshot.error ?? ""}` : t("unavailable");
          return /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-page" }, head, snapshot.status === "unavailable" ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, t("unavailableHint")) : null, snapshot.status === "error" && !snapshot.error ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-hint" }, t("noBridge")) : null, /* @__PURE__ */ import_react.default.createElement("div", { className: `tls-banner ${snapshot.status === "error" ? "tls-banner-error" : "tls-banner-warn"}` }, message), statusBar);
        }
        const apiKeySaved = secretAt(snapshot.secrets, ["apiKey"]);
        const fallbackKeySaved = secretAt(snapshot.secrets, ["fallback", "apiKey"]);
        return /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-page" }, head, readOnly ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-banner tls-banner-warn" }, t("readOnly")) : null, snapshot.applies !== void 0 && snapshot.applies !== "live" ? /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-banner tls-banner-warn" }, `applies: ${snapshot.applies}`) : null, /* @__PURE__ */ import_react.default.createElement(Section, { title: t("sectionPrimary"), hint: t("sectionPrimaryHint") }, /* @__PURE__ */ import_react.default.createElement(Row, { label: t("provider") }, /* @__PURE__ */ import_react.default.createElement(
          SelectField,
          {
            value: values.provider,
            disabled,
            options: providerOptions(t, false),
            onChange: (next) => commit([setOp(["provider"], next)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("apiKey"), hint: t("apiKeyHint") }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-inline" }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.apiKey,
            fieldKey: `${revisionKey}:apiKey`,
            disabled,
            secret: true,
            placeholder: apiKeySaved ? t("apiKeySaved") : void 0,
            onCommit: (next) => commit([setOp(["apiKey"], next)])
          }
        ), apiKeySaved ? /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            className: "tls-btn tls-btn-sm",
            disabled,
            onClick: () => commit([setOp(["apiKey"], "")])
          },
          t("off")
        ) : null)), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("baseUrl"), hint: t("baseUrlHint") }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.baseUrl,
            fieldKey: `${revisionKey}:baseUrl`,
            disabled,
            onCommit: (next) => commit([setOp(["baseUrl"], next)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("cx"), hint: t("cxHint") }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.cx,
            fieldKey: `${revisionKey}:cx`,
            disabled,
            onCommit: (next) => commit([setOp(["cx"], next)])
          }
        ))), /* @__PURE__ */ import_react.default.createElement(Section, { title: t("sectionFallback"), hint: t("sectionFallbackHint") }, /* @__PURE__ */ import_react.default.createElement(Row, { label: t("provider") }, /* @__PURE__ */ import_react.default.createElement(
          SelectField,
          {
            value: values.fallback.provider,
            disabled,
            options: providerOptions(t, true),
            onChange: (next) => commit([setOp(["fallback", "provider"], next)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("apiKey"), hint: t("apiKeyHint") }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-inline" }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.fallback.apiKey,
            fieldKey: `${revisionKey}:fallback.apiKey`,
            disabled,
            secret: true,
            placeholder: fallbackKeySaved ? t("apiKeySaved") : void 0,
            onCommit: (next) => commit([setOp(["fallback", "apiKey"], next)])
          }
        ), fallbackKeySaved ? /* @__PURE__ */ import_react.default.createElement(
          "button",
          {
            type: "button",
            className: "tls-btn tls-btn-sm",
            disabled,
            onClick: () => commit([setOp(["fallback", "apiKey"], "")])
          },
          t("off")
        ) : null)), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("baseUrl"), hint: t("baseUrlHint") }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.fallback.baseUrl,
            fieldKey: `${revisionKey}:fallback.baseUrl`,
            disabled,
            onCommit: (next) => commit([setOp(["fallback", "baseUrl"], next)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("cx"), hint: t("cxHint") }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.fallback.cx,
            fieldKey: `${revisionKey}:fallback.cx`,
            disabled,
            onCommit: (next) => commit([setOp(["fallback", "cx"], next)])
          }
        ))), /* @__PURE__ */ import_react.default.createElement(Section, { title: t("sectionChain"), hint: t("sectionChainHint") }, /* @__PURE__ */ import_react.default.createElement(
          ChainEditor,
          {
            values,
            disabled,
            t,
            revisionKey,
            onCommit: (items) => commit([setOp(["chain"], items)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Section, { title: t("sectionOutput"), hint: t("sectionOutputHint") }, /* @__PURE__ */ import_react.default.createElement(Row, { label: t("maxResults"), hint: t("maxResultsHint") }, /* @__PURE__ */ import_react.default.createElement(
          NumberField,
          {
            value: values.maxResults,
            fieldKey: `${revisionKey}:maxResults`,
            disabled,
            min: LIMITS.minResults,
            max: LIMITS.maxResults,
            onCommit: (next) => commit([setOp(["maxResults"], next)]),
            onReject: () => setNonce((value) => value + 1)
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("maxSnippetChars"), hint: t("maxSnippetCharsHint") }, /* @__PURE__ */ import_react.default.createElement(
          NumberField,
          {
            value: values.maxSnippetChars,
            fieldKey: `${revisionKey}:maxSnippetChars`,
            disabled,
            min: LIMITS.minSnippetChars,
            max: LIMITS.maxSnippetChars,
            onCommit: (next) => commit([setOp(["maxSnippetChars"], next)]),
            onReject: () => setNonce((value) => value + 1)
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("outputFormat"), hint: t("outputFormatHint") }, /* @__PURE__ */ import_react.default.createElement(
          SelectField,
          {
            value: values.outputFormat,
            disabled,
            options: [
              { value: "markdown", label: t("fmtMarkdown") },
              { value: "json", label: t("fmtJson") }
            ],
            onChange: (next) => commit([setOp(["outputFormat"], next)])
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("includeAnswer"), hint: t("includeAnswerHint") }, /* @__PURE__ */ import_react.default.createElement("label", { className: `tls-check${disabled ? " tls-check-disabled" : ""}` }, /* @__PURE__ */ import_react.default.createElement(
          "input",
          {
            type: "checkbox",
            checked: values.includeAnswer,
            disabled,
            onChange: (event) => commit([setOp(["includeAnswer"], event.currentTarget.checked)])
          }
        ), /* @__PURE__ */ import_react.default.createElement("span", null, values.includeAnswer ? t("on") : t("off"))))), /* @__PURE__ */ import_react.default.createElement(Section, { title: t("sectionAdvanced"), hint: t("sectionAdvancedHint") }, /* @__PURE__ */ import_react.default.createElement(Row, { label: t("timeoutMs"), hint: t("timeoutMsHint") }, /* @__PURE__ */ import_react.default.createElement(
          NumberField,
          {
            value: values.timeoutMs,
            fieldKey: `${revisionKey}:timeoutMs`,
            disabled,
            min: LIMITS.minTimeoutMs,
            max: LIMITS.maxTimeoutMs,
            onCommit: (next) => commit([setOp(["timeoutMs"], next)]),
            onReject: () => setNonce((value) => value + 1)
          }
        )), /* @__PURE__ */ import_react.default.createElement(Row, { label: t("language"), hint: t("languageHint") }, /* @__PURE__ */ import_react.default.createElement(
          TextField,
          {
            value: values.language,
            fieldKey: `${revisionKey}:language`,
            disabled,
            onCommit: (next) => commit([setOp(["language"], next)])
          }
        ))), /* @__PURE__ */ import_react.default.createElement(Section, { title: t("chainStatus"), hint: t("noKeyMode") }, /* @__PURE__ */ import_react.default.createElement("div", { className: "tls-inline" }, verdictList.length === 0 ? /* @__PURE__ */ import_react.default.createElement("span", { className: "tls-hint" }, t("chainStatusNone")) : null, verdictList.map((verdict) => {
          const ok = verdict.missing === null;
          const missing = verdict.missing === "apiKey" ? t("keyMissing") : verdict.missing === "baseUrl" ? t("baseUrlMissing") : verdict.missing === "cx" ? t("cxMissing") : "";
          return /* @__PURE__ */ import_react.default.createElement(
            "span",
            {
              key: `${verdict.label}:${verdict.provider}`,
              className: `tls-chip ${ok ? "tls-chip-ok" : "tls-chip-bad"}`
            },
            /* @__PURE__ */ import_react.default.createElement("span", null, verdict.label),
            /* @__PURE__ */ import_react.default.createElement("span", null, ok ? t("usable") : `${t("notUsable")} \u2014 ${missing}`)
          );
        }), !usable && verdictList.length > 0 ? /* @__PURE__ */ import_react.default.createElement("span", { className: "tls-hint" }, t("chainStatusNone")) : null)), statusBar);
      }
    
      // src/client/i18n.ts
      var SETTINGS_LOCALE_NS = "settings.tlsearch";
      var ZH = {
        nav: "\u8054\u7F51\u641C\u7D22",
        title: "\u8054\u7F51\u641C\u7D22\uFF08tlsearch\uFF09",
        subtitle: "\u7ED9 Agent \u4E00\u4E2A search \u5DE5\u5177\uFF0C\u6309\u540E\u7AEF\u94FE\u4F9D\u6B21\u5C1D\u8BD5\uFF1B\u7B2C\u4E00\u4E2A\u6210\u529F\u7684\u5C31\u8FD4\u56DE\u3002",
        hintEveryChangeLive: "\u8FD9\u4E00\u9875\u7684\u6BCF\u4E00\u9879\u90FD\u4F1A\u7ACB\u5373\u5199\u56DE\u914D\u7F6E\u5E76\u751F\u6548\uFF0C\u4E0D\u9700\u8981\u91CD\u542F\u3002",
        loading: "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026",
        unavailable: "\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B\u8FD9\u5F20\u914D\u7F6E\u8868\u5355",
        unavailableHint: "\u901A\u5E38\u662F\u63D2\u4EF6\u7684\u914D\u7F6E\u91CC\u8FD8\u6CA1\u6709\u4EFB\u4F55\u4E00\u9879\u9700\u8981\u91CD\u65B0\u52A0\u8F7D\u7684\u5B57\u6BB5\uFF0C\u6216\u8005\u5BBF\u4E3B\u7248\u672C\u4E0D\u652F\u6301\u6309\u5B57\u6BB5\u5199\u5165\u3002\u53EF\u4EE5\u5148\u7528\u914D\u7F6E\u6587\u4EF6\u586B\u597D\u518D\u56DE\u6765\u3002",
        noBridge: "\u6D4F\u89C8\u5668\u6CA1\u6709\u8FDE\u4E0A\u5BBF\u4E3B\u7684\u8BBE\u7F6E\u670D\u52A1\uFF0C\u8FD9\u4E00\u9875\u73B0\u5728\u53EA\u80FD\u770B\uFF0C\u4E0D\u80FD\u6539\u3002",
        readOnly: "\u5F53\u524D\u914D\u7F6E\u662F\u53EA\u8BFB\u7684\uFF08\u5BBF\u4E3B\u4FA7 profile \u4E0D\u53EF\u5199\uFF09\uFF0C\u6539\u52A8\u4E0D\u4F1A\u4FDD\u5B58\u3002",
        saveFailed: "\u4FDD\u5B58\u5931\u8D25",
        conflict: "\u914D\u7F6E\u5728\u522B\u5904\u88AB\u6539\u8FC7\uFF0C\u5DF2\u91CD\u65B0\u8BFB\u53D6\uFF0C\u8BF7\u518D\u6539\u4E00\u6B21\u3002",
        saved: "\u5DF2\u4FDD\u5B58",
        saving: "\u4FDD\u5B58\u4E2D\u2026",
        reload: "\u91CD\u65B0\u8BFB\u53D6",
        sectionPrimary: "\u4E3B\u540E\u7AEF",
        sectionPrimaryHint: "\u6700\u5E38\u7528\u7684\u90A3\u4E00\u4E2A\u3002\u7559\u7A7A apiKey \u5C31\u4F1A\u9000\u5230\u73AF\u5883\u53D8\u91CF\uFF0C\u518D\u9000\u5230\u5907\u7528\u540E\u7AEF\u4E0E\u540E\u7AEF\u94FE\u3002",
        sectionFallback: "\u5907\u7528\u540E\u7AEF\uFF08\u7B80\u5199\uFF09",
        sectionFallbackHint: "\u53EA\u586B\u4E00\u4E2A\u540E\u7AEF\u65F6\u7528\u5B83\uFF1B\u6BD4\u5728\u540E\u7AEF\u94FE\u91CC\u5199\u4E00\u9879\u66F4\u7701\u4E8B\u3002",
        sectionChain: "\u540E\u7AEF\u94FE",
        sectionChainHint: '\u6309\u987A\u5E8F\u5C1D\u8BD5\uFF0C\u524D\u4E00\u4E2A\u5931\u8D25\uFF08\u8D85\u65F6 / \u9650\u6D41 / \u4E0D\u53EF\u7528\uFF09\u624D\u8D70\u4E0B\u4E00\u4E2A\u3002\u6BCF\u4E00\u9879\u5F62\u5982 {"provider":"brave","apiKey":"..."}\u3002',
        sectionOutput: "\u641C\u7D22\u7ED3\u679C",
        sectionOutputHint: "\u63A7\u5236\u8FD4\u56DE\u7ED9 Agent \u7684\u5185\u5BB9\u91CF\u4E0E\u683C\u5F0F\u3002",
        sectionAdvanced: "\u9AD8\u7EA7",
        sectionAdvancedHint: "\u4E00\u822C\u4E0D\u7528\u6539\u3002",
        provider: "\u540E\u7AEF",
        providerNone: "\uFF08\u4E0D\u7528\uFF09",
        apiKey: "API Key",
        apiKeyHint: "\u7559\u7A7A\u8868\u793A\u4E0D\u5728\u8FD9\u91CC\u914D\u7F6E\uFF1A\u4F1A\u53BB\u8BFB\u73AF\u5883\u53D8\u91CF\uFF0C\u518D\u4E0D\u884C\u5C31\u7B97\u4E0D\u53EF\u7528\u3002\u5BC6\u94A5\u4E0D\u56DE\u663E\uFF0C\u7559\u7A7A\u5373\u4FDD\u6301\u539F\u503C\u3002",
        apiKeySaved: "\u5DF2\u4FDD\u5B58\uFF08\u4E0D\u56DE\u663E\uFF09",
        baseUrl: "Base URL",
        baseUrlHint: "\u7559\u7A7A\u7528\u8BE5\u540E\u7AEF\u7684\u9ED8\u8BA4\u5730\u5740\uFF1B\u81EA\u5EFA SearXNG \u5FC5\u586B\u3002",
        cx: "CX / \u641C\u7D22\u5F15\u64CE ID",
        cxHint: "\u53EA\u6709 Google \u9700\u8981\u3002",
        maxResults: "\u7ED3\u679C\u6761\u6570\u4E0A\u9650",
        maxResultsHint: "1 \u2013 10\uFF0C\u9ED8\u8BA4 5\u3002",
        maxSnippetChars: "\u6458\u8981\u622A\u65AD\u957F\u5EA6",
        maxSnippetCharsHint: "40 \u2013 2000\uFF0C\u9ED8\u8BA4 250\u3002\u592A\u957F\u4F1A\u6324\u5360\u4E0A\u4E0B\u6587\u3002",
        timeoutMs: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09",
        timeoutMsHint: "1000 \u2013 60000\uFF0C\u9ED8\u8BA4 15000\u3002\u8D85\u65F6\u4F1A\u88AB\u8BB0\u4E3A\u4E00\u6B21\u5931\u8D25\u5E76\u5207\u5230\u4E0B\u4E00\u4E2A\u540E\u7AEF\u3002",
        language: "\u7ED3\u679C\u8BED\u8A00",
        languageHint: "\u4F20\u7ED9\u540E\u7AEF\u7684\u8BED\u8A00\u504F\u597D\uFF0C\u4F8B\u5982 zh / en\u3002\u7559\u7A7A\u7531\u540E\u7AEF\u51B3\u5B9A\u3002",
        includeAnswer: "\u8BF7\u6C42\u9644\u5E26\u7B54\u6848\u6458\u8981",
        includeAnswerHint: "\u53EA\u6709\u90E8\u5206\u540E\u7AEF\u652F\u6301\uFF1B\u4E0D\u5F71\u54CD\u641C\u7D22\u7ED3\u679C\u672C\u8EAB\u3002",
        outputFormat: "\u8F93\u51FA\u683C\u5F0F",
        outputFormatHint: "Agent \u770B\u5230\u7684\u7ED3\u679C\u957F\u4EC0\u4E48\u6837\u3002",
        fmtMarkdown: "Markdown",
        fmtJson: "JSON",
        chainEmpty: "\uFF08\u7A7A\uFF1A\u53EA\u7528\u4E3B\u540E\u7AEF\u4E0E\u5907\u7528\u540E\u7AEF\uFF09",
        chainInvalid: "\u8FD9\u4E00\u6BB5\u4E0D\u662F\u5408\u6CD5\u7684\u540E\u7AEF\u5BF9\u8C61",
        chainAdd: "\u52A0\u4E00\u9879",
        chainRemove: "\u5220\u9664",
        usable: "\u53EF\u7528",
        notUsable: "\u4E0D\u53EF\u7528",
        keyMissing: "\u7F3A\u5C11 API Key",
        baseUrlMissing: "\u7F3A\u5C11 Base URL",
        cxMissing: "\u7F3A\u5C11 CX",
        chainStatus: "\u5F53\u524D\u53EF\u7528\u540E\u7AEF",
        chainStatusNone: "\u4E00\u4E2A\u90FD\u6CA1\u6709\uFF1A\u8FD9\u4E48\u8C03\u7528\u4F1A\u76F4\u63A5\u62A5\u9519\uFF0C\u5E76\u544A\u8BC9\u4F60\u7F3A\u4EC0\u4E48\u3002",
        noKeyMode: "\u6CA1\u6709\u914D\u7F6E\u4EFB\u4F55\u5BC6\u94A5\u65F6\u63D2\u4EF6\u7167\u5E38\u88C5\u914D\uFF0C\u5DE5\u5177\u4F1A\u8FD4\u56DE\u4E00\u53E5\u300C\u600E\u4E48\u914D\u300D\u7684\u8BF4\u660E\uFF0C\u4E0D\u4F1A\u8BA9\u5BBF\u4E3B\u8D77\u4E0D\u6765\u3002",
        on: "\u5F00",
        off: "\u5173"
      };
      var EN = {
        nav: "Web search",
        title: "Web search (tlsearch)",
        subtitle: "Gives the agent a search tool that walks the backend chain and returns the first success.",
        hintEveryChangeLive: "Every field on this page is written back and applied immediately \u2014 no restart.",
        loading: "Loading configuration\u2026",
        unavailable: "The host does not expose a configuration form here",
        unavailableHint: "Usually this means no field of this plugin is marked as live-editable, or the host version cannot write per field. You can still fill in the configuration file and come back.",
        noBridge: "The browser is not connected to the host settings service, so this page is read-only.",
        readOnly: "This configuration is read-only (the host profile is not writable); changes will not be saved.",
        saveFailed: "Save failed",
        conflict: "The configuration changed elsewhere and was reloaded \u2014 please make the change again.",
        saved: "Saved",
        saving: "Saving\u2026",
        reload: "Reload",
        sectionPrimary: "Primary backend",
        sectionPrimaryHint: "The usual one. Leave the API key empty to fall back to the environment variable, then to the fallback backend and the chain.",
        sectionFallback: "Fallback backend (shorthand)",
        sectionFallbackHint: "Used when you only want one backup backend; simpler than an entry in the chain.",
        sectionChain: "Backend chain",
        sectionChainHint: 'Tried in order; the next one runs only when the previous fails (timeout / rate limit / unavailable). Each entry looks like {"provider":"brave","apiKey":"..."}.',
        sectionOutput: "Search results",
        sectionOutputHint: "How much is returned to the agent, and in which shape.",
        sectionAdvanced: "Advanced",
        sectionAdvancedHint: "Rarely needs changing.",
        provider: "Backend",
        providerNone: "(none)",
        apiKey: "API key",
        apiKeyHint: 'Empty means "not configured here": the environment variable is read instead, and the backend counts as unusable if that is empty too. Saved secrets are never echoed; leave it empty to keep the current value.',
        apiKeySaved: "(saved \u2014 not shown)",
        baseUrl: "Base URL",
        baseUrlHint: "Empty uses the default address of that backend; required for a self-hosted SearXNG.",
        cx: "CX / search engine id",
        cxHint: "Google only.",
        maxResults: "Result limit",
        maxResultsHint: "1 \u2013 10, default 5.",
        maxSnippetChars: "Snippet length",
        maxSnippetCharsHint: "40 \u2013 2000, default 250. Longer snippets crowd out the context.",
        timeoutMs: "Timeout (ms)",
        timeoutMsHint: "1000 \u2013 60000, default 15000. A timeout counts as a failure and moves to the next backend.",
        language: "Result language",
        languageHint: "Language preference passed to the backend, e.g. zh / en. Empty lets the backend decide.",
        includeAnswer: "Ask for an answer summary",
        includeAnswerHint: "Only some backends support it; search results themselves are unaffected.",
        outputFormat: "Output format",
        outputFormatHint: "What the agent sees.",
        fmtMarkdown: "Markdown",
        fmtJson: "JSON",
        chainEmpty: "(empty: primary and fallback backends only)",
        chainInvalid: "This entry is not a valid backend object",
        chainAdd: "Add entry",
        chainRemove: "Remove",
        usable: "usable",
        notUsable: "unusable",
        keyMissing: "API key missing",
        baseUrlMissing: "base URL missing",
        cxMissing: "CX missing",
        chainStatus: "Usable backends",
        chainStatusNone: "None: a call will fail with a message naming the missing piece.",
        noKeyMode: 'With no key configured the plugin still mounts; the tool answers with a short "how to configure" note instead of breaking the host.',
        on: "on",
        off: "off"
      };
      var DICTS = { zh: ZH, en: EN };
      var DICTIONARIES = DICTS;
      function detectLang() {
        try {
          const root = typeof document === "undefined" ? void 0 : document.documentElement;
          const declared = root?.getAttribute("lang") ?? root?.lang;
          if (declared) return /^en\b/i.test(declared) ? "en" : "zh";
          const nav = typeof navigator === "undefined" ? void 0 : navigator.language;
          if (nav) return /^en\b/i.test(nav) ? "en" : "zh";
        } catch {
        }
        return "zh";
      }
      function dictOf(lang) {
        return DICTS[lang] ?? ZH;
      }
      function translate(lang, key, vars) {
        const template = dictOf(lang)[key];
        if (!vars) return template;
        return template.replace(
          /\{(\w+)\}/g,
          (_match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : `{${name}}`
        );
      }
      function createTranslator(lang) {
        return (key, vars) => translate(lang, key, vars);
      }
    
      // src/client/styles.ts
      var STYLE_ID = "dsh-tlsearch-client-styles";
      var CLIENT_CSS = `
    .tls-page {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 4px 2px 32px;
      font-family: var(--dsw-font-family, inherit);
      color: var(--dsw-alias-label-primary, #1a1a1a);
      font-size: 13px;
      line-height: 1.6;
    }
    
    .tls-head { display: flex; flex-direction: column; gap: 4px; }
    .tls-title { font-size: 16px; font-weight: 600; }
    .tls-subtitle { color: var(--dsw-alias-label-secondary, #666); }
    .tls-hint { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 12px; line-height: 1.55; }
    
    .tls-banner {
      padding: 8px 10px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.24));
      border-radius: 8px;
      font-size: 12px;
    }
    .tls-banner-warn { color: #9a6a00; border-color: rgba(154,106,0,.4); }
    .tls-banner-error { color: #c0392b; border-color: rgba(192,57,43,.4); }
    
    .tls-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
      border-radius: 12px;
      background: var(--dsw-alias-bg-base, transparent);
    }
    .tls-section-head { display: flex; flex-direction: column; gap: 2px; }
    .tls-section-title { font-weight: 600; font-size: 13px; }
    
    .tls-row {
      display: grid;
      grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
      gap: 8px 14px;
      align-items: start;
    }
    .tls-row-label { padding-top: 6px; color: var(--dsw-alias-label-secondary, #666); }
    .tls-row-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    
    .tls-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    
    .tls-input,
    .tls-select,
    .tls-textarea {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 6px 9px;
      font: inherit;
      color: inherit;
      background: var(--dsw-alias-bg-base, transparent);
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
      border-radius: 8px;
      outline: none;
    }
    .tls-input:focus,
    .tls-select:focus,
    .tls-textarea:focus { border-color: var(--dsw-alias-state-business-primary, #2f7d32); }
    .tls-input:disabled,
    .tls-select:disabled,
    .tls-textarea:disabled { opacity: .55; }
    .tls-input-num { max-width: 130px; }
    .tls-input-secret { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tls-textarea { resize: vertical; min-height: 76px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .tls-textarea-bad { border-color: rgba(192,57,43,.6); }
    
    .tls-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 5px 12px;
      font: inherit;
      color: inherit;
      background: var(--dsw-alias-bg-base, transparent);
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32));
      border-radius: 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    .tls-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
    .tls-btn:disabled { opacity: .5; cursor: default; }
    .tls-btn-sm { padding: 2px 8px; font-size: 12px; }
    
    .tls-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .tls-check input { margin: 0; flex: none; }
    .tls-check-disabled { opacity: .55; cursor: default; }
    
    .tls-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
      border-radius: 999px;
    }
    .tls-chip-ok { color: #1f7a34; border-color: rgba(31,122,52,.4); }
    .tls-chip-bad { color: #c0392b; border-color: rgba(192,57,43,.4); }
    
    .tls-flash { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
    .tls-flash-ok { color: #1f7a34; }
    .tls-flash-bad { color: #c0392b; }
    
    .tls-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .tls-spacer { flex: 1 1 auto; }
    .tls-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
    `;
      var installed = 0;
      function ensureClientStyles() {
        if (typeof document === "undefined") return false;
        installed += 1;
        if (document.getElementById(STYLE_ID)) return false;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CLIENT_CSS;
        document.head.appendChild(style);
        return true;
      }
      function removeClientStyles() {
        if (typeof document === "undefined") return;
        installed = Math.max(0, installed - 1);
        if (installed > 0) return;
        document.getElementById(STYLE_ID)?.remove();
      }
    
      // src/client/index.tsx
      var inject = ["slots", "locale", "remote", "remote.settings"];
      var SETTINGS_SECTION_ID = "tlsearch";
      var SETTINGS_SECTION_ORDER = 31;
      function warn(ctx, message, error) {
        try {
          const logger = ctx.get("logger");
          logger?.warn?.(message, error);
        } catch {
        }
      }
      function useLang() {
        const [lang, setLang] = import_react2.default.useState(() => detectLang());
        import_react2.default.useEffect(() => {
          if (typeof document === "undefined" || typeof MutationObserver === "undefined") return void 0;
          const observer = new MutationObserver(() => setLang(detectLang()));
          try {
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "class"] });
          } catch {
            return void 0;
          }
          return () => observer.disconnect();
        }, []);
        return lang;
      }
      function TlsearchSection(props) {
        const lang = useLang();
        const t = import_react2.default.useMemo(() => createTranslator(lang), [lang]);
        return /* @__PURE__ */ import_react2.default.createElement(SettingsPage, { store: props.store, t });
      }
      TlsearchSection.displayName = "TlsearchSettingsSection";
      function apply(ctx) {
        if (typeof document === "undefined") return;
        const disposers = [];
        const dispose = () => {
          for (const entry of disposers.splice(0)) {
            try {
              entry();
            } catch (error) {
              warn(ctx, "tlsearch: \u8BBE\u7F6E\u9762\u677F\u56DE\u6536\u5931\u8D25\u3002", error);
            }
          }
        };
        ctx.effect(() => dispose, "tlsearch: settings section");
        const slots = ctx.slots;
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
          warn(ctx, "tlsearch: \u5BBF\u4E3B\u6CA1\u6709 slots \u670D\u52A1\uFF0C\u8BBE\u7F6E\u9875\u65E0\u6CD5\u6302\u8F7D\u3002");
          return;
        }
        try {
          ensureClientStyles();
          disposers.push(removeClientStyles);
        } catch (error) {
          warn(ctx, "tlsearch: \u6CE8\u5165\u6837\u5F0F\u5931\u8D25\uFF0C\u9875\u9762\u4F1A\u5931\u53BB\u5916\u89C2\u4F46\u4ECD\u53EF\u7528\u3002", error);
        }
        let boundT;
        try {
          const locale = ctx.locale;
          if (locale && typeof locale.register === "function") {
            const registered = locale.register(SETTINGS_LOCALE_NS, DICTIONARIES);
            if (typeof registered === "function") disposers.push(registered);
          }
          if (locale && typeof locale.bind === "function") {
            const bound = locale.bind(SETTINGS_LOCALE_NS);
            if (typeof bound === "function") boundT = bound;
          }
        } catch (error) {
          warn(ctx, "tlsearch: \u6CE8\u518C\u6587\u6848\u547D\u540D\u7A7A\u95F4\u5931\u8D25\uFF0C\u5BFC\u822A\u540D\u9000\u56DE\u5185\u7F6E\u8BCD\u8868\u3002", error);
        }
        const store = createConfigStore(ctx.remote);
        disposers.push(() => store.dispose());
        try {
          slots.inject(
            "settings.section",
            () => slots.register(
              {
                name: "settings.section",
                id: SETTINGS_SECTION_ID,
                order: SETTINGS_SECTION_ORDER,
                // `label` 传 thunk：语言变化时宿主重新取词，导航名跟着变。
                label: () => boundT ? boundT("nav") : translate(detectLang(), "nav"),
                locale: SETTINGS_LOCALE_NS,
                inject: () => ({ store })
              },
              // 插槽组件拿到的 props = owner props + `inject()` 的返回值。宿主侧只做对象合并，
              // 类型上收窄成 `SlotComponent` 才符合 register 的签名。
              TlsearchSection
            )
          );
        } catch (error) {
          warn(ctx, "tlsearch: \u6CE8\u518C\u8BBE\u7F6E\u9875\u5931\u8D25\u3002", error);
        }
      }
      return __toCommonJS(entry_exports);
    })();
    
    return __tlsearch_client_exports;
  }
});
