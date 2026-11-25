// Issue #43 — 宿主 settings-form 契约（Config 必须是真实 @deepseek-ai/schemastery@3.19.x 节点）。
//
// 缺陷（#43 隔离 Host 实证）：手写 Config（src/index.js）无 `meta`。宿主 SettingsForms.schema(entry)
// 经 'toJSON' in schema 即放行，describe() 随后在 runtime.Config 原对象上直调 volatileForm(schema)，
// volatileForm 第一行 `schema.meta.volatile` 对 undefined 取属性 → TypeError →
// settings.describe RPC → gateway/internal → Desktop 主窗口打不开。
//
// 宿主读取位实证（0.2.2-rc.5 同版本 app.asar 本会话实测原文，schema.js）：
//   function volatileForm(schema) {
//     if (schema.meta.volatile) return plainSchema(schema);        // ← 读取位①：raw runtime.Config.meta.volatile
//     if (schema.type === "object") {
//       const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
//         const field = volatileForm(child);                        // ← 读取位②：dict[child].meta.volatile
//         ...
//   schema(entry) { const s = entry.fiber?.runtime?.Config; return s !== void 0 && "toJSON" in s ? s : void 0 }
//   describe(): revision raw = JSON.stringify([entry.fiber.uid, schema.toJSON(), entry.options.config ?? {}]);
//               命名空间可见性 = volatileForm(schema) !== undefined（无任何 volatile 字段 ⇒ describe 丢弃该行 ⇒
//               search-chain namespace 从设置面消失）。
//   plainSchema = new z(schema.toJSON()) 后逐节点 walk：delete node.meta.volatile，读 node.meta.role/default
//               与 dict/inner/list —— 序列化 refs 图中每个可达 schema 节点都必须携带 meta 对象。
// schemastery@3.19.0 源码实证（.pnpm store，本会话同版本）：
//   src/index.ts:117/141  Meta.volatile?: boolean；每个 Schema 必有 meta: Schemastery.Meta；
//   src/index.ts:480-482  volatile() ⇒ meta.volatile = true（extra('volatile', true)，plain 可写属性）；
//   src/index.ts:290-307  ~standard getter：vendor 'schemastery'，validate 同步返回 {value} | {issues:[{message,path}]}；
//   src/index.ts:311-323  toJSON() = { uid, refs }——深序列化含每节点 meta（宿主 new z() 重建面）；
//   src/index.ts:808-822  object resolver：非 strict `merge(result, data)`——未知键接受且透传（z.object 与
//                         手写「原样返回含未知键」一致面；拒绝未知键 = 「保存永败」死锁，P2-2 定案不变）；
//   src/index.ts:488-496  validateVolatileSchema：volatile 父之下不得再嵌 volatile（fixed object path 约束）；
//   src/index.ts:521-530  volatile 字段 parse 输出 createVolatile(value) 包裹——宿主 plainConfig 以
//                         isVolatile(value) ⇒ value.get() 解包（每查询现读的 in-place 载体，configuration.md）。
//
// 本文件为 oracle（红先）：预期红 = meta/宿主读取位面（A 组，现手写无 meta）+ 依赖与副本声明面（C 组，
// package.json 未声明 schemastery、包内不可 resolve）；B 组行为保持集迁移自既有 index.js Config 测试
// （dsh-config-schema.test.js P2-2 定案等），语义集不缩水，现实现必须绿。
//
// 已知缺口（#43 后续 issue，本 PR 不修——审阅轮定级，仅注记不改断言）：
//   ① 嵌套 null：entries 子字段等嵌套层的 null 写闸语义未定（本 PR 仅钉根层 null 拒绝，B2）；
//   ② entries[].apiKey 明文写闸：schema 面不拦明文 key（凭据边界另议，现仅 normalizeConfig 读路径剥离）；
//   ③ 重复 id 写闸：schema 层 refine 未落，现由 normalizeConfig 读闸兜底（B4 钉的是全链拒绝行为）。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { CONFIG_CODES, TOOL_TYPES } from "../src/constants.js";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP0 src/index.js Config";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "#43 宿主 settings-form 契约")) return null;
  return res.module;
}

