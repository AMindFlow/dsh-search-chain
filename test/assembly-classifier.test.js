// WP6 装配面 — 任务 3：分类器唯一权威（WP5）+ 装配层错误面。
// 规格依据：
//   FB-005（fallback.md）：必须区分凭据或权限、额度、限流、代理、直连网络、通道参数限制、单项
//     超时和异常响应；错误须指出对应条目和可核查的配置。
//   #12 清单 4：classifyUpstreamFailure 唯一权威 = WP5 src/search.js（各 adapter 本地镜像语义
//     分叉 rebase 后以链上分类实测转绿为验收）；清单 6：其余 4xx（400/422…）→ CHANNEL_LIMIT
//     定案写死；清单 8：classifier 入参形状钉死 {status, upstreamCode, phase}。
//   #12 清单 3：ROW_UNAVAILABLE → 链层映射 WebError（装配层责任，index.js 捕获
//     ConfigError.ROW_UNAVAILABLE → WebError code），禁止静默回落装载快照（B1′ 防线）。
//   DSH-002/FB-004：链终态错误经装配原样上抛，不被吞。
// 红/绿预期：映射表等待 WP5 src/search.js（红属预期）；ROW_UNAVAILABLE 的 WebError 形状等待
// WP6 dev（main 现状抛 ConfigError，红属预期）；终态不吞在 main 已绿。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hostApply, withRowRemoval, makeWebError } from "./helpers/assembly-harness.js";

const WP_SEARCH = "WP5 src/search.js（classifyUpstreamFailure，FB-005 唯一权威）";
const WP_INDEX = "WP6 src/index.js";

const ENTRIES = [C.makeEntry({ id: "e-tav", type: "tavily", name: "合成 Tavily 线" })];
const CFG = C.makeSavedConfig(ENTRIES);

function stubChainThrow(err) {
  const calls = [];
  return {
    calls,
    async search() {
      calls.push(1);
      throw err;
    },
    release() {},
  };
}

function stubOfficial() {
  const calls = [];
  return { calls, async search() { return { sources: [], truncated: false }; } };
}

test("FB-005/#12-4,6,8：classifyUpstreamFailure 唯一权威——映射表（入参面 {status, upstreamCode, phase}）", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005/#12-4/6/8 分类器")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(
    typeof classifyUpstreamFailure,
    "function",
    "src/search.js 必须导出 classifyUpstreamFailure(info)（#12-4 唯一权威）",
  );

  const cases = [
    // 凭据或权限（FB-005）
    { info: { status: 401 }, want: C.ENTRY_CODES.CREDENTIALS, note: "401 → 凭据或权限" },
    { info: { status: 403 }, want: C.ENTRY_CODES.CREDENTIALS, note: "403 → 凭据或权限" },
    // 额度（FB-005：402 属额度）
    { info: { status: 402 }, want: C.ENTRY_CODES.QUOTA, note: "402 → 额度" },
    // 限流（FB-005：其他 429）
    { info: { status: 429 }, want: C.ENTRY_CODES.RATE_LIMITED, note: "429 无额度证据 → 限流" },
    // #12-6：其余 4xx → CHANNEL_LIMIT 定案
    { info: { status: 400 }, want: C.ENTRY_CODES.CHANNEL_LIMIT, note: "#12-6 其余 4xx(400) → CHANNEL_LIMIT" },
    { info: { status: 422 }, want: C.ENTRY_CODES.CHANNEL_LIMIT, note: "#12-6 其余 4xx(422) → CHANNEL_LIMIT" },
    { info: { status: 418 }, want: C.ENTRY_CODES.CHANNEL_LIMIT, note: "#12-6 其余 4xx(418) → CHANNEL_LIMIT" },
    // 异常响应（FB-005）
    { info: { status: 500 }, want: C.ENTRY_CODES.BAD_RESPONSE, note: "500 → 异常响应" },
    { info: { phase: "response", status: 200 }, want: C.ENTRY_CODES.BAD_RESPONSE, note: "phase=response + 200（畸形体）→ 异常响应" },
    // 单项超时 / 直连网络（FB-005）
    { info: { phase: "timeout" }, want: C.ENTRY_CODES.TIMEOUT, note: "phase=timeout → 单项超时" },
    { info: { phase: "transport" }, want: C.ENTRY_CODES.NETWORK, note: "phase=transport 无代理证据 → 直连网络" },
  ];
  for (const c of cases) {
    const got = classifyUpstreamFailure(structuredClone(c.info));
    assert.equal(
      got,
      c.want,
      `${c.note}：实测=${String(got)}（#12-8 入参面 {status, upstreamCode, phase}）`,
    );
  }
});

