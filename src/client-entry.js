// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）+ Issue #46 bundle 页配置表单（BCF-001..006）。
//
// 装载链（DSH 0.2.2-rc.5 app.asar 模板，权威）：
//   本文件顶层经 window.__ModuleLoader__.load({ id, factory }) 自注册；id 恒为包名。
//   宿主以 factory(require) 取得产物 { inject, apply }；React 只经 factory 入参
//   require("react") 进入组件作用域（loader 本身无 require 属性）。
//
// 约束：
//   - 模块顶层零副作用；无 window 或无模块表时整体短路（node import / 测试不抛、零 DOM 接触）。
//   - inject 恰 ["slots"]（live client 服务目录内声明，[L3]）；package.json dsh.client.inject 是
//     装载包列表，恰 []（[M4]）。
//   - 经典脚本、零 import、零构建、无 JSX：自包含，仅经 globalThis 探测宿主。
//   - 幂等：同一 ctx.slots 重复 apply 只挂载一次；卸载 cleanup 经 ctx.effect 登记并清空幂等键。
//   - React 缺失（require 抛出或返回非 React 值）时组件安全降级为 null。
//
// 范围（docs/specs/draft/bundle-config-ui.md）：
//   - settings.section「网页搜索链」：只读指示器（标题 + 指向 bundle 页配置表单的指引）。
//   - plugins.bundle.config（key = 包名）：bundle 页配置表单（view:'page'）与一行摘要（view:'summary'）。
//     表单不依赖 form prop（[C1] 宿主 bundle 级不传）；读写一律经 host.call("config.get"/"config.put")
//     走本包宿主半（src/config-bridge.js）。ctx.host 缺席时降级为「不可用」提示，不抛。
//   - 表单只覆盖三范围：条目增删改（类型/启用/名称/credentialRef）、官方开关、超时；不含 apiKey 输入。
//
// 本文件的常量为 src/constants.js 的本地镜像（PROVIDER_ID / TOOL_TYPES / BUNDLE 包名），变更须同步。
const PROVIDER_ID = "search-chain";
const PACKAGE_KEY = "dsh-search-chain"; // [C1] plugins.bundle.config 以包名为 key（非行 id）
const SECTION_SLOT = "settings.section";
const BUNDLE_SLOT = "plugins.bundle.config";
const SECTION_TITLE = "网页搜索链";

/** 区域排序：live [L2] 既有 occupants 之后（account -10 / general 0 / models 10 / plugins 15 / agent-presets 20）。 */
const SECTION_ORDER = 30;

/** CAT-001 八个类型（与 src/constants.js TOOL_TYPES 同值）。 */
const ENTRY_TYPES = [
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
];

/** 区域标题的懒求值 thunk（live label?: string|(()=>string)）。 */
const sectionLabel = () => SECTION_TITLE;

/** 编辑指引文案（BCF-006：实际可走路径）。 */
const EDIT_HINT = "编辑请使用 设置→插件→已安装→dsh-search-chain→配置表单";

/** 已挂载的 ctx.slots 幂等键；卸载 cleanup 清除。 */
const mounted = new WeakMap();

