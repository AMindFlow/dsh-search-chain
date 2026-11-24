// WP6 装配面 — 任务 7：官方分支零自定义资源（含非法条目隔离，对齐 main P1-1 语义）。
// 规格依据：
//   DSH-005（dsh-integration.md）：该分支（官方路由 + 开关开）的请求不消耗自定义条目或其凭据，
//     空自定义链不影响该分支；官方结果/错误直接返回。
//   P1-1（main 终审轮定案，dsh-official-routing.test.js 探针实证）：深校验（normalizeConfig）只属
//     链路径；官方路由 + 开关开必须照走官方，非法自定义条目（bogus type / 非法 proxy）在场时
//     零 CONFIG_INVALID、零链执行。
//   CFG-002：只为实际尝试的条目解析 key——官方分支不尝试任何自定义条目 → 凭据服务零调用。
// 黑盒面：真实 apply + hostShape 替身 + testDeps 注入链/官方桩；凭据消费经 host.credentials spy 计数。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hostApply } from "./helpers/assembly-harness.js";

const WP = "WP6 src/index.js";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-005 官方分支隔离")) return null;
  return res.module;
}

/** P1-1 同一非法 fixture：bogus 类型 + 非法 proxy（链路径深校验必拦，官方分支必须隔离）。 */
const BAD = C.makeSavedConfig(
  [
    C.makeEntry({ id: "e-bogus", type: "bogus-type", name: "非法类型条目" }),
    C.makeEntry({ id: "e-badproxy", type: "tavily", proxy: "not a url", name: "非法代理条目" }),
  ],
  { useOfficialDeepSeekSearch: true },
);

function stubOfficial() {
  const calls = [];
  return {
    calls,
    async search(request, signal) {
      calls.push({ request, signal });
      return { sources: C.makeSources(1), truncated: false, content: "official 产出" };
    },
  };
}

function stubChain() {
  const calls = [];
  return {
    calls,
    async search(request, signal) {
      calls.push({ request, signal });
      return { sources: C.makeSources(1), truncated: false };
    },
    release() {},
  };
}

test("DSH-005（装配面）：官方分支零自定义资源——零条目执行、零凭据读取、零出站（非法条目在场亦然）", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  const chain = stubChain();
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, structuredClone(BAD), { chain, official });
  const creds = host.credentials; // fake-credentials spy：resolveCalls/recordCalls

  const out = await provider.search({ query: "合成查询", maxResults: 3, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.deepEqual(out.content, "official 产出", "官方结果直接返回（DSH-005）");
  assert.equal(official.calls.length, 1, "官方分支命中官方 provider");
  assert.equal(chain.calls.length, 0, "官方分支零自定义条目执行（即使条目非法也不得碰链，P1-1）");
  assert.equal(creds.resolveCalls.length, 0, "零自定义凭据引用读取（DSH-005：不消耗自定义条目凭据）");
  assert.equal(creds.recordCalls.length, 0, "零 DSH 托管凭据记录读取（DSH-005）");
  assert.equal(host.traps.webFetch, 0, "官方分支零宿主 fetch 出站");
  await host.disposeAll();
});

test("P1-1（装配面）：深校验只拦链——同一非法 fixture 在链路由下止步 CONFIG_INVALID，零条目执行、零凭据读取", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  const chain = stubChain();
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, structuredClone(BAD), { chain, official });
  const creds = host.credentials;

  let err;
  try {
    await provider.search({ query: "合成查询", llmProvider: "custom-model-route" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "链路由 + 非法条目必须显式失败，不得静默降级");
  assert.equal(
    err.code,
    C.CONFIG_CODES.INVALID,
    "链路径深校验终态 = CONFIG_INVALID（P1-1：深校验只属链路径），实测=" + String(err?.code),
  );
  assert.equal(chain.calls.length, 0, "CONFIG_INVALID 拦在条目执行之前（零外发）");
  assert.equal(creds.resolveCalls.length, 0, "非法配置止步前零凭据读取（CFG-002 只解析实际尝试条目）");
  assert.equal(creds.recordCalls.length, 0, "非法配置止步前零托管记录读取");
  assert.equal(official.calls.length, 0, "链路由不碰官方（DSH-005）");
  await host.disposeAll();
});

test("DSH-005（装配面）：官方分支对自定义链配置不敏感——空链与非法链同走官方（配置隔离）", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  for (const [label, cfg] of [
    ["空自定义链", C.makeSavedConfig([], { useOfficialDeepSeekSearch: true })],
    ["非法自定义链", structuredClone(BAD)],
  ]) {
    const chain = stubChain();
    const official = stubOfficial();
    const { host, provider } = hostApply(mod, cfg, { chain, official });
    let err;
    try {
      await provider.search({ query: "合成查询", llmProvider: C.OFFICIAL_ROUTE_ID });
    } catch (e) {
      err = e;
    }
    assert.equal(err, undefined, `${label}：官方查询不得被自定义链配置影响（DSH-005）`);
    assert.equal(official.calls.length, 1, `${label}：官方分支照常命中`);
    assert.equal(chain.calls.length, 0, `${label}：链零执行`);
    await host.disposeAll();
  }
});
