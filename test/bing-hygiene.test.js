// bing.md 验收所用样本的卫生检查（docs/specs/draft/bing.md；卫生规则见 test/fixtures/README.md 规则 1–6）。全红：先经 loadBingBackend 门控，等待 WP4。
// 覆盖：复用的 Bing fixture 均已在 FIXTURE_NAMES 登记且可加载（规则 6）；
//       复用 fixture 与内联补充样本的 URL 主机只允许 .invalid / .test（规则 1）；
//       无带认证信息的 URL 与未标注合成的 sk- 形状串（规则 2、4）。
// 说明：fixtures-hygiene.test.js 是既有 WP0 卫生测试，本文件只补充 Bing 样本，不改动既有测试。
import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NAMES, loadFixture } from "./helpers/fixtures.js";
import { INLINE, loadBingBackend, MARKED_BLOCK_PAGE } from "./helpers/bing-oracle.js";

const CLAUSE = "BING 样本卫生";
const BING_FIXTURE_KEYS = ["bingResults", "bingEmpty", "bingNotRss", "bingMalformed"];

function hostsIn(text) {
  return [...text.matchAll(/https?:\/\/([^/"'\s<&?]+)/g)].map((m) => m[1]);
}

test("卫生：复用的 Bing fixture 均已在 FIXTURE_NAMES 登记且非空（fixtures 规则 6）", async (t) => {
  await loadBingBackend(t, CLAUSE);
  for (const key of BING_FIXTURE_KEYS) {
    assert.equal(typeof FIXTURE_NAMES[key], "string", `FIXTURE_NAMES.${key} 必须已登记（卫生规则 6）`);
    assert.ok(loadFixture(FIXTURE_NAMES[key]).length > 0, `${FIXTURE_NAMES[key]} 必须非空`);
  }
});

test("卫生：复用的 Bing fixture 中所有 URL 主机只保留 .invalid 或 .test（规则 1）", async (t) => {
  await loadBingBackend(t, CLAUSE);
  for (const key of BING_FIXTURE_KEYS) {
    const text = loadFixture(FIXTURE_NAMES[key]);
    for (const host of hostsIn(text)) {
      assert.ok(/\.(invalid|test)$/.test(host), `${FIXTURE_NAMES[key]} 含非保留主机 ${host}（规则 1）`);
    }
  }
});

test("卫生：内联补充样本的 URL 主机只保留 .invalid 或 .test，且不含 user:pass@ 认证信息（规则 1、2）", async (t) => {
  await loadBingBackend(t, CLAUSE);
  const samples = { ...INLINE, markedBlockPage: MARKED_BLOCK_PAGE };
  for (const [name, text] of Object.entries(samples)) {
    if (typeof text !== "string") continue;
    for (const host of hostsIn(text)) {
      assert.ok(/\.(invalid|test)$/.test(host), `内联样本 ${name} 含非保留主机 ${host}（规则 1）`);
    }
    assert.doesNotMatch(text, /https?:\/\/[^/\s"']*:[^/\s"'@]*@/, `内联样本 ${name} 不得含 user:pass@ 认证信息（规则 2）`);
  }
});

test("卫生：内联样本与复用样本中的 sk- 形状串必须带 synthetic 标记（规则 4）", async (t) => {
  await loadBingBackend(t, CLAUSE);
  const texts = [
    ...BING_FIXTURE_KEYS.map((k) => loadFixture(FIXTURE_NAMES[k])),
    ...Object.values(INLINE).filter((v) => typeof v === "string"),
    MARKED_BLOCK_PAGE,
  ];
  for (const text of texts) {
    for (const m of text.matchAll(/sk-[A-Za-z0-9_-]+/g)) {
      assert.ok(m[0].includes("synthetic"), `sk- 形状串须含 synthetic 标记（规则 4）：${m[0]}`);
    }
  }
});
