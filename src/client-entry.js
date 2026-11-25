// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）+ Issue #48 设置面板（SET-001..005）+ bundle 页配置表单（BCF-001..006）。
//
// 装载链（DSH 0.2.2-rc.5 app.asar 模板，权威）：
//   本文件顶层经 window.__ModuleLoader__.load({ id, factory }) 自注册；id 恒为包名。
//   宿主以 factory(require) 取得产物 { inject, apply }；React 只经 factory 入参 require("react")。
//
// 约束：
//   - 模块顶层零副作用；无 window 或无模块表时整体短路（node import / 测试不抛、零 DOM 接触）。
//   - inject 恰 ["slots"]（[C3]：client 静态 ctx 无 host 服务；声明 host → 包不激活）。apply 与组件
//     全程不读 ctx.host（读即抛 cannot get property "host" without inject）。
//   - 经典脚本、零 import、零构建、无 JSX：自包含，仅经 globalThis 探测宿主。
//   - 幂等：同一 ctx.slots 重复 apply 只挂载一次；卸载 cleanup 经 ctx.effect 登记并清空幂等键。
//   - React 缺失（require 抛出或返回非 React 值）时组件安全降级为 null。
//
// 通道（规格 bundle-config-ui.md [C8]）：
//   读 = 同源 POST /api/settings/describe（args={}），取 namespaces 中 ns=search-chain 的 user 层与
//         revision（投影）；缺 revision 即禁止保存。
//   写 = 同源 POST /api/settings/mutate，args={ns, ops, expectedRevision}；凭据只写 = /api/credentials/set，args={ref,value}；
//         新 key 先写凭据、再写配置；toOps 对 moved/new entries 整条 set 并递归剥离秘密字段，稳定位置仍字段级 diff（D-1）。
//   合并/校验 = Component.contract（内联纯函数，与 src/config.js normalizeConfig 全等，对比钉见 test）。
//
// 本文件的常量为 src/constants.js 的本地镜像（TOOL_TYPES / 默认超时 / 凭据字段），变更须同步。

const PROVIDER_ID = "search-chain";
const SEARCH_NS = "search-chain"; // settings namespace（行 id 同值）
const PACKAGE_KEY = "dsh-search-chain"; // [C1] plugins.bundle.config 以包名为 key（非行 id）
const SECTION_SLOT = "settings.section";
const BUNDLE_SLOT = "plugins.bundle.config";
const SECTION_TITLE = "网页搜索链";

/** 区域排序：live [L2] 既有 occupants 之后。 */
const SECTION_ORDER = 30;

/** CAT-001 八个类型（与 src/constants.js TOOL_TYPES 同值）。 */
const TOOL_TYPES = [
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
];
const DEFAULT_TIMEOUT_MS = 25000;
const SECRET_FIELD = /^(apikey|api_key|key|secret|token|password|auth|authorization)$/i;
const HANDLED_ENTRY_FIELDS = ["id", "type", "name", "enabled", "credentialRef", "proxy"];
/** 表单管理的条目子字段（合并时覆盖；其余字段保留既有值）。 */
const MANAGED_ENTRY_KEYS = ["id", "type", "name", "enabled", "credentialRef"];
/** 表单管理的顶层键：保存时恒产出 set（即便值未变）。 */
const MANAGED_TOP_KEYS = ["useOfficialDeepSeekSearch", "timeoutMs"];

