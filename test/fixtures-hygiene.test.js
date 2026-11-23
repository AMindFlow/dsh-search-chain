// fixture 卫生检查（全绿；对 test/fixtures/ 全部内容生效）。
// 规则来源：test/fixtures/README.md。任何提交进 fixture 的真实域名、带认证信息 URL、
// 真实 key 形状、明文 key 字段、未登记 fixture 都会让本文件变红——这是入库门槛。
// 覆盖：AGENTS.md 凭据边界（无带认证信息代理/真实 key）、fixtures 组织规则 1..6。
import test from "node:test";
import assert from "node:assert/strict";
import { loadFixture, listFixtures, FIXTURE_NAMES } from "./helpers/fixtures.js";

const RESERVED_SUFFIXES = [".invalid", ".test", ".example"];
const URL_RE = /\bhttps?:\/\/[^\s"'<>()\]]+/g;
const SK_RE = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g;
const PLAINTEXT_KEY_FIELDS = /^(api_?key|apikey|access_?token|auth_?token|token|secret|password)$/i;

function hostAllowed(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return RESERVED_SUFFIXES.some((s) => bare.endsWith(s)) || bare === "localhost";
}

function walkJson(node, visit, where = "$") {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkJson(v, visit, `${where}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    visit(k, v, `${where}.${k}`);
    walkJson(v, visit, `${where}.${k}`);
  }
}

function textOf(rel) {
  return rel.endsWith(".json") ? JSON.stringify(loadFixture(rel)) : loadFixture(rel);
}

test("卫生规则 1/2：全部 fixture 的 URL 仅指向保留域，绝无认证信息", () => {
  for (const rel of listFixtures()) {
    const text = textOf(rel);
    for (const raw of text.match(URL_RE) ?? []) {
      const url = raw.replace(/&amp;.*$/, "");
      let u;
      try {
        u = new URL(url);
      } catch {
        assert.fail(`${rel}: 无法解析 URL：${raw}`);
      }
      assert.ok(hostAllowed(u.hostname), `${rel}: URL host 必须保留 TLD/localhost（卫生规则 1）：${u.hostname}`);
      assert.equal(u.username + u.password, "", `${rel}: 禁止带认证信息的 URL（卫生规则 2）：${raw}`);
    }
    assert.ok(!/\bhttps?:\/\/[^\s/]*@/.test(text), `${rel}: 出现 user:pass@ 形态 URL`);
  }
});

test("卫生规则 4：sk- 形状字符串必须带 synthetic 可辨识标记", () => {
  for (const rel of listFixtures()) {
    for (const m of textOf(rel).match(SK_RE) ?? []) {
      assert.match(m, /synthetic/i, `${rel}: key 形状字符串 ${m} 不是可辨识合成值`);
    }
  }
});

test("卫生规则 3：fixture 条目只带 credentialRef，绝不带明文 key 字段", () => {
  for (const rel of listFixtures()) {
    if (!rel.endsWith(".json")) continue;
    walkJson(loadFixture(rel), (k, v, where) => {
      if (PLAINTEXT_KEY_FIELDS.test(k) && typeof v === "string" && v.length > 0) {
        assert.fail(`${rel}: ${where} 出现明文凭据字段「${k}」（卫生规则 3）`);
      }
    });
  }
});

test("卫生规则 6：fixture 文件与 FIXTURE_NAMES/upstream 引用完全对应", () => {
  const registered = new Set(Object.values(FIXTURE_NAMES));
  for (const rel of Object.values(FIXTURE_NAMES)) {
    if (!rel.endsWith(".json")) continue;
    walkJson(loadFixture(rel), (k, v) => {
      if (k === "fixture" && typeof v === "string") registered.add(v);
    });
  }
  const present = new Set(listFixtures());
  for (const rel of registered) assert.ok(present.has(rel), `FIXTURE_NAMES/引用指向不存在的文件：${rel}`);
  for (const rel of present) assert.ok(registered.has(rel), `fixture 未登记（卫生规则 6）：${rel}`);
});
