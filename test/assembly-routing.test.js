// WP6 装配面 — 任务 2：路由矩阵（DSH-005）开关 × 路由 id 全组合 + 官方缺席回落 + 官方错原样抛。
// 规格依据：
//   DSH-005（dsh-integration.md）：开关开 且 实际模型路由为官方路由（deepseek-official）→ 宿主
//     服务端搜索路径；关闭开关或路由为其他模型（含 DeepSeek 账号模式、同名自定义模型、第三方
//     兼容端点）→ 自定义链；官方结果/错误直接返回，失败保持此次选择，不静默回退。
//   SET-005（settings-ui.md）：useOfficialDeepSeekSearch 缺省视为开启。
//   #12 清单 17：路由矩阵按 llmProvider：deepseek-account/deepseek-official → 官方分支判定面，
//     其中 DEEPSEEK_ACCOUNT_ROUTE_ID ≠ OFFICIAL_ROUTE_ID 必须走自定义链。
// 黑盒面：真实 apply + 真实 hostShape 替身；链/官方均为 testDeps 注入桩（计数 + 请求记录）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hostApply, makeWebError } from "./helpers/assembly-harness.js";

const WP = "WP6 src/index.js";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-005/SET-005")) return null;
  return res.module;
}

function stubChain() {
  const calls = [];
  return {
    calls,
    async search(request, signal) {
      calls.push({ request, signal });
      return { sources: C.makeSources(1), truncated: false, content: "chain" };
    },
    release() {},
  };
}

function stubOfficial() {
  const calls = [];
  return {
    calls,
    async search(request, signal) {
      calls.push({ request, signal });
      return { sources: C.makeSources(1), truncated: false, content: "official" };
    },
  };
}

const ENTRIES = [C.makeEntry({ id: "e-oai", type: "openai", name: "合成 OpenAI 线" })];

test("DSH-005/SET-005（装配面）：开关 × 路由 id 全组合矩阵——仅『开关开 + 官方路由』走官方", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  const switchStates = [
    { name: "开关缺省(SET-005 视为开)", useOfficialDeepSeekSearch: undefined },
    { name: "开关显式开", useOfficialDeepSeekSearch: true },
    { name: "开关显式关", useOfficialDeepSeekSearch: false },
  ];
  const routes = [
    { name: `官方路由 ${C.OFFICIAL_ROUTE_ID}`, llmProvider: C.OFFICIAL_ROUTE_ID, wantOfficial: true },
    { name: `账号路由 ${C.DEEPSEEK_ACCOUNT_ROUTE_ID}（≠官方路由，DSH-005 必须走链）`, llmProvider: C.DEEPSEEK_ACCOUNT_ROUTE_ID, wantOfficial: false },
    { name: "第三方模型路由", llmProvider: "openai-official", wantOfficial: false },
    { name: "路由缺失（非模型请求）", llmProvider: undefined, wantOfficial: false },
  ];

  for (const sw of switchStates) {
    for (const rt of routes) {
      // 缺省面必须【省略字段】（SET-005 缺省视为开）——不能经 makeSavedConfig 补默认值
      const cfg =
        sw.useOfficialDeepSeekSearch === undefined
          ? { entries: structuredClone(ENTRIES) }
          : C.makeSavedConfig(structuredClone(ENTRIES), { useOfficialDeepSeekSearch: sw.useOfficialDeepSeekSearch });
      const chain = stubChain();
      const official = stubOfficial();
      const { host, provider } = hostApply(mod, cfg, { chain, official });
      const wantOfficial = sw.useOfficialDeepSeekSearch !== false && rt.wantOfficial;

      await provider.search({ query: "合成查询", maxResults: 3, llmProvider: rt.llmProvider });

      const label = `${sw.name} × ${rt.name}`;
      if (wantOfficial) {
        assert.equal(official.calls.length, 1, `${label}：应委托官方（DSH-005/SET-005）`);
        assert.equal(chain.calls.length, 0, `${label}：官方分支零自定义链执行（DSH-005）`);
      } else {
        assert.equal(chain.calls.length, 1, `${label}：必须走自定义链（DSH-005）`);
        assert.equal(official.calls.length, 0, `${label}：不得委托官方（DSH-005）`);
      }
      await host.disposeAll();
    }
  }
});

test("DSH-005（装配面）：DEEPSEEK_ACCOUNT_ROUTE_ID ≠ OFFICIAL_ROUTE_ID 判定——账号模式开关开也走链", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // 显式对照两个常量不等（防止 dev 把账号 id 与官方 id 归一后「统一走官方」的变异）：
  assert.notEqual(C.DEEPSEEK_ACCOUNT_ROUTE_ID, C.OFFICIAL_ROUTE_ID, "账号路由 id 与官方路由 id 必须不同（契约常量）");
  const cfg = C.makeSavedConfig(ENTRIES, { useOfficialDeepSeekSearch: true });
  const chain = stubChain();
  const official = stubOfficial();
  const { host, provider } = hostApply(mod, cfg, { chain, official });

  await provider.search({ query: "q", llmProvider: C.DEEPSEEK_ACCOUNT_ROUTE_ID });
  assert.equal(official.calls.length, 0, "账号模式（deepseek-account）不得走官方搜索（DSH-005）");
  assert.equal(chain.calls.length, 1, "账号模式必须走自定义链（DSH-005：账号模式走自定义链）");
  await host.disposeAll();
});

test("DSH-005（装配面）：官方缺席（宿主无官方 provider）→ 官方路由回落自定义链而非崩溃", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const cfg = C.makeSavedConfig(ENTRIES, { useOfficialDeepSeekSearch: true });
  const chain = stubChain();
  const { host, provider } = hostApply(mod, cfg, { chain, official: null }); // 显式缺席

  const out = await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.ok(out && Array.isArray(out.sources), "官方缺席时自定义链接管（链自己按 FB-004 报终态）");
  assert.equal(chain.calls.length, 1, "官方缺席：查询回落自定义链（不崩溃、不静默成功）");
  await host.disposeAll();
});

test("DSH-005（装配面）：官方错原样抛（同一错误对象），不静默回退，且保持此次选择", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const boom = makeWebError("OFFICIAL_UPSTREAM", "官方通道合成故障（上游 500）");
  const failingOfficial = {
    calls: 0,
    async search() {
      this.calls += 1;
      throw boom;
    },
  };
  const cfg = C.makeSavedConfig(ENTRIES, { useOfficialDeepSeekSearch: true });
  const chain = stubChain();
  const { host, provider } = hostApply(mod, cfg, { chain, official: failingOfficial });

  let err;
  try {
    await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "官方失败必须向宿主抛错，不得静默（未抛出即为缺陷）");
  assert.equal(err, boom, "官方失败错误原样上抛：同一对象（DSH-002/DSH-005）");
  assert.equal(chain.calls.length, 0, "不得悄悄回退自定义链（DSH-005：保持此次选择）");

  // 保持选择：下一次同路由查询仍走官方（无「失败后自动切链」的隐性状态）
  let err2;
  try {
    await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  } catch (e) {
    err2 = e;
  }
  assert.equal(err2, boom, "失败后的下一次查询仍走官方通道且仍原样报错（保持此次选择，无记忆漂移）");
  assert.equal(failingOfficial.calls, 2, "失败后的下一次查询仍选官方（选择无记忆性漂移）");
  assert.equal(chain.calls.length, 0, "保持选择期间链零调用");
  await host.disposeAll();
});