test("#12-3/B1′（装配面）：宿主我行运行时不可用 → WebError 终态（CONFIG_ROW_UNAVAILABLE），无链/官方执行", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "#12-3 ROW_UNAVAILABLE→WebError")) return;
  const mod = modRes.module;

  const chain = stubChainThrow(new Error("不应执行"));
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, CFG, { chain, official });
  withRowRemoval(host, "own"); // 宿主行被移除/卸载的等价面（configuration() 无我行）

  let err;
  try {
    await provider.search({ query: "q", llmProvider: "custom-model-route" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "行不可用必须显式失败，禁止静默回落装载快照（B1′ 防线）");
  t.diagnostic(
    `[WP6 oracle] #12-3 实测：name=${String(err?.name)} code=${String(err?.code)} message=${String(err?.message).slice(0, 80)}`,
  );
  assert.equal(
    err.name,
    "WebError",
    "#12-3：装配层必须把 ConfigError(ROW_UNAVAILABLE) 映射为 WebError 上抛（宿主终态语义），实测 name=" +
      String(err?.name),
  );
  assert.equal(
    err.code,
    C.CONFIG_CODES.ROW_UNAVAILABLE,
    "#12-3：错误码保持 CONFIG_ROW_UNAVAILABLE（可定位到配置行问题），实测 code=" + String(err?.code),
  );
  assert.equal(chain.calls.length, 0, "行不可用：链零执行（零出站零凭据）");
  assert.equal(official.calls.length, 0, "行不可用：官方零执行");
  await host.disposeAll();
});

test("DSH-002/FB-004（装配面）：链终态错不被吞——FB-004 WebError 与程序违约均原样上抛（同一对象）", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "DSH-002 终态透传")) return;
  const mod = modRes.module;

  // FB-004 终态（不降级类：内容策略拒绝终止）
  const terminal = makeWebError(
    C.CHAIN_CODES.CONTENT_POLICY,
    "上游内容策略拒绝：e-tav 明确拒绝",
    [
      {
        entryId: "e-tav",
        entryType: "tavily",
        entryName: "合成 Tavily 线",
        code: C.ENTRY_CODES.CONTENT_POLICY,
        reason: "451 内容策略",
      },
    ],
  );
  {
    const chain = stubChainThrow(terminal);
    const { host, provider } = hostApply(mod, CFG, { chain, official: stubOfficial() });
    let err;
    try {
      await provider.search({ query: "q", llmProvider: "custom-model-route" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "链终态必须上抛");
    assert.equal(err, terminal, "FB-004 终态 WebError 原样上抛（同一对象，不被吞/不重包装）");
    C.assertWebError(err, {
      code: C.CHAIN_CODES.CONTENT_POLICY,
      attempts: [{ entryId: "e-tav", code: C.ENTRY_CODES.CONTENT_POLICY }],
    });
    await host.disposeAll();
  }
  // 程序违约（FB-005：内部程序违约向调用方暴露；无 code）
  const program = new TypeError("synthetic internal invariant violation");
  {
    const chain = stubChainThrow(program);
    const { host, provider } = hostApply(mod, CFG, { chain, official: stubOfficial() });
    let err;
    try {
      await provider.search({ query: "q", llmProvider: "custom-model-route" });
    } catch (e) {
      err = e;
    }
    assert.equal(err, program, "程序违约原样暴露给调用方（FB-005），不得被吞成普通 WebError");
    await host.disposeAll();
  }
});
