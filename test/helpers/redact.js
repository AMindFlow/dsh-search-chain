// 脱敏断言辅助（CFG-003）。
// 规则：日志、返回错误、测试样本与交付产物不得包含实际 key、代理认证信息、
// 带认证参数的 PAC URL 或原始报错响应体。

import assert from "node:assert/strict";

/** 递归收集所有字符串（含 Error 的非枚举 details、数组、嵌套对象）。 */
export function collectStrings(value, seen = new Set(), out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") continue;
      let v;
      try {
        v = value[key];
      } catch {
        continue;
      }
      collectStrings(v, seen, out);
    }
    if (value instanceof Error && typeof value.stack === "string") out.push(value.stack);
  }
  return out;
}

/**
 * 断言任何字符串里都不出现给定秘密值（合成 key、代理口令等）。
 * @param {import("node:test").TestContext} t
 * @param {any} value 任意结构（结果、错误、日志采集器、fetch calls…）
 * @param {string[]} secrets 秘密值列表；空串会被忽略（否则平凡失败）
 * @param {string} label 断言失败时的语境说明
 */
export function assertNoSecrets(t, value, secrets, label) {
  const needles = [...new Set(secrets.filter((s) => typeof s === "string" && s.length > 0))];
  const strings = collectStrings(value);
  for (const s of strings) {
    for (const secret of needles) {
      assert.ok(
        !s.includes(secret),
        `${label}: 文本不得包含秘密「${secret}」或原始响应（CFG-003），命中片段：${JSON.stringify(
          s.slice(Math.max(0, s.indexOf(secret) - 40), s.indexOf(secret) + secret.length + 40),
        )}`,
      );
    }
  }
}

/** 不得出现带认证信息的 URL（user:pass@host）。代理认证、PAC 认证参数都在此列。 */
export function assertNoCredentialUserinfo(t, value, label) {
  const pattern = /(?:^|[\s"'(=])\S*\/{0,2}\S+:[^\s/"'@]+:[^\s/"'@\s]+@|\S+:[^\s/"'@\s]+@[a-z0-9.-]+\b/i;
  for (const s of collectStrings(value)) {
    assert.ok(!pattern.test(s), `${label}: 文本疑似含带认证信息的 URL（CFG-003）：${JSON.stringify(s)}`);
  }
}

/**
 * 原始响应体特征：错误文本与日志中不得出现 HTML/XML 原始体（CFG-003「不得包含…原始报错响应体」）。
 * 仅用于 error.message 与日志文本，不用于 fixture 原文。
 */
export function assertNoRawBody(t, value, label) {
  const pattern = /<(!doctype\s+)?(html|body|\?xml)\b/i;
  for (const s of collectStrings(value)) {
    assert.ok(!pattern.test(s), `${label}: 文本疑似包含原始报错响应体（CFG-003）：${JSON.stringify(s.slice(0, 120))}`);
  }
}

/** 日志采集器：作为 deps.log 注入，随后对 text() 做脱敏断言。 */
export function createLogCapture() {
  const entries = [];
  const log = (level, message, ...rest) => {
    entries.push({ level, message, rest });
  };
  return {
    log,
    entries,
    text() {
      return entries.map((e) => `${e.level} ${e.message} ${e.rest.map((r) => safe(r)).join(" ")}`).join("\n");
    },
  };
}

function safe(r) {
  if (typeof r === "string") return r;
  try {
    return JSON.stringify(r);
  } catch {
    return String(r);
  }
}