/** 宿主 volatileForm 逐行复刻（app.asar schema.js 实证；plainSchema/z.object 叶子以标记替代）。 */
function volatileFormShadow(schema) {
  if (schema.meta.volatile) return { __form: "plain" }; // 宿主：return plainSchema(schema)
  if (schema.type === "object") {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileFormShadow(child);
        return field === undefined ? [] : [[key, field]];
      }),
    );
    return Object.keys(dict).length === 0 ? undefined : { __form: "object", dict }; // 宿主：z.object(dict)
  }
  return undefined;
}

/** 宿主 plainConfig 复刻（Volatile ⇒ get() 解包，其余深拷贝语义等价）。 */
function plainValue(v) {
  if (v !== null && typeof v === "object" && typeof v.get === "function") return plainValue(v.get());
  if (Array.isArray(v)) return v.map(plainValue);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, plainValue(c)]));
  }
  return v;
}

/** 宿主 resolveConfig 第一、二道闸复刻（同步性 + issues 判定）；返回 validate 结果。 */
function hostValidate(Config, input) {
  const result = Config["~standard"].validate(input);
  assert.ok(result && !("then" in result), "validate 必须同步返回非 thenable（宿主 resolveConfig 对 then 直接抛）");
  return result;
}

/** schema issues → CONFIG_* 报错可组装性：`码: path: message` 文本（宿主 ValidationError 等价消费面）。 */
function issuesToConfigText(issues) {
  return `${CONFIG_CODES.INVALID}: ` + issues.map((i) => `${(i.path ?? ["<root>"]).join(".")}: ${i.message}`).join("; ");
}

