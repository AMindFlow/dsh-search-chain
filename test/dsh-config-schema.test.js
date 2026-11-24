// WP0 验收 — 宿主 Standard Schema 挂载面（实机首挂缺陷钉死）。
// 背景（wp0-verify profile 实机坐实，既有测试面从未覆盖）：cordis resolveConfig 不消费裸
// JSON Schema，它直接调用 Config 上的 Standard Schema 端口。asar 实证原文：
//   const result = runtime.Config["~standard"].validate(config);
//   if ("then" in result) throw new Error(async);        // 异步结果直接拒绝
//   if (result.issues) throw new ValidationError(...);   // issues 非空 = 装载失败
// 我们曾导出裸 JSON Schema 对象（无 ["~standard"]）→ TypeError → 激活失败。dev 侧以手写字面
// Standard Schema（{"~standard": {version: 1, vendor, validate}}）修复；本文件钉死该最小面。
// 语义分界（勿在此扩面）：schema 面只钉【浅层类型】——根形状（对象）、字段类型（string/boolean/
// integer）、未知键拒绝；深规则（timeoutMs 正整数预算语义、entry 结构与凭据引用、跨字段约束）
// 归 normalizeConfig，由 config-contract.test.js（CFG-002/003/FB-003）钉，不在此重复也不在此放宽。
// 契约：helpers/contract.js A1（Config 面）。实现方不得弱化断言。
import test from "node:test";
import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP0 src/index.js Config";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "装载面/CFG-001")) return null;
  return res.module;
}

/** 复刻 cordis resolveConfig 调用面（asar 实证原文，见文件头）；返回 validate 结果供断言。 */
function hostResolveConfigValidate(Config, input) {
  const result = Config["~standard"].validate(input);
  // 原文第一道闸：`if ("then" in result) throw` —— 替身化为同步性断言。
  assert.ok(!("then" in result), "validate 必须同步返回（宿主对带 then 的结果直接抛错）");
  return result;
}

/** 原文第二道闸：result.issues 真值 = 装载失败（undefined/null 视为通过）。 */
const hostAccepts = (result) => !result.issues;

test("装载面：Config[\"~standard\"] 字面 Standard Schema 存在（version=1，vendor 非空，validate 函数）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const std = mod.Config && mod.Config["~standard"];
  assert.ok(std && typeof std === "object",
    "Config 必须携带 [\"~standard\"] 端口对象——裸 JSON Schema 无此端口，宿主 resolveConfig 取 validate 即 TypeError（实机首挂缺陷，PR#14）");
  assert.equal(std.version, 1, "Standard Schema version 固定 1");
  assert.equal(typeof std.vendor, "string");
  assert.ok(std.vendor.length > 0, "vendor 为非空字符串（Standard Schema v1 规范：vendor: string，声明校验器来源）");
  assert.equal(typeof std.validate, "function", "validate 必须是函数");
});

test("CFG-001 schema 面：合法配置 → 无 issues，result.value 原样返回且输入不被改动", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const VALID = [
    {}, // 全缺省装载合法（缺省语义由 normalizeConfig/分层补齐，schema 面不注入默认值）
    { entries: [], useOfficialDeepSeekSearch: false, timeoutMs: 1 },
  ];
  for (const input of VALID) {
    const before = structuredClone(input);
    const result = hostResolveConfigValidate(mod.Config, input);
    assert.ok(hostAccepts(result),
      `合法配置必须通过 schema（got issues: ${JSON.stringify(result.issues)}）：${JSON.stringify(input)}`);
    assert.ok("value" in result, "成功结果必须携带 value（Standard Schema：{value}）");
    assert.deepEqual(result.value, before, "value 原样返回输入（默认值注入归 normalizeConfig，不在 schema 面）");
    assert.deepEqual(input, before, "validate 不得改动调用方输入对象");
  }
});

test("CFG-001 schema 面：非法配置 → issues 非空且每条含字符串 message（浅层类型面）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const INVALID = [
    { timeoutMs: "12" }, // 类型违例：字符串数字（正整数语义深浅均拒：此处钉类型）
    { useOfficialDeepSeekSearch: "yes" }, // 类型违例：非布尔
    { unknownKey: 1 }, // 未知键（additionalProperties:false 的 schema 面等价物）
    [], // 根形状违例：数组根
    null, // 根形状违例：null 根
  ];
  for (const input of INVALID) {
    const result = hostResolveConfigValidate(mod.Config, input);
    assert.ok(!hostAccepts(result),
      `非法配置必须出 issues（宿主据此抛 ValidationError）：${JSON.stringify(input)}`);
    assert.ok(Array.isArray(result.issues) && result.issues.length > 0,
      `issues 必须为非空数组：${JSON.stringify(input)}`);
    for (const issue of result.issues) {
      assert.equal(typeof issue.message, "string");
      assert.ok(issue.message.length > 0, `每条 issue 携带非空 message（可操作报错）：${JSON.stringify(input)}`);
      if ("path" in issue && issue.path !== undefined) {
        assert.ok(Array.isArray(issue.path), `path 若存在须为数组：${JSON.stringify(input)}`);
      }
    }
  }
  // 分界注释：timeoutMs:0 / 负预算等【值域】规则此处刻意不钉——FB-003 深浅判定归 normalizeConfig
  // （config-contract.test.js 已钉 CONFIG_INVALID），schema 面允许实现取严不取松。
});
