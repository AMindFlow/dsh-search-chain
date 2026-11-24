// WP6 装配面 — 任务 4：额度统一规则 + available() 语义 + configuration() 每操作快照。
// 规格依据：
//   #12 清单 5（额度信号统一规则定案）：任意状态码，载荷含额度证据
//     （error.code ∈ {insufficient_quota, resource_exhausted} / RESOURCE_EXHAUSTED 文案 / quota 措辞）
//     → QUOTA；无额度证据的 429 → RATE_LIMITED。（FB-005:34 字面回补归 WP7）
//   DSH-002（dsh-integration.md）：available() 必须同步判断且不得发起网络请求；已初始化的插件
//     应允许宿主进入 search()，空配置由链按 FB-004 在 search 时报终态（而非 available 拒绝）。
//   #12 清单 10/21：available()/AMBIGUOUS 口径与 provider 面命名——宿主 WebSearchProvider 契约为
//     available(): boolean（无参、无网络）+ 可选 ready?(llmProvider): Promise<boolean>；宿主自动
//     选择语义（无 id 且多个可用 provider → WEB_PROVIDER_AMBIGUOUS，inspect 实证 0.2.2-rc.5）要求
//     我方 available() 是路由无关的同步布尔，让宿主选择能一致地把我方归类为「可用」。
//   #12 清单 12/CFG-004：configuration() 每查询行读，一次操作内快照（编辑期一致性）；
//     操作进行中的保存不得改变在途操作，下一次操作读新值。
// 红/绿预期：额度规则等待 WP5 分类器（红属预期）；其余在 main 已绿。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hostApply, makeWebError, countConfigReads } from "./helpers/assembly-harness.js";

const WP_SEARCH = "WP5 src/search.js（classifyUpstreamFailure，FB-005/#12-5 额度统一规则）";
const WP_INDEX = "WP6 src/index.js";

function stubOfficial() {
  const calls = [];
  return {
    calls,
    async search(request, signal) {
      calls.push({ request, signal });
      return { sources: [], truncated: false, content: "official" };
    },
  };
}

test("#12-5：额度统一规则——任意状态码 + 额度证据 → QUOTA；无证据 429 → RATE_LIMITED", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "#12-5 额度统一规则")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function", "src/search.js 必须导出 classifyUpstreamFailure");

  const cases = [
    { info: { status: 402 }, want: C.ENTRY_CODES.QUOTA, note: "402 本身即额度（FB-005）" },
    { info: { status: 400, upstreamCode: "insufficient_quota" }, want: C.ENTRY_CODES.QUOTA, note: "#12-5 任意状态码+quota 证据 → QUOTA（400 不覆盖证据）" },
    { info: { status: 403, upstreamCode: "resource_exhausted" }, want: C.ENTRY_CODES.QUOTA, note: "#12-5 resource_exhausted 证据 → QUOTA" },
    { info: { status: 429, upstreamCode: "insufficient_quota" }, want: C.ENTRY_CODES.QUOTA, note: "#12-5 429 带 quota 证据 → QUOTA（优先于限流）" },
    { info: { status: 500, upstreamCode: "insufficient_quota" }, want: C.ENTRY_CODES.QUOTA, note: "#12-5 5xx 带 quota 证据 → QUOTA" },
    { info: { status: 429 }, want: C.ENTRY_CODES.RATE_LIMITED, note: "#12-5 无额度证据的 429 → RATE_LIMITED" },
  ];
  for (const c of cases) {
    const got = classifyUpstreamFailure(structuredClone(c.info));
    assert.equal(got, c.want, `${c.note}：实测=${String(got)}`);
  }
});

test("DSH-002/#12-10,21（装配面）：available() 同步布尔、无网络/无链/无写；空配置不可用拒绝不在此面", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "DSH-002 available()")) return;
  const mod = modRes.module;

  // 空配置（未配置任何条目）：可用性问题必须在 search 面按 FB-004 终态报告，不得在 available 拒绝
  const chainCalls = [];
  const chain = {
    async search() {
      chainCalls.push(1);
      throw makeWebError(C.CHAIN_CODES.NOT_CONFIGURED, "未配置可用搜索工具");
    },
    release() {},
  };
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, C.makeSavedConfig([]), { chain, official });

  const v = provider.available(); // 宿主契约：无参调用
  assert.equal(typeof v, "boolean", "available() 必须同步返回布尔（宿主契约 A1），不可返回 Promise/thenable");
  assert.ok(!("then" in Object(v)), "available() 不得是 thenable（宿主 resolveConfig 同禁异步校验面）");
  assert.equal(v, true, "已初始化即允许宿主进入 search()（DSH-002）；空配置在 search 面报 FB-004 终态，不在 available 拒绝");
  // 路由无关（#12-10/21 AMBIGUOUS 口径）：宿主自动选择按「可用 provider」计数，
  // 我方 available() 不得随路由/上下文漂移，否则宿主 WEB_PROVIDER_AMBIGUOUS 判定面不一致
  assert.equal(provider.available(), v, "available() 无路由参数、结果稳定（宿主自动选择语义一致）");
  assert.equal(chainCalls.length, 0, "available() 不得触碰链");
  assert.equal(official.calls.length, 0, "available() 不得触碰官方路径");
  assert.equal(host.traps.webFetch, 0, "available() 不得发起网络");
  assert.equal(host.editor.calls.length, 0, "available() 不得写配置");

  // 空配置终态在 search 面报告（FB-004）：同一 provider 拒绝的不是「可用性」而是查询
  let err;
  try {
    await provider.search({ query: "q", llmProvider: "custom-model-route" });
  } catch (e) {
    err = e;
  }
  assert.equal(err?.code, C.CHAIN_CODES.NOT_CONFIGURED, "空配置 → search 面 FB-004 终态（而非 available=false）");
  await host.disposeAll();
});