/** 装配全链（宿主写闸 ∪ 自家读路径）：schema 有 issues 即拒；否则 normalizeConfig(raw) 必须也认。 */
function pipelineRejectReason(Config, normalizeConfig, input) {
  const r = hostValidate(Config, input);
  if (r.issues) {
    assert.ok(Array.isArray(r.issues) && r.issues.length > 0);
    for (const i of r.issues) {
      assert.equal(typeof i.message, "string");
      assert.ok(i.message.length > 0, `issue 携带非空 message：${JSON.stringify(input)}`);
      if (i.path !== undefined) assert.ok(Array.isArray(i.path), `issue.path 须为数组：${JSON.stringify(input)}`);
    }
    return { layer: "schema", text: issuesToConfigText(r.issues) };
  }
  try {
    normalizeConfig(structuredClone(input));
  } catch (e) {
    assert.ok(
      Object.values(CONFIG_CODES).includes(e?.code),
      `读路径拒绝必须携带 CONFIG_CODES 码，实际：${JSON.stringify(e?.code)}`,
    );
    return { layer: "normalize", text: `${e.code}: ${e.message}` };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────
// A. 宿主读取位面（issue #43 崩溃面；现手写 Config 无 meta ⇒ 预期红）
// ─────────────────────────────────────────────────────────────────────────────────

test("#43-A1 volatileForm 复刻直读 Config：不崩、form 定义、可编辑字段全部在场（describe 命名空间可见性）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // SettingsForms.schema(entry) 放行条件（'toJSON' in schema）——现实现已满足，行为保持。
  assert.ok("toJSON" in mod.Config, "SettingsForms.schema 以 'toJSON' in schema 放行——缺 toJSON 则命名空间静默消失");
  let form;
  try {
    form = volatileFormShadow(mod.Config);
  } catch (e) {
    assert.fail(
      `#43 崩溃面复刻：volatileForm 在 runtime.Config 上直读 schema.meta.volatile——` +
        `meta 缺失即 TypeError → settings.describe gateway/internal：${e && e.message}`,
    );
  }
  assert.ok(form, "无任何 volatile 字段 ⇒ volatileForm=undefined ⇒ describe() 丢弃 search-chain 行（设置面命名空间消失）");
  assert.equal(form.__form, "object", "根不得整体 volatile（官方形状：字段级 volatile，行根按 dict 逐字段展开）");
  for (const key of ["entries", "timeoutMs", "useOfficialDeepSeekSearch"]) {
    assert.ok(form.dict && key in form.dict, `可编辑字段 ${key} 必须 volatile 可见（volatileForm dict 键）`);
  }
});

test("#43-A2 meta 面：根 meta 为对象且根不 volatile；dict 子节点 meta 存在且 volatile===true（可读写语义）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const Config = mod.Config;
  assert.ok(
    Config.meta !== null && typeof Config.meta === "object" && !Array.isArray(Config.meta),
    `Config.meta 必须为对象——宿主 volatileForm 第一行 schema.meta.volatile 的读取位（#43 崩溃面）。实际：${JSON.stringify(Config.meta)}`,
  );
  assert.ok(!Config.meta.volatile, "根 meta.volatile 必须 falsy：行根整体 volatile 会把整行折叠为单一表单字段（官方形状为字段级）");
  assert.ok(
    Config.dict !== null && typeof Config.dict === "object",
    `Config.dict 必须为对象——volatileForm 对象分支 Object.entries(schema.dict ?? {}) 的读取位；实际：${JSON.stringify(Config.dict)}`,
  );
  for (const key of ["entries", "timeoutMs", "useOfficialDeepSeekSearch"]) {
    const child = Config.dict[key];
    assert.ok(child, `dict 必须含可编辑字段 ${key}`);
    assert.ok(
      child.meta !== null && typeof child.meta === "object",
      `dict.${key}.meta 必须为对象——volatileForm 递归 child.meta.volatile 读取位`,
    );
    assert.equal(child.meta.volatile, true, `dict.${key}.meta.volatile 必须严格为 true（.volatile() 经 extra() 置位）`);
    const d = Object.getOwnPropertyDescriptor(child.meta, "volatile");
    assert.ok(
      d && d.writable === true && d.configurable === true,
      `dict.${key}.meta.volatile 必须是可写可删的 plain 属性（宿主 plainSchema walk delete node.meta.volatile 的读写语义）`,
    );
  }
});

