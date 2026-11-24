// gap 修正 B 包 oracle（P1-3）— ENTRY_CODES 单一权威 = src/constants.js。
//
// 依据：FB-005 条目分类是横向契约（链按码消费）；「常量复制」的同步义务（constants.js 头注与各后端
// 镜像注记）只允许「值同」，不允许把镜像再导出为第二权威。src/constants.js 头注：运行时常量以
// constants.js 为源；test/helpers/contract.js 为 oracle 侧同值权威。后端命名空间再导出 ENTRY_CODES
// 会形成第三份可被 import 的权威（当前唯一违例：tavily.js 的 `export const ENTRY_CODES`——待 B 包
// 删除后改从 ../constants.js 引用）。
//
// 断言（均用动态 import，命名空间面）：
//   1) tavily 命名空间无 ENTRY_CODES 导出（缺陷钉：main 仍导出；B 包删除后转绿）。
//   2) 任何后端命名空间若仍暴露 ENTRY_CODES，必须与 src/constants.js 深比对全等（同步义务守卫，
//      当前绿：tavily 镜像值同 constants；其余六家本就不导出）。
//   3) src/constants.js 与 test/helpers/contract.js 的 ENTRY_CODES 深比对全等（运行侧↔oracle 侧
//      同值面守卫，当前绿；防止「改一侧漏一侧」把透传/分类断言建立在漂移的码表上）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";

/** 七个后端模块（命名空间动态导入，不预设导出形状）。 */
const BACKEND_MODULES = [
  "backends/openai.js",
  "backends/tavily.js",
  "backends/exa.js",
  "backends/brave.js",
  "backends/bing.js",
  "backends/gemini.js",
  "backends/deepseek.js",
];

async function importSrc(rel) {
  return import(new URL(`../src/${rel}`, import.meta.url).href);
}

test("P1-3 tavily 命名空间不得导出 ENTRY_CODES（FB-005 条目分类码单一权威=src/constants.js）", async () => {
  const ns = await importSrc("backends/tavily.js");
  assert.ok(
    !Object.hasOwn(ns, "ENTRY_CODES"),
    `tavily.js 仍把本地镜像再导出为第二权威：export ENTRY_CODES=${JSON.stringify(ns.ENTRY_CODES)}——` +
      "违反单一权威（P1-3）；应删除该导出并改从 ../constants.js 引用（预期红：main 未删）",
  );
});

test("P1-3 后端命名空间暴露的 ENTRY_CODES 必须与 src/constants.js 深比对全等（同步义务守卫，7 家全查）", async () => {
  const constants = await importSrc("constants.js");
  const problems = [];
  for (const rel of BACKEND_MODULES) {
    const ns = await importSrc(rel);
    if (ns.ENTRY_CODES === undefined) continue; // 不导出 = 合规（码从 ../constants.js 单源引用）
    try {
      assert.deepStrictEqual(ns.ENTRY_CODES, constants.ENTRY_CODES);
    } catch (err) {
      problems.push(
        `${rel} 导出的 ENTRY_CODES 与 src/constants.js 漂移：${err.message.split("\n")[0]}`,
      );
    }
  }
  assert.deepEqual(problems, [], "后端 ENTRY_CODES 与 constants 深比对不一致（同步义务被破坏）");
});

test("P1-3 src/constants.js ENTRY_CODES 与 test/helpers/contract.js 深比对全等（运行侧↔oracle 侧同值面）", async () => {
  const constants = await importSrc("constants.js");
  assert.deepStrictEqual(
    constants.ENTRY_CODES,
    C.ENTRY_CODES,
    "ENTRY_CODES 在运行侧（src/constants.js）与 oracle 侧（test/helpers/contract.js）漂移——同步义务违约",
  );
});
