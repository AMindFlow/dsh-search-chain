// helpers 自测（WP0 oracle，全绿）：替身可用性 + seam 可满足性证明。
// 文件内的 toyChain/toyProvider 是「契约可被满足」的黄金样例参考实现，仅供自测；
// 不是产品实现，dev 不得据此认为 WP5/WP6 已完成（产品测试在 dsh-*.test.js / config-contract.test.js，当前为红）。
// 覆盖：clock / fake-fetch / fake-transport / fake-credentials / fake-host / fake-backend /
//       chain-harness+provider-harness / redact / impl（DSH-001..005、CFG-001..004、FB-002..005 的替身面）。
import test from "node:test";
import assert from "node:assert/strict";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch, SYNTHETIC_KEY, SYNTHETIC_PROXY, SYNTHETIC_PAC } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { createScriptedBackend, stepSuccess, stepEmpty, stepFail, stepHang, stepLate, stepProgramError } from "./helpers/fake-backend.js";
import { createChainHarness, createProviderHarness, DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { assertNoSecrets, assertNoCredentialUserinfo, assertNoRawBody, createLogCapture } from "./helpers/redact.js";
import { tryImportSrc, failIfUnimplemented, srcPath } from "./helpers/impl.js";
import * as C from "./helpers/contract.js";

test("clock：拨钟按到期顺序触发，负延时登记钳制，clear 生效（FB-003 面）", async () => {
  const clock = createControlledClock({ now: 1000 });
  const order = [];
  clock.setTimeout(() => order.push("b"), 200);
  clock.setTimeout(() => order.push("a"), 100);
  const cancelled = clock.setTimeout(() => order.push("x"), 50);
  clock.clearTimeout(cancelled);
  clock.setTimeout(() => order.push("neg"), -5); // 钳制 0 并登记
  assert.equal(clock.now(), 1000);
  clock.advance(300);
  assert.deepEqual(order, ["neg", "a", "b"]);
  assert.equal(clock.invalidTimings.length, 1);
  assert.equal(clock.invalidTimings[0].clampedTo, 0);
  assert.equal(clock.nextDue(), null);
  assert.equal(clock.pending().length, 0);
});

test("clock.abortSignal：已中止立即触发，未中止可撤销", async () => {
  const clock = createControlledClock();
  const ac = new AbortController();
  let fired = 0;
  const h1 = clock.abortSignal(ac.signal, () => fired++);
  h1.cancel();
  ac.abort();
  await flush(2);
  assert.equal(fired, 0, "撤销后不得触发");
  clock.abortSignal(ac.signal, () => fired++);
  await flush(2);
  assert.equal(fired, 1, "已中止 signal 立即触发");
});

test("fake-fetch：声明式路由、记录、未声明出站即抛、abort 生效", async () => {
  const fetchFn = createFakeFetch();
  fetchFn.when("synthetic-host.test/ok").responds({ status: 201, body: { ok: true } });
  fetchFn.when("synthetic-host.test/fail").fails();
  const res = await fetchFn("https://synthetic-host.test/ok", { headers: { Authorization: `Bearer ${SYNTHETIC_KEY("tavily")}` } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
  const rec = fetchFn.callsFor("ok")[0];
  assert.equal(rec.headers.authorization, `Bearer ${SYNTHETIC_KEY("tavily")}`);
  await assert.rejects(fetchFn("https://synthetic-host.test/fail"));
  await assert.rejects(fetchFn("https://never-declared.invalid/"), /未声明的出站调用/);
  assert.equal(fetchFn.count(), 3);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(fetchFn("https://synthetic-host.test/ok", { signal: ac.signal }), (e) => e.name === "AbortError");
});

test("fake-fetch：受控时钟延时与 hangs 挂起由拨钟/abort 驱动（FB-003 面）", async () => {
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ clock });
  fetchFn.when("slow.host.test").responds({ body: { done: true }, delayMs: 500 });
  fetchFn.when("hang.host.test").hangs();
  let settled = "pending";
  const p = fetchFn("https://slow.host.test").then(() => (settled = "ok"), () => (settled = "err"));
  await flush(2);
  assert.equal(settled, "pending", "未拨钟不得完成——链路时间必须受控");
  clock.advance(500);
  await p;
  assert.equal(settled, "ok");

  const ac = new AbortController();
  const h = fetchFn("https://hang.host.test", { signal: ac.signal });
  await flush(2);
  ac.abort();
  await assert.rejects(h, (e) => e.name === "AbortError");
});

test("fake-fetch：合成常量符合卫生约定（保留 TLD + synthetic 标记）", () => {
  for (const u of [SYNTHETIC_PROXY, SYNTHETIC_PAC]) assert.match(u, /\.invalid(:|\/)/);
  assert.match(SYNTHETIC_PAC, /\?v=3$/, "CFG-005 示例须保留查询参数");
  assert.match(SYNTHETIC_KEY("openai"), /sk-synthetic-.*DO-NOT-LOG/);
});

test("fake-transport：open/close 生命周期与计数（CFG-004/FB-001 面）", () => {
  const f = createFakeTransportFactory();
  const h1 = f.open(C.makeEntry({ id: "e1" }));
  const h2 = f.open(C.makeEntry({ id: "e2" }));
  assert.deepEqual(f.openedEntryIds, ["e1", "e2"]);
  assert.equal(f.allClosed(), false);
  h1.close();
  h1.close();
  assert.equal(h1.closeCount, 2);
  assert.equal(f.handleFor("e1")[0].closed, true);
  h2.close();
  assert.equal(f.allClosed(), true);
  assert.equal(f.openCount(), 2);
});

test("fake-credentials：两 key 空间、读取记录、注入故障（CFG-002/CFG-003 面）", async () => {
  const creds = createFakeCredentials({
    refs: { "ref:e1": SYNTHETIC_KEY("openai") },
    records: { TAVILY_API_KEY: SYNTHETIC_KEY("tavily") },
    failRefReads: ["ref:broken"],
  });
  assert.equal(await creds.resolve("ref:e1"), SYNTHETIC_KEY("openai"));
  assert.equal((await creds.readRecord("TAVILY_API_KEY")).value, SYNTHETIC_KEY("tavily"));
  assert.equal(await creds.readRecord("EXA_API_KEY"), undefined);
  assert.deepEqual(creds.resolveCalls, ["ref:e1"]);
  assert.deepEqual(creds.recordCalls, ["TAVILY_API_KEY", "EXA_API_KEY"], "未命中也必须留痕（可观察性）");
  creds.removeRef("ref:e1");
  assert.equal(await creds.resolve("ref:e1"), undefined);
  await assert.rejects(creds.resolve("ref:broken"));
  await creds.modifyRecord("OPENAI_API_KEY", (cur) => ({ name: "OPENAI_API_KEY", value: SYNTHETIC_KEY("openai") }));
  assert.equal((await creds.readRecord("OPENAI_API_KEY")).value, SYNTHETIC_KEY("openai"));
  assert.equal(creds.totalReads(), 6, '3 resolve + 3 readRecord');
});

test("fake-host：注册/重复注册/反注册/effect 清理/configEditor 失败语义（DSH-001 面）", async () => {
  const host = createFakeHost({ config: { entries: [] } });
  const disposer = host.ctx.web.registerSearchProvider({ id: "search-chain", available: () => true, search: async () => ({ sources: [], truncated: false }) });
  assert.equal(host.searchRegistrationCount(), 1);
  assert.deepEqual(host.providerIds(), ["search-chain"]);
  assert.throws(
    () => host.ctx.web.registerSearchProvider({ id: "search-chain", available: () => true, search: async () => ({}) }),
    (e) => e.name === "WebError" && e.code === "WEB_DUPLICATE_PROVIDER",
  );
  disposer();
  assert.equal(host.searchRegistrationCount(), 0);
  assert.equal(host.disposedCount("search-chain"), 1);

  let cleaned = 0;
  host.ctx.effect(() => () => cleaned++);
  await host.disposeAll();
  assert.equal(cleaned, 1);

  await host.editor.edit(host.entry, (cur) => ({ ...cur, timeoutMs: 5 }));
  assert.equal(host.editor.saved().timeoutMs, 5);
  host.editor.failNext = new Error("synthetic save failure");
  await assert.rejects(host.editor.edit(host.entry, (cur) => ({ ...cur, timeoutMs: 999 })));
  assert.equal(host.editor.saved().timeoutMs, 5, "保存失败后已生效快照保持一致（CFG-004/SET-004）");
});

test("fake-backend：脚本顺序消费、末步重复、默认挂起、失败带码、late 与 programError（A5/FB 面）", async () => {
  const ctxFor = (entry, extra = {}) => ({
    entry,
    query: DEFAULT_QUERY,
    key: "k",
    fetch: null,
    budgetMs: 1000,
    clock: createControlledClock(),
    signal: undefined,
    ...extra,
  });
  const b = createScriptedBackend("tavily", {
    e1: [stepFail({ code: C.ENTRY_CODES.NETWORK }), stepSuccess({ sources: C.makeSources(1) })],
    e2: [stepEmpty()],
  });
  await assert.rejects(b.search(ctxFor({ id: "e1" })), (e) => e.code === C.ENTRY_CODES.NETWORK);
  const r1 = await b.search(ctxFor({ id: "e1" }));
  assert.equal(r1.sources.length, 1);
  const r1b = await b.search(ctxFor({ id: "e1" }));
  assert.equal(r1b.sources.length, 1, "末步重复，防测试遗漏假通过");
  assert.deepEqual((await b.search(ctxFor({ id: "e2" }))).sources, []);
  assert.equal(b.callCount("e1"), 3);

  const bp = createScriptedBackend("bing", { e: [stepProgramError({})] });
  await assert.rejects(bp.search(ctxFor({ id: "e" })), TypeError, "程序违约无 code 原样抛");

  const clock = createControlledClock();
  const bh = createScriptedBackend("bing", { e: [stepLate({ sources: C.makeSources(2), resolveAfterMs: 100 })] });
  const ac = new AbortController();
  ac.abort();
  const lateP = bh.search(ctxFor({ id: "e" }, { clock, signal: ac.signal }));
  await flush(2);
  clock.advance(100); // 受控时钟不拨不前进；late 步骤无视 abort 完成
  const late = await lateP;
  assert.equal(late.sources.length, 2, "late 步骤无视 abort 完成，由链忽略（FB-003）");
});

test("redact：秘密扫描深度覆盖错误与日志，假阳面不误伤", () => {
  const cap = createLogCapture();
  cap.log("warn", "条目 e1 失败", { cause: "响应体 <html>blocked</html> token=" + SYNTHETIC_KEY("openai") });
  assert.throws(() => assertNoSecrets(null, cap.text(), [SYNTHETIC_KEY("openai")], "日志"), /CFG-003/);
  assert.throws(() => assertNoRawBody(null, "上游返回 <html>…</html>", "错误文本"), /CFG-003/);
  assert.throws(() => assertNoCredentialUserinfo(null, "代理不可达 http://syn-proxy.invalid:8080 via user:hunter2@upstream.example:3128", "日志"), /认证信息/);
  const err = new Error("干净消息");
  err.detail = { ref: "ref:e1", note: "缺 OPENAI_API_KEY" };
  assertNoSecrets(null, err, [SYNTHETIC_KEY("openai")], "干净错误");
  assertNoCredentialUserinfo(null, err, "干净错误");
});

test("impl：缺失模块报 missing，越界拒绝（红/绿策略基础）", async () => {
  const res = await tryImportSrc("definitely-not-implemented-xyz.js");
  assert.deepEqual(res, { ok: false, reason: "missing" });
  assert.throws(() => srcPath("../outside.js"), /越界/);
  // TestContext 无 .fail：记红走 t.diagnostic + assert.fail（抛 AssertionError，非 skip）
  const fakeT = { diagnostics: [], skips: 0, diagnostic(m) { this.diagnostics.push(m); }, skip() { this.skips++; } };
  assert.throws(
    () => failIfUnimplemented(fakeT, res, "WP5 src/search.js", "FB-003"),
    (e) => e instanceof assert.AssertionError && /等待实现 WP5 src\/search\.js/.test(e.message),
    "缺失须记红：抛 AssertionError，且失败原因可定位到工作包",
  );
  assert.equal(fakeT.diagnostics.length, 1, "必须输出 [WP0 oracle] 条款诊断");
  assert.match(fakeT.diagnostics[0], /\[WP0 oracle\] FB-003: 等待实现 WP5 src\/search\.js/);
  assert.equal(fakeT.skips, 0, "缺失实现不得 skip，必须红");
});

test("chain-harness：toyChain 满足 A4/A5/A6 接缝，观测面全部可用（FB-001/002/004 面）", async () => {
  const toyChain = (deps) => ({
    released: false,
    async search(request, signal) {
      const config = deps.getConfig();
      const enabled = config.entries.filter((e) => e.enabled);
      if (enabled.length === 0) {
        const err = new Error("未配置可用搜索工具");
        err.name = "WebError";
        err.code = C.CHAIN_CODES.NOT_CONFIGURED;
        err.details = { attempts: [] };
        throw err;
      }
      const attempts = [];
      let sources = [];
      let usedName = null;
      for (const entry of enabled) {
        const handle = deps.transport.open(entry);
        try {
          const backend = deps.backends.get(entry.type);
          const result = await backend.search({
            entry,
            query: request.query,
            maxResults: request.maxResults,
            key: null,
            fetch: handle.fetch,
            budgetMs: deps.getConfig().timeoutMs ?? C.DEFAULT_TIMEOUT_MS,
            signal,
            clock: deps.clock,
            log: deps.log,
          });
          usedName = entry.name;
          sources = result.sources;
          break;
        } catch (e) {
          attempts.push({ entryId: entry.id, entryType: entry.type, entryName: entry.name, code: e.code ?? "ENTRY_BAD_RESPONSE", reason: e.message });
        } finally {
          handle.close();
        }
      }
      if (sources.length === 0) {
        const err = new Error("全部条目未获有效来源");
        err.name = "WebError";
        err.code = C.CHAIN_CODES.UPSTREAM_FAILURES;
        err.details = { attempts };
        throw err;
      }
      const truncated = request.maxResults != null && sources.length > request.maxResults;
      if (truncated) sources = sources.slice(0, request.maxResults);
      return {
        sources,
        truncated,
        ...(attempts.length > 0 ? { content: `已由「${usedName}」返回结果（前序条目失败/跳过）` } : {}),
      };
    },
    release() {
      this.released = true;
    },
  });

  const e1 = C.makeEntry({ id: "e1", type: "tavily", name: "合成 Tavily 一" });
  const e2 = C.makeEntry({ id: "e2", type: "openai", name: "合成 OpenAI 二" });
  const h = createChainHarness(toyChain, {
    entries: [e1, e2],
    timeoutMs: 2000,
    steps: {
      e1: [stepFail({ code: C.ENTRY_CODES.NETWORK, message: "合成网络失败" })],
      e2: [stepSuccess({ sources: C.makeSources(4), consumeMs: 300 })],
    },
  });

  const result = await h.runToValue(h.search({ query: DEFAULT_QUERY, maxResults: 3 }), 10_000);
  C.assertSearchResult(test_assert_t_shim(), result, {
    sources: C.makeSources(3),
    entryName: "合成 OpenAI 二",
    maxResults: 3,
    truncated: true,
  });
  assert.deepEqual(h.executions().map((x) => x.entryId), ["e1", "e2"], "FB-001 顺序");
  assert.equal(h.executionCount("e2"), 1, "每条目至多一次提交（FB-001）");
  assert.equal(h.transport.allClosed(), true, "结束后释放连接（CFG-004）");
  assert.equal(h.transport.openedEntryIds.length, 2);
  assert.deepEqual([...h.clock.invalidTimings], []);

  // FB-003：consumeMs=300 说明实现只走注入 clock；真实墙钟不应等待（快速通过即证明）。
  // 再查一次只剩必败条目：末步重复（fail）→ 终态 UPSTREAM_FAILURES 且 attempts 含条目码。
  h.setConfig(C.makeSavedConfig([e1]));
  const err = await h.runToError(h.search());
  assert.equal(err.code, C.CHAIN_CODES.UPSTREAM_FAILURES);
  C.assertWebError(err, {
    code: C.CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [{ entryId: "e1", code: C.ENTRY_CODES.NETWORK }],
  });
  // 空配置 → NOT_CONFIGURED（FB-004 空配置）
  h.setConfig(C.makeSavedConfig([]));
  const err2 = await h.runToError(h.search());
  assert.equal(err2.code, C.CHAIN_CODES.NOT_CONFIGURED);
  assert.deepEqual(err2.details.attempts, []);
  h.chain.release();
  assert.equal(h.chain.released, true);
});

function test_assert_t_shim() {
  // assertSearchResult 只用 t 作签名兼容位，不产生断言副作用
  return { diagnostic() {} };
}

test("provider-harness：toyProvider 满足 DSH-005 路由接缝（矩阵在红文件对真实实现复验）", async () => {
  const toyMakeProvider = (deps) => {
    const routeOf = deps.routeOf ?? ((request) => request?.llmProvider);
    return {
      id: C.PROVIDER_ID,
      available: () => true,
      async search(request, signal) {
        const config = deps.getConfig();
        const wantOfficial = config.useOfficialDeepSeekSearch !== false
          && Boolean(deps.official)
          && routeOf(request) === (deps.officialRouteId ?? C.OFFICIAL_ROUTE_ID);
        if (wantOfficial) return deps.official.search(request, signal);
        return deps.chain.search(request, signal);
      },
      release() {
        deps.chain.release?.();
      },
    };
  };
  const officialResult = { sources: C.makeSources(1), truncated: false, content: "official" };
  const h = createProviderHarness(toyMakeProvider, { officialBehavior: officialResult });
  const r = await h.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(r, officialResult, "官方分支结果原样返回（DSH-005 直接返回）");
  assert.equal(h.chainRequestCount(), 0, "官方分支不触碰自定义链");
  assert.equal(h.officialRequestCount(), 1);

  h.setConfig({ entries: [], useOfficialDeepSeekSearch: false });
  await h.search({ query: DEFAULT_QUERY, llmProvider: C.OFFICIAL_ROUTE_ID });
  assert.equal(h.chainRequestCount(), 1, "开关关闭走自定义链");

  await h.search({ query: DEFAULT_QUERY, llmProvider: C.DEEPSEEK_ACCOUNT_ROUTE_ID });
  assert.equal(h.officialRequestCount(), 1, "账号模式走自定义链（DSH-005）");
  h.provider.release();
  assert.equal(h.releaseCount(), 1);
});
