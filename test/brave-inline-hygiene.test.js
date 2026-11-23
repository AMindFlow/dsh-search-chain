// WP10 Brave 内联样本卫生检查（全绿，自检 oracle 自身样本，不是实现验收）。
// 规则来源：test/fixtures/README.md 卫生规则 1..4。Brave 样本内联在 test/helpers/brave-oracle.js，
// 不进入 test/fixtures/，因此 fixtures-hygiene.test.js 不检查它们——本文件补上同等检查。
import test from "node:test";
import assert from "node:assert/strict";
import { inlineSamples, BRAVE_KEY } from "./helpers/brave-oracle.js";
import { listFixtures } from "./helpers/fixtures.js";

const RESERVED_SUFFIXES = [".invalid", ".test", ".example"];
const URL_RE = /\bhttps?:\/\/[^\s"'<>()\]]+/g;
const SK_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g;
const PLAINTEXT_KEY_FIELDS = /^(api_?key|apikey|access_?token|auth_?token|token|secret|password|key)$/i;

function walk(node, visit, where = "$") {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, visit, `${where}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    visit(k, v, `${where}.${k}`);
    walk(v, visit, `${where}.${k}`);
  }
}

function textOf(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

test("卫生（内联）规则 1：样本中的 URL host 只允许保留 TLD 或 localhost", () => {
  for (const [name, value] of Object.entries(inlineSamples())) {
    for (const raw of textOf(value).match(URL_RE) ?? []) {
      const bare = new URL(raw.replace(/&amp;.*$/, "")).hostname.replace(/^\[|\]$/g, "");
      const ok = RESERVED_SUFFIXES.some((s) => bare.endsWith(s)) || bare === "localhost";
      assert.ok(ok, `${name}: URL host 必须保留 TLD/localhost（卫生规则 1）：${bare}`);
    }
  }
});

test("卫生（内联）规则 2：样本中不出现带认证信息的 URL（user:pass@host）", () => {
  for (const [name, value] of Object.entries(inlineSamples())) {
    assert.ok(!/\bhttps?:\/\/[^\s/]*@/.test(textOf(value)), `${name}: 出现 user:pass@ 形态 URL（卫生规则 2）`);
  }
});

test("卫生（内联）规则 4：sk- 形状字符串必须带 synthetic 可辨识标记", () => {
  assert.match(BRAVE_KEY, /synthetic/i, "BRAVE_KEY 须为可辨识合成值");
  for (const [name, value] of Object.entries(inlineSamples())) {
    for (const m of textOf(value).match(SK_RE) ?? []) {
      assert.match(m, /synthetic/i, `${name}: key 形状字符串 ${m} 不是可辨识合成值（卫生规则 4）`);
    }
  }
});

test("卫生（内联）规则 3：样本对象不含明文凭据字段", () => {
  for (const [name, value] of Object.entries(inlineSamples())) {
    if (typeof value !== "object" || value === null) continue;
    walk(value, (k, v, where) => {
      if (PLAINTEXT_KEY_FIELDS.test(k) && typeof v === "string" && v.length > 0) {
        assert.fail(`${name}: ${where} 出现明文凭据字段「${k}」（卫生规则 3）`);
      }
    });
  }
});

test("卫生（内联）：未新增 brave 专属 fixture 文件（内联策略约束，见 brave-oracle.js 头注释）", () => {
  const brave = listFixtures().filter((f) => /brave/i.test(f));
  assert.deepEqual(brave, [], "Brave 样本应内联于 helpers/brave-oracle.js，不得新增 test/fixtures/brave* 文件");
});
