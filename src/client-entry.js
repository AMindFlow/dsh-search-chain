// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）+ Issue #46 bundle 页配置表单（BCF-001..006）。
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
// 通道（规格 bundle-config-ui.md [C8]，终选；host.call 通道已作废）：
//   读 = 同源 POST /api/settings/describe，取 namespaces 中 ns=search-chain 的 user 层（投影）；
//   写 = 同源 POST /api/settings/mutate，args={ns, ops}，ops 由 contract.toOps 产出（路径补丁，
//         不触及既有明文 key 路径；宿主只改 user 层）。
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

const sectionLabel = () => SECTION_TITLE;

/** 编辑指引（BCF-006 放宽：含「设置」与包名；路径措辞的 DOM 锚点为开放项）。 */
const EDIT_HINT = "编辑请在 设置 → 插件 中打开 dsh-search-chain 的配置表单";

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
      const next = saved ? { ...saved } : {};
      for (const k of MANAGED_ENTRY_KEYS) {
        if (formEntry[k] !== undefined) next[k] = formEntry[k];
      }
      if (next.credentialRef === "") delete next.credentialRef;
      return next;
    }

    /** 合并：表单管理字段覆盖 current；未知键与既有 apiKey 原样保留；表单明文字段忽略。 */
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
      for (const k of ["useOfficialDeepSeekSearch", "timeoutMs"]) {
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
     * 产出路径补丁（set/unset），作用于 current 后 ≡ next。从不产出含既有明文 key 值的 op：
     * 既有条目只做字段级 diff；新增条目仅允许追加；删除经 unset 索引。
     * v0.1 表单只增删改、不重排：保留条目的相对顺序变化或中段插入即抛错（重排需整条覆写，会携带既有明文 key）。
     */
    function toOps(next, current) {
      const ops = [];
      const state = structuredClone(isPlainObject(current) ? current : {});
      const emit = (op) => {
        ops.push(op);
        applyOne(state, op);
      };
      const nxt = isPlainObject(next) ? next : {};
      for (const key of Object.keys(state)) {
        if (key !== "entries" && !(key in nxt)) emit({ op: "unset", path: [key] });
      }
      // 管理键恒产出 set（即便值未变，保存总有可观测写入；值相同不改变结果）；未知键仅在变化时产出。
      const MANAGED_TOP = ["useOfficialDeepSeekSearch", "timeoutMs"];
      for (const key of Object.keys(nxt)) {
        if (key === "entries") continue;
        if (MANAGED_TOP.includes(key) || !deepEq(state[key], nxt[key])) emit({ op: "set", path: [key], value: nxt[key] });
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
      const targetIds = new Set(target.filter(isPlainObject).map((e) => e.id));
      for (let i = state.entries.length - 1; i >= 0; i--) {
        const e = state.entries[i];
        if (!isPlainObject(e) || !targetIds.has(e.id)) emit({ op: "unset", path: ["entries", String(i)] });
      }
      let p = 0;
      for (const t of target) {
        if (!isPlainObject(t)) throw invalid("entries 含非对象项");
        const cur = state.entries[p];
        if (cur !== undefined && isPlainObject(cur) && cur.id === t.id) {
          for (const k of Object.keys(t)) {
            if (!deepEq(cur[k], t[k])) emit({ op: "set", path: ["entries", String(p), k], value: t[k] });
          }
          for (const k of Object.keys(cur)) {
            if (!(k in t)) emit({ op: "unset", path: ["entries", String(p), k] });
          }
          p += 1;
        } else {
          if (p !== state.entries.length) {
            throw new Error("条目顺序调整或中段插入 v0.1 不支持（重排需整条覆写，会携带既有明文 key）");
          }
          emit({ op: "set", path: ["entries", String(p)], value: t });
          p += 1;
        }
      }
      return ops;
    }

    const contract = Object.freeze({ merge, validate, toOps });

    // ───────────────────────────── 组件 ─────────────────────────────

    /** settings RPC 信封（[C8]）：不赌 args 传形以外的字段；payload 恒为 {args}。 */
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

    /** 投影：describe 值中 search-chain 的 base/user（user = 宿主 mutate 作用的层）。 */
    function projectionOf(value) {
      if (!value || !Array.isArray(value.namespaces)) return null;
      const item = value.namespaces.find((n) => n && n.ns === SEARCH_NS);
      if (!item) return null;
      return {
        base: isPlainObject(item.base) ? item.base : {},
        user: isPlainObject(item.user) ? item.user : {},
      };
    }

    function draftFrom(config) {
      const entries = Array.isArray(config.entries) ? config.entries : [];
      return {
        entries: entries.map((e) => ({
          id: String(e.id),
          type: typeof e.type === "string" ? e.type : TOOL_TYPES[0],
          name: typeof e.name === "string" ? e.name : "",
          enabled: e.enabled !== false,
          credentialRef: typeof e.credentialRef === "string" ? e.credentialRef : "",
        })),
        useOfficial: config.useOfficialDeepSeekSearch !== false,
        timeoutText: config.timeoutMs === undefined ? "" : String(config.timeoutMs),
      };
    }

    const EMPTY_DRAFT = Object.freeze({ entries: [], useOfficial: true, timeoutText: "" });
    const IDLE = Object.freeze({ kind: "idle", text: "", issues: [] });

    /** settings.section 只读指示器（第二参）。 */
    function SettingsIndicator(_props) {
      if (!React) return null;
      return React.createElement(
        "section",
        { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
        React.createElement("h3", null, SECTION_TITLE),
        React.createElement("p", null, EDIT_HINT),
      );
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
        status: IDLE,
      });
      const alive = React.useRef(true);
      const ackPending = React.useRef(false);

      // 挂载即拉取投影：setModel 同步置位（驱动渲染），结果异步回填。
      React.useEffect(() => {
        alive.current = true;
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
              setModel((m) => ({ ...m, phase: "unavailable", status: { kind: "error", text, issues: [] } }));
              return;
            }
            const effective = { ...proj.base, ...proj.user };
            const check = validate(effective);
            setModel((m) => ({
              ...m,
              phase: "ready",
              base: proj.base,
              user: proj.user,
              draft: draftFrom(check.ok ? check.config : effective),
              status: check.ok
                ? IDLE
                : { kind: "error", text: "当前配置未通过校验，请修正后保存", issues: check.issues.map((i) => i.message) },
            }));
          },
          (err) => {
            if (!alive.current) return;
            setModel((m) => ({
              ...m,
              phase: "unavailable",
              status: { kind: "error", text: `读取配置失败：${String((err && err.message) || err)}`, issues: [] },
            }));
          },
        );
        return () => {
          alive.current = false;
        };
      }, []);

      // 保存进行中：同值 render 期 setState（React 下 identity 更新即 bailout，无副作用）。
      // 作用：保存结果回填后的那一趟渲染必被驱动，不因首趟未置脏而停在 pending。
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
        setModel((m) => ({ ...m, status: { kind: "pending", text: "保存中…", issues: [] } }));
        let pending;
        try {
          pending = rpc("mutate", { ns: SEARCH_NS, ops });
        } catch (err) {
          pending = Promise.reject(err);
        }
        Promise.resolve(pending).then(
          (res) => {
            if (!alive.current) return;
            const got = unwrap(res);
            if (got.ok) {
              setModel((m) => ({
                ...m,
                user: merged,
                status: { kind: "saved", text: "已保存", issues: [] },
              }));
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
            SettingsIndicator,
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