test("DSH-002/#12-21（装配面）：可选 ready(llmProvider) 面——存在时须为异步布尔且不随路由拒绝", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "#12-21 ready 面")) return;
  const mod = modRes.module;

  const chain = { async search() { return { sources: [], truncated: false }; }, release() {} };
  const official = stubOfficial();
  const { host, provider } = hostApply(
    mod,
    C.makeSavedConfig([C.makeEntry({ id: "e-oai", type: "openai", name: "合成 OpenAI 线" })]),
    { chain, official },
  );

  if (typeof provider.ready !== "function") {
    // 宿主契约：Omitted = ready。当前 main 无 ready 面——合法（宿主视为 ready）。
    t.diagnostic("[WP6 oracle] #12-21：provider 未提供 ready()（宿主契约 omitted=ready），本条按省略面通过");
    return;
  }
  // WP6 若按 #12-21 添加 ready 别名：宿主契约要求 Promise<boolean>，仅查配置、无网络，
  // 且不得把「路由不明（undefined）」或任何路由当作不可用——路由判定归 search()（DSH-005）。
  for (const llm of [undefined, C.OFFICIAL_ROUTE_ID, C.DEEPSEEK_ACCOUNT_ROUTE_ID, "custom-model-route"]) {
    let out;
    let rejected = null;
    try {
      out = await provider.ready(llm);
    } catch (e) {
      rejected = e;
    }
    assert.equal(rejected, null, `ready(${String(llm)}) 不得拒绝（选择失败由操作自身表面化，宿主 selectedProviderReady 语义）`);
    assert.equal(typeof out, "boolean", `ready(${String(llm)}) 必须 resolve 布尔`);
  }
  await host.disposeAll();
});

test("#12-12/CFG-004（装配面）：configuration() 每操作快照——在途操作不被中途保存改变，下一操作读新值", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "#12-12/CFG-004 快照")) return;
  const cfgRes = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfgRes, "WP1 src/config.js", "CFG-004 writeConfig")) return;
  const mod = modRes.module;
  const cfgMod = cfgRes.module;

  const entries = [C.makeEntry({ id: "e-oai", type: "openai", name: "合成 OpenAI 线" })];
  const initial = C.makeSavedConfig(entries, { useOfficialDeepSeekSearch: false });
  let release = null;
  const gateResult = { sources: C.makeSources(1), truncated: false, content: "gate" };
  const chainCalls = [];
  const chain = {
    async search() {
      chainCalls.push(1);
      await new Promise((resolve) => {
        release = resolve; // 手动门：让操作 A 在途时插入保存
      });
      return gateResult;
    },
    release() {},
  };
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, initial, { chain, official });
  const reads = countConfigReads(host);
  const port = mod.createSettingsPort(host.ctx);
  assert.equal(typeof port, "object", "createSettingsPort 必须可用（生产保存路径）");

  // 操作 A：开关 OFF + 官方路由 → 链路径，停在手动门
  const pa = provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  await new Promise((r) => setImmediate(r)); // 让 A 完成路由读取并进入门
  assert.equal(chainCalls.length, 1, "操作 A 按开始时的快照（开关 OFF）选了链");
  assert.equal(official.calls.length, 0);

  // 在途保存：开关翻 ON——不得改变在途操作 A
  await cfgMod.writeConfig(port, { ...structuredClone(initial), useOfficialDeepSeekSearch: true });
  assert.equal(chainCalls.length, 1, "在途操作 A 不受中途保存影响（一次操作内快照，#12-12）");
  assert.equal(official.calls.length, 0, "在途操作 A 不得中途改走官方");
  release();
  const outA = await pa;
  assert.equal(outA, gateResult, "操作 A 结果原样返回（快照内完成）");

  // 操作 B：下一次查询读新快照 → 开关 ON + 官方路由 → 官方
  await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(official.calls.length, 1, "下一次操作必须读保存后的新快照走官方（CFG-004）");
  assert.equal(chainCalls.length, 1, "操作 B 不再触碰链");

  // #12-12 记录面（非断言）：单次操作的 configuration() 行读次数
  reads.reset();
  await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  t.diagnostic(
    `[WP6 oracle] #12-12 记录：单次官方分支操作 configuration() 行读次数=${reads.reads()}（清单口径：一次操作内快照可接受，实测卡顿再加缓存失效策略）`,
  );
  await host.disposeAll();
});
