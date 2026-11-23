// WP0 验收 — DSH-002 provider 可用性与时序。
// 覆盖条款：
//   DSH-002：available() 同步返回布尔，不发起网络/不抛错；search() 每次调用只发一个查询，
//            请求对象透传给链（不重写 query/maxResults/llmProvider）；链结果原样透传；
//            链的 FB-004 终态错误（WebError+attempts）原样上报宿主，不吞错、不包装。
// 契约：helpers/contract.js A1/A4/A7。实现方（WP6）不得弱化断言。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createProviderHarness, DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP6 src/index.js";

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-002")) return null;
  return res.module;
}

const CONFIG = C.makeSavedConfig([C.makeEntry({ id: "e-bing", type: "bing", name: "合成 Bing 通道" })]);

test("DSH-002：available() 同步布尔，不触碰链与官方路径", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = createProviderHarness(mod.createSearchProvider, {
    config: CONFIG,
    official: "absent",
  });
  const v = h.provider.available();
  assert.equal(typeof v, "boolean", "available() 必须同步返回布尔（A1），绝不可返回 Promise/网络探测");
  assert.equal(h.chainRequestCount(), 0, "available() 不得发起搜索");
  assert.equal(h.officialRequestCount(), 0);
});

test("DSH-002：一次调用一个查询；请求透传；结果原样返回", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const stubResult = { sources: C.makeSources(2), truncated: false, content: "链产出" };
  const chainCalls = [];
  const h = createProviderHarness(mod.createSearchProvider, {
    config: CONFIG,
    official: "absent",
    chain: {
      async search(request, signal) {
        chainCalls.push({ request, signal });
        return stubResult;
      },
    },
  });
  const request = { query: DEFAULT_QUERY, maxResults: 5, llmProvider: "some-custom-route" };
  const out = await h.search(request);
  assert.equal(chainCalls.length, 1, "每次宿主调用只允许一个查询（DSH-002/R8 单查询）");
  assert.deepEqual(chainCalls[0].request, request, "请求必须原样透传，不得改写（DSH-002）");
  assert.equal(out, stubResult, "链结果对象必须原样透传给宿主（DSH-002）");
});

test("DSH-002：signal 透传；无 signal 调用也不得崩溃", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const chainCalls = [];
  const h = createProviderHarness(mod.createSearchProvider, {
    config: CONFIG,
    official: "absent",
    chain: {
      async search(request, signal) {
        chainCalls.push({ request, signal });
        return { sources: [], truncated: false };
      },
    },
  });
  const ac = new AbortController();
  await h.search({ query: DEFAULT_QUERY, llmProvider: "x" }, ac.signal);
  assert.equal(chainCalls[0].signal, ac.signal, "宿主取消信号必须传给链（DSH-002/FB-003 共享取消）");
  await h.search({ query: DEFAULT_QUERY, llmProvider: "x" }); // 无 signal
  assert.equal(chainCalls.length, 2);
});

test("DSH-002：链的 FB-004 终态错误原样上报（同一错误对象）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const terminal = {
    name: "WebError",
    code: C.CHAIN_CODES.ALL_KEYS_MISSING,
    message: "全部启用条目缺少必要凭据：缺 OPENAI_API_KEY",
    details: {
      attempts: [
        {
          entryId: "e-openai",
          entryType: "openai",
          entryName: "合成 OpenAI 线",
          code: C.SKIPPED_NO_KEY,
          reason: "缺 OPENAI_API_KEY",
        },
      ],
    },
  };
  const h = createProviderHarness(mod.createSearchProvider, {
    config: CONFIG,
    official: "absent",
    chain: {
      async search() {
        throw terminal;
      },
    },
  });
  const err = await assert.rejects(h.search({ query: DEFAULT_QUERY, llmProvider: "x" }));
  assert.equal(err, terminal, "终态错误必须原样上报：不得吞掉、重包装或降级为普通文本（DSH-002/FB-004）");
  C.assertWebError(err, {
    code: C.CHAIN_CODES.ALL_KEYS_MISSING,
    attempts: [{ entryId: "e-openai", code: C.SKIPPED_NO_KEY }],
  });
});
