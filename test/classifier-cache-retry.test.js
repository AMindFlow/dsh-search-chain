// gap 修正 B 包 oracle（P1-4）— deepseek / tavily 共享分类器加载缓存对齐 #12-25 先例。
//
// 先例（main 上 exa.js / brave.js / openai.js / gemini.js 的 upstreamClassifier，#12-25 注释）：
//   - 加载失败（rejected）不得永久缓存：失败即重置，下一次调用重新探测；
//   - src/search.js 存在但未导出 classifyUpstreamFailure → A4 程序违约，向上抛出（不带 ENTRY 码）。
// 被检面（main 现状 = 预期红）：
//   - deepseek.js loadSharedClassifier：import(...) 失败被 `() => null` 吞掉并永久缓存 → 之后一直
//     静默走 localClassify 本地兜底（首败即被钉死，永不重试）；未导出同样静默兜底。
//   - tavily.js generalClassifierState 的 "absent" 状态机：导入失败与未导出一并置 "absent" 缓存，
//     之后不再重试，静默 localGeneralCode 兜底。
// 期望（B 包修复后转绿）：
//   1) 首败不缓存 rejected：第一次加载失败当次以「无 ENTRY 码的程序违约」上抛（FB-005 程序违约原样
//      暴露，不包装）；分类面转为可加载后的下一次调用重新探测加载并使用共享分类器（可观察：tmp 桩把
//      transport 相归为 ENTRY_QUOTA，本地兜只给 ENTRY_NETWORK，二者可区分）。
//   2) 持续加载失败（文件存在但求值必败）→ 每次调用都程序违约上抛（无 ENTRY 码），而非静默本地兜底；
//      未导出（A4）同样程序违约上抛。
//
// 构造方式：把后端模块复制到临时目录（backends/<x>.js + 同级 constants.js）。重试场景用「缺文件
// absent→created」（分类面依赖 classifier-dep.js 先缺席、后创建）驱动：dev 实证 Node 缓存 ESM 求值
// 错误（含语法损坏——损坏文件修复后 import 仍取缓存错误，演示不了重试成功，见本文件 git 历史），
// 但不缓存缺文件失败（ERR_MODULE_NOT_FOUND），创建后即可重试成功；分类面因缺文件而不可加载，正是
// 「可选面缺席」的真实形态。注意 search.js 本体缺席属 existsSync 的合法本地兜底面（resolve null 被
// 缓存，非重试可观察面），不作重试场景。持续失败场景仍用「语法损坏」（求值必败），无导出场景用
// 「合法但未导出」。每场景独立临时目录 → 模块 URL 唯一，互不串扰。运行时零真实等待（fetch 立即抛，
// 预算定时器即时清理）。
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as C from "./helpers/contract.js";
import { srcPath } from "./helpers/impl.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";

/** 语法损坏的 search.js：import 求值必败且错误被 Node 缓存——持续失败面专用（重试面用「缺文件 absent→created」）。 */
const SEARCH_BROKEN = "// oracle P1-4：本文件语法损坏，import 必败（持续加载失败面）\n@@@ 非法 JavaScript 占位 @@@\n";

/**
 * 重试场景桩：A4 分类器形状，transport 相一律归 ENTRY_QUOTA——与任何本地兜底（transport→
 * ENTRY_NETWORK）可区分；但依赖 classifier-dep.js——该依赖缺席时整个分类面 import 必败
 * （文件存在但导入失败 → 程序违约面；ENOENT 失败不被 Node 缓存），创建依赖后即恢复可加载，
 * 构成 absent→created 的重试可观察面（rejected 不得永久缓存，#12-25）。
 */
const SEARCH_NEEDS_DEP = [
  "// oracle P1-4：分类面依赖缺席——import 必败（重试首败面），依赖创建后重试加载成功。",
  'import "./classifier-dep.js";',
  "export function classifyUpstreamFailure(info) {",
  "  return info && info.phase === \"transport\" ? \"ENTRY_QUOTA\" : \"ENTRY_BAD_RESPONSE\";",
  "}",
  "",
].join("\n");

/** 合法模块但未导出 classifyUpstreamFailure（A4 无导出面）。 */
const SEARCH_NO_EXPORT = "// oracle P1-4：合法但未导出 classifyUpstreamFailure（A4 违约面）\nexport const unrelated = true;\n";

const ENTRY_CODE_VALUES = new Set(Object.values(C.ENTRY_CODES));
const isEntryCode = (code) => typeof code === "string" && ENTRY_CODE_VALUES.has(code);

/**
 * 临时目录布局（后端相对路径 ../search.js、../constants.js 因此落在临时副本上）：
 *   tmp/constants.js            ← src/constants.js 副本（deepseek 静态 import；tavily 无静态依赖，多备无害）
 *   tmp/search.js               ← 桩（NEEDS_DEP / BROKEN / NO_EXPORT）
 *   tmp/classifier-dep.js       ← NEEDS_DEP 的依赖（缺席即不存在；创建即重试可观察面的「created」）
 *   tmp/backends/<name>.js      ← 被测后端副本
 */