test("#43-A3 序列化面：toJSON=refs 深序列化、逐节点 meta 在场、可编辑字段 meta.volatile 于宿主重建位可见", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // describe() 逐行 revision raw：JSON.stringify([uid, schema.toJSON(), config]) 不得抛（可序列化性）。
  let raw;
  try {
    raw = JSON.stringify([7, mod.Config.toJSON(), { entries: [] }]);
  } catch (e) {
    assert.fail(`describe revision raw 序列化失败（循环/不可序列化成员？宿主逐行 JSON.stringify）：${e && e.message}`);
  }
  assert.ok(typeof raw === "string" && raw.length > 0);

  const proj = JSON.parse(JSON.stringify(mod.Config.toJSON()));
  // 宿主读取位=schemastery refs 序列化：plainSchema 以 new z(schema.toJSON()) 重建后 walk
  // delete node.meta.volatile 并读 meta.role/default/dict/inner/list（app.asar 实证）。
  assert.ok(
    proj !== null && typeof proj === "object" && "uid" in proj && "refs" in proj && typeof proj.refs === "object",
    `toJSON() 必须为 schemastery refs 序列化（{uid, refs}，宿主 new z(toJSON()) 重建面）；` +
      `JSON Schema 字面投影宿主不消费（schemastery toJSON src/index.ts:311-323）。实际顶层键：` +
      `${JSON.stringify(Object.keys(proj ?? {}))}`,
  );
  const refs = proj.refs;
  const root = refs[proj.uid];
  assert.ok(root && typeof root === "object", `refs[${proj.uid}] 根节点缺失`);
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    const target = typeof node === "number" ? refs[node] : node;
    if (target === undefined || seen.has(target)) continue;
    seen.add(target);
    assert.ok(
      target.meta !== null && typeof target.meta === "object",
      `序列化节点（type=${JSON.stringify(target.type)}）必须携带 meta 对象——plainSchema walk 对每个重建节点 delete node.meta.volatile，缺 meta 即崩`,
    );
    for (const child of Object.values(target.dict ?? {})) queue.push(child);
    if (target.inner !== undefined) queue.push(target.inner);
    for (const child of target.list ?? []) queue.push(child);
  }
  for (const key of ["entries", "timeoutMs", "useOfficialDeepSeekSearch"]) {
    const childRef = root.dict?.[key];
    const child = typeof childRef === "number" ? refs[childRef] : childRef;
    assert.ok(child && child.meta?.volatile === true, `序列化 refs：dict.${key} 节点 meta.volatile 必须为 true（宿主重建面）`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────
// B. 行为保持集（迁移自既有 index.js Config 测试期望；现实现绿，迁移语义集不缩水）
// ─────────────────────────────────────────────────────────────────────────────────

test("B1 合法配置通过：无 issues；value 经宿主 plainConfig 解包后=输入原样（含未知键透传、缺省不补值、不改输入）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = (over) => C.makeEntry({ id: `e-${Math.random().toString(36).slice(2)}`, ...over });
  const VALID = [
    {}, // 全缺省装载合法；schema 面不注入默认值（默认归 normalizeConfig，FB-003/SET-005 分界不变）
    { entries: [], useOfficialDeepSeekSearch: false, timeoutMs: 1 },
    // P2-2 定案：未知键【接受】。schemastery object resolver 非 strict `merge(result, data)`
    // （src/index.ts:808-822）：未知键无 issues 且透传进 value——与手写「原样返回含未知键」一致面。
    { someOtherPluginKey: 1, timeoutMs: 5 },
    C.makeSavedConfig([
      entry({ type: "openai", credentialRef: "ref:main" }),
      entry({ type: "bing", enabled: false }),
      entry({ type: "tavily", proxy: "http://synthetic.invalid:8080" }),
      entry({ type: "deepseek-agentic-search", proxy: { pac: "http://synthetic.invalid/proxy.pac" } }),
    ]),
  ];
  for (const input of VALID) {
    const before = structuredClone(input);
    const result = hostValidate(mod.Config, input);
    assert.ok(!result.issues, `合法配置必须无 issues：${JSON.stringify(input)} got ${JSON.stringify(result.issues)}`);
    assert.ok("value" in result, "成功结果必须携带 value（Standard Schema）");
    assert.deepEqual(plainValue(result.value), before, "value 经 Volatile 解包后=输入（现实现无包裹时解包=恒等）");
    assert.deepEqual(input, before, "validate 不得改动调用方输入对象");
  }
});

test("B2 形状错误拒绝：issues 非空、message/path 结构完整、可组装 CONFIG_* 报错文本", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const INVALID = [
    { timeoutMs: "12" },
    { useOfficialDeepSeekSearch: "yes" },
    { entries: "not-a-list" },
    [],   // 根形状违例：数组根
    null, // 根形状违例：null 根（新契约要求根 required——既有 dsh-config-schema 钉过，空义集不得缩水）
  ];
  for (const input of INVALID) {
    const result = hostValidate(mod.Config, input);
    assert.ok(result.issues, `形状错误必须出 issues（宿主据此抛 ValidationError）：${JSON.stringify(input)}`);
    const text = issuesToConfigText(result.issues);
    assert.ok(text.includes(CONFIG_CODES.INVALID), `报错文本必须可组装 CONFIG_CODES 码：${text}`);
    assert.ok(text.length > CONFIG_CODES.INVALID.length + 2, "issues 必须携带可操作细节");
  }
  // 字段名可定位性：timeoutMs/entries 违例的报错文本须能指认字段（path 或 message 二选一在场）。
  for (const [input, field] of [[{ timeoutMs: "12" }, "timeoutMs"], [{ entries: "x" }, "entries"]]) {
    const text = issuesToConfigText(hostValidate(mod.Config, input).issues);
    assert.ok(text.includes(field), `报错文本必须可定位字段 ${field}（CONFIG_* 组装的可操作性）：${text}`);
  }
});

