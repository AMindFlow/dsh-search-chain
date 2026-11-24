// WP6 装配面 — 任务 6：总预算（FB-003）DEFAULT_TIMEOUT_MS 默认 + timeoutMs 覆盖在装配层生效。
// 规格依据：
//   FB-003（fallback.md）：插件总预算 timeoutMs 为正整数毫秒，默认 25000；预算从单次搜索开始计算，
//     涵盖凭据、代理、请求和解析；条目到期须取消当前请求；宿主取消或总超时须取消在途操作
//     且不得再请求。
//   contract.js A8：deps.clock = { now, setTimeout, clearTimeout, abortSignal }，测试注入受控
//     时钟，绝不依赖真实等待。
//   contract.js A4（注入面约定）：apply 第三参 testDeps 为测试专用注入面；WP6 若改注入方式须
//     同步契约。本文件钉定装配层预算可测面：testDeps.clock（受控时钟）+ testDeps.fetch
//     （替换全局 fetch 的出站面，零真实网络）——生产链在装配时以二者替换默认时钟/全局 fetch。
// 红/绿预期：预算常量核对在 main 已绿；两预算行为测试等待 WP5 真实链 + WP6 装配接线
// （src/search.js 缺失即红，红属预期；若 final apply 不接受 clock/fetch 注入面，红同样属预期，
// 诊断会指明未收敛/未生效，dev 须接线或按 A4 流程改契约）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { flush, createControlledClock } from "./helpers/clock.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { hostApply, hermeticEnvKeys } from "./helpers/assembly-harness.js";

const WP_SEARCH = "WP5 src/search.js + WP6 src/index.js（装配层预算接线：testDeps.clock/fetch 注入面，A4/A8）";

