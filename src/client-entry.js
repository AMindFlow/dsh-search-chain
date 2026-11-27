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

    // Issue #55 最小面归一化助手：持久层条目 id 可能带首尾空白——读入仅经 normalizeEntry trim 进草稿/校验面，
    // 写回不得改写原持久 id（保留 raw、最小字段级 diff）。草稿 id 为 trim 形态，故「草稿/编辑身份 ↔ 持久行」
    // 的比对一律按 trim 后身份进行；非字符串 id 保持原严格相等语义（正常 id 行为逐位不变）。
    function normEntryId(id) {
      return typeof id === "string" ? id.trim() : id;
    }
    function sameEntryId(a, b) {
      return typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b;
    }

    /**
     * 二轮修复（B-007/009）：编辑器绑定守卫——候选列表与「最新持久化列表」只允许在绑定条目一行上不同。
     * 新建：长度 +1、前段逐行相同、新条目恰在末尾；编辑：长度与位置不变、其余行逐行相同。
     * 任一不符 = 持久快照与编辑器绑定漂移（stale 竞态）→ 拒发（宁可可见报错，不得静默覆盖他条目）。
     */
    function singleEntryDiff(user, candidate, boundId) {
      const list = isPlainObject(user) && Array.isArray(user.entries) ? user.entries : [];
      if (!Array.isArray(candidate)) return false;
      const isBound = (e) => isPlainObject(e) && sameEntryId(e.id, boundId); // #55：绑定 id 为草稿（trim）形态，持久行可能带首尾空白
      if (candidate.filter(isBound).length !== 1) return false; // 绑定条目须在候选中恰出现一次
      const boundIdx = candidate.findIndex(isBound);
      const curIdx = list.findIndex(isBound);
      const sameRow = (a, b) => isPlainObject(a) && isPlainObject(b) && a.id === b.id && a.type === b.type
        && a.name === b.name
        && (a.enabled !== false) === (b.enabled !== false)
        && (a.credentialRef ?? "") === (b.credentialRef ?? "");
      if (curIdx < 0) {
        if (candidate.length !== list.length + 1 || boundIdx !== candidate.length - 1) return false;
        for (let i = 0; i < list.length; i++) if (!sameRow(list[i], candidate[i])) return false;
        return true;
      }
      if (candidate.length !== list.length || boundIdx !== curIdx) return false;
      for (let i = 0; i < list.length; i++) if (i !== curIdx && !sameRow(list[i], candidate[i])) return false;
      return true;
    }

    /** 二轮修复：权威快照乐观更新——把本轮成功 ops 应用到 user 层克隆（与宿主 mutate 同形；随后读回仍为权威）。 */
    function applyOpsToLayer(layer, ops) {
      const out = structuredClone(isPlainObject(layer) ? layer : {});
      for (const op of ops) applyOne(out, op);
      return out;
    }

    /**
     * 三轮修复（B-012 键盘重排焦点断链）：重排渲染提交后的回焦目标裁决——键盘焦点须跟随被移动条目。
     * 仅当被移动条目仍在新列表中才回焦（条目已被移除等 → 放弃意图）；入参非字符串/空、列表非法 → null。
     */
    function reorderFocusTarget(movedId, nextEntries) {
      if (typeof movedId !== "string" || movedId === "") return null;
      if (!Array.isArray(nextEntries)) return null;
      return nextEntries.some((e) => isPlainObject(e) && e.id === movedId) ? movedId : null;
    }

    /**
     * 四轮修复（B-007/009/019 污染源）：SET-006 新建/编辑提交名称门裁决（SPC-023「新建=完整校验」）。
     * name 须 trim 后非空——空名/纯空白名不得落库（落库后界面占位「（未命名条目）」，
     * 并污染下游校验面）。合法 → null；不合法 → 编辑器动作行上方 role=alert 呈现的错误文本。
     * 仅本面板提交面收紧：运行时 normalizeConfig（src/config.js）保持对 legacy 空名行宽容
     * （name 只用于展示/文案，运行时不因空名拒载整份配置）。
     */
    function entryNameGate(name) {
      return (typeof name === "string" && name.trim() !== "") ? null : "名称不能为空（纯空白无效）：请输入名称后再提交。";
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
    const contract = Object.freeze({
      merge,
      validate,
      toOps,
      draftCacheApply,
      draftCacheGlobalKey: DRAFT_CACHE_GLOBAL_KEY,
      // 二轮修复（B-007/009/B-012）：编辑器绑定守卫与权威快照乐观更新（纯函数面，测试直测）。
      singleEntryDiff,
      applyOpsToLayer,
      // 三轮修复（B-012 键盘重排焦点断链）：重排渲染提交后的回焦目标裁决（纯函数面，测试直测）。
      reorderFocusTarget,
      // 四轮修复（B-007/009/019 污染源）：新建/编辑提交名称门（纯函数面，测试直测）。
      entryNameGate,
    });

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
      .sc-card { box-sizing: border-box; position: relative; border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px 12px 10px; display: flex; flex-direction: column; gap: 12px; } /* v3 用户反馈（V3-2）：左内衬 14→10px，把手左靠（定值 12px 14px 12px 10px） */
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
      .sc-card-info { display: inline-flex; align-items: center; gap: 4px; min-width: 0; } /* v3 用户反馈（V3-2）：info 间隙 6→4px（名称随把手左靠，定值 4px） */
      .sc-card-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
      .sc-card-name { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
      .sc-card-name-placeholder { color: var(--dsw-alias-label-secondary, inherit); }
      .sc-type-badge { flex: none; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .sc-type-duplicate { display: none; }
      /* R2：徽标纯点——.sc-status wrapper 废止；语义（role=img/aria-label/title/data-state）落在点自身。 */
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
      .sc-button-danger:disabled, .sc-add-button:disabled, .sc-drag-handle:disabled { opacity: 0.4; cursor: default; }
      .sc-input:disabled { opacity: 0.6; cursor: default; }
      .sc-button:focus-visible, .sc-button-primary:focus-visible, .sc-button-secondary:focus-visible, .sc-button-danger:focus-visible,
      .sc-confirm-close:focus-visible, .sc-drag-handle:focus-visible,
      .sc-add-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
      }
      /* R3：display 用 flex 而非 inline-flex（flex 子项被块级化，视觉等价；且禁 display 隐藏机制审查按字面匹配）。 */
      .sc-drag-handle {
        box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        width: 21px; height: 28px; padding: 0; border: none; /* v3 用户反馈（V3-2）：把手宽 28→21px（−25%），纵向触控区 28px 不减；字形经 flex 双轴居中，21px 内仍居中 */
        border-radius: var(--dsw-radius-sm);
        background: transparent; color: var(--dsw-alias-label-tertiary);
        font-family: inherit; font-size: 14px; line-height: 1; cursor: pointer;
        flex: none;
        /* R3：opacity 过渡为基线层声明（hover:none 常显环境亦须 0.12s ease）；显隐值由 hover 层接管。 */
        transition: opacity 0.12s ease;
      }
      .sc-drag-handle:not(:disabled) { cursor: grab; }
      .sc-drag-handle:active:not(:disabled) { cursor: grabbing; }
      /* R3 v2 显隐层（仅 hover:hover 环境）：静息 opacity 0 常隐（含静息 disabled，SPC-027 v2 裁决）；
         卡片 hover 或把手 focus-visible 显现 1；disabled 仅 hover/focus-visible 叠加态 .4。
         baseline（hover:none）端常显 1、disabled 恒 .4 由顶层 :disabled 组保持。禁用 display/visibility 机制。 */
      @media (hover: hover) {
        .sc-drag-handle { opacity: 0; }
        .sc-drag-handle:disabled { opacity: 0; }
        .sc-card:hover .sc-drag-handle, .sc-drag-handle:focus-visible { opacity: 1; }
        .sc-card:hover .sc-drag-handle:disabled, .sc-drag-handle:disabled:focus-visible { opacity: .4; }
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
        .sc-drag-handle { transition: none; }
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
      .sc-editor, .sc-dialog {
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
      /* V4-2：删除确认模态（居中遮罩 alertdialog；×/取消/Escape 关闭均零变更；旧内联 sc-confirm 表单废止）。
         表面双主题固定近白（A-068：不透明近白、圆角>0、视口中心）；危险钮沿用 SPC-023 outline token（A-046）。 */
      .sc-confirm-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(15, 16, 19, 0.45); }
      .sc-confirm { position: relative; width: min(380px, calc(100vw - 32px)); background: #ffffff; color: #1f2329; border-radius: var(--dsw-radius-panel, 12px); padding: 20px 20px 16px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28); outline: none; }
      .sc-confirm-close { position: absolute; top: 10px; right: 10px; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: #596069; font-size: 18px; line-height: 1; cursor: pointer; }
      @media (hover: hover) { .sc-confirm-close:hover:not(:disabled) { background: rgba(31, 35, 41, 0.08); color: #1f2329; } }
      .sc-confirm-title { margin: 0 24px 0 0; font-size: 15px; line-height: 22px; font-weight: 600; color: #1f2329; }
      .sc-confirm-desc { margin: 0; font-size: 13px; line-height: 20px; color: #454c55; }
      /* V5-2：原 .sc-picker/.sc-picker-item/-title/-billing 规则随 picker 控件废止整体移除（SPC-025 目标面废止）。 */
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
      .sc-billing-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
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
        .sc-dialog { padding: 18px; }
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
        confirmId: null,
        busy: false,
        editorBusy: false,
        savedNotice: null,
        sectionError: null,
        editorError: null,
        // 三轮修复（B-012）：重排回焦意图——被移动条目 id；渲染提交后 effect 据此回焦（焦点跟随条目）。
        pendingHandleFocus: null,
      });
      const alive = React.useRef(true);
      const restoreFocus = React.useRef(null);
      // V4-2：删除模态——触发移除按钮（关闭时焦点回归）与弹窗容器节点（打开时焦点入框）；
      // confirmRef 渲染期镜像模态开启态（编辑器 Escape 处理器据此让位顶层模态）。
      const removeTriggerRef = React.useRef(null);
      // V5-2/V5-3：添加入口原位成表单——新增表单打开期间添加按钮不渲染，表单关闭（取消/Escape）后
      // 按钮重新挂载；触发时的按钮节点已卸载，回焦经该 ref 指向重新挂载后的按钮。
      const addButtonRef = React.useRef(null);
      const confirmDialogRef = React.useRef(null);
      const confirmRef = React.useRef(null);
      confirmRef.current = model.confirmId;
      // 事件处理器经本 ref 读最新在途标志（避免 async 提交间的陈旧闭包）；渲染期镜像。
      const lockRef = React.useRef(false);
      lockRef.current = model.busy || model.editorBusy;
      const locked = model.busy || model.editorBusy;
      // ─────────────── 二轮修复（B-007/009/B-012）：单写者提交管线 ───────────────
      // 根因：各离散/条目级提交以渲染闭包 model 构造 ops 与 expectedRevision；上一提交成功后的读回（load）
      // 未落定时闭包 user/revision 陈旧 → toOps 把「他人已持久化的状态」当「我要提交的差异」以 LWW 覆盖
      // 他条目（B-007/009 名序错乱、run 间非确定性），重排构建器因成员漂移静默返回 []（B-012 零 mutate），
      // 删除 unset 落错下标残留幽灵条目（世界分叉 _6）。
      // (1) latestRef：权威最新持久快照 {user, base, revision}——load() 读回成功同 tick 写入（先于 setModel）；
      //     所有提交路径的基线只从这里取，绝不取闭包 model 的 user/revision。
      // (2) readChain：读回按发起顺序 FIFO 入链——describe 回包即使乱序到达，也按发起序写入 latestRef
      //     （后发起者最后写入=最新视图）；提交构建 ops 前必须 await 链尾（drainReads）。
      // (3) commitChain：单写者——两提交绝不并发；第 N+1 次提交在第 N 次的读回落进 latestRef 之后才执行
      //     （读回与下一次提交严格串行，每条离散路径都从最新持久投影起算 next）。
      const latestRef = React.useRef({ user: null, base: null, revision: undefined });
      const readChainRef = React.useRef(Promise.resolve());
      const commitChainRef = React.useRef(Promise.resolve());
      // 三轮修复（B-012 键盘重排焦点断链）：把手按钮 DOM 节点登记（ref 回调 entryId→节点）——
      // 重排渲染提交后按被移动条目 id 找回新位把手；focusIntentLockedRef 记录回焦意图挂起期间
      // 是否经历过锁定渲染（busy→把手 disabled→浏览器 blur），解锁后据此回焦并消费意图。
      const handleRefs = React.useRef(new Map());
      const focusIntentLockedRef = React.useRef(false);
      const drainReads = () => readChainRef.current;
      const enqueueCommit = (fn) => {
        const run = commitChainRef.current.then(fn);
        commitChainRef.current = run.then(() => {}, () => {});
        return run;
      };

      // 刷新不得静默覆盖在编字段（SET-008 语义）：
      // keepStatus=提交成功后的后台刷新时，正在编辑的条目字段与明文 key 缓冲保留现值。
      const overlayEditingDraft = (m, draft) => {
        if (!m.editingId) return draft;
        const prev = m.draft.entries.find((e) => e.id === m.editingId);
        if (!prev) return draft;
        if (draft.entries.some((e) => e.id === m.editingId)) {
          return {
            ...draft,
            entries: draft.entries.map((e) => (e.id === m.editingId ? { ...e, name: prev.name, credentialRef: prev.credentialRef, enabled: prev.enabled } : e)),
          };
        }
        // v3 用户反馈（V3-1 无占位行）：v2「未提交新建重追加尾部」分支废止——在编新建条目（不在新投影中）
        // 不再由本函数重追加。幽灵行的存续改由 SET-008 全量复原（draftCacheApply create 分支，重挂自动重开
        // 编辑器）+ 列表渲染按持久视图过滤（无占位行）承载：复原语义=编辑器字段复原+自动重开，不进列表。
        return draft;
      };

      // ─────────────────────── SET-008：跨分区草稿保全（模块级缓存读写与重挂校验） ───────────────────────
      // 字段/key/超时变更同步进缓存（首改建档，baseRevision=建档时当前宿主修订）；
      // 成功提交/显式取消清对应记录；卸载与后台刷新不清缓存、不覆盖。
      // 二轮修复：优先取权威快照 revision——读回在途时闭包 m.revision 可能陈旧（陈旧 baseRevision 会在重挂校验里制造假版本冲突）。
      const cacheBaseRevision = (m) => (typeof latestRef.current.revision === "number"
        ? latestRef.current.revision
        : (typeof m.revision === "number" ? m.revision : undefined));
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
        const done = Promise.resolve(pending).then((res) => {
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
          // 二轮修复：权威快照同 tick 写入（先于 setModel）——任何 await 本 done 链尾的路径，读 latestRef 必为最新已读回视图。
          latestRef.current = { user: proj.user, base: proj.base, revision: proj.revision };
          setModel((m) => {
            let draft = draftFrom(normalized);
            let nextKeys = m.keys;
            let editingId = keepStatus ? m.editingId : null;
            let sectionError;
            if (keepStatus) {
              // 后台快照刷新：不清缓存、不覆盖在编字段与在编超时草稿（SET-008）。
              // 五轮修复（codex 复审 P2·SET-008 完整语义）：所有在场草稿都要复原，不只活动编辑器的行——
              // 旧版仅 overlayEditingDraft 回覆盖活动编辑器行：编辑 A（未提交）→开 B→保存 B→读回重建后
              // A 的未提交字段从页内消失；重开 A 只读（已回退的）草稿行、不查 draftCache，再保存把
              // 缓存永久删掉，草稿丢失。次序：(1) 自身提交读回先自对齐 baseRevision（自身写不得制造
              // 假版本冲突）；(2) draftCacheApply 对重建草稿执行全量复原（被切换走条目的编辑字段回填、
              // 未提交新建重追加、全局超时草稿，与初始挂载重挂校验同判据）；(3) 活动编辑器在编字段仍由
              // overlayEditingDraft 护住（现值优先于缓存回填）；活动编辑器不受后台刷新影响（不取 overlay.editingId）。
              if (selfCommitPending && typeof proj.revision === "number") {
                for (const rec of draftCache.values()) rec.baseRevision = proj.revision;
                selfCommitPending = false;
              }
              const overlay = draftCacheApply(draftCache, proj, draft);
              if (overlay) {
                draft = overlay.draft;
                nextKeys = { ...m.keys, ...overlay.keys };
                draft = overlayEditingDraft(m, draft);
                if (draftCache.has(DRAFT_CACHE_GLOBAL_KEY)) draft = { ...draft, timeoutText: m.draft.timeoutText };
                sectionError = overlay.conflicts.length > 0
                  ? { text: "设置已被外部变更：未提交草稿已保留（未静默丢弃、未自动重放）", issues: overlay.conflicts.map((c) => c.text) }
                  : m.sectionError;
              } else {
                // 无缓存记录（或投影缺 revision）：旧路径——仅护在编字段/在编超时草稿。
                draft = overlayEditingDraft(m, draft);
                if (draftCache.has(DRAFT_CACHE_GLOBAL_KEY)) draft = { ...draft, timeoutText: m.draft.timeoutText };
                sectionError = m.sectionError;
              }
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
            // editorError 不在此重置（经 ...m 保留，与 ① 行为一致）；
            // keys/editingId 为 SET-008 重挂校验产物（keepStatus 时即 m.keys / m.editingId）。
            // V5-2：addOpen 标志已废止——「新增表单打开」由「编辑器条目为未持久（幽灵）条目」派生，
            // 读回/重挂重建 editingId 后派生态自动一致（含 SET-008 重挂自动重开新建表单的情形）。
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
        // 二轮修复：读回按发起序 FIFO 入链——回包乱序到达也不破坏「后发起者最后写入 latestRef」。
        readChainRef.current = readChainRef.current.then(() => done, () => done);
        return done;
      };

      React.useEffect(() => {
        alive.current = true;
        load();
        return () => { alive.current = false; };
      }, []);

      // 三轮修复（B-012 键盘重排焦点断链）：重排渲染提交时 React 键控列表把卡片 DOM 节点物理挪位，
      // 浏览器按规范 blur 原聚焦把手（run-5 探针实锤：首次 ArrowUp 生效、其后 activeElement=空、第二下落空）；
      // 且提交在途 busy→locked 把手 disabled 会二次 blur、解锁后浏览器不自动回焦。
      // 焦点须跟随被移动条目：effect 于渲染提交后运行（新位 DOM 就绪），经 handleRefs 按 entryId 取节点 focus()。
      // 意图生命周期：moveEntry 写入 pendingHandleFocus；首焦（未锁定渲染）聚焦但不消费——reorder 提交必然
      // 引发锁定周期（busy→disabled→blur），意图须存活到解锁渲染；解锁后若焦点仍在「空位」（body）= 失焦
      // 源于我们的 disabled → 回焦并消费；用户期间已把焦点移到别处 → 只消费不抢焦（尊重用户）。
      React.useEffect(() => {
        const intent = model.pendingHandleFocus;
        if (!intent) return;
        const target = reorderFocusTarget(intent, model.draft.entries);
        if (!target) {
          setModel((m) => (m.pendingHandleFocus === intent ? { ...m, pendingHandleFocus: null } : m));
          return;
        }
        const el = handleRefs.current.get(target);
        if (locked) {
          focusIntentLockedRef.current = true; // 提交在途：把手 disabled（浏览器已 blur）——保留意图待解锁渲染
          return;
        }
        if (!el || el.disabled) return;
        if (focusIntentLockedRef.current) {
          focusIntentLockedRef.current = false;
          const doc = typeof document === "undefined" ? null : document;
          const blank = !doc || !doc.activeElement || doc.activeElement === doc.body;
          if (blank) el.focus(); // 失焦源于提交锁定的 disabled——回焦；用户已移走焦点则尊重用户
          setModel((m) => (m.pendingHandleFocus === intent ? { ...m, pendingHandleFocus: null } : m));
          return;
        }
        el.focus(); // 首焦（未锁定）：聚焦但不消费——锁定周期必然到来，解锁后本 effect 再聚焦并消费
      }, [model.pendingHandleFocus, locked]);

      // ─────────────────────── SET-006：条目级提交与离散落盘 ───────────────────────
      // 所有落盘以“最新持久化快照”为基线构造，载荷只含该处变更；
      // 其他条目或全局字段的未提交草稿一律不得混入（O-4：expectedRevision 互斥提交）。
      // 五轮修复（codex 复审 P1/P2 同根·宿主层模型）：数组是整段遮蔽（user.entries 存在即整体取代
      // base.entries，无行级合并）——有效持久列表 = user 层有 entries ? user 层 : base 层（保序保兄弟）。
      // 全部 op 构造器改以有效列表起算：首次 user 层写入即整单具化有效列表（toOps 对空 user 层逐行整条
      // set），不得只写 user 层而丢继承兄弟行（= 静默遮蔽整个继承数组）。
      const userEntriesOf = (m) => (Array.isArray(m.user.entries) ? m.user.entries : []);
      const baseEntriesOf = (m) => (Array.isArray(m.base.entries) ? m.base.entries : []);
      const effectiveEntriesOf = (m) => {
        const user = isPlainObject(m && m.user) ? m.user : {};
        if (Array.isArray(user.entries)) return user.entries;
        const base = isPlainObject(m && m.base) ? m.base : {};
        return Array.isArray(base.entries) ? base.entries : [];
      };
      // P2 official 开关：「变没变」从合并后有效配置取值再判（base=false 且 user 无覆盖 → 有效值 false；
      // 旧版只读 user 层 `!== false`，误判「已是 true」→ 打开开关零 mutate：UI 显示开、实际关）。
      // 缺省 true = SET-005 schema 默认（与 draftFrom 投影同判据）。
      const effectiveOfficialOf = (m) => {
        const user = isPlainObject(m && m.user) ? m.user : {};
        if (typeof user.useOfficialDeepSeekSearch === "boolean") return user.useOfficialDeepSeekSearch;
        const base = isPlainObject(m && m.base) ? m.base : {};
        return typeof base.useOfficialDeepSeekSearch === "boolean" ? base.useOfficialDeepSeekSearch : true;
      };
      // 五轮补充（codex 同族残留收口，lead (z) 点头）：timeout「值未变化」对照合并后有效值（user 显式数值
      // 优先 → base → schema 默认 25000，与 draftFrom 投影同判据）；旧版只读 user 层，base 有值且无覆盖时
      // 重输当前有效值会写冗余 user override（同 P2#2 错层族）。
      const effectiveTimeoutMsOf = (m) => {
        const user = isPlainObject(m && m.user) ? m.user : {};
        if (typeof user.timeoutMs === "number") return user.timeoutMs;
        const base = isPlainObject(m && m.base) ? m.base : {};
        return typeof base.timeoutMs === "number" ? base.timeoutMs : DEFAULT_TIMEOUT_MS;
      };

      // 离散动作立即落盘：成功=生效确认（重新读取投影）；失败=保留意图（草稿保留目标值）+ 节级顶部可操作错误。
      // 二轮修复（单写者）：提交整体在 commitChain 队列内执行——(a) 先 await 全部在途读回落进 latestRef；
      // (b) ops 从权威快照起算（buildOps(snap)，snap=最新持久投影）；(c) expectedRevision 取同一 snap（乐观锁）；
      // (d) 成功后乐观更新 latestRef 并 await load(true) 读回——队列内下一次提交必然从本轮之后的最新投影起算。
      const commitDiscrete = (buildOps, successText) => {
        const m0 = model;
        if (lockRef.current || m0.phase !== "ready" || typeof m0.revision !== "number") return Promise.resolve(false);
        return enqueueCommit(async () => {
          if (!alive.current) return false;
          await drainReads(); // (a) 无陈旧读回：latestRef 基线新于任何在途 describe
          if (!alive.current) return false;
          const snap = latestRef.current;
          if (!snap || typeof snap.revision !== "number") return false;
          let ops = null;
          try { ops = buildOps(snap); } catch { ops = null; }
          if (!ops || ops.length === 0) return true; // 意图未变化：无需写
          if (lockRef.current) return false; // 队列排空后复核在途标志（排队期间可能已有新操作先行）
          setModel((m) => ({ ...m, busy: true, savedNotice: null, sectionError: null }));
          let response;
          try {
            response = await rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: snap.revision });
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
          // (d) 乐观更新权威快照（读回失败时下一提交仍可按 op 后状态起算；读回最终为权威）。
          try { latestRef.current = { ...snap, user: applyOpsToLayer(snap.user, ops) }; } catch { /* 失败由读回纠正 */ }
          // v3 用户反馈（V3-3 开关免提示）：successText 为 null 时不设 savedNotice（开关状态呈现即反馈）；
          // 编辑器保存/超时/删除/重排维持成功文案（SET-007 槽位规范不变，仅收敛触发集）。
          setModel((m) => ({ ...m, busy: false, savedNotice: successText ? { text: successText } : null }));
          selfCommitPending = true; // SET-008：自身成功提交 → 读回后把存活草稿记录的 baseRevision 自对齐
          await load(true); // (d) 单写者：本次读回必须在队列内下一提交构建 ops 前落定
          return true;
        });
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
      // 五轮修复（codex 复审 P2）：比对「变没变」从合并后有效配置取值——继承 base=false 且 user 无覆盖时
      // 打开开关必须落盘（user 层写 override=true），不得零 mutate（UI 显示开、实际关）。
      const officialToggleChange = (ev) => {
        const target = Boolean(ev.target && ev.target.checked);
        if (lockRef.current) return;
        setModel((m) => ({ ...m, sectionError: null, savedNotice: null, draft: { ...m.draft, useOfficial: target } }));
        commitDiscrete((m) => (effectiveOfficialOf(m) === target ? [] : [{ op: "set", path: ["useOfficialDeepSeekSearch"], value: target }]), null); // v3 用户反馈（V3-3）：开关免提示——开关状态呈现即反馈（落盘语义不变）
      };

      // 超时输入：失焦/回车 且 值有变化且合法 才提交（仅 timeoutMs 键）；成功后清 __global__ 草稿记录（SET-008）。
      // 二轮修复（B-017）：提交值以实时 DOM（ev.currentTarget.value）为准——onChange→state 回写与 blur 同帧时，
      // 闭包 state 是旧值（会把旧 25000 当「值未变化」静默不写、非法值永不到达校验分支→无 alert）；
      // 输入框当前值恒为用户实际所输。harness 直调回调无 currentTarget 时回退闭包 state（既有用例语义不变）。
      const timeoutCommit = (ev) => {
        if (lockRef.current) return;
        const live = ev && ev.currentTarget && typeof ev.currentTarget.value === "string" ? ev.currentTarget.value : null;
        const text = (live !== null ? live : String(model.draft.timeoutText ?? "")).trim();
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          if (live !== null) syncGlobalCache(model, live); // 非法草稿也入缓存（重挂可复原，不静默丢弃）
          setModel((m) => ({ ...m, sectionError: { text: "超时须为正整数（毫秒）", issues: [] }, savedNotice: null }));
          return;
        }
        setModel((m) => ({ ...m, sectionError: null, draft: { ...m.draft, timeoutText: String(parsed) } }));
        // 「值未变化」判定同样对照最新持久快照（闭包 user 可能陈旧）→ 移入提交链内，ops 为空即不写。
        // 五轮补充（codex 同族残留收口，lead (z) 点头）：对照合并后有效值（user 显式数值 → base → 默认 25000）
        // 判「变没变」——继承 world（base 有 timeoutMs、user 无覆盖）重输当前有效值零 mutate，
        // 新值落 user 层单键 override（与 official 开关同形，不连带具化条目列表）。
        const run = commitDiscrete((snap) => (effectiveTimeoutMsOf(snap) === parsed ? [] : [{ op: "set", path: ["timeoutMs"], value: parsed }]), "已保存设置。");
        run.then((ok) => { if (ok) draftCache.delete(DRAFT_CACHE_GLOBAL_KEY); }, () => {});
      };

      // 卡片启用开关：onChange 即离散提交（仅自身 enabled 键；未提交的新条目无持久化变更）。
      // 五轮修复（codex 复审 P2·继承条目的离散动作不落盘）：以有效持久列表起算——继承条目（base 层、
      // user 层无同 id 行）的开关同样落盘：把有效列表（含变更行）整单具化进 user 层（数组整段遮蔽语义
      // 下，只写单字段会丢全部继承兄弟行）。user 层世界有效列表==user 层，toOps 仍产出单字段 op（载荷不变）。
      const enabledToggleChange = (entryId, ev) => {
        const target = Boolean(ev.target && ev.target.checked);
        if (lockRef.current) return;
        setModel((m) => ({ ...m, sectionError: null, savedNotice: null, draft: { ...m.draft, entries: m.draft.entries.map((e) => (e.id === entryId ? { ...e, enabled: target } : e)) } }));
        commitDiscrete((m) => {
          const list = effectiveEntriesOf(m);
          const idx = list.findIndex((e) => sameEntryId(e.id, entryId)); // #55：entryId 为草稿（trim）形态，持久行可能带首尾空白
          if (idx < 0) return []; // 未提交新条目无持久化变更
          if ((list[idx].enabled !== false) === target) return []; // 意图未变化：无需写（对照有效值）
          return toOps({ entries: list.map((e) => (sameEntryId(e.id, entryId) ? { ...e, enabled: target } : e)) }, { entries: userEntriesOf(m) });
        }, null); // v3 用户反馈（V3-3）：开关免提示——开关状态呈现即反馈（落盘语义不变）
      };

      // 移除确认：清草稿（含 SET-008 缓存记录：条目已不存在，其草稿作废）+ 落盘 unset（仅该条目键）。
      // 五轮修复（codex 复审 P2）：继承条目的移除同样落盘——user 层行按原路径单行 unset（载荷不变）；
      // 继承行（base 层）则把移除后的有效列表整单具化进 user 层（遮蔽 base，该行从有效视图消失）；
      // 旧版对继承行 idx===-1 静默零 ops（页内删卡后读回条目复活=数据不一致）。
      // 六轮修复（codex P2）：当 base 仅剩单条且 user.entries 缺失时，不能把缺失传成 { entries: [] } 给 toOps，
      // 否则 toOps({ entries: [] }, { entries: [] }) 产出零 ops；须以实际 user 层（缺失传 {}）起算，显式写入
      // user.entries = []（{ op: "set", path: ["entries"], value: [] }）遮蔽 base。
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
          const user = userEntriesOf(m);
          const uIdx = user.findIndex((e) => sameEntryId(e.id, entryId)); // #55：持久行 id 可能带首尾空白
          if (uIdx >= 0) return [{ op: "unset", path: ["entries", String(uIdx)] }];
          const list = effectiveEntriesOf(m);
          const idx = list.findIndex((e) => sameEntryId(e.id, entryId)); // #55
          if (idx < 0) return [];
          const hasUserEntries = isPlainObject(m && m.user) && Array.isArray(m.user.entries);
          return toOps({ entries: list.filter((e) => !sameEntryId(e.id, entryId)) }, hasUserEntries ? { entries: user } : {});
        }, "已保存设置。");
      };

      // 拖拽/键盘重排：草稿先行（视觉即时），随后以持久化快照的相对顺序落盘（D-1 整条编码，仅 entries 键）。
      // 五轮修复（codex 复审 P2）：以有效持久列表起算——纯继承世界（user 层无 entries）的重排同样落盘：
      // 把重排后的有效列表整单具化进 user 层；旧版 user 层空列表 → 目标 id 全被过滤 → 静默零 ops。
      // user 层世界有效列表==user 层，载荷与旧版逐字节一致。
      const commitReorder = (orderIds) => {
        const ids = orderIds || model.draft.entries.map((e) => e.id);
        commitDiscrete((m) => {
          const user = userEntriesOf(m);
          const list = effectiveEntriesOf(m);
          const present = new Set(list.map((e) => normEntryId(e.id))); // #55：持久行 id 可能带首尾空白，草稿 id 为 trim 形态
          const targetIds = ids.filter((id) => present.has(normEntryId(id)));
          if (targetIds.length !== list.length) return []; // 草稿含未提交新条目（不在有效列表）：持久化顺序不受影响
          if (targetIds.every((id, i) => sameEntryId(id, list[i].id))) return [];
          const byId = new Map(list.map((e) => [normEntryId(e.id), e]));
          return toOps({ entries: targetIds.map((id) => byId.get(normEntryId(id))) }, { entries: user });
        }, "已保存设置。");
      };
      const moveEntry = (id, delta) => {
        if (lockRef.current) return;
        const list = [...model.draft.entries];
        const from = list.findIndex((e) => e.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= list.length) return;
        [list[from], list[to]] = [list[to], list[from]];
        // 三轮修复（B-012）：记录回焦意图——重排渲染挪位 DOM 会 blur 原聚焦把手，
        // 渲染提交后 effect 按被移动条目 id 回焦（键盘焦点跟随条目，连续按键可持续排序）。
        setModel((m) => ({ ...m, draft: { ...m.draft, entries: list }, pendingHandleFocus: id }));
        commitReorder(list.map((e) => e.id));
      };
      // V5-2：点「添加搜索工具」即原位开新增表单——不再经 picker 选厂商独立步骤（该步骤废止）。
      // 复用既有幽灵条目链：草稿末尾追加幽灵（不入列表，V3-1）、编辑表单内下拉选厂商、
      // SET-006 条目级提交（提交成功才持久化）、SET-008 草稿缓存。默认厂商 = CATALOG_UI 顺序第一种。
      const addEntry = (trigger) => {
        if (lockRef.current) return;
        // V5-5：存在未保存的新增（幽灵）草稿时，重开新增入口必须恢复同一待保存草稿——
        // editingId 切回幽灵 id（id 不变，名称/厂商类型/credentialRef 随草稿行回填，key 明文
        // 缓冲在 model.keys，厂商下拉选中值 = 切走前厂商），不新分配 id、不重置字段；
        // SET-008 create 缓存记录不动（重挂复原路径不受影响）。判定面 = 内存草稿列表中
        // 未持久行（与 editorIsCreate / V5-3 互斥 / 卡片幽灵过滤同一幽灵判定）。
        const pending = model.draft.entries.find((e) => !entryIsPersisted(model, e));
        if (pending) {
          restoreFocus.current = trigger ?? null;
          setModel((m) => ({ ...m, editingId: pending.id, editorError: null }));
          return;
        }
        const [type, label] = CATALOG_UI[0];
        const id = `search_chain_${Date.now().toString(36)}_${++entryIdSeq}`;
        // 触发节点（添加按钮）在表单期间不渲染（V5-3 互斥）——回焦改由 addButtonRef 承接（见 cancelEditor）。
        restoreFocus.current = trigger ?? null;
        setModel((m) => ({
          ...m,
          editingId: id,
          editorError: null,
          draft: { ...m.draft, entries: [...m.draft.entries, { id, type, name: label, enabled: true, credentialRef: "" }] },
        }));
        // SET-008：新建草稿入缓存（稳定临时 id 为键；未提交即卸载，重挂须能复原）。
        // 二轮修复：baseRevision 取权威快照（读回在途时闭包 model.revision 陈旧 → 重挂校验假版本冲突）。
        draftCache.set(id, { mode: "create", type, fields: { name: label, credentialRef: "" }, key: "", baseRevision: typeof latestRef.current.revision === "number" ? latestRef.current.revision : undefined });
      };

      // V5-2：新增表单内切换厂商——字段集与凭据规则与编辑表单完全一致（keyed = credentialRef + key；bing 皆无）。
      // 草稿字段迁移规则（规格 V5-2 设计决定）：名称仍等于旧厂商默认名（用户未修改）→ 跟随新厂商默认名；
      // 用户已修改的名称原样保留；credentialRef 与 key 明文缓冲原样保留（免 key 厂商下隐藏、切回恢复）；
      // SET-008 缓存记录 type 同步更新（重挂复原按切换后的厂商重建幽灵）。
      const changeAddType = (id, type) => {
        if (lockRef.current) return;
        const row = CATALOG_UI.find((x) => x[0] === type);
        if (!row) return; // 未知厂商值：忽略（受控 select 不会产生，防外部异常事件）
        const entry = model.draft.entries.find((e) => e.id === id);
        if (!entry || entryIsPersisted(model, entry)) return; // 仅新增（幽灵）表单提供厂商切换
        const newLabel = row[1];
        const oldRow = CATALOG_UI.find((x) => x[0] === entry.type);
        const oldLabel = oldRow ? oldRow[1] : entry.type;
        const name = entry.name === oldLabel ? newLabel : entry.name;
        const keyVal = typeof model.keys[id] === "string" ? model.keys[id] : "";
        setModel((m) => ({
          ...m,
          editorError: null,
          draft: { ...m.draft, entries: m.draft.entries.map((e) => (e.id === id ? { ...e, type, name } : e)) },
        }));
        const rec = draftCache.get(id) || { mode: "create", type, fields: {}, key: "", baseRevision: typeof latestRef.current.revision === "number" ? latestRef.current.revision : undefined };
        rec.type = type;
        rec.fields = { name, credentialRef: entry.credentialRef ?? "" };
        rec.key = keyVal;
        draftCache.set(id, rec);
      };

      // 二轮修复：同时查权威快照——创建提交成功但读回未落定时闭包 user 缺该条目，误判 create 会使重挂校验误报版本冲突。
      // 五轮修复（codex 复审 P1/P2 同根）：继承条目（base 层已持久）同样判为已持久——驱动编辑器编辑/新建
      // 语义、取消时恢复持久值（而非当作新条目删行）、SET-008 缓存记录 mode（edit 而非 create）。
      const entryIsPersisted = (m, entry) => effectiveEntriesOf(m).some((e) => sameEntryId(e.id, entry.id))
        || (latestRef.current && effectiveEntriesOf(latestRef.current).some((e) => sameEntryId(e.id, entry.id))); // #55：持久行 id 可能带首尾空白

      // 编辑器提交的候选条目列表：按稳定条目 id 合并该条目全部托管字段，
      // 其余条目取持久化快照值；载荷不含其他条目/全局字段草稿（SET-006）。
      // 五轮修复（codex 复审 P1·继承列表遮蔽——必拦）：候选从有效持久列表（继承合并视图，保序保兄弟）
      // 起算——编辑继承条目原位只改该行；新建追加有效列表末尾。旧版只以 user 层起算：继承条目不可见
      // → 编辑继承条目被误走「新建追加」分支、落盘只含该条 → user 层遮蔽整个继承数组（改名 → 只剩它；
      // 新建 → 继承兄弟行全没）。toOps 底仍为 user 层：对空 user 层逐行整条 set = 有效列表整单具化。
      const candidateEntriesFor = (m, entry, credRef) => {
        const list = effectiveEntriesOf(m);
        const matched = list.find((e) => sameEntryId(e.id, entry.id)); // #55：持久行 id 可能带首尾空白
        // #55：命中持久行时 patch.id 取原持久行 raw id——trim 后草稿 id 不得改写原持久 id（写回最小字段级 diff）。
        const patch = { id: matched ? matched.id : entry.id, type: entry.type, name: entry.name, enabled: entry.enabled };
        if (credRef) patch.credentialRef = credRef;
        if (matched) {
          return list.map((e) => {
            if (!sameEntryId(e.id, entry.id)) return e;
            const out = { ...e, ...patch };
            if (!credRef) delete out.credentialRef;
            return out;
          });
        }
        return [...list, { ...patch }];
      };

      // 条目级提交（新建=创建 / 编辑=更新）：先凭据后配置；成功=该条目整体生效并关闭编辑器；
      // 失败=编辑器原地保留（字段与 key 缓冲不丢）+ 动作行上方 role=alert 错误。
      // 二轮修复（单写者 + 绑定守卫）：提交在 commitChain 队列内执行——先 await 在途读回落进 latestRef，
      // 再自权威快照 snap 起算：candidate = candidateEntriesFor(snap, entry, credRef)、expectedRevision = snap.revision；
      // 且必须通过 singleEntryDiff({entries: 有效持久列表}, candidate, boundId)——候选与最新持久列表（继承合并
      // 视图，五轮修复起算有效列表：守卫意图「他行零改动」对继承底板同样成立）若不在绑定条目一行上
      // 存在漂移（stale 快照竞态）则拒发（B-007/009：旧代码以陈旧 user 列表为底，toOps 把他条目当「我的差异」LWW 覆盖）。
      // 免 key 厂商（如 bing）隐藏凭据字段但仍保留 V5-2 缓存值以便切回 keyed 厂商时回填；
      // 校验与提交路径须按当前厂商决定是否采信缓存的 credentialRef 与明文 key。
      const editorCredInputs = (entry, rawKey) => {
        const isKeyed = KEYED_TYPES.includes(entry.type);
        const keyVal = (typeof rawKey === "string" ? rawKey : "").trim();
        const writesKey = isKeyed && keyVal !== "";
        const credRef = isKeyed ? (entry.credentialRef ?? "").trim() : "";
        return { keyVal, writesKey, credRef };
      };

      const submitEditor = () => {
        const entry = model.draft.entries.find((e) => e.id === model.editingId);
        if (!entry || lockRef.current) return;
        if (model.phase !== "ready" || typeof model.revision !== "number") return;
        const boundId = entry.id; // 编辑器绑定：本次提交只允许触及该 id 一行
        const { keyVal, writesKey, credRef: initialCredRef } = editorCredInputs(entry, model.keys[boundId]);
        let credRef = initialCredRef;
        // 四轮修复（B-007/009/019 污染源）：名称门（与实时 editorBlock 同判据；真实 DOM 中禁用钮不可点，
        // 此守卫兜底测试侧直接触发）：空名/纯空白名 → 零出站、编辑器不关、输入不丢（SET-004 失败保留面），
        // 错误于动作行上方 role=alert 呈现（SPC-023/SPC-030）。新建与编辑同一路径同判据。
        const nameProblem = entryNameGate(entry.name);
        if (nameProblem) {
          setModel((m) => ({ ...m, editorError: { text: nameProblem, issues: [] } }));
          return;
        }
        // 代码级阻断（与实时 editorBlock 同判据；真实 DOM 中禁用钮不可点，此守卫兜底测试侧直接触发）：
        // 超语法 ref 且本次不带新 key → 零出站（R-1 / P2-3 留空变体）。
        if (!writesKey && credRef && !POSIX_REF.test(credRef)) {
          setModel((m) => ({ ...m, editorError: { text: "凭据引用格式无效：仅允许以字母或下划线开头，后续使用字母、数字或下划线。", issues: [] } }));
          return;
        }
        setModel((m) => ({ ...m, editorBusy: true, editorError: null, savedNotice: null, sectionError: null }));
        enqueueCommit(async () => {
          try {
            if (!alive.current) return;
            await drainReads(); // 写前等待在途读回落进 latestRef（单写者串行）
            if (!alive.current) return;
            const snap = latestRef.current;
            if (!snap || typeof snap.revision !== "number") throw new Error("宿主投影缺少 revision，禁止保存（请重新打开设置）");
            if (writesKey) {
              // 新引用总是 POSIX 合法（受控生成）；先写凭据，成功后才允许携带新 ref 落盘。
              const newRef = credentialRefFor(boundId);
              credRef = newRef;
              const credResponse = await credentialRpc("set", { ref: newRef, value: keyVal });
              const credResult = unwrap(credResponse);
              if (!credResult.ok) throw new Error(credResult.message || "凭据服务拒绝写入");
            }
            const candidate = candidateEntriesFor(snap, entry, credRef);
            // 绑定守卫：漂移即拒发（可见报错，不得静默覆盖他条目）。
            // 五轮修复（codex 复审 P1 配套）：对照有效持久列表（继承合并视图）裁决——继承条目的候选行
            // 对 base 底板「他行零改动」即放行（旧版对照 user 层：继承编辑被误走新建分支，守卫按长度
            // +1 拒发=继承条目永远无法提交；继承新建则把 user 层空列表当底板，守卫与遮蔽缺陷同源）。
            if (!singleEntryDiff({ entries: effectiveEntriesOf(snap) }, candidate, boundId)) {
              throw new Error("提交目标与编辑器绑定条目不一致（持久快照漂移），本次写入已拒绝；请重新保存");
            }
            const check = validate({ ...snap.base, ...{ ...snap.user, entries: candidate } });
            if (!check.ok) throw new Error(`校验未通过：${check.issues.map((i) => i.message).join("；")}`);
            const ops = toOps({ entries: candidate }, { entries: userEntriesOf(snap) });
            if (ops.length > 0) {
              const response = await rpc("mutate", { ns: SEARCH_NS, ops, expectedRevision: snap.revision });
              const result = unwrap(response);
              if (!result.ok) throw new Error(result.message || "宿主拒绝该请求");
              try { latestRef.current = { ...snap, user: applyOpsToLayer(snap.user, ops) }; } catch { /* 失败由读回纠正 */ }
            }
            const name = (entry.name || "").trim() || entry.type;
            draftCache.delete(boundId); // SET-008：成功提交 → 清该条目草稿记录
            selfCommitPending = true; // SET-008：存活的其他草稿记录 baseRevision 自对齐
            setModel((m) => {
              const keys = { ...m.keys };
              delete keys[boundId];
              return { ...m, editorBusy: false, editingId: null, keys, editorError: null, savedNotice: { text: `已保存 ${name}。` } };
            });
            await load(true); // 单写者：读回必须在队列内下一提交构建 ops 前落定
          } catch (err) {
            if (!alive.current) return;
            let message = String((err && err.message) || err || "保存失败");
            for (const secret of Object.values(model.keys)) {
              if (typeof secret === "string" && secret.trim()) message = message.replaceAll(secret.trim(), "[redacted]");
            }
            setModel((m) => ({ ...m, editorBusy: false, editorError: { text: `保存失败：${message}`, issues: [] } }));
          }
        });
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
              // 五轮修复（codex 复审 P1/P2 配套）：持久值取有效行——继承条目的取消恢复到 base 值；
              // 旧版 entryIsPersisted 对继承条目误判新建（删行=页内丢失继承条目）且此处查不到持久行。
              const persisted = effectiveEntriesOf(m).find((e) => sameEntryId(e.id, entry.id)); // #55：持久行 id 可能带首尾空白
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
          return { ...m, editingId: null, keys, editorError: null, draft: { ...m.draft, entries } };
        });
        restoreFocus.current = null;
        if (trigger && typeof trigger.focus === "function") Promise.resolve().then(() => trigger.focus());
        // V5-2/V5-3：新增表单的触发控件（添加按钮）在表单期间不渲染、取消时已卸载，上述回焦为空操作——
        // 实际的添加按钮回焦由渲染提交后的 effect 承接（见 editorIsCreate 下方的 addFormWasOpen effect）。
      };
      // V5-1：同一条「编辑」再点 = 收起——开/收全程零写入；草稿字段与 SET-008 缓存记录保留
      // （收起 ≠ 丢弃；「丢弃」语义仍仅由取消 / Escape 承载）。重开同一编辑器时草稿字段随
      // model.draft 原样回到编辑器（与切换条目在编语义一致）。
      const openEditorFor = (entryId, trigger) => {
        if (lockRef.current) return;
        restoreFocus.current = trigger ?? null;
        if (model.editingId === entryId) {
          setModel((m) => ({ ...m, editingId: null, editorError: null }));
          return;
        }
        setModel((m) => ({ ...m, editingId: entryId, editorError: null }));
      };
      const onDialogKeyDown = (ev) => {
        if (ev.key === "Escape") {
          if (confirmRef.current) return; // V4-2：删除模态开启时 Escape 属顶层模态（document 后备路径消费），编辑器不动
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
      // ─────────────── V4-2：删除确认模态（居中 alertdialog，替代旧内联确认） ───────────────
      // 关闭路径（×/取消/Escape）均只清 confirmId——零数据变更（SET-002 无写路径）；
      // 确认走既有 confirmRemoveClick（条目级 unset 单键提交 + SET-007「已保存设置。」，语义不变）。
      const closeConfirm = () => {
        setModel((m) => (m.confirmId ? { ...m, confirmId: null } : m));
      };
      const onConfirmKeyDown = (ev) => {
        if (ev.key === "Escape") { ev.preventDefault?.(); closeConfirm(); return; }
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
      // v3 用户反馈（V3-1 无占位行）：未提交新建条目（幽灵）只存在于编辑器——列表恒等于已持久条目
      // 视图（有效持久列表）。草稿仍保留幽灵行（编辑器取值/提交候选/SET-008 缓存链不改），渲染按
      // 持久 id 过滤：打开新建/后台读回/O-6 重开任何时机，页内列表都不出现占位行。
      const editorEntry = model.draft.entries.find((e) => e.id === model.editingId);
      // V4-1：编辑器就地展开——编辑器树先于卡片节点构建；持久条目渲染进其归属卡片（cardNodes 内），
      // 新建（未持久）条目无外层卡片，编辑器继续置于新建块之后（不入列表，V3-1 判据不变）。
      // #55：持久行 id 可能带首尾空白，草稿 id 为 trim 形态——身份集合按 trim 后构建，
      // 带空白 id 的有效条目卡片不再被过滤隐藏（cardNodes/幽灵过滤的 .has(草稿id) 判据不变）。
      const persistedIdSet = new Set(effectiveEntriesOf(model).map((e) => normEntryId(e.id)));
      // SET-006：提交钮实时校验（在途/只读/缺 revision/校验失败 → 禁用）；新 ref 由受控生成、恒合法，校验用占位 ref 投影。
      const editorIsCreate = editorEntry ? !entryIsPersisted(model, editorEntry) : false;
      // V5-2/V5-3：新增表单关闭（取消/Escape/保存成功 → editingId 落空）且未改开其他编辑器
      // （editingId 非空 = 从新增表单切到编辑持久条目，走编辑按钮触发回焦，不抢焦）时，
      // 焦点回到重新挂载后的添加按钮。effect 在渲染提交后运行，按钮节点必已登记——
      // 触发时的按钮节点在表单期间不渲染（已卸载），微任务无法保证重挂载提交时点。
      const addFormWasOpen = React.useRef(false);
      React.useEffect(() => {
        if (addFormWasOpen.current && !editorIsCreate && model.editingId === null) {
          const btn = addButtonRef.current;
          if (btn && typeof btn.focus === "function") btn.focus();
        }
        addFormWasOpen.current = editorIsCreate;
      });
      const editorBlock = (() => {
        if (!editorEntry) return null;
        // 四轮修复（B-007/009/019 污染源）：名称门实时呈现——空名/纯空白名即时禁用提交钮并在动作行
        // 上方 role=alert 报错（SPC-023「新建=完整校验」/SPC-030），不必等提交才暴露。
        const nameProblem = entryNameGate(editorEntry.name);
        if (nameProblem) return { text: nameProblem, issues: [] };
        const { writesKey, credRef } = editorCredInputs(editorEntry, model.keys[editorEntry.id]);
        if (!writesKey && credRef && !POSIX_REF.test(credRef)) {
          return { text: "凭据引用格式无效：仅允许以字母或下划线开头，后续使用字母、数字或下划线。", issues: [] };
        }
        const check = validate({ ...model.base, ...{ ...model.user, entries: candidateEntriesFor(model, editorEntry, writesKey ? "SEARCH_CHAIN_CREDENTIAL_REF" : credRef) } });
        if (!check.ok) return { text: "无法提交：配置校验未通过", issues: check.issues.map((i) => i.message) };
        return null;
      })();
      const editorProblem = model.editorError || editorBlock;
      const editorSubmitDisabled = model.busy || model.editorBusy || model.phase !== "ready" || typeof model.revision !== "number" || !!editorBlock;
      // v3 用户反馈（V3-1 文案统一）：提交钮编辑/新建一律「取消|保存」，busy「保存中…」——
      // 废止「创建工具/创建中…」（任何编辑器动作标签中不得出现）。
      const submitLabel = model.editorBusy ? "保存中…" : "保存";
      const editor = editorEntry ? React.createElement("div", {
        role: "dialog", "aria-modal": "true", "aria-labelledby": "sc-editor-title",
        "data-role": "editor", onKeyDown: onDialogKeyDown, className: "sc-dialog sc-editor",
      },
        React.createElement("h4", { id: "sc-editor-title", className: "sc-editor-title" }, `${editorIsCreate ? "新建" : "编辑"} ${editorEntry.name || editorEntry.type}`),
        // V5-2 / V5-6：厂商下拉框仅出现在新增表单（原 sc-picker 独立选厂商步骤废止）——选项文本为纯厂商名；
        // 下拉正下方 .sc-billing-hint 随所选厂商联动显示 CATALOG_UI[2] 计费提示原文（仅新建显示）。
        editorIsCreate ? React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "厂商"), React.createElement("select", {
          className: "sc-input sc-select-input", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.type, onChange: (ev) => changeAddType(editorEntry.id, ev.target.value),
        }, ...CATALOG_UI.map(([type, label]) => React.createElement("option", { key: type, value: type }, label)))) : null,
        editorIsCreate ? React.createElement("p", {
          className: "sc-billing-hint", "data-role": "billing-hint",
        }, CATALOG_UI.find(([type]) => type === editorEntry.type)?.[2] ?? "") : null,
        React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "名称"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "name", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.name ?? "", onChange: (ev) => updateEditorField(editorEntry.id, "name", ev.target.value), autoFocus: true,
        })),
        KEYED_TYPES.includes(editorEntry.type) ? React.createElement("label", { className: "sc-field" }, React.createElement("span", { className: "sc-field-label" }, "凭据引用"), React.createElement("input", {
          className: "sc-input", type: "text", "data-role": "field", "data-field": "credentialRef", "data-entry-id": editorEntry.id, disabled: locked,
          value: editorEntry.credentialRef ?? "", placeholder: "例如 TAVILY_API_KEY",
          onChange: (ev) => updateEditorField(editorEntry.id, "credentialRef", ev.target.value),
        })) : null,
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
      const cardNodes = model.draft.entries.filter((entry) => persistedIdSet.has(entry.id)).map((entry) => {
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
            // R3：把手左移——.sc-card-info 首子节点（button）；骨架 把手→名称→徽标→状态点。
            React.createElement("div", { className: "sc-card-info" },
              React.createElement("button", {
                className: "sc-drag-handle", type: "button", "data-role": "drag-handle", "data-entry-id": entry.id, disabled: locked,
                draggable: !locked, "aria-label": `拖动排序：${entry.name || row?.[1] || entry.type}`,
                title: "拖动排序；也可按方向键调整位置",
                // 三轮修复（B-012）：登记把手节点（entryId→node）——重排渲染提交后回焦 effect 按被移动条目 id 取新位节点。
                ref: (el) => {
                  if (el) handleRefs.current.set(entry.id, el);
                  else handleRefs.current.delete(entry.id);
                },
                onDragStart: (ev) => { if (locked) return; ev.dataTransfer?.setData?.("text/plain", entry.id); ev.currentTarget?.closest?.('[data-role="card"]')?.setAttribute?.("data-dragging", ""); },
                onDragEnd: (ev) => { clearDragMarks(ev.currentTarget); },
                onKeyDown: (ev) => {
                  if (locked) return;
                  if (ev.key === "ArrowUp") { ev.preventDefault?.(); moveEntry(entry.id, -1); }
                  else if (ev.key === "ArrowDown") { ev.preventDefault?.(); moveEntry(entry.id, 1); }
                },
              }, "⠿"),
              React.createElement("span", { "data-role": "card-name", "data-entry-id": entry.id, className: entry.name ? "sc-card-name" : "sc-card-name sc-card-name-placeholder" }, displayName),
              React.createElement("span", { "data-role": "card-type", "data-entry-id": entry.id, className: duplicateTypeLabel ? "sc-type-duplicate" : "sc-type-badge" }, displayType),
              // R2：徽标纯点——data-role/data-state/role=img/aria-label/title 全部落在点自身；空文本、无 aria-live、无 wrapper。
              React.createElement("span", {
                className: "sc-status-dot", "data-role": "card-status", "data-entry-id": entry.id,
                role: "img", "aria-label": entryStatusText(entry), title: entryStatusText(entry),
                "data-state": entryStatusState(entry),
              }),
            ),
            React.createElement("div", { className: "sc-card-actions" },
              React.createElement("label", { className: "sc-switch" },
                React.createElement("input", {
                  className: "sc-switch-input", type: "checkbox", role: "switch", "aria-checked": entry.enabled,
                  "aria-label": `启用 ${entry.name || row?.[1] || entry.type}`,
                  "data-role": "enabled-toggle", "data-entry-id": entry.id, checked: entry.enabled, disabled: locked,
                  onChange: (ev) => enabledToggleChange(entry.id, ev),
                }),
                // V5-4：卡片开关可见「启用」文字移除（无障碍名称仍在 input aria-label；官方行标签不受本条影响）。
                React.createElement("span", { className: "sc-switch-track", "aria-hidden": "true" }),
              ),
              React.createElement("button", {
                className: "sc-button-secondary", type: "button", "data-role": "card-edit", "data-entry-id": entry.id, disabled: locked,
                onClick: (ev) => openEditorFor(entry.id, ev.currentTarget ?? null),
              }, "编辑"),
              React.createElement("button", {
                className: "sc-button-danger", type: "button", "data-role": "card-remove", "data-entry-id": entry.id, disabled: locked,
                onClick: (ev) => { if (!locked) { removeTriggerRef.current = ev.currentTarget ?? null; setModel((m) => ({ ...m, confirmId: entry.id })); } },
              }, "移除"),
            ),
          ),
            // V4-1：编辑器归属其卡片（卡片直接子节点、条目行 nextElementSibling）；目标切换时唯一编辑器整体移动，无尾部残影。
            entry.id === model.editingId ? editor : null,
        );
      });
      // 二轮修复（B-017）：超时输入非法态——非空且非正整数 → aria-invalid（与节级 alert 双通道）。
      const timeoutDraftText = String(model.draft.timeoutText ?? "").trim();
      const timeoutInvalid = timeoutDraftText !== "" && (!Number.isSafeInteger(Number(timeoutDraftText)) || Number(timeoutDraftText) <= 0);
      // SET-007：节级顶部槽——成功（role=status）与错误/冲突（role=alert）互斥，位于首个卡片之前；面板底部零状态节点。
      const savedNode = model.savedNotice ? React.createElement("p", {
        className: "sc-saved-notice", "data-role": "save-status", "data-state": "saved", role: "status", "aria-live": "polite",
      }, model.savedNotice.text) : null;
      const sectionErrorNode = model.sectionError ? React.createElement("p", {
        className: "sc-status-node", "data-role": "save-error", "data-state": "error", role: "alert",
      }, model.sectionError.text, ...(model.sectionError.issues ?? []).map((issue, i) => React.createElement("span", { key: `issue-${i}`, style: secondaryTextStyle }, ` ${issue}`))) : null;
      // V5-2/V5-3：旧「点添加 → sc-picker 选厂商」独立步骤废止（picker 控件整体移除）。
      // 「新增表单打开」由「当前编辑器条目为未持久（幽灵）条目」派生（editorIsCreate，非独立标志）：
      // 幽灵编辑器渲染于添加块入口原位，期间添加按钮不渲染（互斥）；表单关闭（取消/Escape/保存成功）
      // 后 editingId 落空 → 派生态自动恢复入口。
      // V4-2：删除确认模态（取代旧内联确认）——居中遮罩 alertdialog，标题/正文按规格精确文案，
      // 右上 ×、取消（secondary）、危险「删除 {名称}」（SPC-023 outline token，保留 confirm-remove 锚点）。
      const confirm = model.confirmId ? (() => {
        const cEntry = model.draft.entries.find((e) => e.id === model.confirmId);
        if (!cEntry) return null;
        const cRow = CATALOG_UI.find((x) => x[0] === cEntry.type);
        const cName = cEntry.name || (cRow?.[1] ?? cEntry.type) || "条目";
        return React.createElement("div", { className: "sc-confirm-backdrop" },
          React.createElement("div", {
            role: "alertdialog", "aria-modal": "true", "aria-labelledby": "sc-confirm-title", "aria-describedby": "sc-confirm-desc",
            className: "sc-dialog sc-confirm", tabIndex: -1, ref: confirmDialogRef, onKeyDown: onConfirmKeyDown,
          },
            React.createElement("h2", { id: "sc-confirm-title", className: "sc-confirm-title" }, `删除 ${cName}?`),
            React.createElement("p", { id: "sc-confirm-desc", className: "sc-confirm-desc" }, `删除 ${cName} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。`),
            React.createElement("button", { className: "sc-confirm-close", type: "button", "aria-label": "关闭", onClick: closeConfirm }, "×"),
            React.createElement("div", { className: "sc-confirm-actions" },
              React.createElement("button", { className: "sc-button sc-button-secondary", type: "button", disabled: locked, onClick: closeConfirm }, "取消"),
              React.createElement("button", {
                className: "sc-button-danger sc-delete-confirm", type: "button", "data-role": "confirm-remove", "data-entry-id": model.confirmId,
                disabled: locked, onClick: () => confirmRemoveClick(model.confirmId),
              }, `删除 ${cName}`),
            ),
          ),
        );
      })() : null;
      // V4-2：模态焦点与键盘后备——打开时焦点入弹窗容器（真实 Tab 首轮即落在框内控件）；
      // Escape 走 document 级后备（覆盖焦点不在框内的场景）；关闭后焦点回归触发移除钮。
      React.useEffect(() => {
        if (!model.confirmId) return undefined;
        const el = confirmDialogRef.current;
        if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
        return undefined;
      }, [model.confirmId]);
      React.useEffect(() => {
        if (!model.confirmId) return undefined;
        const onDocKey = (ev) => {
          if (ev.key === "Escape") { ev.stopPropagation?.(); setModel((m) => (m.confirmId ? { ...m, confirmId: null } : m)); }
        };
        document.addEventListener("keydown", onDocKey);
        return () => document.removeEventListener("keydown", onDocKey);
      }, [model.confirmId]);
      React.useEffect(() => {
        if (model.confirmId) return undefined;
        const t = removeTriggerRef.current;
        removeTriggerRef.current = null;
        if (t && typeof t.focus === "function") Promise.resolve().then(() => { if (typeof document !== "undefined" && document.contains(t)) t.focus(); });
        return undefined;
      }, [model.confirmId]);
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
            "aria-invalid": timeoutInvalid || undefined, // 二轮修复（B-017）：非法值输入框自证（与节级 alert 并行）
            value: model.draft.timeoutText,
            onChange: (ev) => {
              if (lockRef.current) return;
              setModel((m) => ({ ...m, sectionError: null, draft: { ...m.draft, timeoutText: ev.target.value } }));
              syncGlobalCache(model, ev.target.value); // SET-008：超时草稿入缓存
            },
            onBlur: timeoutCommit,
            onKeyDown: (ev) => { if (ev.key === "Enter") { ev.preventDefault?.(); timeoutCommit(ev); } }, // 二轮修复：回车提交同样取实时 DOM 值
          }),
          React.createElement("p", { className: "sc-official-hint" }, "单次搜索的共享总预算；按剩余时间与剩余启用工具数均分给各次尝试，单条超时或失败后在剩余总预算内回退到下一个工具。"),
        ),
        // v3 用户反馈（V3-1 无占位行）：空状态判据=已持久条目视图（有效列表）——新建编辑器开启期间
        // 草稿含幽灵行，但持久视图仍空 → 空状态与新建编辑器同屏呈现（列表恒等于持久视图）。
        effectiveEntriesOf(model).length === 0 ? React.createElement("p", { "data-role": "empty-state", style: secondaryTextStyle }, "还没有配置搜索工具，点击下方「添加搜索工具」添加第一条。") : null,
        cardNodes.length ? React.createElement("div", { className: "sc-card-list" }, ...cardNodes) : null,
        // V5-2：添加入口原位成表单——新增表单（幽灵编辑器）渲染于入口原位，替换入口本身；
        // V5-3：表单打开期间添加按钮不渲染（互斥），关闭后恢复。持久条目编辑器仍在归属卡片内（cardNodes），零重复。
        React.createElement("div", { className: "sc-add-block" },
          editorIsCreate
            ? editor
            : React.createElement("div", { className: "sc-add-actions" },
                React.createElement("button", {
                  className: "sc-add-button", type: "button", "data-role": "add-tool", disabled: locked,
                  ref: (el) => { addButtonRef.current = el; },
                  onClick: (ev) => { if (!locked) addEntry(ev.currentTarget ?? null); },
                }, "＋ 添加搜索工具"),
              ),
        ),
        confirm,
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
