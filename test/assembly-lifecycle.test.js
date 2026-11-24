// WP6 装配面 — 任务 5：条目生命周期——运行时行增删下一次查询生效 + 行移除显式失败。
// 规格依据：
//   FB-001（fallback.md）：每次搜索以当前已保存列表为准，从上到下串行尝试；
//     已停用及缺少所需 key 的条目须跳过，出站请求数为零。
//   FB-004：空列表 → CHAIN_NOT_CONFIGURED；全部启用条目缺 key → CHAIN_KEYS_MISSING 且须说明缺失项；
//     终态 WebError 的 attempts 按尝试顺序。
//   CFG-004：保存成功后下一次查询生效（后续保存只影响下一次查询）。
//   #12 清单 18：宿主行不可用/移除 → WEB_PROVIDER_UNAVAILABLE（官方 web-search-deepseek 行读失败
//     映射，B2′ 每查询活读）；清单 19：editor.edit(entry, (raw, inherited) => newRawLayer) 变异函数
//     签名（生产保存路径经 writeConfig 走宿主 edit 闸）。
//   B1′：本插件行缺失/移除 → 显式 CONFIG_ROW_UNAVAILABLE（装配层映射见 assembly-classifier 任务 3）。
// 红/绿预期：生产链（WP5 真实链 + WP6 装配接线）等待落地（红属预期）；官方行移除在 main 已绿。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import {
  hostApply,
  withRowRemoval,
  hermeticEnvKeys,
  makeOfficialRowConfig,
} from "./helpers/assembly-harness.js";

const WP_SEARCH = "WP5 src/search.js（createSearchChain）+ WP6 src/index.js 装配接线";
const WP_INDEX = "WP6 src/index.js";

test("FB-001/CFG-004（装配面，生产链）：运行时条目增删（生产写路径）下一次查询生效", async (t) => {
  const chainRes = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, chainRes, WP_SEARCH, "FB-001/CFG-004 条目生命周期")) return;
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "FB-001/CFG-004 装配")) return;
  const cfgRes = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfgRes, "WP1 src/config.js", "CFG-004")) return;
  const mod = modRes.module;
  const cfgMod = cfgRes.module;

  hermeticEnvKeys(t); // 清除白名单 env：缺 key 断言不受本机串扰（恢复在 t.after）

  const entries = [C.makeEntry({ id: "e-a", type: "openai", name: "合成 OpenAI 线" })];
  const { host, provider } = hostApply(mod, C.makeSavedConfig([]), { official: { calls: [], async search() { return { sources: [], truncated: false }; } } });
  const port = mod.createSettingsPort(host.ctx);

  // 基线：空列表 → FB-004 未配置终态
  let err = await searchErr(provider, "custom-model-route");
  assert.equal(err.code, C.CHAIN_CODES.NOT_CONFIGURED, "空列表 → CHAIN_NOT_CONFIGURED（FB-004）");

  // 行增（A）：下一次查询生效——全部启用条目缺 key → KEYS_MISSING 且说明缺失项
  await cfgMod.writeConfig(port, { entries: structuredClone(entries), useOfficialDeepSeekSearch: true });
  err = await searchErr(provider, "custom-model-route");
  assert.equal(err.code, C.CHAIN_CODES.KEYS_MISSING, "增行 A（openai，无 key）后下一次查询读到新列表（FB-001/CFG-004）");
  C.assertWebError(err, { code: C.CHAIN_CODES.KEYS_MISSING, attempts: [{ entryId: "e-a", code: C.SKIPPED_NO_KEY }] });
  assert.ok(err.message.includes("OPENAI_API_KEY"), "KEYS_MISSING 须说明缺失项（FB-004）");

  // 行增（B）：顺序按已保存列表从上到下（A→B）
  const entriesB = [
    ...entries,
    C.makeEntry({ id: "e-b", type: "tavily", name: "合成 Tavily 线" }),
  ];
  await cfgMod.writeConfig(port, { entries: structuredClone(entriesB), useOfficialDeepSeekSearch: true });
  err = await searchErr(provider, "custom-model-route");
  assert.equal(err.code, C.CHAIN_CODES.KEYS_MISSING);
  C.assertWebError(err, {
    code: C.CHAIN_CODES.KEYS_MISSING,
    attempts: [
      { entryId: "e-a", code: C.SKIPPED_NO_KEY },
      { entryId: "e-b", code: C.SKIPPED_NO_KEY },
    ],
  });

  // 行删（A，留 B）：下一次查询只剩 B
  await cfgMod.writeConfig(port, { entries: [structuredClone(entriesB[1])], useOfficialDeepSeekSearch: true });
  err = await searchErr(provider, "custom-model-route");
  C.assertWebError(err, {
    code: C.CHAIN_CODES.KEYS_MISSING,
    attempts: [{ entryId: "e-b", code: C.SKIPPED_NO_KEY }],
  });
  assert.ok(!err.message.includes("OPENAI_API_KEY"), "已移除条目 A 不得再出现在缺失项说明中");

  // 行删（B，空）：回到未配置终态
  await cfgMod.writeConfig(port, { entries: [], useOfficialDeepSeekSearch: true });
  err = await searchErr(provider, "custom-model-route");
  assert.equal(err.code, C.CHAIN_CODES.NOT_CONFIGURED, "删空列表 → 下一次查询 CHAIN_NOT_CONFIGURED（FB-004）");

  await host.disposeAll();
});

