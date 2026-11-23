// EXA-001 请求侧验收（docs/specs/draft/exa.md）。全红：src/backends/exa.js 尚未实现，等待 WP9。
// 覆盖条款：EXA-001「要求」中的 POST 端点、x-api-key 鉴权、query、type:"auto"、highlights、
//           numResults（仅宿主提供上限时发送）；FB-001「缺 key 零出站」在适配器级的体现。
// 验收：用替身核对单次请求的鉴权、查询、结果数和内容参数（EXA-001 验收）。
// 待办见 helpers/exa-oracle.js 文件头（TODO-EXA-1/2/5/8/11）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXA_ENDPOINT,
  EXA_KEY,
  EXA_QUERY,
  loadExaBackend,
  makeExaCtx,
  onlyCall,
  routeExa,
  sentBody,
  settle,
  exaOk,
  exaResult,
} from "./helpers/exa-oracle.js";

const CLAUSE = "EXA-001 请求";

test("EXA-001 请求：每次尝试恰好一次 POST 到 https://api.exa.ai/search（精确端点）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  const call = onlyCall(fetch);
  assert.equal(call.url, EXA_ENDPOINT, "端点必须精确为 https://api.exa.ai/search（EXA-001）");
  assert.equal(call.method, "POST", "必须使用 POST（EXA-001）");
});

test("EXA-001 请求：鉴权使用 x-api-key，值为 A4 注入的 ctx.key", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  const call = onlyCall(fetch);
  assert.equal(call.headers["x-api-key"], EXA_KEY, "x-api-key 头必须等于注入的 key（EXA-001 鉴权）");
});

test("EXA-001 请求：key 只来自 ctx.key，不读取进程环境变量（CFG-002 解析在 A4 完成）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx({ key: EXA_KEY });
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  const prev = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "sk-synthetic-env-DIFFERENT-KEY-DO-NOT-LOG";
  try {
    await exa.search(ctx);
  } finally {
    if (prev === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = prev;
  }

  assert.equal(onlyCall(fetch).headers["x-api-key"], EXA_KEY, "必须以 ctx.key 为准，不得改读环境变量");
});

test("EXA-001 请求体：逐字段为 query、type:\"auto\"、contents.highlights，且不请求正文 text", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx({ query: EXA_QUERY });
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  const body = sentBody(onlyCall(fetch));
  assert.equal(body.query, EXA_QUERY, "query 必须逐字等于当前查询（EXA-001）");
  assert.equal(body.type, "auto", "type 必须为 \"auto\"（EXA-001）");
  // TODO-EXA-2：highlights 的形状未定，true 或对象均可。
  assert.ok(body.contents && body.contents.highlights, "必须请求 highlights（contents.highlights 为真值，EXA-001）");
  assert.ok(
    !(body.contents && body.contents.text),
    "EXA-001 只要求 highlights；不得请求 contents.text（sources-only，FB-002）",
  );
});

test("EXA-001 请求体：请求体仅含 query/type/numResults/contents 四键（逐字段，无 category 等额外字段）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx({ maxResults: 3 });
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  const keys = Object.keys(sentBody(onlyCall(fetch))).sort();
  // TODO-EXA-11：category/搜索模式不在规格中，故不允许出现。
  assert.deepEqual(keys, ["contents", "numResults", "query", "type"], "请求体键集合须与 EXA-001 逐字段一致");
});

test("EXA-001 请求体：宿主提供 maxResults 时以 numResults 发送同值（在 1..10 内的透传）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx({ maxResults: 3 });
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  assert.equal(sentBody(onlyCall(fetch)).numResults, 3, "numResults 必须等于宿主 maxResults（EXA-001）");
});

test("EXA-001 请求体：宿主未提供上限时不发送 numResults（TODO-EXA-5 边界外不测）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx({});
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  await exa.search(ctx);

  assert.ok(!("numResults" in sentBody(onlyCall(fetch))), "无 maxResults 时不得发送 numResults（EXA-001「宿主提供…时」）");
});

test("EXA-001 请求：缺 key（undefined/空白）时零出站且抛错（FB-001 适配器级；TODO-EXA-8）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  for (const key of [undefined, "", "   "]) {
    const { ctx, fetch } = makeExaCtx({ key });
    routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

    const res = await settle(exa.search(ctx));

    assert.equal(fetch.count(), 0, `key=${JSON.stringify(key)} 时不得发出任何请求（FB-001 零出站）`);
    assert.equal(res.ok, false, `key=${JSON.stringify(key)} 时必须拒绝，不得返回结果`);
  }
});
