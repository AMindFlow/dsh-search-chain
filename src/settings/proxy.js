// WP12 设置面板 — 条目 proxy 形态校验（CFG-001 本地镜像）。
//
// 规格来源：docs/specs/draft/config-network.md CFG-001：
//   省略或空白 → 直连（已保存形状中省略 proxy）；非空字符串 → HTTP(S) 正向代理 URL；
//   { pac: "http(s) URL" } → PAC（保留查询参数，校验见 CFG-005 运行期）。其余形态一律非法。
//
// 同步义务（delegation 约定）：冻结测试「CFG-001/SET-002：面板 proxy 校验与 normalizeConfig
// 语义逐例一致」要求本校验与 WP1 src/config.js normalizeConfig 的接受/拒绝逐例相同。
// WP1 未合入前本文件是面板侧唯一校验实现（运行时不得 import 尚不存在的模块）；
// WP1 合入后若 normalizeConfig 语义与本文件出现分歧，须在同一 PR 中修正两侧之一
// 并说明理由（config-contract.test.js 的 proxy 用例是语义真值）。
//
// 判定样本（与 config-contract.test.js / settings-ui.test.js 的委托比对样本一致）：
//   接受："http://syn-proxy.invalid:8080"、{ pac: "http://syn-pac.invalid:8765/...?v=3" }、""、"   "（后两者→直连）
//   拒绝："syn-proxy.invalid:8080"（无 scheme）、"ftp://..."（非 HTTP(S)）、42、{ bogus: 1 }、
//         { pac: "not-an-url" }、{ pac: "   " }（空白 pac 不是直连，是非法形态）

/** 绝对 HTTP(S) URL（不解析 DNS；仅协议与可解析性）。 */
export function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 校验并规范化 proxy 输入。
 * @param {unknown} proxy
 * @returns {{ kind: "direct" } | { kind: "value", value: string | { pac: string } }}
 *   kind "direct" = 省略/空白 → 直连（已保存形状中须省略 proxy 字段）；
 *   kind "value" = 原样保留（不做 trim/改写，保存形状与输入一致，委托比对按值断言）。
 * @throws {Error} 越界形态：error.code = CONFIG_CODES.INVALID（由调用方包装文案）。
 */
export function validateProxy(proxy) {
  if (typeof proxy === "string") {
    if (proxy.trim() === "") return { kind: "direct" };
    if (!isHttpUrl(proxy)) return null; // 调用方抛 INVALID：无 scheme 或非 HTTP(S)
    return { kind: "value", value: proxy };
  }
  if (proxy !== null && typeof proxy === "object" && !Array.isArray(proxy)) {
    const keys = Object.keys(proxy);
    // 严格形状 { pac }：不得带其他键（{ bogus: 1 } 拒绝）。
    if (keys.length !== 1 || !Object.hasOwn(proxy, "pac")) return null;
    const pac = proxy.pac;
    if (typeof pac !== "string" || pac.trim() === "") return null; // 空白/非字符串 pac 非法
    if (!isHttpUrl(pac)) return null;
    return { kind: "value", value: { pac } };
  }
  return null; // 数字、布尔、数组、null 等一律越界
}