const sectionLabel = () => SECTION_TITLE;

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

    // ───────────────────────── 内联纯函数面（Component.contract）─────────────────────────
    // 与 src/config.js 同形裁决：validate ≡ normalizeConfig（对比钉在测试内）。不依赖 DOM/fetch/react。

    const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const invalid = (message) => {
      const e = new Error(message);
      e.code = "CONFIG_INVALID";
      return e;
    };

    function assertHttpUrl(text, where) {
      let u;
      try {
        u = new URL(text);
      } catch {
        throw invalid(`${where} 必须是绝对 HTTP(S) URL`);
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw invalid(`${where} 必须是 HTTP(S) URL`);
    }

    function normalizeProxy(raw, where) {
      const w = where ? `${where}.proxy` : "proxy";
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw === "string") {
        const s = raw.trim();
        if (s === "") return undefined;
        assertHttpUrl(s, w);
        return s;
      }
      if (isPlainObject(raw) && Object.keys(raw).length === 1 && typeof raw.pac === "string") {
        const pac = raw.pac.trim();
        if (pac === "") throw invalid(`${w}.pac 不得为空白`);
        assertHttpUrl(pac, `${w}.pac`);
        return { pac };
      }
      throw invalid(`${w} 形态非法（须为代理 URL 字符串或 { pac }）`);
    }

    function normalizeEntry(raw, index) {
      const where = `entries[${index}]`;
      if (!isPlainObject(raw)) throw invalid(`${where} 必须是对象`);
      if (typeof raw.id !== "string" || raw.id.trim() === "") throw invalid(`${where}.id 必须是非空字符串`);
      if (typeof raw.type !== "string" || !TOOL_TYPES.includes(raw.type)) {
        throw invalid(`${where}.type 不是已知工具类型`);
      }
      const name = raw.name === undefined ? raw.type : raw.name;
      if (typeof name !== "string") throw invalid(`${where}.name 必须是字符串`);
      const enabled = raw.enabled === undefined ? true : raw.enabled;
      if (typeof enabled !== "boolean") throw invalid(`${where}.enabled 必须是布尔值`);
      const out = { id: raw.id.trim(), type: raw.type, name, enabled };
      if (raw.credentialRef !== undefined && raw.credentialRef !== null && raw.credentialRef !== "") {
        if (typeof raw.credentialRef !== "string" || raw.credentialRef.trim() === "") {
          throw invalid(`${where}.credentialRef 非法`);
        }
        out.credentialRef = raw.credentialRef.trim();
      }
      const proxy = normalizeProxy(raw.proxy, where);
      if (proxy !== undefined) out.proxy = proxy;
      for (const [k, v] of Object.entries(raw)) {
        if (HANDLED_ENTRY_FIELDS.includes(k) || SECRET_FIELD.test(k)) continue;
        if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
      }
      return out;
    }

    function normalizeConfig(raw) {
      if (raw === undefined || raw === null) raw = {};
      if (!isPlainObject(raw)) throw invalid("配置必须是对象");
      const rawEntries = raw.entries === undefined ? [] : raw.entries;
      if (!Array.isArray(rawEntries)) throw invalid("entries 必须是数组");
      const entries = rawEntries.map((e, i) => normalizeEntry(e, i));
      const seen = new Set();
      for (const e of entries) {
        if (seen.has(e.id)) throw invalid(`entries 中 id 重复：${e.id}`);
        seen.add(e.id);
      }
      const useOfficial = raw.useOfficialDeepSeekSearch === undefined ? true : raw.useOfficialDeepSeekSearch;
      if (typeof useOfficial !== "boolean") throw invalid("useOfficialDeepSeekSearch 必须是布尔值");
      const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : raw.timeoutMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw invalid("timeoutMs 必须是正整数毫秒");
      return { entries, useOfficialDeepSeekSearch: useOfficial, timeoutMs };
    }

    function validate(raw) {
      try {
        return { ok: true, config: normalizeConfig(raw) };
      } catch (e) {
        return {
          ok: false,
          code: "CONFIG_INVALID",
          issues: [{ message: String((e && e.message) || "配置未通过校验") }],
        };
      }
    }

    function mergeEntry(prior, formEntry) {
      if (!isPlainObject(formEntry)) return formEntry; // 非对象原样交写闸拒绝
      const saved = typeof formEntry.id === "string" ? prior.get(formEntry.id) : undefined;
      // 草稿包含 effective entry 的完整配置，写 user 层时须 materialize base 条目；
      // 仍保留 user 原有 secret/未知字段，再由草稿中的受支持值覆盖。
      const next = saved ? { ...saved } : {};
      for (const [k, value] of Object.entries(formEntry)) {
        if (SECRET_FIELD.test(k)) continue;
        if (MANAGED_ENTRY_KEYS.includes(k) || k === "proxy" || ["string", "number", "boolean"].includes(typeof value)) {
          next[k] = value;
        }
      }
      if (next.credentialRef === "") delete next.credentialRef;
      return next;
    }

    /** 合并：表单管理字段覆盖 current；未知键与既有 apiKey 原样保留（merged 面）；表单明文字段忽略。 */
    function merge(form, current) {
      const base = isPlainObject(current) ? current : {};
      const f = isPlainObject(form) ? form : {};
      const out = { ...base };
      if (f.entries !== undefined) {
        if (Array.isArray(f.entries)) {
          const prior = new Map();
          if (Array.isArray(base.entries)) {
            for (const e of base.entries) if (isPlainObject(e) && typeof e.id === "string") prior.set(e.id, e);
          }
          out.entries = f.entries.map((fe) => mergeEntry(prior, fe));
        } else {
          out.entries = f.entries; // 非数组原样交写闸
        }
      }
      for (const k of MANAGED_TOP_KEYS) {
        if (f[k] !== undefined) out[k] = f[k];
      }
      return out;
    }

    function deepEq(a, b) {
      if (a === b) return true;
      if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
    }

    /** 递归剥离明文字段（SECRET_FIELD 键）：ops 的 set 值绝不携带既有/表单的明文 key（P2-1）。 */
    function stripSecrets(v) {
      if (Array.isArray(v)) return v.map(stripSecrets);
      if (v !== null && typeof v === "object") {
        const out = {};
        for (const [k, child] of Object.entries(v)) if (!SECRET_FIELD.test(k)) out[k] = stripSecrets(child);
        return out;
      }
      return v;
    }

    /** 路径补丁 reducer（与 settings 宿主 mutate 语义同形：数值段=数组下标；unset 数组段=splice）。 */
    function applyOne(state, op) {
      const segs = op.path.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
      let node = state;
      for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        if (node[k] === undefined || node[k] === null) node[k] = typeof segs[i + 1] === "number" ? [] : {};
        node = node[k];
      }
      const last = segs[segs.length - 1];
      if (op.op === "set") node[last] = structuredClone(op.value);
      else if (Array.isArray(node) && typeof last === "number") node.splice(last, 1);
      else delete node[last];
    }

    /**
     * 产出路径补丁（set/unset），作用于 current 后 ≡ next（剥离明文后）。
     * 位置不变的条目维持字段级 diff；仅位置变化/新追加条目以整条 set，且 set 值递归剥离秘密键。
     * 删除通过从尾部 unset 收尾，避免重排引入无关列表覆写（D-1）。
     */
    function toOps(next, current) {
      const ops = [];
      const state = structuredClone(isPlainObject(current) ? current : {});
      const emit = (op) => {
        const o = op.op === "set" ? { op: "set", path: op.path, value: stripSecrets(op.value) } : op;
        ops.push(o);
        applyOne(state, o);
      };
      const nxt = isPlainObject(next) ? next : {};
      for (const key of Object.keys(state)) {
        if (key !== "entries" && !(key in nxt)) emit({ op: "unset", path: [key] });
      }
      for (const key of Object.keys(nxt)) {
        if (key === "entries") continue;
        if (MANAGED_TOP_KEYS.includes(key) || !deepEq(state[key], nxt[key])) emit({ op: "set", path: [key], value: nxt[key] });
      }
      const target = nxt.entries;
      if (target === undefined) {
        if (state.entries !== undefined) emit({ op: "unset", path: ["entries"] });
        return ops;
      }
      if (!Array.isArray(target)) {
        emit({ op: "set", path: ["entries"], value: target });
        return ops;
      }
      if (!Array.isArray(state.entries)) emit({ op: "set", path: ["entries"], value: [] });
      for (const t of target) if (!isPlainObject(t)) throw invalid("entries 含非对象项");
      for (let i = 0; i < target.length; i++) {
        const t = target[i];
        const cur = state.entries[i];
        if (isPlainObject(cur) && cur.id === t.id) {
          for (const k of Object.keys(t)) {
            if (!deepEq(cur[k], t[k])) emit({ op: "set", path: ["entries", String(i), k], value: t[k] });
          }
          for (const k of Object.keys(cur)) {
            if (!(k in t)) emit({ op: "unset", path: ["entries", String(i), k] });
          }
        } else {
          emit({ op: "set", path: ["entries", String(i)], value: t });
        }
      }
      for (let i = state.entries.length - 1; i >= target.length; i--) {
        emit({ op: "unset", path: ["entries", String(i)] });
      }
      return ops;
    }

    const contract = Object.freeze({ merge, validate, toOps });

    // ───────────────────────────── 组件 ─────────────────────────────

    /** settings RPC 信封（[C8]）：payload 恒为 {args}。 */
    let rpcSeq = 0;
    function rpc(method, args) {
      const body = {
        type: "client-request",
        rpcId: `bcf-${Date.now().toString(36)}-${++rpcSeq}`,
        method: `settings/${method}`,
        payload: { args },
      };
      return fetch(`/api/settings/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    }

    /** 兼容两种回包形：{result:{ok,value|error}}（宿主线格式）与 {ok, result}（投影样本）。 */
    function unwrap(res) {
      if (!res || typeof res !== "object") return { ok: false, message: "宿主回包为空" };
      if (res.result && typeof res.result === "object" && "ok" in res.result) {
        if (res.result.ok === true) return { ok: true, value: res.result.value };
        const err = res.result.error || res.error;
        return { ok: false, message: (err && err.message) || "宿主拒绝该请求" };
      }
      if (res.ok === true) return { ok: true, value: res.result };
      return { ok: false, message: (res.error && res.error.message) || "宿主拒绝该请求" };
    }

    /** 投影：describe 值中 search-chain 的 base/user 与 revision（user = 宿主 mutate 作用的层）。 */
    function projectionOf(value) {
      if (!value || !Array.isArray(value.namespaces)) return null;
      const item = value.namespaces.find((n) => n && n.ns === SEARCH_NS);
      if (!item) return null;
      return {
        base: isPlainObject(item.base) ? item.base : {},
        user: isPlainObject(item.user) ? item.user : {},
        revision: typeof item.revision === "number" ? item.revision : undefined,
      };
    }

    function draftFrom(config) {
      const entries = Array.isArray(config.entries) ? config.entries : [];
      return {
        entries: entries.map((e) => {
          const passthrough = {};
          if (isPlainObject(e)) {
            for (const [k, value] of Object.entries(e)) {
              if (HANDLED_ENTRY_FIELDS.includes(k) || SECRET_FIELD.test(k)) continue;
              if (["string", "number", "boolean"].includes(typeof value)) passthrough[k] = value;
            }
            // proxy is a supported structured field; strip secret-shaped nested keys defensively.
            if (Object.prototype.hasOwnProperty.call(e, "proxy")) passthrough.proxy = stripSecrets(e.proxy);
          }
          return {
            ...passthrough,
            id: String(e.id),
            type: typeof e.type === "string" ? e.type : TOOL_TYPES[0],
            name: typeof e.name === "string" ? e.name : "",
            enabled: e.enabled !== false,
            credentialRef: typeof e.credentialRef === "string" ? e.credentialRef : "",
          };
        }),
        useOfficial: config.useOfficialDeepSeekSearch !== false,
        timeoutText: config.timeoutMs === undefined ? "" : String(config.timeoutMs),
      };
    }

    const EMPTY_DRAFT = Object.freeze({ entries: [], useOfficial: true, timeoutText: "" });
    const IDLE = Object.freeze({ kind: "idle", text: "", issues: [] });

    /** settings.section 完整设置面板（第二参）。所有配置读写均经同源 Remote API。 */
    let entryIdSeq = 0;
    let credentialRefSeq = 0;
    const KEYED_TYPES = TOOL_TYPES.filter((type) => type !== "bing");
    const CATALOG_UI = [
      ["openai", "OpenAI", "按 OpenAI API 账户用量计费。"],
      ["tavily", "Tavily", "Basic 查询消耗一个 credit。"],
      ["exa", "Exa", "费用随 Exa 搜索和内容用量计算。"],
      ["brave", "Brave", "按 Brave Web Search API 账户用量计费。"],
      ["bing", "Bing RSS", "公开 RSS 通道，免 key，不产生供应商计费。"],
      ["gemini", "Gemini", "计费受所选模型和账户影响。"],
      ["deepseek-search", "DeepSeek Search API", "有结果的成功请求按次计费。"],
      ["deepseek-agentic-search", "DeepSeek Agentic Search", "不另收搜索次数费用，模型用量仍按 token 计费。"],
    ];
    const PANEL_CSS = `
      .sc-panel { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 720px; color: var(--dsw-alias-label-primary, inherit); font-family: inherit; }
      .sc-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .sc-description { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
      .sc-official-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
      .sc-official-row .sc-switch { color: var(--dsw-alias-label-primary); }
      .sc-official-row .sc-switch-label { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
      .sc-official-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .sc-card-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .sc-card { box-sizing: border-box; position: relative; border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
      .sc-card::before, .sc-card::after { content: ''; position: absolute; z-index: 1; left: 0; right: 0; height: 4px; }
      .sc-card::before { top: -4px; }
      .sc-card::after { bottom: -4px; }
      .sc-card[data-dragging] { opacity: 0.5; }
      .sc-card[data-drop-target] { z-index: 1; }
      .sc-card[data-drop-target='before']::before,
      .sc-card[data-drop-target='after']::after {
        height: 12px;
        background:
          linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,
          linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,
          linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;
      }
      .sc-card[data-drop-target='before']::before { top: -10px; }
      .sc-card[data-drop-target='after']::after { bottom: -10px; }
      .sc-card-drag-preview { background: var(--dsw-alias-bg-module-platform); }
      .sc-card-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .sc-card-info { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .sc-card-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
      .sc-card-name { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .sc-card-name-placeholder { color: var(--dsw-alias-label-secondary, inherit); }
      .sc-type-badge { flex: none; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .sc-type-duplicate { display: none; }
      .sc-status { display: inline-flex; flex: none; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; font-weight: 400; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .sc-status-dot { box-sizing: border-box; display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; }
      .sc-status-dot[data-state="ready"] { background: var(--dsw-alias-state-success-primary); }
      .sc-status-dot[data-state="missing"] { background: var(--dsw-alias-state-error-primary); }
      .sc-status-dot[data-state="disabled"] { background: var(--dsw-alias-state-idle-primary); }
      .sc-button, .sc-button-primary, .sc-button-secondary {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: 36px;
        padding: 0 14px;
        border: none;
        border-radius: var(--dsw-radius-md);
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        cursor: pointer;
      }
      .sc-button-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      @media (hover: hover) {
        .sc-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      }
      .sc-button-secondary { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); }
      @media (hover: hover) {
        .sc-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
      }
      .sc-button-danger {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 36px;
        padding: 0 14px;
        border: none;
        border-radius: var(--dsw-radius-md);
        background: transparent;
        color: var(--dsw-alias-state-error-primary);
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        cursor: pointer;
      }
      @media (hover: hover) {
        .sc-button-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
      }
      .sc-card-actions .sc-button-secondary {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        gap: 4px; height: 28px; padding: 0 10px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-sm);
        background: transparent; color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
      }
      @media (hover: hover) {
        .sc-card-actions .sc-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
      }
      .sc-card-actions .sc-button-danger {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        height: 28px; padding: 0 10px;
        border: none; border-radius: var(--dsw-radius-sm);
        background: transparent; color: var(--dsw-alias-state-error-primary);
        font: inherit; font-size: 12px; line-height: 18px; text-decoration: none; cursor: pointer;
      }
      @media (hover: hover) {
        .sc-card-actions .sc-button-danger:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover-danger);
          text-decoration: none;
        }
      }
      .sc-delete-confirm:not(:disabled) {
        --dsh-button-outline-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-state-error-primary);
      }
      @media (hover: hover) {
        .sc-delete-confirm:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
      }
      .sc-button-primary-small,
      .sc-save-button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        align-self: flex-end;
        height: 36px;
        padding: 0 14px;
        border: none;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-foreground);
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        cursor: pointer;
      }
      @media (hover: hover) {
        .sc-button-primary-small:hover:not(:disabled),
        .sc-save-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      }
      .sc-button:disabled, .sc-button-primary:disabled, .sc-button-primary-small:disabled, .sc-button-secondary:disabled,
      .sc-button-danger:disabled, .sc-save-button:disabled, .sc-add-button:disabled, .sc-drag-handle:disabled,
      .sc-picker-item:disabled { opacity: 0.4; cursor: default; }
      .sc-input:disabled { opacity: 0.6; cursor: default; }
      .sc-button:focus-visible, .sc-button-primary:focus-visible, .sc-button-secondary:focus-visible, .sc-button-danger:focus-visible,
      .sc-button-primary-small:focus-visible, .sc-save-button:focus-visible, .sc-drag-handle:focus-visible,
      .sc-add-button:focus-visible, .sc-picker-item:focus-visible {
        outline: none;
        box-shadow: 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      }
      .sc-drag-handle {
        box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; padding: 0; border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent; color: var(--dsw-alias-label-tertiary);
        font-family: inherit; font-size: 14px; line-height: 1; cursor: pointer;
      }
      .sc-drag-handle:not(:disabled) { cursor: grab; }
      .sc-drag-handle:active:not(:disabled) { cursor: grabbing; }
      @media (hover: hover) {
        .sc-drag-handle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      }
      .sc-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
      .sc-switch:has(.sc-switch-input:disabled) { cursor: default; }
      .sc-switch-label { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
      .sc-switch-input:disabled ~ .sc-switch-label { opacity: .5; }
      .sc-hidden-label,
      .sc-switch-input {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
      }
      .sc-switch-track {
        box-sizing: border-box;
        position: relative;
        display: block;
        flex: 0 0 auto;
        width: 36px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        corner-shape: round;
        background: var(--dsw-alias-border-l3);
        cursor: pointer;
      }
      .sc-switch-track::after {
        content: "";
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        corner-shape: round;
        background: var(--dsw-alias-switch-thumb);
        transition: transform .12s ease;
      }
      .sc-switch-input:checked + .sc-switch-track { background: var(--dsw-alias-brand-primary); }
      .sc-switch-input:checked + .sc-switch-track::after {
        background: var(--dsw-alias-label-primary-foreground);
        transform: translate(16px);
      }
      .sc-switch-input:disabled + .sc-switch-track { cursor: default; opacity: .5; }
      .sc-switch-input:focus-visible + .sc-switch-track {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      html[data-input-modality='pointer'] .sc-switch-input:focus-visible + .sc-switch-track { outline-color: transparent; }
      @media (prefers-reduced-motion: reduce) {
        .sc-switch-track { transition: none; }
        .sc-switch-track::after { transition: none; }
      }
      .sc-add-block { display: flex; flex-direction: column; gap: 12px; }
      .sc-add-actions { display: flex; }
      .sc-add-button {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 1 1 0;
        min-width: 180px;
        height: 44px;
        padding: 0 14px;
        gap: 6px;
        border: 1px dashed var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-lg);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        cursor: pointer;
      }
      @media (hover: hover) {
        .sc-add-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      }
      .sc-editor, .sc-picker, .sc-dialog {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 14px 16px;
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-primary);
      }
      .sc-editor { gap: 14px; }
      .sc-card .sc-editor, .sc-card .sc-dialog { background: none; padding: 0; }
      .sc-picker { gap: 8px; }
      .sc-picker-item {
        display: flex;
        width: 100%;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 14px 16px;
        border: 0;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        text-align: start;
        cursor: pointer;
      }
      @media (hover: hover) {
        .sc-picker-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
      }
      .sc-picker-title { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .sc-picker-billing { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
      .sc-editor-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .sc-editor-actions, .sc-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .sc-field { display: flex; flex-direction: column; gap: 6px; margin-block: 0; }
      .sc-field-label { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
      .sc-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
      .sc-input {
        box-sizing: border-box;
        width: 100%;
        height: 32px;
        padding: 0 10px;
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-md);
        font: inherit;
        font-size: 14px;
        line-height: 22px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
      }
      .sc-input::placeholder { color: var(--dsw-alias-label-dimmed); }
      .sc-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
      select.sc-input { max-width: 240px; cursor: pointer; }
      .sc-select-input {
        appearance: none;
        padding-right: 32px;
        /* Data-URI SVGs cannot resolve CSS variables; #81858C is the caption gray
           shared by both themes. */
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 12px center;
        background-size: 12px 12px;
      }
      .sc-status-node { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .sc-status-node[data-state="saved"] { color: var(--dsw-alias-state-success-primary); }
      .sc-status-node[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
      @media (max-width: 720px) {
        .sc-card { padding: 18px 16px; }
        .sc-card-row { align-items: flex-start; flex-direction: column; }
        .sc-card-actions { justify-content: flex-start; }
        .sc-dialog, .sc-picker { padding: 18px; }
      }
    `;
    const POSIX_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const theme = (token, fallback = "inherit") => `var(--dsw-alias-${token}, ${fallback})`;
    const primaryTextStyle = { color: theme("label-primary") };
    const secondaryTextStyle = { color: theme("label-secondary") };

    function credentialRpc(method, args) {
      const body = {
        type: "client-request",
        rpcId: `sc-cred-${Date.now().toString(36)}-${++rpcSeq}`,
        method: `credentials/${method}`,
        payload: { args },
      };
      return fetch(`/api/credentials/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    }

    function credentialRefFor(entryId) {
      const safeId = String(entryId).replace(/[^A-Za-z0-9_]/g, "_") || "entry";
      return `SEARCH_CHAIN_CREDENTIAL_${safeId}_${Date.now().toString(36)}_${++credentialRefSeq}`;
    }

    function SettingsPanel(_props) {
      if (!React) return null;
      // 组件工厂的轻量测试/预览适配：完整 DSH React 提供 hooks；仅 createElement 的宿主探针显示静态标题与添加入口。
      if (typeof React.useState !== "function" || typeof React.useEffect !== "function" || typeof React.useRef !== "function") {
        return React.createElement("section", { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
          React.createElement("h3", null, SECTION_TITLE),
          React.createElement("p", { "data-role": "empty-state" }, "还没有配置搜索工具。"),
          React.createElement("button", { type: "button", "data-role": "add-tool" }, "添加搜索工具"),
        );
      }
      const [model, setModel] = React.useState({
        phase: "loading",
        base: {},
        user: {},
        revision: undefined,
        draft: { entries: [], useOfficial: true, timeoutText: String(DEFAULT_TIMEOUT_MS) },
        keys: {},
        editingId: null,
        addOpen: false,
        confirmId: null,
        status: IDLE,
      });
      const alive = React.useRef(true);
      const restoreFocus = React.useRef(null);
      const locked = model.status.kind === "pending";

      const load = (keepStatus = false) => {
        setModel((m) => ({ ...m, phase: "loading" }));
        let pending;
        try { pending = rpc("describe", {}); } catch (err) { pending = Promise.reject(err); }
        Promise.resolve(pending).then((res) => {
          if (!alive.current) return;
          const got = unwrap(res);
          const proj = got.ok ? projectionOf(got.value) : null;
          if (!proj) {
            const text = got.ok ? "宿主投影中缺少 search-chain 命名空间" : `读取配置失败：${got.message}`;
            setModel((m) => ({ ...m, phase: "unavailable", revision: undefined, status: { kind: "error", text, issues: [] } }));
            return;
          }
          const effective = { ...proj.base, ...proj.user };
          const check = validate(effective);
          const normalized = check.ok ? check.config : effective;
          const draft = draftFrom(normalized);
          setModel((m) => ({
            ...m,
            phase: typeof proj.revision === "number" ? "ready" : "unavailable",
            base: proj.base,
            user: proj.user,
            revision: proj.revision,
            draft,
            status: keepStatus ? m.status : typeof proj.revision !== "number"
              ? { kind: "error", text: "宿主投影缺少 revision，禁止保存（请重新打开设置）", issues: [] }
              : check.ok ? IDLE : { kind: "error", text: "当前配置未通过校验，请修正后保存", issues: check.issues.map((i) => i.message) },
          }));
        }, (err) => {
          if (!alive.current) return;
          setModel((m) => ({ ...m, phase: "unavailable", revision: undefined, status: { kind: "error", text: `读取配置失败：${String((err && err.message) || err)}`, issues: [] } }));
        });
      };

      React.useEffect(() => {
        alive.current = true;
        load();
        return () => { alive.current = false; };
      }, []);

      const updateEntry = (id, patch) => {
        if (locked) return;
        setModel((m) => ({
          ...m,
          draft: { ...m.draft, entries: m.draft.entries.map((e) => e.id === id ? { ...e, ...patch } : e) },
          status: m.status.kind === "error" ? IDLE : m.status,
        }));
      };
      const moveEntry = (id, delta) => setModel((m) => {
        if (locked || m.status.kind === "pending") return m;
        const from = m.draft.entries.findIndex((e) => e.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= m.draft.entries.length) return m;
        const entries = [...m.draft.entries];
        [entries[from], entries[to]] = [entries[to], entries[from]];
        return { ...m, draft: { ...m.draft, entries } };
      });
      const addEntry = (type) => {
        if (locked) return;
        const label = CATALOG_UI.find((x) => x[0] === type)?.[1] ?? type;
        const id = `search_chain_${Date.now().toString(36)}_${++entryIdSeq}`;
        setModel((m) => ({ ...m, addOpen: false, draft: { ...m.draft, entries: [...m.draft.entries, { id, type, name: label, enabled: true, credentialRef: "" }] } }));
      };
      const save = async () => {
        if (locked || model.status.kind === "pending" || model.phase !== "ready" || typeof model.revision !== "number") return;
        // 先把本次非空 key 将生成的新引用投影到临时 entries，再校验剩余引用；
        // 这样迁移旧冒号 ref 时，旧值既不会阻断，也不会进入任何请求体。
        let entries = model.draft.entries.map((e) => ({ ...e }));
        const credentialWrites = [];
        for (let i = 0; i < entries.length; i++) {
          const value = typeof model.keys[entries[i].id] === "string" ? model.keys[entries[i].id].trim() : "";
          if (!KEYED_TYPES.includes(entries[i].type) || !value) continue;
          const ref = credentialRefFor(entries[i].id);
          entries[i] = { ...entries[i], credentialRef: ref };
          credentialWrites.push({ ref, value });
        }
        const bad = entries.find((e) => e.credentialRef && !POSIX_REF.test(e.credentialRef.trim()));
        if (bad) {
          setModel((m) => ({ ...m, status: { kind: "error", text: "凭据引用格式无效：仅允许以字母或下划线开头，后续使用字母、数字或下划线。", issues: [] } }));
          return;
        }
        setModel((m) => ({ ...m, status: { kind: "pending", text: "保存中…", issues: [] } }));
        try {
          for (const { ref, value } of credentialWrites) {
            const response = await credentialRpc("set", { ref, value });
            const result = unwrap(response);
            if (!result.ok) throw new Error(result.message || "凭据服务拒绝写入");
          }
          const form = {
            entries,
            useOfficialDeepSeekSearch: model.draft.useOfficial,
            timeoutMs: Number(model.draft.timeoutText),
          };
          const merged = merge(form, model.user);
          const check = validate(Object.assign({}, model.base, merged));
          if (!check.ok) {
            setModel((m) => ({ ...m, status: { kind: "error", text: "配置未保存：校验未通过", issues: check.issues.map((i) => i.message) } }));
            return;
          }
          const ops = toOps(merged, model.user);
          const response = await rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: model.revision });
          const result = unwrap(response);
          if (!result.ok) {
            let message = String(result.message || "宿主拒绝该请求");
            for (const secret of Object.values(model.keys)) {
              if (typeof secret === "string" && secret.trim()) message = message.replaceAll(secret.trim(), "[redacted]");
            }
            setModel((m) => ({ ...m, status: { kind: "error", text: `保存失败：${message}`, issues: [] } }));
            return;
          }
          setModel((m) => ({
            ...m,
            user: merged,
            draft: { ...m.draft, entries: entries.map((e) => ({ ...e })), timeoutText: String(form.timeoutMs) },
            keys: {},
            status: { kind: "saved", text: "已保存", issues: [] },
          }));
          load(true);
        } catch (err) {
          let message = String((err && err.message) || err || "保存失败");
          for (const secret of Object.values(model.keys)) {
            if (typeof secret === "string" && secret.trim()) message = message.replaceAll(secret.trim(), "[redacted]");
          }
          setModel((m) => ({ ...m, status: { kind: "error", text: `保存失败：${message}`, issues: [] } }));
        }
      };
      const closeEditor = () => {
        if (locked) return;
        setModel((m) => ({ ...m, editingId: null }));
        const node = restoreFocus.current;
        if (node && typeof node.focus === "function") Promise.resolve().then(() => node.focus());
      };
      const onDialogKeyDown = (ev) => {
        if (locked) return;
        if (ev.key === "Escape") { ev.preventDefault?.(); closeEditor(); return; }
        if (ev.key === "Tab" && ev.currentTarget?.querySelectorAll) {
          const items = [...ev.currentTarget.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled);
          if (items.length) {
            const first = items[0], last = items[items.length - 1], active = ev.currentTarget.ownerDocument?.activeElement;
            if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
            else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
          }
        }
      };

      const entryStatusText = (e) => {
        if (!e.enabled) return "已关闭";
        if (KEYED_TYPES.includes(e.type) && !e.credentialRef) return "缺少凭据引用";
        return "已就绪";
      };
      const entryStatusState = (e) => (!e.enabled ? "disabled" : KEYED_TYPES.includes(e.type) && !e.credentialRef ? "missing" : "ready");
      const dragList = (node) => node?.closest?.(".sc-card-list") ?? null;
      const clearDragMarks = (node) => {
        const list = dragList(node);
        if (!list?.querySelectorAll) return;
        for (const el of list.querySelectorAll("[data-drop-target],[data-dragging]")) {
          el.removeAttribute("data-drop-target");
          el.removeAttribute("data-dragging");
        }
      };
      // 落点语义（指示线与实际插入共用）：指针在目标卡上半部 → before（插到目标之前），下半部 → after（插到目标之后）。
      const dropSide = (ev) => {
        const card = ev.currentTarget;
        if (!card?.getBoundingClientRect || typeof ev.clientY !== "number") return "after";
        const r = card.getBoundingClientRect();
        return ev.clientY < r.top + r.height / 2 ? "before" : "after";
      };
      const markDropTarget = (ev) => {
        const card = ev.currentTarget;
        if (!card?.getBoundingClientRect || !card.setAttribute) return;
        const pos = dropSide(ev);
        for (const el of dragList(card)?.querySelectorAll?.("[data-drop-target]") ?? []) if (el !== card) el.removeAttribute("data-drop-target");
        if (card.getAttribute("data-drop-target") !== pos) card.setAttribute("data-drop-target", pos);
      };
      const cardNodes = model.draft.entries.map((entry) => {
        const row = CATALOG_UI.find((x) => x[0] === entry.type);
        const displayName = entry.name || "（未命名条目）";
        const displayType = row?.[1] ?? entry.type;
        const duplicateTypeLabel = displayName === displayType;
        return React.createElement("article", {
          key: entry.id, "data-role": "card", "data-entry-id": entry.id, className: "sc-card",
          onDragOver: (ev) => { if (!locked) { ev.preventDefault?.(); markDropTarget(ev); } },
          onDrop: (ev) => {
            if (locked) return;
            ev.preventDefault?.();
            // 先读取落点侧（与指示线同一判定），再清理拖拽标记。
            const side = dropSide(ev);
            clearDragMarks(ev.currentTarget);
            const moving = ev.dataTransfer?.getData?.("text/plain");
            if (!moving || moving === entry.id) return;
            setModel((m) => {
              const list = [...m.draft.entries];
              const from = list.findIndex((e) => e.id === moving), to = list.findIndex((e) => e.id === entry.id);
              if (from < 0 || to < 0) return m;
              // 目标插入位：before=目标原索引 to，after=to+1（均按移除前的原列表计）。
              // 先移除被拖项：若插入位在其之后，移除后索引左移一位。
              const pos = side === "after" ? to + 1 : to;
              const finalIndex = from < pos ? pos - 1 : pos;
              if (finalIndex === from) return m;
              const [item] = list.splice(from, 1); list.splice(finalIndex, 0, item);
              return { ...m, draft: { ...m.draft, entries: list } };
            });
          },
        },
          React.createElement("div", { className: "sc-card-row" },
            React.createElement("div", { className: "sc-card-info" },
              React.createElement("span", { "data-role": "card-name", "data-entry-id": entry.id, className: entry.name ? "sc-card-name" : "sc-card-name sc-card-name-placeholder" }, displayName),
              React.createElement("span", { "data-role": "card-type", "data-entry-id": entry.id, className: duplicateTypeLabel ? "sc-type-duplicate" : "sc-type-badge" }, displayType),
              React.createElement("span", { "data-role": "card-status", "data-entry-id": entry.id, "aria-live": "polite", className: "sc-status" },
                React.createElement("span", { className: "sc-status-dot", "aria-hidden": "true", "data-state": entryStatusState(entry) }),
                React.createElement("span", null, entryStatusText(entry)),
              ),
            ),
            React.createElement("div", { className: "sc-card-actions" },
              React.createElement("label", { className: "sc-switch" },
                React.createElement("input", {
                  className: "sc-switch-input", type: "checkbox", role: "switch", "aria-checked": entry.enabled,
                  "aria-label": `启用 ${entry.name || row?.[1] || entry.type}`,
                  "data-role": "enabled-toggle", "data-entry-id": entry.id, checked: entry.enabled, disabled: locked,
                  onChange: (ev) => updateEntry(entry.id, { enabled: Boolean(ev.target.checked) }),
                }),
                React.createElement("span", { className: "sc-switch-track", "aria-hidden": "true" }),
                React.createElement("span", { className: "sc-switch-label" }, "启用"),
              ),
              React.createElement("button", {
                className: "sc-button-secondary", type: "button", "data-role": "card-edit", "data-entry-id": entry.id, disabled: locked,
                onClick: (ev) => { if (locked) return; restoreFocus.current = ev.currentTarget ?? null; setModel((m) => ({ ...m, editingId: entry.id, status: m.status.kind === "error" ? IDLE : m.status })); },
              }, "编辑"),
              React.createElement("button", {
                className: "sc-button-danger", type: "button", "data-role": "card-remove", "data-entry-id": entry.id, disabled: locked,
                onClick: () => { if (!locked) setModel((m) => ({ ...m, confirmId: entry.id })); },
              }, "移除"),
              React.createElement("button", {
                className: "sc-drag-handle", type: "button", "data-role": "drag-handle", "data-entry-id": entry.id, disabled: locked,
                draggable: !locked, "aria-label": `拖动排序：${entry.name || row?.[1] || entry.type}`,
                title: "拖动排序；也可按方向键调整位置",
                onDragStart: (ev) => { if (locked) return; ev.dataTransfer?.setData?.("text/plain", entry.id); ev.currentTarget?.closest?.('[data-role="card"]')?.setAttribute?.("data-dragging", ""); },
                onDragEnd: (ev) => { clearDragMarks(ev.currentTarget); },
                onKeyDown: (ev) => {
                  if (locked) return;
                  if (ev.key === "ArrowUp") { ev.preventDefault?.(); moveEntry(entry.id, -1); }
                  else if (ev.key === "ArrowDown") { ev.preventDefault?.(); moveEntry(entry.id, 1); }
                },
              }, "⠿"),
            ),
          ),
        );
      });
      const editorEntry = model.draft.entries.find((e) => e.id === model.editingId);
      const statusNode = model.status.kind === "idle" ? null : React.createElement("p", {
        className: model.status.kind === "error" ? "sc-status-node sc-error" : "sc-status-node",
        "data-role": model.status.kind === "error" ? "save-error" : "save-status",
        "data-state": model.status.kind,
        role: model.status.kind === "error" ? "alert" : "status",
      }, model.status.text, ...(model.status.issues ?? []).map((issue, i) => React.createElement("span", { key: `issue-${i}`, style: secondaryTextStyle }, ` ${issue}`)));
      const editor = editorEntry ? React.createElement("div", {
        role: "dialog", "aria-modal": "true", "aria-labelledby": "sc-editor-title",
        "data-role": "editor", onKeyDown: onDialogKeyDown, className: "sc-dialog sc-editor",
      },
        React.createElement("h4", { id: "sc-editor-title", className: "sc-editor-title" }, `编辑 ${editorEntry.name || editorEntry.type}`),
        React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "名称"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "name", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.name, onChange: (ev) => updateEntry(editorEntry.id, { name: ev.target.value }), autoFocus: true,
        })),
        React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "凭据引用"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "credentialRef", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.credentialRef ?? "", placeholder: "例如 TAVILY_API_KEY",
          onChange: (ev) => updateEntry(editorEntry.id, { credentialRef: ev.target.value }),
        })),
        KEYED_TYPES.includes(editorEntry.type) ? React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "API key（仅写入，不会回显）"), React.createElement("input", {
          className: "sc-input", type: "password", autoComplete: "new-password", "data-role": "field", "data-field": "key", "data-entry-id": editorEntry.id, disabled: locked,
          value: model.keys[editorEntry.id] ?? "", placeholder: "输入新 key；留空则保留现有凭据",
          onChange: (ev) => { if (!locked) setModel((m) => ({ ...m, keys: { ...m.keys, [editorEntry.id]: ev.target.value } })); },
        })) : null,
        React.createElement("div", { className: "sc-editor-actions" }, React.createElement("button", { className: "sc-button sc-button-primary sc-button-primary-small", type: "button", disabled: locked, onClick: closeEditor }, "完成")),
      ) : null;
      const addPicker = model.addOpen ? React.createElement("div", { role: "group", "aria-label": "选择搜索工具", className: "sc-picker" },
        ...CATALOG_UI.map(([type, label, billing]) => React.createElement("button", {
          key: type, className: "sc-picker-item", type: "button", "data-role": "add-type", "data-type": type, disabled: locked,
          onClick: () => addEntry(type),
        }, React.createElement("strong", { className: "sc-picker-title" }, label), React.createElement("span", { className: "sc-picker-billing" }, billing))),
      ) : null;
      const confirm = model.confirmId ? React.createElement("div", { role: "alertdialog", "aria-modal": "true", className: "sc-dialog sc-confirm" },
        React.createElement("p", null, "移除该搜索工具？不会删除宿主凭据。"),
        React.createElement("div", { className: "sc-confirm-actions" },
          React.createElement("button", { className: "sc-button-danger sc-delete-confirm", type: "button", "data-role": "confirm-remove", "data-entry-id": model.confirmId, disabled: locked, onClick: () => { if (!locked) setModel((m) => ({ ...m, confirmId: null, draft: { ...m.draft, entries: m.draft.entries.filter((e) => e.id !== model.confirmId) } })); } }, "确认移除"),
          React.createElement("button", { className: "sc-button sc-button-secondary", type: "button", disabled: locked, onClick: () => { if (!locked) setModel((m) => ({ ...m, confirmId: null })); } }, "取消"),
        ),
      ) : null;
      return React.createElement("div", { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
      React.createElement("section", {
        className: "sc-panel",
        style: { ...primaryTextStyle, fontFamily: "inherit" },
      },
        React.createElement("style", { "data-sc-style": "panel" }, PANEL_CSS),
        React.createElement("h3", { className: "sc-title" }, SECTION_TITLE),
        React.createElement("p", { className: "sc-description" }, "搜索工具按列表顺序依次尝试，前一个失败时回退到下一个。"),
        React.createElement("div", { className: "sc-official-row" },
        React.createElement("label", { className: "sc-switch sc-official-switch" },
          React.createElement("input", {
            className: "sc-switch-input", type: "checkbox", role: "switch", "aria-checked": model.draft.useOfficial,
            "aria-label": "DeepSeek 官方 API 使用官方搜索", "data-role": "official-toggle", disabled: locked,
            checked: model.draft.useOfficial,
            onChange: (ev) => { if (!locked) setModel((m) => ({ ...m, draft: { ...m.draft, useOfficial: Boolean(ev.target.checked) } })); },
          }),
          React.createElement("span", { className: "sc-switch-track", "aria-hidden": "true" }),
          React.createElement("span", { className: "sc-switch-label" }, "DeepSeek 官方 API 使用官方搜索"),
        ),
        React.createElement("p", { className: "sc-official-hint", "data-role": "official-hint" }, "仅对 DeepSeek 官方 API 会话生效；关闭后相关会话改用下方工具链。官方搜索不另按次收费，模型用量仍按 token 计费。")),
        model.draft.entries.length === 0 ? React.createElement("p", { "data-role": "empty-state", style: secondaryTextStyle }, "还没有配置搜索工具，点击下方「添加搜索工具」添加第一条。") : null,
        cardNodes.length ? React.createElement("div", { className: "sc-card-list" }, ...cardNodes) : null,
        React.createElement("div", { className: "sc-add-block" }, React.createElement("div", { className: "sc-add-actions" }, React.createElement("button", { className: "sc-add-button", type: "button", "data-role": "add-tool", disabled: locked, onClick: () => { if (!locked) setModel((m) => ({ ...m, addOpen: !m.addOpen })); } }, "＋ 添加搜索工具")), addPicker),
        confirm,
        editor,
        React.createElement("button", { className: "sc-button sc-button-primary sc-save-button", type: "button", "data-role": "save", disabled: model.phase !== "ready" || model.status.kind === "pending", onClick: save }, "保存"),
        statusNode,
      ));
    }

    /** bundle 页配置组件（第二参，plugins.bundle.config）。只用 useState / useEffect / useRef。 */
    function BundleConfig(props) {
      if (!React) return null;
      const view = props && props.view;
      const [model, setModel] = React.useState({
        phase: "loading", // loading | ready | unavailable
        draft: EMPTY_DRAFT,
        base: {},
        user: {},
        revision: undefined,
        status: IDLE,
      });
      const alive = React.useRef(true);
      const ackPending = React.useRef(false);

      /** 读取投影（describe）。挂载与保存后的刷新共用。 */
      const load = (keepStatus) => {
        setModel((m) => ({ ...m, phase: "loading" }));
        let pending;
        try {
          pending = rpc("describe", {});
        } catch (err) {
          pending = Promise.reject(err);
        }
        Promise.resolve(pending).then(
          (res) => {
            if (!alive.current) return;
            const got = unwrap(res);
            const proj = got.ok ? projectionOf(got.value) : null;
            if (!proj) {
              const text = got.ok ? "宿主投影中缺少 search-chain 命名空间" : `读取配置失败：${got.message}`;
              setModel((m) => ({ ...m, phase: "unavailable", revision: undefined, status: { kind: "error", text, issues: [] } }));
              return;
            }
            if (proj.revision === undefined) {
              setModel((m) => ({
                ...m,
                phase: "unavailable",
                revision: undefined,
                status: { kind: "error", text: "宿主投影缺少 revision，禁止保存（请重新打开配置表单）", issues: [] },
              }));
              return;
            }
            const effective = { ...proj.base, ...proj.user };
            const check = validate(effective);
            setModel((m) => ({
              ...m,
              phase: "ready",
              base: proj.base,
              user: proj.user,
              revision: proj.revision,
              draft: draftFrom(check.ok ? check.config : effective),
              status: keepStatus
                ? m.status
                : check.ok
                  ? IDLE
                  : { kind: "error", text: "当前配置未通过校验，请修正后保存", issues: check.issues.map((i) => i.message) },
            }));
          },
          (err) => {
            if (!alive.current) return;
            setModel((m) => ({
              ...m,
              phase: "unavailable",
              revision: undefined,
              status: { kind: "error", text: `读取配置失败：${String((err && err.message) || err)}`, issues: [] },
            }));
          },
        );
      };

      // 挂载即拉取投影。
      React.useEffect(() => {
        alive.current = true;
        load();
        return () => {
          alive.current = false;
        };
      }, []);

      // 保存进行中：一次性 ref 驱动结果回填后的那一趟渲染（真实 React 下仅多一次渲染）。
      if (model.status.kind !== "pending") ackPending.current = false;
      else if (!ackPending.current) {
        ackPending.current = true;
        setModel((m) => ({ ...m }));
      }

      if (view === "summary") {
        return React.createElement(
          "section",
          { "data-bundle-config-summary": "1" },
          React.createElement("span", null, "网页搜索链：条目与超时在配置表单中管理"),
        );
      }

      const ready = model.phase === "ready";
      const draft = model.draft;
      const setDraft = (fn) => setModel((m) => ({ ...m, draft: fn(m.draft) }));
      const updateEntry = (id, patch) =>
        setDraft((d) => ({ ...d, entries: d.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
      const removeEntry = (id) => setDraft((d) => ({ ...d, entries: d.entries.filter((e) => e.id !== id) }));
      const addEntry = () => {
        setDraft((d) => ({
          ...d,
          entries: [
            ...d.entries,
            { id: `new-${d.entries.length + 1}-${Date.now().toString(36)}`, type: TOOL_TYPES[0], name: "", enabled: true, credentialRef: "" },
          ],
        }));
      };

      const save = () => {
        if (!ready) return;
        if (typeof model.revision !== "number") {
          setModel((m) => ({ ...m, status: { kind: "error", text: "缺少 revision，禁止保存（请重新打开配置表单）", issues: [] } }));
          return;
        }
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
        const merged = merge(form, model.user);
        const check = validate(Object.assign({}, model.base, merged));
        if (!check.ok) {
          setModel((m) => ({
            ...m,
            status: { kind: "error", text: "配置未保存：校验未通过", issues: check.issues.map((i) => i.message) },
          }));
          return;
        }
        let ops;
        try {
          ops = toOps(merged, model.user);
        } catch (err) {
          setModel((m) => ({ ...m, status: { kind: "error", text: String((err && err.message) || err), issues: [] } }));
          return;
        }
        const revision = model.revision;
        setModel((m) => ({ ...m, status: { kind: "pending", text: "保存中…", issues: [] } }));
        let pending;
        try {
          pending = rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: revision });
        } catch (err) {
          pending = Promise.reject(err);
        }
        Promise.resolve(pending).then(
          (res) => {
            if (!alive.current) return;
            const got = unwrap(res);
            if (got.ok) {
              const nextRev = got.value && typeof got.value.revision === "number" ? got.value.revision : undefined;
              setModel((m) => ({
                ...m,
                user: merged,
                revision: nextRev !== undefined ? nextRev : m.revision,
                status: { kind: "saved", text: "已保存", issues: [] },
              }));
              if (nextRev === undefined) load(true); // 宿主回包未带 revision：重新读投影取得新版本号（保留 saved 态）
            } else {
              setModel((m) => ({
                ...m,
                status: { kind: "error", text: `保存失败：${got.message}`, issues: [] },
              }));
            }
          },
          (err) => {
            if (!alive.current) return;
            setModel((m) => ({
              ...m,
              status: { kind: "error", text: `保存失败：${String((err && err.message) || err)}`, issues: [] },
            }));
          },
        );
      };

      const disabled = !ready;
      const field = (attrs) => React.createElement("input", attrs);
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
            TOOL_TYPES.map((t) => React.createElement("option", { key: t, value: t }, t)),
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
            { type: "button", "data-config-action": "remove-entry", disabled, onClick: () => removeEntry(e.id) },
            "删除",
          ),
        ),
      );

      const st = model.status;
      const statusNode =
        st.kind === "saved"
          ? React.createElement("span", { "data-config-status": "saved" }, st.text)
          : st.kind === "pending"
            ? React.createElement("span", { "data-config-status": "pending" }, st.text)
            : st.kind === "error"
              ? React.createElement(
                  "div",
                  { "data-config-status": "error" },
                  React.createElement("span", { "data-config-error": "1" }, st.text),
                  ...st.issues.map((m, i) => React.createElement("p", { key: `issue-${i}` }, m)),
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
    }

    BundleConfig.contract = contract;

    return {
      inject: ["slots"],
      /**
       * 挂载「网页搜索链」设置区（SET-001）与 bundle 页配置表单（BCF-001）。
       * @param {{
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
            SettingsPanel,
          ),
        );

        const offBundle = ctx.slots.inject(BUNDLE_SLOT, () =>
          ctx.slots.register({ name: BUNDLE_SLOT, key: PACKAGE_KEY, inject: () => ({}) }, BundleConfig),
        );

        // 卸载语义（DSH-001）：撤销懒挂载并清除幂等键；重复调用无副作用。
        ctx.effect(() => () => {
          offSection();
          offBundle();
          mounted.delete(key);
        });
      },
    };
  },
});
