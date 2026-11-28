// WP87 fetch 接管 Oracle — FT-007 fetch 条目模型与凭据边界。
// 观测面：src/constants.js 常量面、writeConfig 写盘（fake-host settingsPort）、fake-fetch 出站头、
// 错误/日志脱敏。面板级回显（FT-007#4 的 DOM 面）与写闸面板错误锚点 = 实现 PR 契约后宿主/面板项（OQ-O7 文档 §1 注记）。
import test from "node:test";
import assert from "node:assert/strict";
import * as constants from "../src/constants.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch, SYNTHETIC_KEY, SYNTHETIC_PAC, SYNTHETIC_PROXY } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { mountFetch, makeFetchConfig } from "./helpers/fetch-oracle.js";

const WP = "WP87 fetch 条目（凭据/写闸/代理边界）";
const URL_PUBLIC = "https://pub.example.com/docs";

function fetchEntry(over = {}) {
  return { id: "fe-1", type: "tavily-extract", name: "Tavily Extract", enabled: true, credentialRef: "fleetseek/fetch/fe-1", ...over };
}

async function gate(t, { entries, env = {}, credentials, fetchTakeover = true, fetchOfficialFallback } = {}) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "FT-007")) return null;
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ default: "never", clock });
  const config = makeFetchConfig({
    fetchTakeover,
    fetchEntries: entries ?? [fetchEntry()],
    ...(fetchOfficialFallback !== undefined ? { fetchOfficialFallback } : {}),
  });
  const m = await mountFetch(res.module, config, {
    fetchDeps: {
      transport: createFakeTransportFactory({ fetchImpl: fetchFn }),
      clock, env,
      credentials: credentials ?? createFakeCredentials({ refs: { "fleetseek/fetch/fe-1": SYNTHETIC_KEY("fetch-fe1") } }),
    },
  });
  assert.ok(m.provider, "fetch provider 必须已注册（FT-001）");
  return { m, fetchFn, clock };
}

const extractOk = (finalUrl = URL_PUBLIC) => ({
  status: 200, body: { results: [{ url: finalUrl, raw_content: "body", response_code: 200 }] },
});

// ── FT-007#1 条目模型分界 ────────────────────────────────────────────────────
test("FT-007#1 搜索目录 TOOL_TYPES 八类型不扩；fetch 类型常量仅 tavily-extract（OQ-O8 命名）", async () => {
  assert.deepEqual(
    [...constants.TOOL_TYPES].sort(),
    ["openai", "tavily", "exa", "brave", "bing", "gemini", "deepseek-search", "deepseek-agentic-search"].sort(),
    "CAT-001 类型目录零改动（红线：不扩 fetch 类型）",
  );
  const fetchTypes = constants.FETCH_TOOL_TYPES ?? constants.FETCH_TYPES ?? constants.TAVILY_FETCH_TYPE?.type;
  assert.ok(fetchTypes, "fetch 侧类型常量缺失（等待实现，OQ-O8）");
  assert.deepEqual([...fetchTypes ?? []], ["tavily-extract"]);
});

test("FT-007#1b fetchEntries 与 entries 分离：非法 fetch 形状不改变搜索 entries 校验面", async (t) => {
  const cfgMod = await tryImportSrc("config.js");
  assert.ok(cfgMod.ok, "config.js 应可加载");
  const { normalizeConfig } = cfgMod.module;
  const base = { entries: [{ id: "e1", type: "tavily", name: "T", enabled: true }], useOfficialDeepSeekSearch: true };
  const ok = normalizeConfig(structuredClone(base));
  assert.equal(ok.entries.length, 1, "搜索 entries 校验语义不受 fetch 面键影响");
  assert.throws(() => normalizeConfig({ ...structuredClone(base), fetchEntries: "not-an-array" }),
    (e) => e?.code === "CONFIG_INVALID", "fetchEntries 必须数组化校验（新键进 normalizeConfig）");
});

// ── FT-007#2/#3 写路径明文清零与 write-only ─────────────────────────────────
test("FT-007#2 明文 key 写入面：fetchEntries 带 apiKey 明文 → 写闸拒 + 磁盘零变化（CFG-W-003 fetch 面等效力）", async (t) => {
  const cfgMod = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfgMod, "WP87 src/config.js", "FT-007#2")) return;
  const { writeConfig } = cfgMod.module;
  const host = createFakeHost({ config: makeFetchConfig() });
  const candidate = {
    ...makeFetchConfig({ fetchTakeover: true }),
    fetchEntries: [{ ...fetchEntry(), apiKey: SYNTHETIC_KEY("plain") }],
  };
  await assert.rejects(writeConfig(host.settingsPort, structuredClone(candidate)),
    (e) => typeof e?.code === "string", "SECRET_FIELD 命中键必须被写路径拒绝");
  const savedDump = JSON.stringify(host.editor.saved());
  assert.ok(!savedDump.includes(SYNTHETIC_KEY("plain")), "明文 key 不得触盘");
});

