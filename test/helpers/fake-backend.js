// 链级测试用的脚本化假后端（适配器 seam 见 helpers/contract.js A5）。
// 真实适配器（WP2/3/4/8/9/10/11）必须满足同一形状：
//   search(ctx) resolve { sources, content? }；空数组 = 明确无结果（FB-004）；
//   失败 throw 携带 .code ∈ ENTRY_CODES；程序违约 throw 无 code 错误（FB-005）。
import { ENTRY_CODES } from "./contract.js";

/** 成功返回若干来源（FB-002）。 */
export function stepSuccess({ sources, content, consumeMs = 0 } = {}) {
  return { kind: "success", sources: sources ?? [], content, consumeMs };
}
/** 明确无结果（FB-004 空语义）。 */
export function stepEmpty({ consumeMs = 0 } = {}) {
  return { kind: "success", sources: [], consumeMs };
}
/** 已分类失败（FB-005）。cause 模拟上游原始错误（可能含敏感原文，链必须脱敏）。 */
export function stepFail({ code = ENTRY_CODES.NETWORK, message = "合成条目失败", consumeMs = 0, cause } = {}) {
  return { kind: "fail", code, message, consumeMs, cause };
}
/** 单项超时：挂起直到链的条目预算中止 ctx.signal。 */
export function stepHang() {
  return { kind: "hang" };
}
/** 迟到结果：预算耗尽被中止后仍resolve，链必须忽略（FB-003）。 */
export function stepLate({ sources = [], resolveAfterMs, content }) {
  return { kind: "late", sources, resolveAfterMs, content };
}
/** 内部程序违约（FB-005）：无 code，原样暴露给调用方。 */
export function stepProgramError({ error } = {}) {
  return { kind: "programError", error: error ?? new TypeError("synthetic internal invariant violation") };
}

function abortError(reason) {
  const err = new Error(reason?.message ?? "aborted");
  err.name = "AbortError";
  return err;
}

/**
 * 假后端：按条目 ID 查脚本（同型多条目共用一个 backend，按 ctx.entry.id 区分，FB-001）。
 * 未脚本化的条目默认挂起（防止测试遗漏导致假通过）。
 * @param {string} type
 * @param {Record<string, object[]>} stepsById
 * @param {{ n: number }} [seqRef] 跨后端共享的全局调用序号（保证 executions 顺序稳定）
 */
export function createScriptedBackend(type, stepsById, seqRef = { n: 0 }) {
  const scripts = new Map(Object.entries(stepsById).map(([k, v]) => [k, [...v]]));
  const calls = [];
  const backend = {
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
      calls.push({ seq: ++seqRef.n, entryId: ctx.entry.id, at: ctx.clock?.now?.() ?? null, budgetMs: ctx.budgetMs, ctx });
      const queue = scripts.get(ctx.entry.id);
      let step;
      if (queue && queue.length > 0) step = queue.length > 1 ? queue.shift() : queue[0];
      else step = stepHang();
      if (step.kind === "programError") throw step.error;
      if (step.kind === "hang") {
        await waitUntilAbort(ctx);
        throw abortError(ctx.signal?.reason);
      }
      if (step.kind === "late") {
        await clockDelay(ctx, step.resolveAfterMs, { ignoreAbort: true });
        return { sources: step.sources, ...(step.content !== undefined ? { content: step.content } : {}) };
      }
      if (step.consumeMs > 0) await clockDelay(ctx, step.consumeMs);
      if (step.kind === "fail") {
        const err = new Error(step.message);
        err.code = step.code;
        if (step.cause) err.cause = step.cause;
        throw err;
      }
      return { sources: step.sources, ...(step.content !== undefined ? { content: step.content } : {}) };
    },
  };
  return backend;
}

function waitUntilAbort(ctx) {
  return new Promise((resolve) => {
    if (ctx.signal?.aborted) return resolve();
    const onAbort = () => {
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 用注入的受控时钟等待 ms；默认在 signal 中止时 reject（模拟被取消的等待）。 */
function clockDelay(ctx, ms, { ignoreAbort = false } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done || ignoreAbort) return;
      done = true;
      ctx.clock?.clearTimeout?.(timer);
      reject(abortError(ctx.signal?.reason));
    };
    const timer = ctx.clock.setTimeout(() => {
      if (done) return;
      done = true;
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!ignoreAbort) ctx.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