test("B3 timeoutMs 正整数（schema 面值域）：0/负数/小数/字符串拒绝；1/25000 通过；NaN/Infinity 全链拒绝", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const cfg = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfg, "WP1 src/config.js", "FB-003 预算值域")) return;
  for (const bad of [0, -5, 2.5, "25000"]) {
    assert.ok(
      hostValidate(mod.Config, { timeoutMs: bad }).issues,
      `timeoutMs 正整数契约：${JSON.stringify(bad)} 必须被 schema 面拒绝`,
    );
  }
  for (const good of [1, 25000]) {
    assert.ok(!hostValidate(mod.Config, { timeoutMs: good }).issues, `timeoutMs=${good} 必须通过`);
  }
  for (const exotic of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const reason = pipelineRejectReason(mod.Config, cfg.module.normalizeConfig, { timeoutMs: exotic });
    assert.ok(reason, `NaN/Infinity 必须被全链（schema ∪ normalizeConfig）拒绝：${JSON.stringify(exotic)}`);
    assert.ok(reason.text.includes(CONFIG_CODES.INVALID));
  }
});

test("B3b timeoutMs 上界：写闸与读闸同不变量——2^53/1e20/1e300 schema 面拒绝；MAX_SAFE 内通过", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // 读闸（normalizeConfig 的 Number.isSafeInteger 语义，config-contract CFG-002 系已钉）拒绝
  // 超出 2^53-1 的值；写闸（本 schema）若不设上界，就存在「保存成功 → 每次装载读不出」的
  // 永久损坏配置——写闸必须与读闸同不变量（#43 审阅轮增量钉）。
  for (const over of [2 ** 53, 1e20, 1e300]) {
    const result = hostValidate(mod.Config, { timeoutMs: over });
    assert.ok(
      result.issues,
      `timeoutMs=${over} 超出安全整数上界，写闸必须拒绝（否则保存即读不出，配置永久损坏）`,
    );
  }
  for (const okValue of [Number.MAX_SAFE_INTEGER, 25000]) {
    assert.ok(!hostValidate(mod.Config, { timeoutMs: okValue }).issues, `timeoutMs=${okValue} 在界内必须通过`);
  }
});

