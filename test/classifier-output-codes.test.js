// PR#35 审阅补口 oracle（P2-a）— deepseek / tavily classifyFailure 的「输出校验」对齐四先例。
//
// 四先例（main 上 exa.js / brave.js / gemini.js / openai.js 的 classify / classifyFailure）同构契约：
//   const code = classifyUpstreamFailure(info);
//   if (!Object.values(ENTRY_CODES).includes(code)) throw …无 ENTRY 码的程序违约（消息含 String(code)，A4）;
//   return code;
//   即：①共享分类器返回非 ENTRY 码（含非字符串）→ 无码程序违约上抛，消息点名未知输出；
//       ②共享分类器自身抛异常 → 原样上抛（不设 try/catch 吞掉）。
// 被检面（本分支现状 = 预期红，dev 修复面）：
//   - deepseek.js classifyFailure：`if (typeof code === "string") return code;` —— 共享分类器返回
//     非 ENTRY 码字符串原样返回，entryError 带着未知码出门（A1）；返回 undefined 静默落 localClassify
//     （A2，非 ENTRY 码的另一种形态，四先例一律上抛）。
//   - tavily.js classifyFailure：`try { general(info) } catch { /* 吞 */ }` —— 共享分类器抛异常被
//     吞掉后静默 localGeneralCode（A3）；未知码 string 不命中 includes 检查后回退 localGeneralCode
//     （A4，「未知码→上抛」被实现成「未知码→本地兜底」）。
// 期望（修复后转绿）：三先例面全部收敛到四先例同构——共享分类器输出非 ENTRY 码或自身抛异常，都
//   以「不带任何 .code 的程序违约」到达调用方；原样上抛面保留分类器原错误的 message/name。
//
// 构造方式沿用 classifier-cache-retry.test.js（P1-4）：后端复制到临时目录（backends/<x>.js +
// 同级 constants.js），桩 search.js 与后端同临时目录（../search.js 相对路径落在桩上）；每场景
// 独立临时目录 → 模块 URL 唯一、分类器加载缓存互不串扰。ctx.fetch 立即抛无码网络故障 → 必经
// transport 相分类器（tavily 的 400/403/432/433 本地特例面不干扰）。运行时零真实等待。
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as C from "./helpers/contract.js";
import { srcPath } from "./helpers/impl.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";

/** 明确不属于 ENTRY_CODES / CONFIG_CODES 的桩输出码（未知分类码的载体）。 */
const BOGUS_CODE = "NOT_A_CLASSIFICATION";
/** 共享分类器自身抛异常面的哨兵（原样上抛 = message/name 均不动）。 */
const CRASH_MSG = "synthetic shared-classifier crash (P2-a sentinel)";

/** 桩：共享分类器返回非 ENTRY 码字符串（A1 deepseek 原样返回面 / A4 tavily 回退面共用）。 */
const SEARCH_RETURNS_BOGUS = `// oracle P2-a：返回未知码 ${BOGUS_CODE}（非 ENTRY_CODES 成员）\nexport function classifyUpstreamFailure(info) { return "${BOGUS_CODE}"; }\n`;
/** 桩：共享分类器返回 undefined（非 ENTRY 码的非字符串形态；四先例同样按未知码上抛）。 */
const SEARCH_RETURNS_UNDEFINED = "// oracle P2-a：返回 undefined（未知码面）\nexport function classifyUpstreamFailure(info) { return undefined; }\n";
/** 桩：共享分类器自身抛异常（A3：tavily try/catch 吞异常面对照四先例的原样上抛）。 */
const SEARCH_THROWS = [
  "// oracle P2-a：classifyUpstreamFailure 自身抛异常（吞异常面）",
  "export function classifyUpstreamFailure(info) {",
  `  const e = new Error(${JSON.stringify(CRASH_MSG)});`,
  '  e.name = "ClassifierCrash";',
  "  throw e;",
  "}",
  "",
].join("\n");

/**
 * 临时目录布局（同 P1-4 先例）：
 *   tmp/constants.js        ← src/constants.js 副本（deepseek/tavily 静态 import）
 *   tmp/search.js           ← 分类器桩（BOGUS / UNDEFINED / THROWS）
 *   tmp/backends/<name>.js  ← 被测后端副本
 */
async function stageBackend(relFromSrc) {
  const dir = await mkdtemp(path.join(tmpdir(), "dsc-p2a-"));
  await mkdir(path.join(dir, "backends"));
  await cp(srcPath(relFromSrc), path.join(dir, "backends", path.basename(relFromSrc)));
  await cp(srcPath("constants.js"), path.join(dir, "constants.js"));
  return {
    dir,
    setSearch: (content) => writeFile(path.join(dir, "search.js"), content, "utf8"),
    importBackend: () => import(pathToFileURL(path.join(dir, "backends", path.basename(relFromSrc))).href),
  };
}

