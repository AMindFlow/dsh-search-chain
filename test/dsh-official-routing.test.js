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
import { createHostShapeFakeHost } from "./helpers/fake-host.js";

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

// ── PR#14 B1：生产接线面 ────────────────────────────────────────────────────────────────
// 上面的矩阵走 createProviderHarness（直连 createSearchProvider 注入），测不出「生产 apply 与
// 配置端口的接线」错误；而 fake-host.settingsPort.current 本身读活 saved，替身也复现不了该缺陷。
// 本测试刻意绕开两条捷径：真实 src/index.js apply(ctx, 装载快照, testDeps) + 真实 src/config.js
// writeConfig 落盘，断言保存成功后【下一次查询】读到新快照——官方开关翻转即时生效（CFG-004，
// config-network.md:27「搜索开始时使用已保存快照，后续保存只影响下一次查询」）。
test("CFG-004/DSH-005 生产接线：保存成功后下一次查询读到新快照（官方开关即时生效）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const cfgRes = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfgRes, "WP1 src/config.js", "CFG-004")) return;
  const cfgMod = cfgRes.module;

  const OLD = C.makeSavedConfig(ENTRIES, { useOfficialDeepSeekSearch: false });
  // 真实宿主只把装载时刻快照交给 apply 且不随保存更新；活配置的唯一来源是 configuration() 行
  // （asar TS 声明终审：Array<{entry, inherited, override}>，有效值 = inherited ⊕ override；
  // entry 与 ctx.fiber.entry 同一对象；行集合无 saved() 捷径；保存写 override 层）。
  // 台架同时挂一行 web-search-deepseek（其 config 作为该行 inherited 层装载；B2′ 的
  // 「行匹配按 options.id」台架就位；B2 行读取断言属 src/official 实机核对面，
  // 本测试经 testDeps 注入 official，不在此钉）。
  const loadSnapshot = structuredClone(OLD);
  const host = createHostShapeFakeHost({
    config: structuredClone(OLD),
    extraRows: [{ entryId: "web-search-deepseek", config: { baseURL: "https://row.example/v1" } }],
  });

  const chainCalls = [];
  const officialCalls = [];
  await Promise.resolve(mod.apply(host.ctx, loadSnapshot, {
    chain: {
      async search(request) {
        chainCalls.push(request);
        return { sources: C.makeSources(1), truncated: false };
      },
      release() {},
    },
    official: {
      async search(request) {
        officialCalls.push(request);
        return officialOk();
      },
    },
  }));
  const provider = host.searchRegistrations()[0];
  assert.ok(provider && provider.id === C.PROVIDER_ID, "provider 必须已经注册（DSH-001）");

  // B-C 写路径真接线：保存必须走 src/index.js 导出的 createSettingsPort(ctx) 端口工厂——
  // 替身的宿主身份校验会拒绝 Fiber/外来目标（B3 回归钉）。导出未落地时本条为预期红。
  if (typeof mod.createSettingsPort !== "function") {
    t.diagnostic(
      "[WP0 oracle] 等待 src/index.js 导出 createSettingsPort(ctx) 端口工厂（B-C：生产保存路径必须" +
      "经真实接线，settings.entry=ctx.fiber.entry）。本条为红是测试信号（勿弱化/勿 skip）——" +
      "dev 导出落地后本用例自动续跑三段语义。",
    );
    assert.fail("等待 createSettingsPort：B-C 生产保存路径测试等待 src/index.js 端口工厂导出");
  }
  const port = mod.createSettingsPort(host.ctx); // 生产端口（非台架 settingsPort）

  // 初始基线：装载态开关为 OFF——官方路由的查询必须走自定义链。此步消除 provider 活读坏成
  // 空配置（行形态错读成 {}）时靠 useOfficial 缺省 true 「空过」甄别点的假绿：活读必须读到
  // 宿主行里的真实值 false，而不是 {}、装载快照缺省或任何缓存。
  await provider.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(
    officialCalls.length,
    0,
    "初始配置开关为 OFF：官方路由查询必须走自定义链。走了官方 = 活读没读到宿主行真实值" +
      "（读成 {}：行形态假设错误 / 读成装载快照缺省：B1 复发）——PR#14 B1' 复现点",
  );
  assert.equal(chainCalls.length, 1, "初始状态官方路由查询走自定义链（SET-005 尊重已保存的显式 OFF）");

  // 台架自检：经生产端口保存确实落到宿主 override 层（若这条红，是台架/端口问题，不是查询接线
  // 问题——排除假红来源）。端口来自 createSettingsPort：Fiber 目标会被替身身份校验拒绝（B3 钉）。
  await cfgMod.writeConfig(port, { ...structuredClone(OLD), useOfficialDeepSeekSearch: true });
  assert.equal(
    (await cfgMod.readConfig(port)).useOfficialDeepSeekSearch,
    true,
    "生产端口保存应已生效（台架自检；读走 inherited⊕override 有效值）",
  );
  // 落层断言（宿主 edit 变异函数语义）：writeConfig 的返回层必须落 override 自身层，
  // inherited 装载基线不因保存而变——分层错位（写进 inherited / 合并进 effective）都在此红。
  const benchRow = host.configuration()[0];
  assert.equal(benchRow.override.useOfficialDeepSeekSearch, true, "保存必须落在该行 override 层（变异函数返回值语义）");
  assert.equal(benchRow.inherited.useOfficialDeepSeekSearch, false, "inherited 基线层保持装载值（保存不触碰继承层）");

  // CFG-004 甄别点：这次 search 必须读【保存后】的快照 → 官方路由 + 开关开 → 官方通道。
  await provider.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(
    officialCalls.length,
    1,
    "CFG-004：保存成功后，下一次 search 必须读新快照走官方通道。若仍走旧快照（自定义链），" +
      "说明生产接线把 settings.current() 绑死为 apply 装载入参 config（src/index.js）——这是接线缺陷（PR#14 B1），不是新增契约断言",
  );
  assert.equal(chainCalls.length, 1, "开关开 + 官方路由生效：本条查询零新增链调用（DSH-005；1 为初始基线那次）");

  // 反向翻转 ON→OFF：第三条查询应回到自定义链——证明每次查询都实时读，而非任一方向缓存。
  await cfgMod.writeConfig(port, { ...structuredClone(OLD), useOfficialDeepSeekSearch: false });
  await provider.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(officialCalls.length, 1, "开关保存为 OFF 后的查询不得再走官方通道（CFG-004/SET-005）");
  assert.equal(chainCalls.length, 2, "第二次保存应作用于下一次查询：回到自定义链（CFG-004）");

  await host.disposeAll();
});