test("B4 entries 每项类型/enum 与重复 id 拒绝（全链：schema 闸 ∪ normalizeConfig；报错文案含 id）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const cfg = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfg, "WP1 src/config.js", "CFG-004 深校验")) return;
  const { Config } = mod;
  const normalize = cfg.module.normalizeConfig;

  // CAT-001 八个类型全枚举合法（类型 enum 面）；合法条目全链通过。
  for (const type of TOOL_TYPES) {
    const input = C.makeSavedConfig([C.makeEntry({ id: `e-${type}`, type })]);
    assert.ok(!hostValidate(Config, input).issues, `type=${type} 必须通过 schema（CAT-001 enum）`);
    assert.equal(pipelineRejectReason(Config, normalize, input), null, `type=${type} 全链必须通过`);
  }
  // 每项形状与 enum：非对象/缺 type/未知 type 全链拒绝，报错可操作。
  for (const [label, entries] of [
    ["非对象项", [null]],
    ["缺 type", [{ id: "e1" }]],
    ["未知 type", [{ id: "e1", type: "not-a-tool" }]],
  ]) {
    const reason = pipelineRejectReason(Config, normalize, { entries });
    assert.ok(reason, `entries ${label} 必须被全链拒绝：${JSON.stringify(entries)}`);
  }
  const dupReason = pipelineRejectReason(Config, normalize, {
    entries: [
      { id: "dup-x", type: "openai" },
      { id: "dup-x", type: "tavily" },
    ],
  });
  assert.ok(dupReason, "重复 id 必须被全链拒绝（重复 id 搜索顺序与凭据解析不可判定）");
  assert.ok(
    dupReason.text.includes("dup-x"),
    `重复 id 错误文案必须含重复的 id（可操作报错；schema refine 或 normalizeConfig 任一层都得带 id）：${dupReason.text}`,
  );
  // apiKey 类子字段裁决位：条目只存引用（credentialRef，CFG-003 明文 key 不落盘）。
  // schemastery src/index.ts:488-496：volatile 父（entries）之下再嵌 volatile 会触发
  // validateVolatileSchema「fixed object path」错——本用例钉：带引用类子字段的合法条目必须平稳通过
  // schema 闸（即 apiKey 类字段不得在 volatile entries 内再标 volatile，只可 role 表达）。
  const refEntry = C.makeEntry({ id: "e-ref", type: "openai", credentialRef: "ref:store", name: "引用条目" });
  assert.ok(
    !hostValidate(Config, C.makeSavedConfig([refEntry])).issues,
    "带 credentialRef 的合法条目必须通过 schema（嵌套 volatile 违例会以 issues 出现）",
  );
});

test("B5 未知键接受面（z.object 语义与原「接受」一致）：无 issues、value 透传，写路径不死锁", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const raw = { entries: [], otherPluginKey: "keep-me", legacyVestigialKey: { nested: true } };
  const result = hostValidate(mod.Config, structuredClone(raw));
  assert.ok(!result.issues, `未知键必须被接受（严格拒绝=保存永败死锁，P2-2 定案）：${JSON.stringify(result.issues)}`);
  const value = plainValue(result.value);
  assert.equal(value.otherPluginKey, "keep-me", "未知键经 schema 面透传（schemastery object merge=手写原样返回一致面）");
  // 落盘保留/读路径剥离语义已由 config-contract.test.js P2-2 与 normalizeConfig 用例钉死，此处不重复。
});

test("B6 ~standard.validate 同步非 thenable + version=1 + 非空 vendor（宿主 resolveConfig 挂载面）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const std = mod.Config["~standard"];
  assert.ok(std && typeof std.validate === "function", "Config 必须携带 ~standard.validate");
  assert.equal(std.version, 1);
  assert.ok(typeof std.vendor === "string" && std.vendor.length > 0, "vendor 非空字符串（Standard Schema v1）");
  const result = std.validate({ entries: [] });
  assert.ok(result && !("then" in result), "validate 返回必须同步非 thenable");
});

// ─────────────────────────────────────────────────────────────────────────────────
// C. 依赖与副本钉（正面钉住「注册表 3.x vs bundle 0.2.x 不对齐、跨副本 volatile 不确定」旧疑点；
//    现 package.json 未声明、包内不可 resolve ⇒ 预期红）
// ─────────────────────────────────────────────────────────────────────────────────

test("C1 package.json dependencies 声明 @deepseek-ai/schemastery ~3.19.0（官方同值）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = pkg.dependencies?.["@deepseek-ai/schemastery"];
  assert.equal(
    declared,
    "~3.19.0",
    "必须按官方 dsh-web-search-deepseek@0.2.2-rc.5 同值声明 ~3.19.0" +
      "（其 package.json deps 实证：\"@deepseek-ai/schemastery\": \"~3.19.0\"）——" +
      "旧注释「注册表 3.x 与 bundle 0.2.x 不对齐、跨副本 volatile 不确定」以显式 pin 正面裁决；实际：" + JSON.stringify(declared),
  );
});