globalThis.window?.__ModuleLoader__?.load({
  id: "dsh-search-chain",
  factory(require) {
    // React 经宿主模块表注入的 require 取得；缺失或异常时降级为 null（组件渲染 null）。
    let React = null;
    try {
      const candidate = require("react");
      React = candidate && typeof candidate.createElement === "function" ? candidate : null;
    } catch {
      React = null;
    }

    /**
     * settings.section 只读指示器组件（第二参）。ownerProps 只给 { close }，本指示器不使用任何 props。
     */
    function SettingsIndicator(_props) {
      if (!React) return null;
      return React.createElement(
        "section",
        { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
        React.createElement("h3", null, SECTION_TITLE),
        React.createElement("p", null, EDIT_HINT),
      );
    }

    /** 辅助：把 config.get 返回的生效配置转成表单草稿（不引用 form prop）。 */
    function draftFromConfig(config) {
      const entries = Array.isArray(config.entries) ? config.entries : [];
      return {
        entries: entries.map((e) => ({
          id: String(e.id),
          type: typeof e.type === "string" ? e.type : ENTRY_TYPES[0],
          name: typeof e.name === "string" ? e.name : "",
          enabled: e.enabled !== false,
          credentialRef: typeof e.credentialRef === "string" ? e.credentialRef : "",
        })),
        useOfficial: config.useOfficialDeepSeekSearch !== false,
        timeoutText: config.timeoutMs === undefined ? "" : String(config.timeoutMs),
      };
    }

    const EMPTY_DRAFT = Object.freeze({ entries: [], useOfficial: true, timeoutText: "" });

    /**
     * bundle 页配置组件（第二参，plugins.bundle.config）。
     * 只用白名单 hook：useState / useEffect / useRef（fake hook-React 测试面同集）。
     * hook 调用顺序与 view 无关（summary 与 page 共用同一组 hook），保证 React 不因视图切换而错位。
     * @param {() => any} getHost 惰性取 ctx.host（缺席时返回 undefined）。
     */
    function makeBundleConfigComponent(getHost) {
      return function BundleConfig(props) {
        if (!React) return null;
        const view = props && props.view;

        const [draft, setDraft] = React.useState(EMPTY_DRAFT);
        const [phase, setPhase] = React.useState("loading"); // loading | ready | unavailable
        const [status, setStatus] = React.useState({ kind: "idle", text: "", issues: [] });
        const counter = React.useRef(0);

        // 挂载即拉取生效配置：setPhase 同步置位（驱动渲染），结果异步回填。
        React.useEffect(() => {
          let alive = true;
          setPhase("loading");
          const host = getHost();
          if (!host || typeof host.call !== "function") {
            setPhase("unavailable");
            setStatus({ kind: "error", text: "宿主配置半不可用，无法读取配置（ctx.host 缺席）", issues: [] });
            return undefined;
          }
          let pending;
          try {
            pending = host.call("config.get");
          } catch (err) {
            pending = Promise.reject(err);
          }
          Promise.resolve(pending).then(
            (res) => {
              if (!alive) return;
              if (res && res.ok === true && res.config && typeof res.config === "object") {
                setDraft(draftFromConfig(res.config));
                setPhase("ready");
              } else {
                setPhase("unavailable");
                setStatus({ kind: "error", text: (res && res.message) || "读取配置失败", issues: [] });
              }
            },
            () => {
              if (!alive) return;
              setPhase("unavailable");
              setStatus({ kind: "error", text: "读取配置失败：宿主半调用异常", issues: [] });
            },
          );
          return () => {
            alive = false;
          };
        }, []);

        if (view === "summary") {
          return React.createElement(
            "section",
            { "data-bundle-config-summary": "1" },
            React.createElement("span", null, "网页搜索链：条目与超时在配置表单中管理"),
          );
        }

        const ready = phase === "ready";
        const updateEntry = (id, patch) =>
          setDraft((d) => ({
            ...d,
            entries: d.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)),
          }));
        const removeEntry = (id) =>
          setDraft((d) => ({ ...d, entries: d.entries.filter((e) => e.id !== id) }));
        const addEntry = () => {
          counter.current += 1;
          const id = `new-${counter.current}`;
          setDraft((d) => ({
            ...d,
            entries: [...d.entries, { id, type: ENTRY_TYPES[0], name: "", enabled: true, credentialRef: "" }],
          }));
        };
        const save = () => {
          if (!ready) return;
          const host = getHost();
          if (!host || typeof host.call !== "function") return;
          const form = {
            entries: draft.entries.map((e) => ({
              id: e.id,
              type: e.type,
              name: e.name,
              enabled: e.enabled,
              credentialRef: e.credentialRef,
            })),
            useOfficialDeepSeekSearch: draft.useOfficial,
            timeoutMs: Number(draft.timeoutText),
          };
          let pending;
          try {
            pending = host.call("config.put", form);
          } catch (err) {
            pending = Promise.reject(err);
          }
          Promise.resolve(pending).then(
            (res) => {
              if (res && res.ok === true && res.config && typeof res.config === "object") {
                setDraft(draftFromConfig(res.config));
                setStatus({ kind: "saved", text: "已保存", issues: [] });
              } else {
                const issues = res && Array.isArray(res.issues) ? res.issues.map((i) => String(i.message)) : [];
                setStatus({ kind: "error", text: (res && res.message) || "保存失败", issues });
              }
            },
            () => setStatus({ kind: "error", text: "保存失败：宿主半调用异常，请重试", issues: [] }),
          );
        };

        const disabled = !ready;
        const field = (props2) => React.createElement("input", props2);

        const rows = draft.entries.map((e) =>
          React.createElement(
            "li",
            { key: e.id, "data-config-entry": e.id },
            React.createElement("span", null, e.name || "（未命名条目）"),
            React.createElement(
              "select",
              {
                "data-config-field": "entry-type",
                value: e.type,
                disabled,
                onChange: (ev) => updateEntry(e.id, { type: ev.target.value }),
              },
              ENTRY_TYPES.map((t) => React.createElement("option", { key: t, value: t }, t)),
            ),
            field({
              type: "text",
              "data-config-field": "entry-name",
              value: e.name,
              disabled,
              "aria-label": "条目名称",
              onChange: (ev) => updateEntry(e.id, { name: ev.target.value }),
            }),
            field({
              type: "checkbox",
              "data-config-field": "entry-enabled",
              checked: e.enabled,
              disabled,
              "aria-label": "启用条目",
              onChange: (ev) => updateEntry(e.id, { enabled: ev.target.checked }),
            }),
            field({
              type: "text",
              "data-config-field": "entry-credentialRef",
              value: e.credentialRef,
              disabled,
              placeholder: "凭据引用（credentialRef）",
              "aria-label": "凭据引用",
              onChange: (ev) => updateEntry(e.id, { credentialRef: ev.target.value }),
            }),
            React.createElement(
              "button",
              {
                type: "button",
                "data-config-action": "remove-entry",
                disabled,
                onClick: () => removeEntry(e.id),
              },
              "删除",
            ),
          ),
        );

        const statusNode =
          status.kind === "saved"
            ? React.createElement("span", { "data-config-status": "saved" }, status.text)
            : status.kind === "error"
              ? React.createElement(
                  "div",
                  { "data-config-status": "error" },
                  React.createElement("span", { "data-config-error": "1" }, status.text),
                  ...status.issues.map((m, i) => React.createElement("p", { key: `issue-${i}` }, m)),
                )
              : null;

        return React.createElement(
          "div",
          { "data-bundle-config": "1" },
          React.createElement(
            "label",
            null,
            field({
              type: "checkbox",
              "data-config-field": "useOfficialDeepSeekSearch",
              checked: draft.useOfficial,
              disabled,
              onChange: (ev) => setDraft((d) => ({ ...d, useOfficial: ev.target.checked })),
            }),
            " 使用官方 DeepSeek 搜索",
          ),
          React.createElement(
            "label",
            null,
            "超时（毫秒）",
            field({
              type: "number",
              min: 1,
              step: 1,
              "data-config-field": "timeoutMs",
              value: draft.timeoutText,
              disabled,
              onChange: (ev) => setDraft((d) => ({ ...d, timeoutText: ev.target.value })),
            }),
          ),
          React.createElement("ul", null, ...rows),
          React.createElement(
            "button",
            { type: "button", "data-config-action": "add-entry", disabled, onClick: addEntry },
            "添加条目",
          ),
          React.createElement(
            "button",
            { type: "button", "data-config-action": "save", disabled, onClick: save },
            "保存",
          ),
          statusNode,
        );
      };
    }

    const bundleConfigComponentFor = (getHost) => makeBundleConfigComponent(getHost);

    return {
      inject: ["slots"],
      /**
       * 挂载「网页搜索链」设置区（SET-001）与 bundle 页配置表单（BCF-001）。
       * @param {{
       *   host?: { call(method: string, input?: unknown): Promise<unknown> },
       *   slots: {
       *     inject(slot: string, factory: () => (() => void)): () => void,
       *     register(registration: object, Component: (props: object) => unknown): () => void,
       *   },
       *   effect(fn: () => (() => void)): void,
       * }} ctx
       */
      apply(ctx) {
        const key = ctx.slots;
        if (mounted.has(key)) return; // 幂等：重复 apply 不双 inject
        mounted.set(key, true);

        const offSection = ctx.slots.inject(SECTION_SLOT, () =>
          ctx.slots.register(
            { name: SECTION_SLOT, id: PROVIDER_ID, order: SECTION_ORDER, label: sectionLabel },
            SettingsIndicator,
          ),
        );

        const offBundle = ctx.slots.inject(BUNDLE_SLOT, () =>
          ctx.slots.register(
            { name: BUNDLE_SLOT, key: PACKAGE_KEY, inject: () => ({}) },
            bundleConfigComponentFor(() => ctx.host),
          ),
        );

        // 卸载语义（DSH-001）：effect 回调返回 cleanup，撤销懒挂载并清除幂等键；重复调用无副作用。
        ctx.effect(() => () => {
          offSection();
          offBundle();
          mounted.delete(key);
        });
      },
    };
  },
});
