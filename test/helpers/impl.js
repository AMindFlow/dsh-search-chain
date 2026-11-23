// 未来实现模块的加载器（测试红/绿策略，见 WP0 任务约定）：
//   - 模块不存在   → 测试必须为红：failIfUnimplemented 让 t.fail 给出「等待 WPx」的可定位原因。
//   - 模块存在但 import 抛错 → 同样为红（模块已进入开发且坏了，oracle 必须变红）。
// dev 不得把红测试改成 skip 或删除断言；只能通过实现模块让它转绿。
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
 * @returns {Promise<{ok:true, mod:any} | {ok:false, reason:"missing"} | {ok:false, reason:"import-error", error:unknown}>}
 */
export async function tryImportSrc(rel) {
  const abs = srcPath(rel);
  if (!existsSync(abs)) return { ok: false, reason: "missing" };
  try {
    return { ok: true, mod: await import(pathToFileURL(abs).href) };
  } catch (error) {
    return { ok: false, reason: "import-error", error };
  }
}

/**
 * 在 test 回调内使用。返回 true 表示已按「实现缺失」记红处理，测试体应立即 return。
 * @param {import("node:test").TestContext} t
 * @param {Awaited<ReturnType<typeof tryImportSrc>>>} res
 * @param {string} wp 等待的工作包，如 "WP5 src/search.js"
 * @param {string} clauses 覆盖的条款编号，如 "DSH-002"
 */
export function failIfUnimplemented(t, res, wp, clauses) {
  if (res.ok) return false;
  if (res.reason === "missing") {
    t.diagnostic(`[WP0 oracle] ${clauses}: 等待实现 ${wp}（模块不存在，当前为红属预期，勿改为 skip）`);
    t.fail(`等待实现 ${wp}（模块缺失，${clauses}）`);
    return true;
  }
  throw res.error;
}
