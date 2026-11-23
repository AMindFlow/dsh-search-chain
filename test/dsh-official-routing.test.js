// WP0 验收 — DSH-005 官方 DeepSeek 委托路由 + SET-005 默认值。
// 覆盖条款：
//   DSH-005：开关开启且实际模型路由为官方路由（deepseek-official）→ 委托宿主官方 provider，
//            结果/错误直接返回（失败保持原选择，不悄悄回退自定义链）；官方分支期间零自定义
//            条目执行、零自定义凭据消费；空自定义链不影响官方分支；
//            DeepSeek 账号模式（deepseek-account）、同名自定义模型、第三方模型兼容请求 → 自定义链。
//   SET-005：useOfficialDeepSeekSearch 缺省视为开启。
// 前提实证（inspect）：官方 Messages 搜索路由 id = "deepseek-official"；账号模式 = "deepseek-account"；
// 宿主按 request.llmProvider（模型路由 id）选路。「路由 id 判定的实机精确性」列入宿主核对项。
// 契约：helpers/contract.js A1/A4。实现方（WP6）不得弱化断言。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createProviderHarness, DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP6 src/index.js";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-005/SET-005")) return null;
  return res.module;
}

const ENTRIES = [C.makeEntry({ id: "e-openai", type: "openai", name: "合成 OpenAI 线" })];
const officialOk = () => ({ sources: C.makeSources(1), truncated: false, content: "official 产出" });

function harness(mod, { config, official = "present", behavior = officialOk, routeOf } = {}) {
  return createProviderHarness(mod.createSearchProvider, {
    config: config ?? C.makeSavedConfig(ENTRIES),
    official,
    officialBehavior: behavior,
    routeOf,
  });
}

test("DSH-005：官方路由 + 开关开启 → 委托官方，结果直接返回，链零调用", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness(mod);
  const ac = new AbortController();
  const req = { query: DEFAULT_QUERY, maxResults: 3, llmProvider: C.OFFICIAL_ROUTE_ID };
  const out = await h.search(req, ac.signal);
  assert.equal(h.officialRequestCount(), 1);
  assert.deepEqual(h.officialCalls[0].request, req, "官方分支也必须原样透传请求");
  assert.equal(h.officialCalls[0].signal, ac.signal, "取消信号透传");
  assert.deepEqual(out, officialOk(), "官方结果直接返回，不二次加工（DSH-005）");
  assert.equal(h.chainRequestCount(), 0, "官方分支零自定义链执行（DSH-005）");
});

test("DSH-005：官方分支零自定义资源——空链不影响，配置条目在场也不碰", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const hEmpty = harness(mod, { config: C.makeSavedConfig([]) });
  await hEmpty.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(hEmpty.officialRequestCount(), 1, "空自定义链不阻断官方分支，也不报未配置（DSH-005）");
  assert.equal(hEmpty.chainRequestCount(), 0);
});

test("DSH-005：官方失败 → 原样抛错并保持选择，无静默回退", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const boom = { name: "WebError", code: "OFFICIAL_UPSTREAM", message: "官方通道合成故障", details: {} };
  const h = harness(mod, {
    behavior: () => {
      throw boom;
    },
  });
  // assert.rejects resolve 为 undefined,捕获返回必得 undefined(与实现无关)。改 try/catch 捕获真实对象。
  let threw = false;
  let err;
  try {
    await h.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  } catch (e) {
    threw = true;
    err = e;
  }
  assert.ok(threw, "官方失败必须向宿主抛错,不得静默(未抛出即为缺陷)");
  assert.equal(err, boom, "官方失败错误原样上报（DSH-002/DSH-005）");
  assert.equal(h.chainRequestCount(), 0, "保持当前选择：不得悄悄回退自定义链（DSH-005）");
});

test("DSH-005/SET-005 路由矩阵：仅『开关开 + 官方路由』走官方，其余全部自定义链", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const cases = [
    { name: "开关关 + 官方路由", config: C.makeSavedConfig(ENTRIES, { useOfficialDeepSeekSearch: false }), llm: C.OFFICIAL_ROUTE_ID, wantOfficial: false },
    { name: "开关开 + 账号模式路由", llm: C.DEEPSEEK_ACCOUNT_ROUTE_ID, wantOfficial: false },
    { name: "开关开 + 第三方模型路由", llm: "openai-official", wantOfficial: false },
    { name: "开关开 + 路由缺失（非模型请求）", llm: undefined, wantOfficial: false },
    { name: "开关缺省(SET-005 视为开) + 官方路由", config: { entries: ENTRIES }, llm: C.OFFICIAL_ROUTE_ID, wantOfficial: true },
    { name: "开关开 + 官方路由", llm: C.OFFICIAL_ROUTE_ID, wantOfficial: true },
  ];
  for (const c of cases) {
    const h = harness(mod, { config: c.config });
    await h.search({ query: DEFAULT_QUERY, maxResults: 2, llmProvider: c.llm });
    if (c.wantOfficial) {
      assert.equal(h.officialRequestCount(), 1, `${c.name}：应委托官方（DSH-005/SET-005）`);
      assert.equal(h.chainRequestCount(), 0, `${c.name}：官方分支不得触碰链`);
    } else {
      assert.equal(h.chainRequestCount(), 1, `${c.name}：必须走自定义链（DSH-005）`);
      assert.equal(h.officialRequestCount(), 0, `${c.name}：不得委托官方`);
    }
  }
});

test("DSH-005：同名自定义模型按路由 id 判定走自定义链（不被展示名迷惑）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // 用户在宿主里新建了展示名撞名「deepseek-official」的自定义模型：其路由 id 是别的。
  // provider 判定只看路由 id（A1：llmProvider=路由 id）。
  const h = harness(mod, { routeOf: (r) => r?.requestRouteId });
  await h.search({
    query: DEFAULT_QUERY,
    model: C.OFFICIAL_ROUTE_ID, // 展示名撞名
    requestRouteId: "custom-route-9527", // 实际路由 id 不同
  });
  assert.equal(h.officialRequestCount(), 0, "同名自定义模型不是官方路由（DSH-005）");
  assert.equal(h.chainRequestCount(), 1);
});

test("DSH-005：官方缺席（宿主无该 provider）时官方路由回落自定义链而非崩溃", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness(mod, { official: "absent" });
  const out = await h.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(typeof out, "object", "官方缺席时必须可由自定义链接管（链自己按 FB-004 报终态）");
  assert.equal(h.chainRequestCount(), 1);
});