test("#12-18/B2′（装配面）：官方 web-search-deepseek 行运行时移除 → 下一次官方查询 WEB_PROVIDER_UNAVAILABLE，零回退", async (t) => {
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_INDEX, "#12-18 官方行移除")) return;
  const mod = modRes.module;

  const chainCalls = [];
  const { host, provider } = hostApply(
    mod,
    C.makeSavedConfig([], { useOfficialDeepSeekSearch: true }),
    {
      chain: {
        async search() {
          chainCalls.push(1);
          return { sources: [], truncated: false };
        },
        release() {},
      },
      // 不注入 official：走生产默认 createLazyHostOfficial（真实惰性官方 + 每查询活读行）
    },
    { extraRows: [{ entryId: "web-search-deepseek", config: makeOfficialRowConfig() }] },
  );

  // 行在场：首查询显式失败（凭据未播种，零网络）——记录其形态即可
  let first;
  try {
    await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
    first = null;
  } catch (e) {
    first = e;
  }
  assert.ok(first === null || first instanceof Error, "行在场的首查询必须收敛（成功或显式错误）");
  t.diagnostic(`[WP6 oracle] 行在场首查询：${first ? `code=${first.code}` : "成功"}`);

  // 行移除（运行时）：下一次官方查询必须显式 WEB_PROVIDER_UNAVAILABLE（#12-18），不得回退链
  withRowRemoval(host, "web-search-deepseek");
  let err;
  try {
    await provider.search({ query: "q", llmProvider: C.OFFICIAL_ROUTE_ID });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "行移除后官方查询必须显式失败（不得静默）");
  t.diagnostic(`[WP6 oracle] #12-18 实测：name=${String(err?.name)} code=${String(err?.code)}`);
  assert.equal(
    err.code,
    "WEB_PROVIDER_UNAVAILABLE",
    "官方行运行时移除 → WEB_PROVIDER_UNAVAILABLE（B2′ 每查询活读行，#12-18），实测 code=" + String(err?.code),
  );
  assert.equal(chainCalls.length, 0, "官方行不可用不得回退自定义链（DSH-005：保持此次选择）");
  await host.disposeAll();
});

async function searchErr(provider, llmProvider) {
  let err;
  try {
    await provider.search({ query: "合成查询", llmProvider });
  } catch (e) {
    err = e;
  }
  if (!err) assert.fail("期望终态错误但未抛出");
  return err;
}
