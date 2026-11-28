// 工作包 #86 池 Oracle 共享套件（仅测试用）：
//   - makeIssuingBackend：满足 A5 形状的「会真实出站」薄适配器——每次 backend.search
//     恰好提交一次查询（POOL-004 修订注「每把凭据至多一次提交」的镜像实现），鉴权头
//     `Bearer <ctx.key>`，上游结局按 attempt=N 路由由 fake-fetch 脚本决定，状态码经
//     src/search.js classifyUpstreamFailure 归码后上抛（FB-005 链按码消费）。
//   - scriptAttempts：把每次出站的 URL 查询参 attempt=N 映射到 401/429/402/网络失败/
//     挂起/空结果/有效来源/内容策略拒绝。
//   - POOL_MAX / POOL_MAX_TEXT：池上限与规范文案要素（key-pool.md 设计决定 + lead 审阅批准）。
// 合成 key 面沿用 fake-fetch SYNTHETIC_KEY（可辨识、正则可查、不入日志/展示）。
import { classifyUpstreamFailure } from "../../src/search.js";
import { SYNTHETIC_KEY } from "./fake-fetch.js";

export const POOL_MAX = 8;

/** 池引用名（POSIX 语法，R-1 合法）与其解析值。 */
export const refName = (letter) => `POOL_REF_${letter}`;
export const poolKey = (letter) => SYNTHETIC_KEY(letter);

export function refPoolOf(letters) {
  return [...letters].map(refName);
}

export function credentialSeedFor(letters) {
  return Object.fromEntries([...letters].map((l) => [refName(l), poolKey(l)]));
}

export const SYNTH_SOURCE = (n) => ({
  url: `https://synthetic-host.invalid/pool-doc?n=${n}`,
  title: `合成来源 ${n}`,
});

/**
 * 「会真实出站」的薄后端（openai 形态鉴权头；ctx.key = 当次轮替 key）。
 * 每次 search() 记 { seq, entryId, key, budgetMs, at }，供「哪把 key、几次提交」断言。
 */
export function makeIssuingBackend(type, { url = "https://syn-supplier.invalid/search" } = {}) {
  const calls = [];
  let n = 0;
  return {
    type,
    calls,
    ctxFor(entryId) {
      const found = [...calls].reverse().find((c) => c.entryId === entryId);
      return found?.ctx;
    },
    callCount(entryId) {
      return entryId ? calls.filter((c) => c.entryId === entryId).length : calls.length;
    },
    async search(ctx) {
      n += 1;
      const seq = n;
      calls.push({ seq, entryId: ctx.entry.id, at: ctx.clock?.now?.() ?? null, budgetMs: ctx.budgetMs, key: ctx.key, ctx });
      const attemptUrl = `${url}?attempt=${seq}`;
      const headers = { authorization: `Bearer ${ctx.key ?? ""}` };
      let res;
      try {
        res = await ctx.fetch(attemptUrl, { method: "GET", headers, signal: ctx.signal });
      } catch (error) {
        if (error?.name === "AbortError") throw error; // 取消/预算中止原样出链（race 侧裁决）
        const e = new Error("synthetic transport failure");
        e.code = classifyUpstreamFailure({ phase: "transport", error });
        throw e;
      }
      if (!res.ok) {
        const e = new Error(`synthetic upstream ${res.status}`);
        e.code = classifyUpstreamFailure({ phase: "response", status: res.status });
        throw e;
      }
      const body = await res.json().catch(() => null);
      if (body?.policy === true) {
        const e = new Error("synthetic content policy rejection");
        e.code = "ENTRY_CONTENT_POLICY"; // A5：终止类由适配器直接赋码（FB-005 注）
        throw e;
      }
      return { sources: Array.isArray(body?.sources) ? body.sources : [] };
    },
  };
}

/**
 * 按 attempt 序号脚本化出站结局。
 * kinds：401/402/429（快速拒绝）、network（传输失败）、hang（挂起等预算/取消）、
 *       empty（明确无结果）、ok:<count>（有效来源 count 条）、policy（内容策略拒绝）。
 */
export function scriptAttempts(fetchFn, script = {}) {
  for (const [attempt, kind] of Object.entries(script)) {
    const match = (u) => {
      try {
        return new URL(String(u)).searchParams.get("attempt") === String(attempt);
      } catch {
        return false;
      }
    };
    if (kind === "hang") fetchFn.when(match).hangs();
    else if (kind === "network") fetchFn.when(match).fails({ error: new TypeError("synthetic fetch failed") });
    else if (kind === "empty") fetchFn.when(match).responds({ status: 200, body: { sources: [] } });
    else if (kind === "policy") fetchFn.when(match).responds({ status: 200, body: { policy: true } });
    else if (kind === 401 || kind === 402 || kind === 429 || kind === "401" || kind === "402" || kind === "429") {
      fetchFn.when(match).responds({ status: Number(kind), body: { error: { message: "synthetic" } } });
    } else if (String(kind).startsWith("ok:")) {
      const count = Number(String(kind).slice(3));
      fetchFn.when(match).responds({ status: 200, body: { sources: Array.from({ length: count }, (_, i) => SYNTH_SOURCE(i + 1)) } });
    } else {
      throw new Error(`[pool-kit] 未知脚本形态：${kind}`);
    }
  }
}

/** 明文 key 不可命中面（POOL-006/009 安全面）：断言 text 不含任何参与池的合成 key。 */
export function assertNoPoolKeys(assertLib, text, letters, where = "") {
  for (const letter of letters) {
    assertLib.ok(!String(text).includes(poolKey(letter)), `${where}不得出现 key ${letter} 明文`);
  }
}