/** A5 最小 ctx：fetch 立即抛无码网络故障 → 分类必经 transport 相共享分类器。 */
function makeCtx(type) {
  return {
    entry: { id: "p2a-e1", type, name: "P2-a 输出校验条目", enabled: true },
    query: "合成查询 输出校验",
    maxResults: 3,
    key: SYNTHETIC_KEY("p2a"),
    budgetMs: 5000,
    signal: undefined,
    clock: undefined, // fetch 立即抛，预算定时器被 finally/cleanup 清理，无真实等待
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

const pickDeepseek = (ns) => ns.deepseekBackends?.["deepseek-search"] ?? ns.deepseekSearchBackend;
const pickTavily = (ns) => ns.tavilyBackend ?? ns.createTavilyBackend?.() ?? ns.default;

/**
 * 「非 ENTRY 码输出 → 无码程序违约上抛」断言聚合器（A1/A2/A4）：
 *  ① 必须拒绝（不得 resolve）；
 *  ② 拒绝错误不得携带任何 .code（四先例 throw 的是无码 Error；带码——无论未知码还是本地兜底
 *    ENTRY 码——都说明违约被输出面消化而非上抛）；
 *  ③ 消息必须点名未知输出 String(code)（四先例消息一律嵌入 ${String(code)}，可核查性）。
 */
function expectUnknownCodeViolation(problems, label, err, returned) {
  if (err && err.resolved !== undefined) {
    problems.push(`${label}：应拒绝（程序违约上抛），实测 resolve 了：${JSON.stringify(err.resolved)}`);
    return;
  }
  if (err.code !== undefined) {
    problems.push(
      `${label}：共享分类器未知输出被消化而非上抛——终态携带 code=${String(err.code)}；四先例契约：非 ENTRY 码 → 无 ENTRY 码的程序违约原样上抛（A4/FB-005）`,
    );
    return;
  }
  if (!err.message.includes(String(returned))) {
    problems.push(
      `${label}：程序违约消息应点名未知输出「${String(returned)}」（四先例消息嵌入 String(code)，可核查）实际：${err.message}`,
    );
  }
}

// ─── deepseek：`typeof code === "string"` 即返回，非 ENTRY 码原样出门 ────────────────────

test("P2-a A1 deepseek：共享分类器返回非 ENTRY 码字符串→无码程序违约上抛（现状原样返回未知码出门，预期红）", async () => {
  const stage = await stageBackend("backends/deepseek.js");
  try {
    await stage.setSearch(SEARCH_RETURNS_BOGUS);
    const ns = await stage.importBackend();
    const backend = pickDeepseek(ns);
    assert.ok(backend && typeof backend.search === "function", "临时副本应仍导出 deepseek-search A5 后端");
    const problems = [];
    expectUnknownCodeViolation(problems, "transport 相未知码输出", await rejectionOfSearch(backend, makeCtx("deepseek-search")), BOGUS_CODE);
    assert.deepEqual(problems, [], "deepseek 对共享分类器输出无校验（预期红：对齐 exa/brave/gemini/openai 四先例后转绿）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});

test("P2-a A2 deepseek：共享分类器返回 undefined→同属未知码，无码程序违约上抛（现状静默落 localClassify，预期红）", async () => {
  const stage = await stageBackend("backends/deepseek.js");
  try {
    await stage.setSearch(SEARCH_RETURNS_UNDEFINED);
    const ns = await stage.importBackend();
    const backend = pickDeepseek(ns);
    const problems = [];
    expectUnknownCodeViolation(problems, "transport 相 undefined 输出", await rejectionOfSearch(backend, makeCtx("deepseek-search")), undefined);
    assert.deepEqual(problems, [], "deepseek 把非字符串输出静默兜到 localClassify（预期红：四先例对非 ENTRY 码一律上抛）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});

// ─── tavily：try{general}catch{} 吞异常；未知码回退 localGeneralCode ────────────────────

test("P2-a A3 tavily：共享分类器自身抛异常→原样上抛（现状 try/catch 吞掉后静默 localGeneralCode，预期红）", async () => {
  const stage = await stageBackend("backends/tavily.js");
  try {
    await stage.setSearch(SEARCH_THROWS);
    const ns = await stage.importBackend();
    const backend = pickTavily(ns);
    assert.ok(backend && typeof backend.search === "function", "临时副本应仍导出 tavily A5 后端");
    const problems = [];
    const err = await rejectionOfSearch(backend, makeCtx("tavily"));
    if (err && err.resolved !== undefined) {
      problems.push(`应拒绝（分类器异常上抛），实测 resolve 了：${JSON.stringify(err.resolved)}`);
    } else {
      // 四先例的 classify 对分类器自身异常不设防（原样传播）：修复 = 删除吞异常，异常对象原样出门。
      if (err.code !== undefined) {
        problems.push(
          `分类器异常被吞并静默本地兜底——终态携带 code=${String(err.code)}；须原样上抛分类器异常（无 ENTRY 码，A4/FB-005）`,
        );
      }
      if (err.message !== CRASH_MSG || err.name !== "ClassifierCrash") {
        problems.push(
          `须原样传播共享分类器异常（message/name 不动）：期望 message=${JSON.stringify(CRASH_MSG)} name="ClassifierCrash"，实测 message=${JSON.stringify(err.message)} name=${JSON.stringify(err.name)}`,
        );
      }
    }
    assert.deepEqual(problems, [], "tavily try{general}catch{} 吞共享分类器异常（预期红：对齐四先例后原样上抛）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});

test("P2-a A4 tavily：共享分类器返回非 ENTRY 码字符串→无码程序违约上抛（现状回退 localGeneralCode，预期红）", async () => {
  const stage = await stageBackend("backends/tavily.js");
  try {
    await stage.setSearch(SEARCH_RETURNS_BOGUS);
    const ns = await stage.importBackend();
    const backend = pickTavily(ns);
    const problems = [];
    expectUnknownCodeViolation(problems, "transport 相未知码输出", await rejectionOfSearch(backend, makeCtx("tavily")), BOGUS_CODE);
    assert.deepEqual(problems, [], "tavily 未知码回退 localGeneralCode（预期红：对齐四先例后未知码一律程序违约上抛）");
  } finally {
    await rm(stage.dir, { recursive: true, force: true });
  }
});
