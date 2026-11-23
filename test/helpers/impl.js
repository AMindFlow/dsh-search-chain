// 未来实现模块的加载器（测试红/绿策略，见 WP0 任务约定）：
//   - 模块不存在   → 测试必须为红：failIfUnimplemented 用 t.diagnostic + assert.fail 给出
//     「等待 WPx <条款>」的可定位原因（node:test TestContext 没有 t.fail，不得使用不存在的 API）。
//   - 模块存在但 import 抛错 → 同样为红（模块已进入开发且坏了，oracle 必须变红）。
// dev 不得把红测试改成 skip 或删除断言；只能通过实现模块让它转绿。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** src 下文件的绝对路径。只允许加载 src/（oracle 不加载别处实现）。 */
export function srcPath(rel) {
  const abs = path.resolve(SRC_ROOT, rel);
  if (!abs.startsWith(SRC_ROOT + path.sep) && abs !== SRC_ROOT) {
    throw new Error(`拒绝越界加载: ${rel}`);
  }
  return abs;
}

/**
 * @returns {Promise<{ok:true, module:any} | {ok:false, reason:"missing"} | {ok:false, reason:"import-error", error:unknown}>}
 */
export async function tryImportSrc(rel) {
  const abs = srcPath(rel);
  if (!existsSync(abs)) return { ok: false, reason: "missing" };
  try {
    return { ok: true, module: await import(pathToFileURL(abs).href) };
  } catch (error) {
    return { ok: false, reason: "import-error", error };
  }
}

/**
 * 在 test 回调内使用。实现缺失时记红：先输出 [WP0 oracle] 条款诊断，再 assert.fail 抛出
 * AssertionError（测试红、非 skip、失败原因可读）。assert.fail 必抛——返回 true 仅防御性，
 * 调用方 `if (failIfUnimplemented(t, res, wp, clauses)) return;` 的写法保持兼容。
 * @param {import("node:test").TestContext} t
 * @param {Awaited<ReturnType<typeof tryImportSrc>>>} res
 * @param {string} wp 等待的工作包，如 "WP5 src/search.js"
 * @param {string} clauses 覆盖的条款编号，如 "DSH-002"
 */
export function failIfUnimplemented(t, res, wp, clauses) {
  if (res.ok) return false;
  if (res.reason === "missing") {
    t.diagnostic(`[WP0 oracle] ${clauses}: 等待实现 ${wp}（模块不存在，当前为红属预期，勿改为 skip）`);
    assert.fail(`等待实现 ${wp}（模块缺失，${clauses}）——红属预期，勿改为 skip（见 helpers/impl.js 约定）`);
    return true; // 不可达：assert.fail 必抛
  }
  throw res.error;
}
