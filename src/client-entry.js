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

    // ─────────────────────── SET-008 跨分区草稿保全：纯函数面（Component.contract） ───────────────────────
    // cache: Map；key = 条目 id（新建条目为稳定临时 id）| 全局键 draftCacheGlobalKey（超时草稿）。
    // 条目记录 = { mode:"edit"|"create", type, fields:{ name, credentialRef }, key, baseRevision }；
    // 全局记录 = { timeoutText, baseRevision }。
    // draftCacheApply 语义（重挂校验）：
    //   版本一致 → 回填字段/key/超时，并给出自动重开的 editingId（新建=重新入列+重开）；
    //   版本冲突 → 草稿保留（仍回填）+ conflicts(kind=version)——提交=按最新版本重放、取消=显式丢弃；
    //   外部删除 → conflicts(kind=deleted) 且自 cache 移除该记录（带因显式丢弃）；
    //   投影无 revision 或 cache 为空 → null（跳过校验）。不静默丢弃、不自动重放。
    const DRAFT_CACHE_GLOBAL_KEY = "__global__";
    function draftCacheApply(cache, proj, draft) {
      if (!cache || !proj || typeof proj.revision !== "number" || cache.size === 0) return null;
      let entries = draft.entries;
      const keys = {};
      let editingId = null;
      const conflicts = [];
      for (const [id, rec] of cache) {
        if (id === DRAFT_CACHE_GLOBAL_KEY) {
          if (typeof rec.baseRevision !== "number" || rec.baseRevision !== proj.revision) {
            conflicts.push({ text: "回退超时：起草后设置版本已变化，草稿已保留", kind: "version" });
          }
          continue;
        }
        const label = (rec.fields && rec.fields.name) || rec.type || id;
        const existing = entries.find((e) => e.id === id);
        if (rec.mode === "create") {
          if (existing) { conflicts.push({ text: `新条目「${label}」：当前设置已存在同 id 条目，按版本冲突处理`, kind: "version" }); continue; }
          entries = [...entries, { id, type: rec.type, name: (rec.fields && rec.fields.name) ?? "", enabled: true, credentialRef: (rec.fields && rec.fields.credentialRef) ?? "" }];
          keys[id] = rec.key ?? "";
          if (!editingId) editingId = id;
          continue;
        }
        if (!existing) {
          conflicts.push({ text: `条目「${label}」已被外部删除：其草稿无法重放，已随本提示丢弃`, kind: "deleted" });
          cache.delete(id);
          continue;
        }
        entries = entries.map((e) => (e.id === id
          ? { ...e, name: (rec.fields && rec.fields.name) ?? e.name, credentialRef: (rec.fields && rec.fields.credentialRef) ?? (e.credentialRef ?? "") }
          : e));
        if (rec.key) keys[id] = rec.key;
        if (!editingId) editingId = id;
        if (typeof rec.baseRevision !== "number" || rec.baseRevision !== proj.revision) {
          conflicts.push({ text: `条目「${label}」：起草后设置版本已变化；提交即按最新版本写入，或点击取消丢弃草稿`, kind: "version" });
        }
      }
      const globalRec = cache.get(DRAFT_CACHE_GLOBAL_KEY);
      return {
        draft: { ...draft, entries, timeoutText: globalRec ? globalRec.timeoutText : draft.timeoutText },
        keys,
        editingId,
        conflicts,
      };
    }
    const contract = Object.freeze({ merge, validate, toOps, draftCacheApply, draftCacheGlobalKey: DRAFT_CACHE_GLOBAL_KEY });

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
    // SET-008：跨分区草稿保全缓存——模块工厂级（每 import 实例一份）：
    // key = 条目 id（新建条目为稳定临时 id）| "__global__"（超时草稿）；
    // 记录 = { mode:"edit"|"create", type, fields:{ name, credentialRef }, key, baseRevision }。
    // 仅在成功提交或显式取消时清对应记录；卸载与后台快照刷新不清缓存、不静默覆盖在编字段。
    // selfCommitPending：本实例自身成功提交待读回 → 读回后把存活记录的 baseRevision 自对齐到新修订
    // （自身写不触发假冲突；外部版本推进仍冲突）。
    const draftCache = new Map();
    let selfCommitPending = false;
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
      /* SET-006/R1-3：全局保存钮（.sc-save-button）与 compact 修饰（.sc-button-primary-small）整体废止；
         编辑器动作行两钮为 SPC-014 standard 档，主按钮视觉由 .sc-button-primary 承接。 */
      .sc-button:disabled, .sc-button-primary:disabled, .sc-button-secondary:disabled,
      .sc-button-danger:disabled, .sc-add-button:disabled, .sc-drag-handle:disabled,
      .sc-picker-item:disabled { opacity: 0.4; cursor: default; }
      .sc-input:disabled { opacity: 0.6; cursor: default; }
      .sc-button:focus-visible, .sc-button-primary:focus-visible, .sc-button-secondary:focus-visible, .sc-button-danger:focus-visible,
      .sc-drag-handle:focus-visible,
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
      /* SET-007：节级顶部成功提示启用 SPC-004 预留位（12/18 + state token，不发明新数值）。 */
      .sc-saved-notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
      /* SET-006 超时输入行：版式沿用官方开关行（列布局 gap 8），标签 14/22 label-primary、提示 12/18（复用既有档）。 */
      .sc-timeout-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
      .sc-timeout-label { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
      .sc-timeout-row .sc-input { width: 240px; max-width: 100%; }
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
      // SET-006 状态面：busy=任一提交在途（面板全局锁）；editorBusy=编辑器提交在途（编辑器输入/提交/取消禁用）；
      // savedNotice=节级顶部成功槽（SET-007 role=status）；sectionError=节级顶部错误槽（role=alert，与成功互斥）；
      // editorError=编辑器动作行上方错误（role=alert）。面板底部零状态节点（SET-007）。
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
        busy: false,
        editorBusy: false,
        savedNotice: null,
        sectionError: null,
        editorError: null,
      });
      const alive = React.useRef(true);
      const restoreFocus = React.useRef(null);
      // 事件处理器经本 ref 读最新在途标志（避免 async 提交间的陈旧闭包）；渲染期镜像。
      const lockRef = React.useRef(false);
      lockRef.current = model.busy || model.editorBusy;
      const locked = model.busy || model.editorBusy;

      // 刷新不得静默覆盖在编字段（SET-008 语义）：
      // keepStatus=提交成功后的后台刷新时，正在编辑的条目字段与明文 key 缓冲保留现值。
      const overlayEditingDraft = (m, draft) => {
        if (!m.editingId) return draft;
        const prev = m.draft.entries.find((e) => e.id === m.editingId);
        if (!prev) return draft;
        return {
          ...draft,
          entries: draft.entries.map((e) => (e.id === m.editingId ? { ...e, name: prev.name, credentialRef: prev.credentialRef, enabled: prev.enabled } : e)),
        };
      };

      // ─────────────────────── SET-008：跨分区草稿保全（模块级缓存读写与重挂校验） ───────────────────────
      // 字段/key/超时变更同步进缓存（首改建档，baseRevision=建档时当前宿主修订）；
      // 成功提交/显式取消清对应记录；卸载与后台刷新不清缓存、不覆盖。
      const cacheBaseRevision = (m) => (typeof m.revision === "number" ? m.revision : undefined);
      const syncEntryCache = (m, id, entry, keyVal) => {
        if (!entry) return;
        const rec = draftCache.get(id) || {
          mode: entryIsPersisted(m, entry) ? "edit" : "create",
          type: entry.type,
          fields: {},
          key: "",
          baseRevision: cacheBaseRevision(m),
        };
        rec.fields = { name: entry.name, credentialRef: entry.credentialRef ?? "" };
        rec.key = keyVal ?? "";
        draftCache.set(id, rec);
      };
      const syncGlobalCache = (m, timeoutText) => {
        const rec = draftCache.get(DRAFT_CACHE_GLOBAL_KEY) || { timeoutText: String(DEFAULT_TIMEOUT_MS), baseRevision: cacheBaseRevision(m) };
        rec.timeoutText = timeoutText;
        draftCache.set(DRAFT_CACHE_GLOBAL_KEY, rec);
      };

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
            setModel((m) => ({ ...m, phase: "unavailable", revision: undefined, savedNotice: null, sectionError: { text, issues: [] }, editorError: null }));
            return;
          }
          const effective = { ...proj.base, ...proj.user };
          const check = validate(effective);
          const normalized = check.ok ? check.config : effective;
          setModel((m) => {
            let draft = draftFrom(normalized);
            let nextKeys = m.keys;
            let editingId = keepStatus ? m.editingId : null;
            let sectionError;
            if (keepStatus) {
              // 后台快照刷新：不清缓存、不覆盖在编字段与在编超时草稿（SET-008）。
              draft = overlayEditingDraft(m, draft);
              if (draftCache.has(DRAFT_CACHE_GLOBAL_KEY)) draft = { ...draft, timeoutText: m.draft.timeoutText };
              if (selfCommitPending && typeof proj.revision === "number") {
                for (const rec of draftCache.values()) rec.baseRevision = proj.revision;
                selfCommitPending = false;
              }
              sectionError = m.sectionError;
            } else {
              // 初始挂载：SET-008 重挂校验（版本一致→回填+自动重开；冲突/外部删除→顶部告警，保留草稿，不静默丢弃/重放）。
              sectionError = typeof proj.revision !== "number"
                ? { text: "宿主投影缺少 revision，禁止保存（请重新打开设置）", issues: [] }
                : check.ok ? null : { text: "当前配置未通过校验，请修正后保存", issues: check.issues.map((i) => i.message) };
              const overlay = draftCacheApply(draftCache, proj, draft);
              if (overlay) {
                draft = overlay.draft;
                nextKeys = { ...m.keys, ...overlay.keys };
                editingId = overlay.editingId;
                if (overlay.conflicts.length > 0) {
                  sectionError = { text: "设置已被外部变更：未提交草稿已保留（未静默丢弃、未自动重放）", issues: overlay.conflicts.map((c) => c.text) };
                }
              }
            }
            // addOpen / editorError 不在此重置（经 ...m 保留，与 ① 行为一致）；
            // keys/editingId 为 SET-008 重挂校验产物（keepStatus 时即 m.keys / m.editingId）。
            return {
              ...m,
              phase: typeof proj.revision === "number" ? "ready" : "unavailable",
              base: proj.base,
              user: proj.user,
              revision: proj.revision,
              draft,
              keys: nextKeys,
              editingId,
              savedNotice: keepStatus ? m.savedNotice : null,
              sectionError,
            };
          });
        }, (err) => {
          if (!alive.current) return;
          setModel((m) => ({ ...m, phase: "unavailable", revision: undefined, savedNotice: null, sectionError: { text: `读取配置失败：${String((err && err.message) || err)}`, issues: [] }, editorError: null }));
        });
      };

      React.useEffect(() => {
        alive.current = true;
        load();
        return () => { alive.current = false; };
      }, []);

      // ─────────────────────── SET-006：条目级提交与离散落盘 ───────────────────────
      // 所有落盘以“最新持久化快照（user 层）”为基线构造，载荷只含该处变更；
      // 其他条目或全局字段的未提交草稿一律不得混入（O-4：expectedRevision 互斥提交）。
      const userEntriesOf = (m) => (Array.isArray(m.user.entries) ? m.user.entries : []);
      const baseEntriesOf = (m) => (Array.isArray(m.base.entries) ? m.base.entries : []);
      const persistedTimeoutOf = (m) => (typeof m.user.timeoutMs === "number" ? m.user.timeoutMs : DEFAULT_TIMEOUT_MS);
      const persistedOfficialOf = (m) => (m.user.useOfficialDeepSeekSearch !== false);

      // 离散动作立即落盘：成功=生效确认（重新读取投影）；失败=保留意图（草稿保留目标值）+ 节级顶部可操作错误。
      const commitDiscrete = async (buildOps, successText) => {
        const m0 = model;
        if (lockRef.current || m0.phase !== "ready" || typeof m0.revision !== "number") return false;
        let ops = null;
        try { ops = buildOps(m0); } catch { ops = null; }
        if (!ops || ops.length === 0) return true; // 意图未变化：无需写
        setModel((m) => ({ ...m, busy: true, savedNotice: null, sectionError: null }));
        let response;
        try {
          response = await rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: m0.revision });
        } catch (err) {
          if (!alive.current) return false;
          setModel((m) => ({ ...m, busy: false, sectionError: { text: `保存失败：${String((err && err.message) || err)}`, issues: [] } }));
          return false;
        }
        if (!alive.current) return false;
        const result = unwrap(response);
        if (!result.ok) {
          setModel((m) => ({ ...m, busy: false, sectionError: { text: `保存失败：${String(result.message || "宿主拒绝该请求")}`, issues: [] } }));
          return false;
        }
        setModel((m) => ({ ...m, busy: false, savedNotice: { text: successText } }));
        selfCommitPending = true; // SET-008：自身成功提交 → 读回后把存活草稿记录的 baseRevision 自对齐
        load(true);
        return true;
      };

      // 编辑器字段变更：写入草稿、清除该编辑器错误态，并同步模块级缓存（SET-008）。
      const updateEditorField = (id, field, value) => {
        if (lockRef.current) return;
        const entry = model.draft.entries.find((e) => e.id === id);
        setModel((m) => ({ ...m, editorError: null, draft: { ...m.draft, entries: m.draft.entries.map((e) => (e.id === id ? { ...e, [field]: value } : e)) } }));
        if (entry) syncEntryCache(model, id, { ...entry, [field]: value }, typeof model.keys[id] === "string" ? model.keys[id] : "");
      };
      const updateKey = (id, value) => {
        if (lockRef.current) return;
        const entry = model.draft.entries.find((e) => e.id === id);
        setModel((m) => ({ ...m, editorError: null, keys: { ...m.keys, [id]: value } }));
        if (entry) syncEntryCache(model, id, entry, value);
      };

      // 顶部官方开关：onChange 即离散提交（仅自身键）。
      const officialToggleChange = (ev) => {
        const target = Boolean(ev.target && ev.target.checked);
        if (lockRef.current) return;
        setModel((m) => ({ ...m, sectionError: null, savedNotice: null, draft: { ...m.draft, useOfficial: target } }));
        commitDiscrete((m) => (persistedOfficialOf(m) === target ? [] : [{ op: "set", path: ["useOfficialDeepSeekSearch"], value: target }]), "已保存设置。");
      };

      // 超时输入：失焦/回车 且 值有变化且合法 才提交（仅 timeoutMs 键）；成功后清 __global__ 草稿记录（SET-008）。
      const timeoutCommit = async () => {
        if (lockRef.current) return;
        const text = String(model.draft.timeoutText ?? "").trim();
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          setModel((m) => ({ ...m, sectionError: { text: "超时须为正整数（毫秒）", issues: [] }, savedNotice: null }));
          return;
        }
        setModel((m) => ({ ...m, sectionError: null, draft: { ...m.draft, timeoutText: String(parsed) } }));
        if (parsed === persistedTimeoutOf(model)) { draftCache.delete(DRAFT_CACHE_GLOBAL_KEY); return; } // 值未变化：不写，草稿与已持久化一致
        setModel((m) => ({ ...m, savedNotice: null }));
        const ok = await commitDiscrete(() => [{ op: "set", path: ["timeoutMs"], value: parsed }], "已保存设置。");
        if (ok) draftCache.delete(DRAFT_CACHE_GLOBAL_KEY);
      };

      // 卡片启用开关：onChange 即离散提交（仅自身 enabled 键；未提交的新条目无持久化变更）。
      const enabledToggleChange = (entryId, ev) => {
        const target = Boolean(ev.target && ev.target.checked);
        if (lockRef.current) return;
        setModel((m) => ({ ...m, sectionError: null, savedNotice: null, draft: { ...m.draft, entries: m.draft.entries.map((e) => (e.id === entryId ? { ...e, enabled: target } : e)) } }));
        commitDiscrete((m) => {
          const list = userEntriesOf(m);
          const idx = list.findIndex((e) => e.id === entryId);
          if (idx < 0) return [];
          return (list[idx].enabled !== false) === target ? [] : [{ op: "set", path: ["entries", String(idx), "enabled"], value: target }];
        }, "已保存设置。");
      };

      // 移除确认：清草稿（含 SET-008 缓存记录：条目已不存在，其草稿作废）+ 落盘 unset（仅该条目键）。
      const confirmRemoveClick = (entryId) => {
        if (lockRef.current) return;
        draftCache.delete(entryId);
        setModel((m) => ({
          ...m,
          confirmId: null,
          editingId: m.editingId === entryId ? null : m.editingId,
          savedNotice: null,
          sectionError: null,
          draft: { ...m.draft, entries: m.draft.entries.filter((e) => e.id !== entryId) },
        }));
        commitDiscrete((m) => {
          const idx = userEntriesOf(m).findIndex((e) => e.id === entryId);
          return idx < 0 ? [] : [{ op: "unset", path: ["entries", String(idx)] }];
        }, "已保存设置。");
      };

      // 拖拽/键盘重排：草稿先行（视觉即时），随后以持久化快照的相对顺序落盘（D-1 整条编码，仅 entries 键）。
      const commitReorder = (orderIds) => {
        const ids = orderIds || model.draft.entries.map((e) => e.id);
        commitDiscrete((m) => {
          const list = userEntriesOf(m);
          const present = new Set(list.map((e) => e.id));
          const targetIds = ids.filter((id) => present.has(id));
          if (targetIds.length !== list.length) return []; // 草稿含未提交新条目：持久化顺序不受影响
          if (targetIds.every((id, i) => id === list[i].id)) return [];
          const byId = new Map(list.map((e) => [e.id, e]));
          return toOps({ entries: targetIds.map((id) => byId.get(id)) }, { entries: list });
        }, "已保存设置。");
      };
      const moveEntry = (id, delta) => {
        if (lockRef.current) return;
        const list = [...model.draft.entries];
        const from = list.findIndex((e) => e.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= list.length) return;
        [list[from], list[to]] = [list[to], list[from]];
        setModel((m) => ({ ...m, draft: { ...m.draft, entries: list } }));
        commitReorder(list.map((e) => e.id));
      };
      const addEntry = (type, trigger) => {
        if (lockRef.current) return;
        const label = CATALOG_UI.find((x) => x[0] === type)?.[1] ?? type;
        const id = `search_chain_${Date.now().toString(36)}_${++entryIdSeq}`;
        // SET-006：选类型即进入该新条目的编辑器（草稿立即出现在列表末尾，提交成功才持久化）。
        restoreFocus.current = trigger ?? null;
        setModel((m) => ({
          ...m,
          addOpen: false,
          editingId: id,
          editorError: null,
          draft: { ...m.draft, entries: [...m.draft.entries, { id, type, name: label, enabled: true, credentialRef: "" }] },
        }));
        // SET-008：新建草稿入缓存（稳定临时 id 为键；未提交即卸载，重挂须能复原）。
        draftCache.set(id, { mode: "create", type, fields: { name: label, credentialRef: "" }, key: "", baseRevision: typeof model.revision === "number" ? model.revision : undefined });
      };

      const entryIsPersisted = (m, entry) => userEntriesOf(m).some((e) => e.id === entry.id);

      // 编辑器提交的候选条目列表：按稳定条目 id 合并该条目全部托管字段，
      // 其余条目取持久化快照值；载荷不含其他条目/全局字段草稿（SET-006）。
      const candidateEntriesFor = (m, entry, credRef) => {
        const list = userEntriesOf(m);
        const patch = { id: entry.id, type: entry.type, name: entry.name, enabled: entry.enabled };
        if (credRef) patch.credentialRef = credRef;
        if (list.some((e) => e.id === entry.id)) {
          return list.map((e) => {
            if (e.id !== entry.id) return e;
            const out = { ...e, ...patch };
            if (!credRef) delete out.credentialRef;
            return out;
          });
        }
        const baseEntry = baseEntriesOf(m).find((e) => e.id === entry.id);
        const added = baseEntry ? { ...baseEntry, ...patch } : { ...patch };
        if (baseEntry && !credRef) delete added.credentialRef;
        return [...list, added];
      };

      // 条目级提交（新建=创建 / 编辑=更新）：先凭据后配置；成功=该条目整体生效并关闭编辑器；
      // 失败=编辑器原地保留（字段与 key 缓冲不丢）+ 动作行上方 role=alert 错误。
      const submitEditor = async () => {
        const entry = model.draft.entries.find((e) => e.id === model.editingId);
        if (!entry || lockRef.current) return;
        if (model.phase !== "ready" || typeof model.revision !== "number") return;
        const keyVal = (typeof model.keys[entry.id] === "string" ? model.keys[entry.id] : "").trim();
        let credRef = (entry.credentialRef ?? "").trim();
        const writesKey = keyVal !== "" && KEYED_TYPES.includes(entry.type);
        // 代码级阻断（与实时 editorBlock 同判据；真实 DOM 中禁用钮不可点，此守卫兜底测试侧直接触发）：
        // 超语法 ref 且本次不带新 key → 零出站（R-1 / P2-3 留空变体）。
        if (!writesKey && credRef && !POSIX_REF.test(credRef)) {
          setModel((m) => ({ ...m, editorError: { text: "凭据引用格式无效：仅允许以字母或下划线开头，后续使用字母、数字或下划线。", issues: [] } }));
          return;
        }
        setModel((m) => ({ ...m, editorBusy: true, editorError: null, savedNotice: null, sectionError: null }));
        try {
          if (writesKey) {
            // 新引用总是 POSIX 合法（受控生成）；先写凭据，成功后才允许携带新 ref 落盘。
            const newRef = credentialRefFor(entry.id);
            credRef = newRef;
            const credResponse = await credentialRpc("set", { ref: newRef, value: keyVal });
            const credResult = unwrap(credResponse);
            if (!credResult.ok) throw new Error(credResult.message || "凭据服务拒绝写入");
          }
          const candidate = candidateEntriesFor(model, entry, credRef);
          const check = validate({ ...model.base, ...{ ...model.user, entries: candidate } });
          if (!check.ok) throw new Error(`校验未通过：${check.issues.map((i) => i.message).join("；")}`);
          const ops = toOps({ entries: candidate }, { entries: userEntriesOf(model) });
          if (ops.length > 0) {
            const response = await rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: model.revision });
            const result = unwrap(response);
            if (!result.ok) throw new Error(result.message || "宿主拒绝该请求");
          }
          const name = (entry.name || "").trim() || entry.type;
          draftCache.delete(entry.id); // SET-008：成功提交 → 清该条目草稿记录
          selfCommitPending = true; // SET-008：存活的其他草稿记录 baseRevision 自对齐
          setModel((m) => {
            const keys = { ...m.keys };
            delete keys[entry.id];
            return { ...m, editorBusy: false, editingId: null, addOpen: false, keys, editorError: null, savedNotice: { text: `已保存 ${name}。` } };
          });
          load(true);
        } catch (err) {
          let message = String((err && err.message) || err || "保存失败");
          for (const secret of Object.values(model.keys)) {
            if (typeof secret === "string" && secret.trim()) message = message.replaceAll(secret.trim(), "[redacted]");
          }
          setModel((m) => ({ ...m, editorBusy: false, editorError: { text: `保存失败：${message}`, issues: [] } }));
        }
      };

      // SET-006/O-5：取消 ≡ 放弃——不写配置；清除该条目字段草稿与明文 key 缓冲；关闭编辑器；焦点回触发控件。
      // 取消仅在提交在途时禁用；只读/缺 revision/校验未过/前次报错均须可点。
      const cancelEditor = () => {
        if (model.editorBusy) return;
        const entry = model.draft.entries.find((e) => e.id === model.editingId);
        if (model.editingId) draftCache.delete(model.editingId); // SET-008：显式取消 → 清该条目草稿记录
        const trigger = restoreFocus.current;
        setModel((m) => {
          const keys = { ...m.keys };
          let entries = m.draft.entries;
          if (entry) {
            delete keys[entry.id];
            if (entryIsPersisted(m, entry)) {
              const persisted = userEntriesOf(m).find((e) => e.id === entry.id);
              entries = entries.map((e) => (e.id === entry.id
                ? {
                    ...e,
                    name: persisted ? (persisted.name ?? "") : e.name,
                    credentialRef: persisted && typeof persisted.credentialRef === "string" ? persisted.credentialRef : "",
                  }
                : e));
            } else {
              entries = entries.filter((e) => e.id !== entry.id); // 新条目：移出草稿即清草稿
            }
          }
          return { ...m, editingId: null, addOpen: false, keys, editorError: null, draft: { ...m.draft, entries } };
        });
        restoreFocus.current = null;
        if (trigger && typeof trigger.focus === "function") Promise.resolve().then(() => trigger.focus());
      };
      const openEditorFor = (entryId, trigger) => {
        if (lockRef.current) return;
        restoreFocus.current = trigger ?? null;
        setModel((m) => ({ ...m, editingId: entryId, editorError: null, addOpen: false }));
      };
      const onDialogKeyDown = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault?.();
          cancelEditor(); // O-5：Escape ≡ 点击取消（同清草稿、同焦点回退）
          return;
        }
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
            const list = [...model.draft.entries];
            const from = list.findIndex((e) => e.id === moving), to = list.findIndex((e) => e.id === entry.id);
            if (from < 0 || to < 0) return;
            // 目标插入位：before=目标原索引 to，after=to+1（均按移除前的原列表计）。
            // 先移除被拖项：若插入位在其之后，移除后索引左移一位。
            const pos = side === "after" ? to + 1 : to;
            const finalIndex = from < pos ? pos - 1 : pos;
            if (finalIndex === from) return;
            const [item] = list.splice(from, 1); list.splice(finalIndex, 0, item);
            setModel((m) => ({ ...m, draft: { ...m.draft, entries: list } }));
            commitReorder(list.map((e) => e.id)); // SET-006：重排即落盘
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
                  onChange: (ev) => enabledToggleChange(entry.id, ev),
                }),
                React.createElement("span", { className: "sc-switch-track", "aria-hidden": "true" }),
                React.createElement("span", { className: "sc-switch-label" }, "启用"),
              ),
              React.createElement("button", {
                className: "sc-button-secondary", type: "button", "data-role": "card-edit", "data-entry-id": entry.id, disabled: locked,
                onClick: (ev) => openEditorFor(entry.id, ev.currentTarget ?? null),
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
      // SET-007：节级顶部槽——成功（role=status）与错误/冲突（role=alert）互斥，位于首个卡片之前；面板底部零状态节点。
      const savedNode = model.savedNotice ? React.createElement("p", {
        className: "sc-saved-notice", "data-role": "save-status", "data-state": "saved", role: "status", "aria-live": "polite",
      }, model.savedNotice.text) : null;
      const sectionErrorNode = model.sectionError ? React.createElement("p", {
        className: "sc-status-node", "data-role": "save-error", "data-state": "error", role: "alert",
      }, model.sectionError.text, ...(model.sectionError.issues ?? []).map((issue, i) => React.createElement("span", { key: `issue-${i}`, style: secondaryTextStyle }, ` ${issue}`))) : null;
      // SET-006：提交钮实时校验（在途/只读/缺 revision/校验失败 → 禁用）；新 ref 由受控生成、恒合法，校验用占位 ref 投影。
      const editorIsCreate = editorEntry ? !entryIsPersisted(model, editorEntry) : false;
      const editorBlock = (() => {
        if (!editorEntry) return null;
        const keyVal = (typeof model.keys[editorEntry.id] === "string" ? model.keys[editorEntry.id] : "").trim();
        const writesKey = keyVal !== "" && KEYED_TYPES.includes(editorEntry.type);
        const credRef = (editorEntry.credentialRef ?? "").trim();
        if (!writesKey && credRef && !POSIX_REF.test(credRef)) {
          return { text: "凭据引用格式无效：仅允许以字母或下划线开头，后续使用字母、数字或下划线。", issues: [] };
        }
        const check = validate({ ...model.base, ...{ ...model.user, entries: candidateEntriesFor(model, editorEntry, writesKey ? "SEARCH_CHAIN_CREDENTIAL_REF" : credRef) } });
        if (!check.ok) return { text: "无法提交：配置校验未通过", issues: check.issues.map((i) => i.message) };
        return null;
      })();
      const editorProblem = model.editorError || editorBlock;
      const editorSubmitDisabled = model.busy || model.editorBusy || model.phase !== "ready" || typeof model.revision !== "number" || !!editorBlock;
      const submitLabel = model.editorBusy ? (editorIsCreate ? "创建中…" : "保存中…") : (editorIsCreate ? "创建工具" : "保存");
      const editor = editorEntry ? React.createElement("div", {
        role: "dialog", "aria-modal": "true", "aria-labelledby": "sc-editor-title",
        "data-role": "editor", onKeyDown: onDialogKeyDown, className: "sc-dialog sc-editor",
      },
        React.createElement("h4", { id: "sc-editor-title", className: "sc-editor-title" }, `${editorIsCreate ? "新建" : "编辑"} ${editorEntry.name || editorEntry.type}`),
        React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "名称"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "name", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.name ?? "", onChange: (ev) => updateEditorField(editorEntry.id, "name", ev.target.value), autoFocus: true,
        })),
        React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "凭据引用"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "credentialRef", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.credentialRef ?? "", placeholder: "例如 TAVILY_API_KEY",
          onChange: (ev) => updateEditorField(editorEntry.id, "credentialRef", ev.target.value),
        })),
        KEYED_TYPES.includes(editorEntry.type) ? React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "API key（仅写入，不会回显）"), React.createElement("input", {
          className: "sc-input", type: "password", autoComplete: "new-password", "data-role": "field", "data-field": "key", "data-entry-id": editorEntry.id, disabled: locked,
          value: model.keys[editorEntry.id] ?? "", placeholder: "输入新 key；留空则保留现有凭据",
          onChange: (ev) => updateKey(editorEntry.id, ev.target.value),
        })) : null,
        editorProblem ? React.createElement("p", {
          className: "sc-status-node", "data-role": "save-error", "data-state": "error", role: "alert",
        }, editorProblem.text, ...(editorProblem.issues ?? []).map((issue, i) => React.createElement("span", { key: `issue-${i}`, style: secondaryTextStyle }, ` ${issue}`))) : null,
        React.createElement("div", { className: "sc-editor-actions" },
          React.createElement("button", { className: "sc-button sc-button-secondary", type: "button", "data-role": "editor-cancel", disabled: model.editorBusy, onClick: cancelEditor }, "取消"),
          React.createElement("button", { className: "sc-button sc-button-primary", type: "button", "data-role": "editor-submit", disabled: editorSubmitDisabled, onClick: submitEditor }, submitLabel),
        ),
      ) : null;
      const addPicker = model.addOpen ? React.createElement("div", { role: "group", "aria-label": "选择搜索工具", className: "sc-picker" },
        ...CATALOG_UI.map(([type, label, billing]) => React.createElement("button", {
          key: type, className: "sc-picker-item", type: "button", "data-role": "add-type", "data-type": type, disabled: locked,
          onClick: (ev) => addEntry(type, ev.currentTarget ?? null),
        }, React.createElement("strong", { className: "sc-picker-title" }, label), React.createElement("span", { className: "sc-picker-billing" }, billing))),
      ) : null;
      const confirm = model.confirmId ? React.createElement("div", { role: "alertdialog", "aria-modal": "true", className: "sc-dialog sc-confirm" },
        React.createElement("p", null, "移除该搜索工具？不会删除宿主凭据。"),
        React.createElement("div", { className: "sc-confirm-actions" },
          React.createElement("button", { className: "sc-button-danger sc-delete-confirm", type: "button", "data-role": "confirm-remove", "data-entry-id": model.confirmId, disabled: locked, onClick: () => confirmRemoveClick(model.confirmId) }, "确认移除"),
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
        // SET-007：节级反馈槽（成功/错误/冲突互斥），位于标题与描述之后、卡片列表之前；面板底部零状态节点。
        savedNode,
        sectionErrorNode,
        React.createElement("div", { className: "sc-official-row" },
        React.createElement("label", { className: "sc-switch sc-official-switch" },
          React.createElement("input", {
            className: "sc-switch-input", type: "checkbox", role: "switch", "aria-checked": model.draft.useOfficial,
            "aria-label": "DeepSeek 官方 API 使用官方搜索", "data-role": "official-toggle", disabled: locked,
            checked: model.draft.useOfficial,
            onChange: (ev) => officialToggleChange(ev),
          }),
          React.createElement("span", { className: "sc-switch-track", "aria-hidden": "true" }),
          React.createElement("span", { className: "sc-switch-label" }, "DeepSeek 官方 API 使用官方搜索"),
        ),
        React.createElement("p", { className: "sc-official-hint", "data-role": "official-hint" }, "仅对 DeepSeek 官方 API 会话生效；关闭后相关会话改用下方工具链。官方搜索不另按次收费，模型用量仍按 token 计费。")),
        // SET-006：超时输入（B-017）——失焦/回车 且 值变化且合法 才落盘（仅 timeoutMs 键）。
        React.createElement("div", { className: "sc-timeout-row", "data-role": "timeout" },
          React.createElement("label", { className: "sc-timeout-label", htmlFor: "sc-timeout-input" }, "回退超时（毫秒）"),
          React.createElement("input", {
            id: "sc-timeout-input", className: "sc-input", type: "number", min: "1", step: "1", inputMode: "numeric",
            "data-role": "field", "data-field": "timeoutMs", disabled: locked,
            value: model.draft.timeoutText,
            onChange: (ev) => {
              if (lockRef.current) return;
              setModel((m) => ({ ...m, sectionError: null, draft: { ...m.draft, timeoutText: ev.target.value } }));
              syncGlobalCache(model, ev.target.value); // SET-008：超时草稿入缓存
            },
            onBlur: timeoutCommit,
            onKeyDown: (ev) => { if (ev.key === "Enter") { ev.preventDefault?.(); timeoutCommit(); } },
          }),
          React.createElement("p", { className: "sc-official-hint" }, "单个工具请求的最长等待；超过后回退到列表中下一个工具。"),
        ),
        model.draft.entries.length === 0 ? React.createElement("p", { "data-role": "empty-state", style: secondaryTextStyle }, "还没有配置搜索工具，点击下方「添加搜索工具」添加第一条。") : null,
        cardNodes.length ? React.createElement("div", { className: "sc-card-list" }, ...cardNodes) : null,
        React.createElement("div", { className: "sc-add-block" }, React.createElement("div", { className: "sc-add-actions" }, React.createElement("button", { className: "sc-add-button", type: "button", "data-role": "add-tool", disabled: locked, onClick: () => { if (!locked) setModel((m) => ({ ...m, addOpen: !m.addOpen })); } }, "＋ 添加搜索工具")), addPicker),
        confirm,
        // SET-006：全局保存钮删除——所有落盘走条目级提交或离散动作（O-8 迁移面）。
        editor,
      ));
    }

    // 内联纯函数面（merge/validate/toOps + SET-008 缓存纯函数 draftCacheApply），测试经此访问。
    SettingsPanel.contract = contract;

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