test("C2 运行时探针：从包内 resolve 到的 @deepseek-ai/schemastery 副本必须为 3.19.x，且 Config 是该副本的真实节点", async (t) => {
  // 等价路径探针：createRequire(src/index.js) 的解析起点与 src/index.js 内
  // `import z from '@deepseek-ai/schemastery'` 完全同路（同目录向上找 node_modules）；
  // 软链 store 环境（node_modules → 共享 pnpm root）下同样可跑——测的就是运行时装载所见。
  const req = createRequire(new URL("../src/index.js", import.meta.url));
  let pkgPath, version;
  try {
    pkgPath = req.resolve("@deepseek-ai/schemastery/package.json");
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch (e) {
    assert.fail(
      `包内无法 resolve @deepseek-ai/schemastery（${e.code ?? e.name}）：` +
        "宿主表单面依赖该副本；未随 dependencies 安装即红（依赖声明面）",
    );
  }
  assert.match(String(version), /^3\.19\.\d+$/, `resolve 到的副本必须 3.19.x（satisfies ~3.19.0），实际：${version} @ ${pkgPath}`);
  const mod = await load(t);
  if (!mod) return;
  const z = req(req.resolve("@deepseek-ai/schemastery"));
  const zDefault = z.default ?? z;
  // 跨副本钉死：Config 的原型必须 === 探针副本的 Schema.prototype——若 bundle 与宿主各持一份
  // schemastery，原型分叉即红（「跨副本 volatile 不确定」的可执行裁决）。
  assert.equal(
    Object.getPrototypeOf(mod.Config),
    Object.getPrototypeOf(zDefault.object({})),
    "Config 必须是包内 resolve 副本构造的 schemastery 节点（跨副本原型一致）",
  );
  // 宿主 plainSchema 第一步重建面：new z(schema.toJSON()) 必须可构造且根 meta/dict 在场。
  const rebuilt = new zDefault(mod.Config.toJSON());
  assert.ok(rebuilt.meta && typeof rebuilt.meta === "object", "重建根节点必须携带 meta（new z(toJSON()) 宿主面）");
  assert.ok(rebuilt.dict?.entries?.meta?.volatile === true, "重建后 dict.entries.meta.volatile 必须仍为 true");
});

// ─────────────────────────────────────────────────────────────────────────────────
// D. volatile 输出语义（chain 每查询现读的 in-place 载体；绿保持面）
// ─────────────────────────────────────────────────────────────────────────────────

test("D1 volatile 字段 parse 输出可经宿主 plainConfig 解包；get() 语义与 configuration.md in-place 现读一致", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const input = C.makeSavedConfig([C.makeEntry({ id: "e-vol", type: "tavily", credentialRef: "ref:v" })], {
    useOfficialDeepSeekSearch: false,
    timeoutMs: 9000,
  });
  const result = hostValidate(mod.Config, structuredClone(input));
  assert.ok(!result.issues, JSON.stringify(result.issues));
  // 若字段已 .volatile()：parse 输出为 createVolatile 包裹（schemastery src/index.ts:521-530），
  // 宿主 plainConfig 以 value.get() 现读（in-place 更新载体）；未包裹实现（现手写）解包=恒等，同绿。
  for (const key of ["entries", "timeoutMs", "useOfficialDeepSeekSearch"]) {
    const wrapped = result.value?.[key];
    if (wrapped !== null && typeof wrapped === "object" && typeof wrapped.get === "function") {
      assert.deepEqual(plainValue(wrapped), input[key], `volatile 包裹的 ${key} 经 get() 必须等于现值（每查询现读）`);
    } else {
      assert.deepEqual(result.value?.[key], input[key], `非 volatile 的 ${key} 透传现值`);
    }
  }
  assert.deepEqual(plainValue(result.value), input);
});