/** 挂起型假 fetch：记录出站但永不 settle（零真实网络）。 */
function hangingFetch() {
  const calls = [];
  const fetchFn = (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise(() => {}); // 永不 resolve/reject：条目预算必须负责收尾
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/** 拨钟驱动直到 promise 收敛；返回 { ok, value|error, elapsed } 或 null（受控时间内未收敛）。 */
async function runWithClock(clock, promise, capMs = 60000) {
  let outcome = null;
  promise.then(
    (value) => {
      outcome = { ok: true, value };
    },
    (error) => {
      outcome = { ok: false, error };
    },
  );
  const t0 = clock.now();
  while (!outcome) {
    await flush(2);
    if (outcome) break;
    if (clock.pending().length === 0) break; // 无任何受控定时器：预算未接注入时钟（或已无收尾手段）
    clock.advance(1000);
    if (clock.now() - t0 > capMs) break;
  }
  await flush(3);
  if (!outcome) return null;
  return { ...outcome, elapsed: clock.now() - t0 };
}

const BING_ENTRY = { id: "e-bing", type: "bing", name: "合成 Bing 通道" };

function makeBudgetHarness(mod, cfg, fetchFn) {
  const clock = createControlledClock();
  const { host, provider } = hostApply(mod, cfg, {
    clock,
    fetch: fetchFn,
    official: { calls: [], async search() { return { sources: [], truncated: false }; } },
  });
  return { host, provider, clock };
}

test("FB-003：DEFAULT_TIMEOUT_MS 常量 = 25000（FB-003 默认总预算，契约 A8/DEFAULT_TIMEOUT_MS）", async (t) => {
  const res = await tryImportSrc("constants.js");
  if (failIfUnimplemented(t, res, "WP0 src/constants.js", "FB-003 DEFAULT_TIMEOUT_MS")) return;
  assert.equal(res.module.DEFAULT_TIMEOUT_MS, C.DEFAULT_TIMEOUT_MS, "src/constants.js DEFAULT_TIMEOUT_MS 必须为 25000");
  assert.equal(C.DEFAULT_TIMEOUT_MS, 25000, "契约常量 DEFAULT_TIMEOUT_MS=25000（FB-003）");
});

test("FB-003（装配面）：默认预算 25000ms——无 timeoutMs 配置时挂起条目在 ~25s（假时钟）收尾，单请求、在途取消", async (t) => {
  const chainRes = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, chainRes, WP_SEARCH, "FB-003 默认预算（装配层）")) return;
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_SEARCH, "FB-003 默认预算（装配层）")) return;
  const mod = modRes.module;

  hermeticEnvKeys(t);
  const fetchFn = hangingFetch();
  // 无 timeoutMs 字段 → 默认 25000
  const cfg = C.makeSavedConfig([{ ...BING_ENTRY, enabled: true }]);
  const { host, provider, clock } = makeBudgetHarness(mod, cfg, fetchFn);

  const out = await runWithClock(clock, provider.search({ query: "合成查询", llmProvider: "custom-model-route" }));
  assert.ok(out, "预算必须经注入时钟收尾：受控时间内未收敛 = 装配层未接 testDeps.clock（A8）或未驱动总预算");
  assert.ok(out.ok === false, "挂起条目不得产生成功结果");
  const err = out.error;
  t.diagnostic(
    `[WP6 oracle] FB-003 默认预算实测：elapsed=${out.elapsed}ms code=${String(err?.code)} attempts=${JSON.stringify(err?.details?.attempts ?? []).slice(0, 200)}`,
  );
  assert.ok(out.elapsed >= C.DEFAULT_TIMEOUT_MS - 10 && out.elapsed <= C.DEFAULT_TIMEOUT_MS + 1000,
    `默认预算须在 ~${C.DEFAULT_TIMEOUT_MS}ms 收尾（实测 ${out.elapsed}ms）——提前=预算未生效，过晚=超发`);
  assert.equal(err?.name, "WebError", "超预算终态必须为 WebError（A7）");
  assert.ok(
    [C.CHAIN_CODES.UPSTREAM_FAILURES, C.CHAIN_CODES.BUDGET_EXHAUSTED].includes(err?.code),
    `终态码应为 CHAIN_UPSTREAM_FAILURES 或 CHAIN_BUDGET_EXHAUSTED（FB-003/FB-004），实测=${String(err?.code)}`,
  );
  assert.ok(Array.isArray(err?.details?.attempts) && err.details.attempts.length >= 1, "终态须附 attempts（FB-004）");
  const hit = err.details.attempts.find((a) => a.entryId === BING_ENTRY.id);
  assert.ok(hit, "attempts 必须包含挂起条目");
  assert.equal(hit.code, C.ENTRY_CODES.TIMEOUT, "挂起条目分类 = ENTRY_TIMEOUT（FB-005 单项超时），实测=" + String(hit.code));
  assert.equal(fetchFn.calls.length, 1, "每个条目最多向其供应商提交一次查询（FB-001），实测=" + fetchFn.calls.length);

  // FB-003：总超时须取消在途操作且不得再请求
  clock.advance(30000);
  await flush(5);
  assert.equal(fetchFn.calls.length, 1, "总超时后不得再发出新请求（FB-003 取消在途且不再请求）");
  await host.disposeAll();
});

test("FB-003（装配面）：timeoutMs 覆盖在装配层生效——timeoutMs=8000 时挂起条目在 ~8s（假时钟）收尾", async (t) => {
  const chainRes = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, chainRes, WP_SEARCH, "FB-003 timeoutMs 覆盖（装配层）")) return;
  const modRes = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, modRes, WP_SEARCH, "FB-003 timeoutMs 覆盖（装配层）")) return;
  const mod = modRes.module;

  hermeticEnvKeys(t);
  const fetchFn = hangingFetch();
  const cfg = C.makeSavedConfig([{ ...BING_ENTRY, enabled: true }], { timeoutMs: 8000 });
  const { host, provider, clock } = makeBudgetHarness(mod, cfg, fetchFn);

  const out = await runWithClock(clock, provider.search({ query: "合成查询", llmProvider: "custom-model-route" }), 30000);
  assert.ok(out, "预算必须经注入时钟收尾（同默认预算用例的诊断）");
  assert.ok(out.ok === false, "挂起条目不得产生成功结果");
  t.diagnostic(
    `[WP6 oracle] FB-003 覆盖预算实测：elapsed=${out.elapsed}ms code=${String(out.error?.code)}（配置 timeoutMs=8000）`,
  );
  assert.ok(out.elapsed >= 7990 && out.elapsed <= 9000,
    `timeoutMs=8000 必须在 ~8000ms 收尾（实测 ${out.elapsed}ms）——若为 ~25000 说明覆盖未生效（仍用默认）`);
  assert.equal(out.error?.name, "WebError");
  assert.equal(fetchFn.calls.length, 1, "覆盖预算下仍每条目至多一次查询（FB-001）");
  await host.disposeAll();
});
