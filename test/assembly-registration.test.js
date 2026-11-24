// WP6 装配面 — 任务 1：装配注册唯一 provider + 卸载 disposer + DSH-002 调用边界。
// 规格依据：
//   DSH-001（dsh-integration.md）：注册唯一 WebSearchProvider（id=search-chain）；卸载移除搜索
//     注册并释放连接资源；重新装载后各只有一个注册项；插件只注册搜索 provider。
//   DSH-002（dsh-integration.md）：每次调用处理一个查询；请求与 signal 透传；链终态错误原样上抛
//     （同一错误对象，不吞不包装）。
//   #12 清单 17/20/21：路由/终态错语义与 provider 面命名（{id,available,search,release} 已被宿主接受）。
// 黑盒面：真实 src/index.js apply（宿主形态替身，A4 第三参注入 { chain, official } 仅为测试双）。
// 实现方（WP6 dev）不得删断言/改 skip 使其通过。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hermeticEnvKeys, hostApply, makeWebError } from "./helpers/assembly-harness.js";
import { createHostShapeFakeHost } from "./helpers/fake-host.js";

const WP = "WP6 src/index.js";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-001/DSH-002")) return null;
  return res.module;
}

/** 记录型假链桩（装配层只负责选路与透传，不关心链内部）。 */
function stubChain(behavior) {
  const calls = [];
  return {
    calls,
    released: 0,
    async search(request, signal) {
      calls.push({ request, signal });
      if (typeof behavior === "function") return behavior(request, signal);
      return behavior ?? { sources: C.makeSources(1), truncated: false };
    },
    release() {
      this.released += 1;
    },
  };
}

function stubOfficial() {
  const calls = [];
  return { calls, async search(request, signal) { calls.push({ request, signal }); return { sources: [], truncated: false, content: "stub-official" }; } };
}

const CFG = C.makeSavedConfig([C.makeEntry({ id: "e-tav", type: "tavily", name: "合成 Tavily 线" })]);
const REQ = { query: "合成查询", maxResults: 4, llmProvider: "custom-model-route" };

test("DSH-001：apply 注册唯一 provider（id=search-chain），只注册搜索 provider", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const chain = stubChain();
  const { host } = hostApply(mod, CFG, { chain, official: stubOfficial() });

  assert.equal(host.searchRegistrationCount(), 1, "装载后恰好一个搜索 provider（DSH-001）");
  assert.deepEqual(host.providerIds(), [C.PROVIDER_ID], "注册 id 必须为 search-chain");
  assert.equal(host.searchRegistrations()[0].id, C.PROVIDER_ID);
  // DSH-001「只注册搜索 provider」+ 设计决定「不得经 ctx.web.search 回流」：
  assert.equal(host.traps.fetchProviderRegistrations, 0, "不得注册 fetch provider");
  assert.equal(host.traps.toolRegistrations, 0, "不得注册工具");
  assert.equal(host.traps.webSearch, 0, "不得经 ctx.web.search 回流（会选回自身）");
  // DSH-003 配套：安装=注册，不自动保存
  assert.equal(host.editor.calls.length, 0, "装载不得改写已保存配置");
  await host.disposeAll();
});

test("DSH-001：卸载 disposer = 反注册 + release 链；重新装载后各只有一个注册项", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const chain = stubChain();
  const { host } = hostApply(mod, CFG, { chain, official: stubOfficial() });
  await host.disposeAll();

  assert.equal(host.searchRegistrationCount(), 0, "卸载后注册表清空（DSH-001）");
  assert.equal(host.disposedCount(C.PROVIDER_ID), 1, "必须执行 disposer 反注册，而非仅丢弃引用");
  assert.equal(chain.released, 1, "卸载必须 release 链资源（连接释放，DSH-001/FB-003）");

  // 重新装载（reload 路径）：仍是单一注册
  const chain2 = stubChain();
  const { host: hostB } = hostApply(mod, CFG, { chain: chain2, official: stubOfficial() });
  assert.equal(hostB.searchRegistrationCount(), 1, "重载后单一注册，无残留（DSH-001）");
  assert.equal(chain2.released, 0, "装载期间不得提前 release");
  await hostB.disposeAll();
});

test("DSH-002（装配面）：单查询透传——请求不重写、结果原样返回（同一对象）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const stubResult = { sources: C.makeSources(2), truncated: false, content: "链产出" };
  const chain = stubChain(stubResult);
  const { host, provider } = hostApply(mod, CFG, { chain, official: stubOfficial() });

  const out = await provider.search(structuredClone(REQ), undefined);
  assert.equal(chain.calls.length, 1, "每次宿主调用只允许一个查询（DSH-002/R8 单查询）");
  assert.deepEqual(chain.calls[0].request, REQ, "请求必须透传，不得重写 query/maxResults/llmProvider");
  assert.equal(out, stubResult, "链结果对象必须原样透传给宿主（DSH-002）");
  await host.disposeAll();
});

test("DSH-002（装配面）：宿主取消 signal 透传到链；无 signal 调用不得崩溃", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const chain = stubChain();
  const { host, provider } = hostApply(mod, CFG, { chain, official: stubOfficial() });

  const ac = new AbortController();
  await provider.search({ query: "q", llmProvider: "x" }, ac.signal);
  assert.equal(chain.calls[0].signal, ac.signal, "宿主取消信号必须透传（DSH-002/FB-003 共享取消）");
  await provider.search({ query: "q", llmProvider: "x" });
  assert.equal(chain.calls.length, 2, "无 signal 调用同样可达链（不崩溃）");
  await host.disposeAll();
});