test("FT-007#2b 合法保存只落 credentialRef；写盘零明文", async (t) => {
  const cfgMod = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, cfgMod, "WP87 src/config.js", "FT-007#2b")) return;
  const { writeConfig } = cfgMod.module;
  const host = createFakeHost({ config: makeFetchConfig() });
  await writeConfig(host.settingsPort, structuredClone(
    makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }),
  ));
  const saved = host.editor.saved();
  assert.equal(saved.fetchEntries?.[0]?.credentialRef, "fleetseek/fetch/fe-1", "fetchEntries 落盘含引用");
  assert.ok(!JSON.stringify(saved).includes("apiKey"), "落盘无 SECRET_FIELD 键名");
});

test("FT-007#3 未触碰 fetch 面保存不落三新键（FT-003#4 写盘粒度）", async () => {
  const cfgMod = await tryImportSrc("config.js");
  assert.ok(cfgMod.ok);
  const { writeConfig } = cfgMod.module;
  const host = createFakeHost({ config: makeFetchConfig() });
  await writeConfig(host.settingsPort, structuredClone({ entries: [], useOfficialDeepSeekSearch: true }));
  const saved = host.editor.saved();
  for (const k of ["fetchTakeover", "fetchEntries", "fetchOfficialFallback"]) {
    assert.ok(!(k in saved), `未触碰时保存不得写 ${k}（磁盘零写入红线）`);
  }
});

// ── FT-007#5 key 归属 / PAC 零携带 ───────────────────────────────────────────
test("FT-007#5 key 只随该条目鉴权头；PAC 下载零携带；无粘头", async (t) => {
  const g = await gate(t, { entries: [fetchEntry({ proxy: { pac: SYNTHETIC_PAC } })] });
  if (!g) return;
  g.fetchFn.when(SYNTHETIC_PAC).responds({ status: 200, body: `function FindProxyForURL(){ return "DIRECT"; }`, headers: { "content-type": "application/x-ns-proxy-autoconfig" } });
  g.fetchFn.when(/.*/).responds(extractOk());
  await g.m.provider.fetch({ url: URL_PUBLIC });
  const pacCalls = g.fetchFn.callsFor(SYNTHETIC_PAC);
  assert.ok(pacCalls.length >= 1, "配置 PAC 的条目应下载 PAC");
  for (const c of pacCalls) {
    assert.ok(!JSON.stringify(c.headers).includes(SYNTHETIC_KEY("fetch-fe1")), "key 不得进入 PAC 下载（CFG-003）");
  }
  const extract = g.fetchFn.calls.filter((c) => !c.url.includes("syn-pac"));
  assert.ok(extract.some((c) => JSON.stringify(c.headers).includes(SYNTHETIC_KEY("fetch-fe1"))), "提取商请求携带该条目 key");
  await g.m.dispose();
});

// ── FT-007#7 CFG-002 解析链（环境变量层）───────────────────────────────────
test("FT-007#7 条目引用缺失 → 目录环境变量层 TAVILY_API_KEY 命中送达", async (t) => {
  const g = await gate(t, {
    entries: [fetchEntry({ credentialRef: undefined })],
    env: { TAVILY_API_KEY: SYNTHETIC_KEY("env-tavily") },
    credentials: createFakeCredentials(),
  });
  if (!g) return;
  g.fetchFn.when(/.*/).responds(extractOk());
  await g.m.provider.fetch({ url: URL_PUBLIC });
  assert.ok(g.fetchFn.calls.some((c) => JSON.stringify(c.headers).includes(SYNTHETIC_KEY("env-tavily"))),
    "CFG-002 第二层环境变量 key 必须送达提取商");
  await g.m.dispose();
});

// ── FT-007#8/#9 代理认证脱敏与不静默回退 ────────────────────────────────────
test("FT-007#8 带认证代理 URL：错误/日志零认证参数（CFG-003）", async (t) => {
  const g = await gate(t, { entries: [fetchEntry({ proxy: "http://secretuser:secretpass@syn-proxy.invalid:8080" })] });
  if (!g) return;
  await g.m.provider.fetch({ url: URL_PUBLIC }).then(
    () => { throw new Error("代理不可达不得成功"); },
    (e) => {
      const dump = `${String(e?.message)} ${JSON.stringify(e?.details ?? {})}`;
      assert.ok(!dump.includes("secretuser"), "错误不得回带代理认证用户名");
      assert.ok(!dump.includes("secretpass"), "错误不得回带代理认证密码");
      assert.ok(typeof e?.code === "string", "代理失败必须带码（CFG-001）");
    },
  );
  await g.m.dispose();
});

test("FT-007#9 固定代理断开：报代理原因且零直连（不静默回退）", async (t) => {
  const g = await gate(t, { entries: [fetchEntry({ proxy: SYNTHETIC_PROXY })] });
  if (!g) return;
  // SYNTHETIC_PROXY 未声明路由：任何实际经代理出站都会以 never 抛错；直连形态必须为零
  await g.m.provider.fetch({ url: URL_PUBLIC }).then(
    () => { throw new Error("代理断开不得静默成功"); },
    (e) => assert.ok(/ENTRY_PROXY|PROXY|代理/.test(String(e?.code) + String(e?.message)), `须报代理原因，实得 ${String(e?.code)}`),
  );
  const directCalls = g.fetchFn.calls.filter((c) => c.init?.route?.kind === "direct");
  assert.equal(directCalls.length, 0, "固定代理故障后直连请求必须为零（CFG-001）");
  await flush();
  await g.m.dispose();
});
