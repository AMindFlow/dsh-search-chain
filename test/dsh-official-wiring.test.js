// WP0 验收 — official.js B2′ 宿主行读取面（终审轮迁入仓库外模拟脚本关键用例）。
// 覆盖变异面：M13 匹配必须走 entry.options.id（宿主 Entry.id 是 include: 前缀 getter，按 id 匹配永假）；
// M14 行缺席 → WEB_PROVIDER_UNAVAILABLE 显式失败（无回退、无缺省）；M8 行内空串 apiKey 不算 key，
// 回落凭据解析链；thunk 每查询活读行（保存后 baseURL/apiKeyEnv 变化下次查询即生效，非装载固化）。
// 宿主包为 package.json 精确版本实装依赖——createLazyHostOfficial 构造的是真 DeepSeekSearchProvider。
// 零网络设计：行凭据不播种 → resolveApiKey 在 fetch 之前即 WebError 终止；行 baseURL 指向
// RFC 2606 保留域 .invalid（即便误达也仅本地 NXDOMAIN），凭据链走 fake-credentials spy。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createHostShapeFakeHost } from "./helpers/fake-host.js";

const WP = "WP6 src/official.js";

async function load(t) {
  const res = await tryImportSrc("official.js");
  if (failIfUnimplemented(t, res, WP, "DSH-005/B2′")) return null;
  return res.module;
}

function hostWithRow(rowConfig) {
  return createHostShapeFakeHost({
    config: C.makeSavedConfig([]),
    extraRows: [{ entryId: "web-search-deepseek", config: rowConfig }],
  });
}

test("B2′ M13：官方行匹配必须走 entry.options.id——前缀 entry.id 不得参与匹配", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const host = hostWithRow({ baseURL: "https://row.example/v1", apiKeyEnv: "ENV_ROW_A" });
  const rows = host.configuration();
  assert.equal(rows[1].entry.id, "include:web-search-deepseek", "替身行携宿主实证前缀 id（匹配必须绕过它）");
  const merged = mod.requireHostSearchRow(host.ctx);
  assert.equal(merged.baseURL, "https://row.example/v1", "命中行有效配置=inherited⊕override");
  assert.equal(merged.apiKeyEnv, "ENV_ROW_A");
  // M13 变异红面：改成 r.entry.id === "web-search-deepseek" 匹配 → 前缀 getter 下永假 → 上方抛错红。
});

test("B2′ M14：官方行缺席 → WEB_PROVIDER_UNAVAILABLE 显式失败，无回退链", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const host = createHostShapeFakeHost({ config: C.makeSavedConfig([]) });
  let err;
  try {
    mod.requireHostSearchRow(host.ctx);
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.code === "WEB_PROVIDER_UNAVAILABLE", "行缺席必须显式抛 WEB_PROVIDER_UNAVAILABLE");
  // 全路径同形：lazy official provider 首查询 thunk 读行失败必须同码终止，不得静默回退自定义链（D-B2）。
  const host2 = createHostShapeFakeHost({ config: C.makeSavedConfig([]) });
  const official = await mod.createLazyHostOfficial(host2.ctx)();
  let err2;
  try {
    await official.search({ query: "q" });
  } catch (e) {
    err2 = e;
  }
  assert.ok(err2 && err2.code === "WEB_PROVIDER_UNAVAILABLE", "全官方查询路径：读行失败显式终止，零回退");
});

test("B2′ thunk 每查询活读行：保存 apiKeyEnv 变化后下次查询即生效（非装载固化）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const host = hostWithRow({ baseURL: "https://row.invalid/v1", apiKeyEnv: "ENV_ROW_A" });
  const official = await mod.createLazyHostOfficial(host.ctx)();
  const spy = host.credentials; // fake-credentials.resolveCalls：凭据链实际被请求解析的 ref 序列
  let e1;
  try {
    await official.search({ query: "q1" });
  } catch (e) {
    e1 = e;
  }
  assert.ok(e1, "凭据未播种 → 解析在 fetch 前终止，搜索显式失败（零网络设计）");
  assert.ok(
    spy.resolveCalls.some((r) => String(r) === "ENV_ROW_A"),
    "首查询按行装载值 apiKeyEnv=ENV_ROW_A 走凭据解析链",
  );
  const rowEntry = host.configuration()[1].entry;
  await host.editor.edit(rowEntry, (raw, inherited) => ({ ...inherited, ...raw, apiKeyEnv: "ENV_ROW_B" }));
  let e2;
  try {
    await official.search({ query: "q2" });
  } catch (e) {
    e2 = e;
  }
  assert.ok(e2, "第二查询同形显式失败（零网络）");
  assert.ok(
    spy.resolveCalls.some((r) => String(r) === "ENV_ROW_B"),
    "保存后 apiKeyEnv=ENV_ROW_B：thunk 每查询重读活行（装载固化/快照缓存实现当场红）",
  );
});

test("B2′ M8：行内空串 apiKey 不算字面 key → 回落凭据解析链", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const host = hostWithRow({ baseURL: "https://row.invalid/v1", apiKeyEnv: "ENV_ROW_M8", apiKey: "" });
  const official = await mod.createLazyHostOfficial(host.ctx)();
  const spy = host.credentials;
  let e;
  try {
    await official.search({ query: "q" });
  } catch (err) {
    e = err;
  }
  assert.ok(e, "显式失败无回退（纯空白/空串=缺失，CFG-002 同律）");
  assert.ok(
    spy.resolveCalls.some((r) => String(r) === "ENV_ROW_M8"),
    "空串字面 key 必须短路失效并回落 resolveApiKey 链（字面串直发的实现红）",
  );
});