test("DSH-002（装配面）：链 FB-004 终态错误原样上抛（同一错误对象，不吞不包装）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const terminal = makeWebError(
    C.CHAIN_CODES.UPSTREAM_FAILURES,
    "全部条目失败：e-tav 限流",
    [
      {
        entryId: "e-tav",
        entryType: "tavily",
        entryName: "合成 Tavily 线",
        code: C.ENTRY_CODES.RATE_LIMITED,
        reason: "429 限流",
      },
    ],
  );
  const chain = stubChain(() => {
    throw terminal;
  });
  const { host, provider } = hostApply(mod, CFG, { chain, official: stubOfficial() });

  let err;
  try {
    await provider.search({ query: "q", llmProvider: "custom-model-route" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "链终态错误必须向宿主上抛（未抛出即为缺陷）");
  assert.equal(err, terminal, "终态错误必须原样上抛：同一对象，不得吞掉/重包装/降级文本（DSH-002/FB-004）");
  C.assertWebError(err, {
    code: C.CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [{ entryId: "e-tav", code: C.ENTRY_CODES.RATE_LIMITED }],
  });
  await host.disposeAll();
});

// ─── WP13（实机 P0 oracle）：inject 宿主服务面声明完备 + 凭据服务缺失的装配终态 ───
// 实机事实（真宿主，独立测试 profile）：src/index.js 的 inject 只声明 ["web","configEditor"]，
// 宿主仅注入 inject 声明过的服务 → 真宿主 ctx.get("credentials") === undefined →
// hostCredentials 的 resolve/readRecord 恒抛 → 全部条目 ENTRY_CREDENTIALS（链看似在跑，实则恒凭据败）。
// 既有测试全绿的原因：fake-host 无条件把 createFakeCredentials() 挂进 services，从不按 inject 收敛——
// 本 WP13 两条即补这两面：①声明完备（红）；②服务缺失时装配行为仍是 ENTRY_CREDENTIALS 终态而非崩溃（钉行为）。

test("WP13（实机 P0）：inject 必须声明完整宿主服务面 web/configEditor/credentials", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  assert.ok(Array.isArray(mod.inject), "inject 必须是字符串数组（bundle 宿主依赖声明）");
  assert.ok(
    mod.inject.every((s) => typeof s === "string" && s.length > 0),
    "inject 每项必须是非空字符串服务名",
  );
  // 宿主只注入 inject 声明的服务（dsh bundle 契约）；缺 credentials 则 ctx.get("credentials")
  // 在真宿主上恒为 undefined，凭据链路整体失效——声明完备性是 P0。
  for (const svc of ["web", "configEditor", "credentials"]) {
    assert.ok(
      mod.inject.includes(svc),
      `inject 缺少 "${svc}"：宿主不会注入未声明服务，真宿主上 ctx.get("${svc}") 恒为 undefined`,
    );
  }
});

test("WP13（实机 P0）：装配 ctx.get(\"credentials\") 缺失时 search 走 ENTRY_CREDENTIALS 终态而非崩溃，零出站", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  hermeticEnvKeys(t); // 隔离本机白名单 key（TAVILY_API_KEY 等），确保真走「凭据服务缺失」路径

  const outbound = [];
  // 关键 1：不注入 chain——走真实 apply 的生产链（hostCredentials(ctx) 经 ctx.get("credentials")，
  // 与真宿主同一接线）。
  // 关键 2：credentials 必须在 apply 之前就不存在——真宿主自装载起即不注入未声明服务，而
  // hostCredentials 在 apply 时捕获 svc；若先装载再删除，测到的是「服务中途消失」而非本缺陷形状。
  const host = createHostShapeFakeHost({ config: structuredClone(CFG) });
  host.services.credentials = undefined;
  assert.equal(host.ctx.get("credentials"), undefined, "前置条件：装载前 ctx 的 credentials 服务面必须缺失");
  const cleanup = mod.apply(host.ctx, structuredClone(CFG), {
    official: null,
    fetch: (url) => {
      outbound.push(String(url));
      throw new Error("network tripwire：凭据失败必须先于任何出站止步");
    },
  });
  assert.equal(typeof cleanup, "function", "apply 必须返回 disposer（与 hostApply 同形）");
  const provider = host.searchRegistrations()[0];

  let err;
  try {
    await provider.search(structuredClone(REQ), undefined);
  } catch (e) {
    err = e;
  }
  // 必须是 FB-004 终态 WebError（可操作、逐条归因），而不是崩溃，也不是静默成功。
  assert.ok(err, "凭据服务缺失必须以链终态错误收束（不得静默成功）");
  C.assertWebError(err, {
    code: C.CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [{ entryId: "e-tav", code: C.ENTRY_CODES.CREDENTIALS }],
  });
  assert.equal(outbound.length, 0, "凭据失败必须止步于出站之前（对供应商零请求）");
  assert.equal(host.traps.webSearch, 0, "不得经 ctx.web.search 回流");
  await host.disposeAll();
});
