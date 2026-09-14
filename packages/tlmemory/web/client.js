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
      var import_react = __toESM(__require("react"), 1);
      var import_dsh_client_ui_primitives = __require("@deepseek-ai/dsh-client-ui-primitives");
    
      // src/client/logic.ts
      var DASHBOARD_ORIGIN = "http://127.0.0.1:4890";
      var VIEW_ID = "tlmemory-dashboard";
      var SIDEBAR_ACTION_ID = "tlmemory-dashboard-action";
      var DASHBOARD_LABEL = "\u8BB0\u5FC6\u770B\u677F";
      var PROBE_TIMEOUT_MS = 2500;
      function dashboardUrl(origin = DASHBOARD_ORIGIN) {
        return `${origin.replace(/\/+$/, "")}/`;
      }
      async function probeDashboardHealth(origin = DASHBOARD_ORIGIN, timeoutMs = PROBE_TIMEOUT_MS, fetcher = (url, init) => fetch(url, init)) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetcher(`${origin.replace(/\/+$/, "")}/api/nodes`, { signal: controller.signal });
          return res.status >= 200 && res.status < 300;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      }
      function openDashboardForSession(sessions, uiConversation) {
        const current = sessions.list.getSnapshot().current;
        if (!current) return false;
        try {
          uiConversation.binding(current).activate(VIEW_ID);
          return true;
        } catch {
          return false;
        }
      }
    
      // src/client/index.tsx
      var inject = ["slots", "sessions", "uiConversation"];
      function MemoryDashboardView(props) {
        const [state, setState] = import_react.default.useState("probing");
        const check = import_react.default.useCallback(() => {
          setState("probing");
          probeDashboardHealth(props.dashboardOrigin).then((ok) => setState(ok ? "online" : "offline"));
        }, [props.dashboardOrigin]);
        import_react.default.useEffect(() => {
          check();
          const timer = setInterval(check, 15e3);
          return () => clearInterval(timer);
        }, [check]);
        const statusStyle = {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          fontSize: 12,
          borderBottom: "1px solid rgba(128,128,128,0.25)",
          background: "rgba(128,128,128,0.08)"
        };
        const statusText = state === "probing" ? "\u8BB0\u5FC6\u770B\u677F\u8FDE\u63A5\u4E2D\u2026" : state === "online" ? "\u8BB0\u5FC6\u770B\u677F\u670D\u52A1\u5728\u7EBF" : "\u8BB0\u5FC6\u770B\u677F\u670D\u52A1\u672A\u542F\u52A8\uFF08127.0.0.1:4890\uFF09";
        const dotColor = state === "online" ? "#22c55e" : state === "probing" ? "#eab308" : "#ef4444";
        return import_react.default.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 420 } },
          import_react.default.createElement(
            "div",
            { style: statusStyle },
            import_react.default.createElement("span", { style: { color: dotColor } }, "\u25CF"),
            import_react.default.createElement("span", { style: { color: "inherit", opacity: 0.85 } }, statusText),
            state === "offline" ? import_react.default.createElement(
              "button",
              {
                onClick: check,
                style: {
                  marginLeft: 8,
                  padding: "2px 10px",
                  fontSize: 12,
                  cursor: "pointer",
                  borderRadius: 4,
                  border: "1px solid rgba(128,128,128,0.4)",
                  background: "transparent"
                }
              },
              "\u91CD\u8BD5"
            ) : null,
            import_react.default.createElement(
              "a",
              {
                href: dashboardUrl(props.dashboardOrigin),
                target: "_blank",
                rel: "noreferrer",
                style: { marginLeft: "auto", fontSize: 12, opacity: 0.85 }
              },
              "\u5728\u65B0\u7A97\u53E3\u6253\u5F00 \u2197"
            )
          ),
          import_react.default.createElement("iframe", {
            src: dashboardUrl(props.dashboardOrigin),
            title: DASHBOARD_LABEL,
            style: { flex: 1, width: "100%", border: "none", minHeight: 0 }
          })
        );
      }
      function MemorySidebarAction(props) {
        return import_react.default.createElement(
          "button",
          {
            onClick: () => {
              props.onOpen();
            },
            title: DASHBOARD_LABEL,
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: props.wide ? "100%" : 32,
              height: 32,
              justifyContent: props.wide ? "flex-start" : "center",
              padding: props.wide ? "0 10px" : 0,
              cursor: "pointer",
              background: "transparent",
              border: "none",
              color: "inherit",
              opacity: 0.85,
              borderRadius: 6
            }
          },
          import_react.default.createElement(import_dsh_client_ui_primitives.IconDatabaseOutline16, null),
          props.wide ? import_react.default.createElement("span", { style: { fontSize: 12 } }, DASHBOARD_LABEL) : null
        );
      }
      function apply(ctx) {
        const slots = ctx.slots;
        ctx.slots.inject(
          "conversation.view",
          () => ctx.slots.register(
            {
              name: "conversation.view",
              id: VIEW_ID,
              order: 30,
              label: () => DASHBOARD_LABEL,
              inject: () => ({ dashboardOrigin: DASHBOARD_ORIGIN })
            },
            MemoryDashboardView
          )
        );
        ctx.slots.inject(
          "sidebar.footer.action",
          () => ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: SIDEBAR_ACTION_ID,
              order: 90,
              label: () => DASHBOARD_LABEL,
              inject: () => ({
                onOpen: () => openDashboardForSession(ctx.sessions, ctx.uiConversation)
              })
            },
            MemorySidebarAction
          )
        );
      }
      return __toCommonJS(entry_exports);
    })();
    
    return __tlmemory_client_exports;
  }
});
