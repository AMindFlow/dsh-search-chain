// PX-002 验收2/3：开关开+引用存在，但全局代理解析缺失/空白/不可读时的失败语义。
// Oracle 骨架（工作包 #88，oracle 文档 PX-002 节）：实现前跑红属预期。
// 观测面：O5 出站路由（A-PX-1 判别）、O7 attempts、O8 文案要素。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, assertSearchResult, assertWebError, CHAIN_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

const CLAUSES = "PX-002";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";

function escalationObserved(h, entryId) {
  const hit = (o) => {
    if (!o || typeof o !== "object") return false;
    if (o.viaGlobal === true || o.viaGlobalProxy === true) return true;
    return Object.values(o).some((v) => typeof v === "string" && v.includes("syn-proxy.invalid:8080"));
  };
  const viaOpen = h.transport.handles.some((x) => x.entry.id === entryId && hit(x.opts));
  const viaRoute = h.fetchFn.calls.some((c) => hit(c.init?.route));
  return viaOpen || viaRoute;
}

async function harnessWith(t, steps, credSeed) {
  return chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: { ...refsFor("e1"), ...credSeed },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: steps },
  });
}

test(`${CLAUSES}：引用缺失 + 直连网络失败 → 零升级出站、失败原因明示「未配置或不可读，未执行升级」与指引（验收2）`, async (t) => {
  const h = await harnessWith(t, [stepFail({ code: ENTRY_CODES.NETWORK, message: "合成 DNS 解析失败" })], {});
  const err = await h.runToError(h.search());
  assert.equal(escalationObserved(h, "e1"), false, "全局代理不可读时不得有任何升级出站（PX-002）");
  assert.equal(h.executionCount("e1"), 1, "仅直连尝试一次，不得静默按开关关闭重试");
  assertWebError(err, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.match(
    err.details.attempts[0].reason,
    /全局升级已开启.*全局代理.*(未配置|不可读).*未执行升级|未配置或不可读，未执行升级/,
    `reason 必须明示升级未执行原因（PX-002 验收2），实际：${err.details.attempts[0].reason}`,
  );
  assert.match(err.details.attempts[0].reason, /(设置|重新保存).*(全局代理|代理地址)/, "须给可操作指引");
});

test(`${CLAUSES}：引用解析为纯空白值 → 同「不可读」语义，零升级出站、明示文案（验收2 空白形）`, async (t) => {
  const h = await harnessWith(t, [stepFail({ code: ENTRY_CODES.NETWORK })], { [GLOBAL_REF]: "   " });
  const err = await h.runToError(h.search());
  assert.equal(escalationObserved(h, "e1"), false, "空白值不得被当作可用代理出站");
  assert.match(err.details.attempts[0].reason, /未配置或不可读|未执行升级/, "空白引用等同不可读语义");
});

test(`${CLAUSES}：凭据服务对引用抛错（不可读形）→ 零升级出站、文案含「不可读」、遵守 CFG-002 分界不新增静默（边角）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: refsFor("e1"),
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK })] },
  });
  h.credentials.failRefReads = h.credentials.failRefReads ?? new Set([GLOBAL_REF]);
  // fake-credentials 以 seed.failRefReads 构造；此处等效面：运行时注入故障标记
  const origResolve = h.credentials.resolve.bind(h.credentials);
  h.credentials.resolve = async (ref) => {
    if (ref === GLOBAL_REF) throw new Error("synthetic credential store unreadable");
    return origResolve(ref);
  };
  const err = await h.runToError(h.search());
  assert.equal(escalationObserved(h, "e1"), false, "解析抛错时不得升级出站");
  assert.match(err.details.attempts[0].reason, /未配置或不可读|不可读.*未执行升级/, "文案区分「不可读」要素");
  assert.ok(!JSON.stringify(err).includes("syn-pass"), "错误面零秘密（CFG-003）");
});

test(`${CLAUSES}：开关开+引用可用但直连成功 → 结果照常返回、零升级出站、无升级文案（验收3）`, async (t) => {
  const h = await harnessWith(t, [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/x", title: "t", snippet: "s" }] })], {
    [GLOBAL_REF]: GLOBAL_URL,
  });
  const res = await h.runToValue(h.search());
  assertSearchResult(t, res, { entryName: undefined });
  assert.equal(escalationObserved(h, "e1"), false, "直连成功不得产生升级出站（PX-002 验收3）");
  assert.equal(h.executionCount("e1"), 1);
  assert.ok(!JSON.stringify(res).includes("升级"), "结果面不得出现升级文案（升级需求未产生）");
});