async function stageBackend(relFromSrc) {
  const dir = await mkdtemp(path.join(tmpdir(), "dsc-p14-"));
  await mkdir(path.join(dir, "backends"));
  await cp(srcPath(relFromSrc), path.join(dir, "backends", path.basename(relFromSrc)));
  await cp(srcPath("constants.js"), path.join(dir, "constants.js"));
  return {
    dir,
    setSearch: (content) => writeFile(path.join(dir, "search.js"), content, "utf8"),
    setDep: () => writeFile(path.join(dir, "classifier-dep.js"), "export const staged = true;\n", "utf8"),
    importBackend: () => import(pathToFileURL(path.join(dir, "backends", path.basename(relFromSrc))).href),
  };
}

/** A5 最小 ctx：fetch 立即抛无码网络故障 → 分类必经共享/本地分类器（phase transport）。 */
function makeCtx(type) {
  return {
    entry: { id: "p14-e1", type, name: "P1-4 缓存重试条目", enabled: true },
    query: "合成查询 分类器缓存",
    maxResults: 3,
    key: SYNTHETIC_KEY("p14"),
    budgetMs: 5000,
    signal: undefined,
    clock: undefined, // 各后端缺省回落自身真实时钟；fetch 立即抛，预算定时器被 finally 清理，无真实等待
    fetch: async () => {
      throw new Error("synthetic network failure without code");
    },
  };
}

/** 执行一次 backend.search 并捕获拒绝（resolve 也捕获为哨兵，防「异常被吞成成功」面）。 */
async function rejectionOfSearch(backend, ctx) {
  try {
    const value = await backend.search(ctx);
    return { resolved: value, code: "⟨resolve 未拒绝⟩" };
  } catch (err) {
    return err instanceof Error ? err : Object.assign(new Error("拒绝值不是 Error"), { code: String(err) });
  }
}

/** 「不得静默本地兜底」断言聚合器。 */
function expectViolation(problems, label, err) {
  if (err && err.resolved !== undefined) {
    problems.push(`${label}：应拒绝（程序违约上抛），实测 resolve 了：${JSON.stringify(err.resolved)}`);
    return;
  }
  if (isEntryCode(err?.code)) {
    problems.push(
      `${label}：加载侧失败被吞并静默走本地兜底（ENTRY 码=${err.code}）——须为不带 ENTRY 码的程序违约上抛（#12-25/A4）`,
    );
  }
}

// ─── deepseek：loadSharedClassifier（import 失败被 `()=>null` 永久缓存）──────────────────

