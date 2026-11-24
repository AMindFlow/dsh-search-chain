// WP5 搜索链 oracle 公共辅助（新增文件，既有 helpers 不改）。
// 职责：加载未来的 src/search.js（缺失即红，等待实现 WP5）、构造键控条目与 credentialRefs、
// 生成 JSON 归一化快照。链级行为以 helpers/chain-harness.js 的受控时钟驱动。
import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { createChainHarness } from "./chain-harness.js";
import { makeEntry } from "./contract.js";
import { SYNTHETIC_KEY } from "./fake-fetch.js";

export const SEARCH_WP = "WP5 src/search.js";

/**
 * 加载 src/search.js 并校验导出 createSearchChain。
 * 模块缺失 / 导出缺失 / import 失败均在此记红（failIfUnimplemented 必抛）。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses 覆盖条款，如 "FB-001/FB-002"
 */
export async function loadSearch(t, clauses) {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, SEARCH_WP, clauses);
  if (typeof res.module.createSearchChain !== "function") {
    t.diagnostic(`[WP0 oracle] ${clauses}: 等待实现 ${SEARCH_WP} 导出 createSearchChain（contract.js A4）`);
    assert.fail(`等待实现 ${SEARCH_WP}：缺少导出 createSearchChain（${clauses}）——红属预期，勿改为 skip`);
  }
  return res.module;
}

/** 构造链测试台（controlled clock + fake backends）。 */
export async function chainHarness(t, clauses, spec = {}) {
  const mod = await loadSearch(t, clauses);
  return createChainHarness(mod.createSearchChain, spec);
}

/** 条目凭据引用（不透明合成串，CFG-003：配置只存引用）。 */
export function refOf(id) {
  return `synthetic-ref:search-chain:${id}`;
}

/** 带凭据引用的启用条目。 */
export function keyedEntry(id, type, name, extra = {}) {
  return makeEntry({ id, type, name, enabled: true, credentialRef: refOf(id), ...extra });
}

/** 为一组条目 ID 生成 credentialRefs 映射（每条目一把合成 key）。 */
export function refsFor(...ids) {
  return Object.fromEntries(ids.map((id) => [refOf(id), SYNTHETIC_KEY(id)]));
}

/** JSON 归一化（去掉 undefined 字段），用于快照比较。 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
