// 受控时钟（FB-003 验收要求「用受控时钟覆盖…」）。
// 注入给实现deps的 clock：{ now(), setTimeout, clearTimeout, abortSignal }。
// 测试代码通过 advance(ms) 拨动时间；只有实现调用 clock.* 才受控，
// 因此实现不得直接用全局 setTimeout/Date.now（该违规由 clock.invalidTimings 与真实超时暴露）。

/**
 * @param {{ now?: number }} [opts]
 */
export function createControlledClock(opts = {}) {
  let t = opts.now ?? 1_700_000_000_000;
  let seq = 0;
  /** @type {Map<number, {due:number, cb:Function, args:any[], kind:string}>} */
  const timers = new Map();
  /** @type {Map<number, {at:number, cb:Function, cleanup:Function}>} */
  const aborters = new Map();
  const clock = {
    /** 拨钟记录：非正/非有限 delay 会被钳制为 0 并登记，供断言（FB-003 无可用时间不得发请求）。 */
    invalidTimings: [],
    errors: [],
    now() {
      return t;
    },
    setTimeout(cb, ms, ...args) {
      const raw = ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        clock.invalidTimings.push({ rawMs: ms, clampedTo: 0, kind: "setTimeout", stack: new Error().stack });
        ms = 0;
      } else if (!Number.isInteger(ms)) {
        clock.invalidTimings.push({ rawMs: ms, clampedTo: ms, kind: "setTimeout-noninteger", stack: new Error().stack });
      }
      const id = ++seq;
      timers.set(id, { due: t + ms, cb, args, kind: "timeout" });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setImmediate(cb, ...args) {
      const id = ++seq;
      timers.set(id, { due: t, cb, args, kind: "immediate" });
      return id;
    },
    clearImmediate(id) {
      timers.delete(id);
    },
    /**
     * 用受控调度实现一个 AbortSignal 的中止效果：
     * 若 signal 已中止立即触发；否则注册监听，由 abortSignal.cancel(id) 撤销。
     */
    abortSignal(signal, onAbort, reason) {
      if (signal?.aborted) {
        queueMicrotask(() => onAbort(reason ?? signal.reason));
        return { cancel() {} };
      }
      const id = ++seq;
      const handler = () => onAbort(signal.reason ?? reason);
      signal.addEventListener("abort", handler, { once: true });
      aborters.set(id, { at: t, cb: handler, cleanup: () => signal.removeEventListener("abort", handler) });
      return {
        cancel() {
          const e = aborters.get(id);
          if (e) {
            e.cleanup();
            aborters.delete(id);
          }
        },
      };
    },
    /** 把时间拨快 ms；按到期顺序触发定时器（模拟微任务由测试 flush）。 */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let nextId = null;
        let nextDue = Infinity;
        for (const [id, timer] of timers) {
          if (timer.due <= target && timer.due < nextDue) {
            nextDue = timer.due;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        t = Math.max(t, timer.due);
        try {
          timer.cb(...timer.args);
        } catch (err) {
          clock.errors.push(err);
        }
      }
      t = target;
      // 已中止的 signal 无需等待定时器
      return clock;
    },
    /** 下一个待触发定时器的绝对时间，没有则 null。 */
    nextDue() {
      let due = null;
      for (const timer of timers.values()) due = due === null ? timer.due : Math.min(due, timer.due);
      return due;
    },
    pending() {
      return [...timers.entries()].map(([id, timer]) => ({ id, due: timer.due, msUntilDue: timer.due - t, kind: timer.kind }));
    },
    pendingAborters() {
      return aborters.size;
    },
  };
  return clock;
}

/** 让出真实事件循环，冲刷因拨钟产生的微任务/宏任务。 */
export async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