test("P1-4 deepseek：loadSharedClassifier 首败不缓存 rejected——首败程序违约上抛，分类面依赖创建后下次调用重试加载成功（#12-25 对齐）", async () => {
  const stage = await stageBackend("backends/deepseek.js");
  try {
    // 第一阶段：search.js 在、但其依赖 classifier-dep.js 缺席——文件存在但导入必败（ENOENT 不被
    // Node 缓存，dev 实证；求值/语法错误则被永久缓存，损坏→修复演示不了重试）。
    await stage.setSearch(SEARCH_NEEDS_DEP);
    const ns = await stage.importBackend();
    const backend = ns.deepseekBackends?.["deepseek-search"] ?? ns.deepseekSearchBackend;
    assert.ok(backend && typeof backend.search === "function", "临时副本应仍导出 deepseek-search A5 后端");
    const problems = [];
    // ① 首败：分类面加载失败（依赖缺席）→ 程序违约（无 ENTRY 码）上抛，不得静默 localClassify（NETWORK）。
    expectViolation(problems, "调用1（classifier-dep.js 缺席）", await rejectionOfSearch(backend, makeCtx("deepseek-search")));
    // ② created 后：下一次调用必须重新探测加载（rejected 未被永久缓存钉死），并使用共享分类器。
    await stage.setDep();
    const second = await rejectionOfSearch(backend, makeCtx("deepseek-search"));
    if (second && second.resolved === undefined && second.code !== C.ENTRY_CODES.QUOTA) {
      problems.push(
        `调用2（classifier-dep.js 已创建）：应重试加载并使用共享分类器（transport 相→${C.ENTRY_CODES.QUOTA}），实测=${String(second.code)}（ENTRY_NETWORK 即首败已被永久缓存、永不重试）`,
      );
    } else if (second && second.resolved !== undefined) {
      problems.push("调用2：search 应拒绝，实测 resolve——故障被吞成成功");
    }
    assert.deepEqual(problems, [], "deepseek 共享分类器缓存与 #12-25 先例不符（预期红：main 首败即被 () => null 吞掉并永久缓存）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});

test("P1-4 deepseek：持续加载失败→程序违约而非静默本地兜底；未导出 classifyUpstreamFailure→A4 程序违约上抛（#12-25 对齐）", async () => {
  const problems = [];
  {
    const stage = await stageBackend("backends/deepseek.js");
    try {
      await stage.setSearch(SEARCH_BROKEN);
      const ns = await stage.importBackend();
      const backend = ns.deepseekBackends?.["deepseek-search"] ?? ns.deepseekSearchBackend;
      // 持续失败：两次调用都不得静默本地兜底（第二次同样重探、同样程序违约上抛）。
      expectViolation(problems, "持续失败-调用1", await rejectionOfSearch(backend, makeCtx("deepseek-search")));
      expectViolation(problems, "持续失败-调用2", await rejectionOfSearch(backend, makeCtx("deepseek-search")));
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
  }
  {
    const stage = await stageBackend("backends/deepseek.js");
    try {
      await stage.setSearch(SEARCH_NO_EXPORT);
      const ns = await stage.importBackend();
      const backend = ns.deepseekBackends?.["deepseek-search"] ?? ns.deepseekSearchBackend;
      // 无导出：A4 程序违约上抛（openai/exa/brave/gemini 先例一致），不得 null 化静默兜底。
      expectViolation(problems, "无导出面", await rejectionOfSearch(backend, makeCtx("deepseek-search")));
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(problems, [], "deepseek 加载侧失败/无导出被静默本地兜底（预期红：main 的 loadSharedClassifier 全部吞成 null）");
});

// ─── tavily：generalClassifierState "absent" 状态机（失败与无导出一并缓存为 absent）──────────

test("P1-4 tavily：absent 状态机首败不缓存——首败程序违约上抛，分类面依赖创建后下次调用重试加载成功（#12-25 对齐）", async () => {
  const stage = await stageBackend("backends/tavily.js");
  try {
    // 第一阶段：search.js 在、其依赖 classifier-dep.js 缺席——导入必败；ENOENT 不被 Node 缓存（dev 实证），
    // 创建依赖后重试可成功；「absent」若被钉死即在此露馅。
    await stage.setSearch(SEARCH_NEEDS_DEP);
    const ns = await stage.importBackend();
    const backend = ns.tavilyBackend ?? ns.createTavilyBackend?.() ?? ns.default;
    assert.ok(backend && typeof backend.search === "function", "临时副本应仍导出 tavily A5 后端");
    const problems = [];
    // ① 首败：「absent」缓存 + localGeneralCode 静默兜底均属违反先例：须程序违约（无 ENTRY 码）上抛。
    expectViolation(problems, "调用1（classifier-dep.js 缺席）", await rejectionOfSearch(backend, makeCtx("tavily")));
    // ② created 后：下一次调用重新探测（absent 不得钉死），共享分类器生效。
    await stage.setDep();
    const second = await rejectionOfSearch(backend, makeCtx("tavily"));
    if (second && second.resolved === undefined && second.code !== C.ENTRY_CODES.QUOTA) {
      problems.push(
        `调用2（classifier-dep.js 已创建）：应重试加载并使用共享分类器（transport 相→${C.ENTRY_CODES.QUOTA}），实测=${String(second.code)}（ENTRY_NETWORK 即 absent 已缓存、永不重试）`,
      );
    } else if (second && second.resolved !== undefined) {
      problems.push("调用2：search 应拒绝，实测 resolve——故障被吞成成功");
    }
    assert.deepEqual(problems, [], "tavily absent 状态机与 #12-25 先例不符（预期红：main 首败即缓存 absent 并静默本地兜底）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});

test("P1-4 tavily：持续加载失败→程序违约而非静默本地兜底；未导出 classifyUpstreamFailure→A4 程序违约上抛（#12-25 对齐）", async () => {
  const problems = [];
  {
    const stage = await stageBackend("backends/tavily.js");
    try {
      await stage.setSearch(SEARCH_BROKEN);
      const ns = await stage.importBackend();
      const backend = ns.tavilyBackend ?? ns.createTavilyBackend?.() ?? ns.default;
      expectViolation(problems, "持续失败-调用1", await rejectionOfSearch(backend, makeCtx("tavily")));
      expectViolation(problems, "持续失败-调用2", await rejectionOfSearch(backend, makeCtx("tavily")));
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
  }
  {
    const stage = await stageBackend("backends/tavily.js");
    try {
      await stage.setSearch(SEARCH_NO_EXPORT);
      const ns = await stage.importBackend();
      const backend = ns.tavilyBackend ?? ns.createTavilyBackend?.() ?? ns.default;
      expectViolation(problems, "无导出面", await rejectionOfSearch(backend, makeCtx("tavily")));
    } finally {
      await rm(stage.dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(problems, [], "tavily 加载侧失败/无导出被 absent 静默兜底（预期红：main 状态机 absent 一律 localGeneralCode）");
});
