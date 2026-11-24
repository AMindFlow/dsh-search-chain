// inject 完备性 oracle（PR#34 审阅缺口轮）：src 里每一次 ctx.get("NAME") / context.get("NAME")
// 都必须有 src/index.js `export const inject` 的对应声明——真宿主只注入 inject 声明过的服务
// （P1-5 / WP13 实机 P0 同律），漏声明的名字在真宿主上恒 undefined，可选链只是把它静默吞掉。
// 本用例是【预期红】的缺口哨兵：现红于 "agents"（src/official.js:99 读 ctx.get("agents")，
// 而 index.js 的 inject 未声明）。修复方向属 dev 面：把 agents 补进 src/index.js 的 inject；
// 测试侧不改期望、不豁免——名字 ⊆ inject 才是宿主上真实可得的语义。
//
// 防漂移写法（为何不用裸 grep）：
//  1. 静态收集对 src 下 .js 全量递归 readdir，新增文件自动纳入，无需维护清单。
//  2. 名字提取 = 原文件名匹配 + 词法扫描掩码（lexMask）双重判定：正则
//     /(?:ctx|context)\.get\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/ 允许命中的同时，
//     要求接收者标识符起点不在【注释或字符串/模板串内部】。误报面由此排除：
//       - 注释里的示例/文档引用（实存例：src/index.js:163 注释中的 ctx.get("credentials")）——
//         块注释/行注释体在掩码中整段为 true；串内容同样为 true（串内文档字符串的示例不算消费，
//         且名字始终取自原文件，不存在“剥空白后捕获空串”的自欺）。
//       - 非 ctx/context 接收者的字面量 .get：headers.get("content-type")（bing.js:369）、
//         Map.get 等——接收者名必须是裸标识符 ctx/context，且其前一字符不得是标识符字符或 `.`
//         （foo.ctx.get(...) 不属宿主注入面，不收）。
//       - 动态键 ctx.get(name)——非字面量参数不参与匹配（宿主无可校验名字；全仓当前不存在，
//         出现时应在此文件补显式豁免说明而不是放任）。
//     已知残留面（当前 src 不存在，若引入需人工复核本扫描）：含 ${...} 插值的模板串内部
//     不再递归扫描（`${ctx.get("x")}` 形态会漏收），正则字面量内含 `//` 或引号时掩码可能
//     把后续代码误标为串/注释（保守方向是少收/多掩，真缺口以可执行代码形态存在时仍会被扫到，
//     并有下方 credentials 收集自证兜底扫描器静默整段失效的情形）。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { srcPath } from "./helpers/impl.js";
import { inject } from "../src/index.js";

/**
 * 词法掩码：mask[i] === true 表示位置 i 处于注释体或字符串/模板串【内容】中（定界符本身为
 * false）。正则字面量整体跳过（内含 `//`、引号时不得误开注释/字符串态；含未闭合 `\` 续行时
 * 保守放弃识别）。简化前提（对本仓 src 成立）：不做 ASI/除号歧义分析——仅当前一代码字符为
 * 运算符/括号类时才把 `/` 当正则起点；模板串 ${…} 插值不递归（其内部文本计入掩码）。
 * @param {string} src
 * @returns {boolean[]} 与 src 等长的掩码数组
 */
function lexMask(src) {
  const mask = new Array(src.length).fill(false);
  const mark = (from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, src.length); i++) mask[i] = true;
  };
  let i = 0;
  let prevCode = ""; // 最近一个代码字符（注释/串内容不算），用于正则字面量起点判定
  const REGEX_PREV = new Set([
    "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
  ]);
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      mark(i + 2, stop); // 注释体（定界 // 保留为可匹配位，但注释体内坐标恒被掩）
      i = stop;
      continue;
    }
    if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      mark(i + 2, stop - 2);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (c !== "`" && src[j] === "\n") break; // 非模板串不跨行（未闭合容错）
        if (src[j] === c) { closed = true; break; }
        j += 1;
      }
      mark(i + 1, Math.min(j, src.length)); // 串内容计入掩码（模板含 ${…} 文本，不递归）
      prevCode = c;
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === "/" && REGEX_PREV.has(prevCode)) {
      const lit = /^\/(?![/*])(?:\\.|\[(?:\\.|[^\]\n\\])*\]|[^/\\\n])*\/[a-z]*/.exec(src.slice(i));
      if (lit) {
        i += lit[0].length; // 正则字面量整体跳过，不掩（其内容不会以裸 ctx 接收者形态成真匹配面）
        prevCode = "/";
        continue;
      }
      // 未闭合：保守放弃正则识别，`/` 按代码字符处理。
    }
    if (!/\s/.test(c)) prevCode = c;
    i += 1;
  }
  return mask;
}

function listSrcJs(dir, rel = "") {
  const found = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) found.push(...listSrcJs(p, r));
    else if (d.isFile() && d.name.endsWith(".js")) found.push(r);
  }
  return found.sort();
}

/** 消费到的宿主服务名 → 文件位置列表（src 全部 .js，净代码中的 ctx/context.get 字面量键）。 */
function collectCtxGetNames() {
  const hits = new Map(); // name → ["file:line", ...]
  const re = /(?:ctx|context)\.get\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)/g;
  for (const rel of listSrcJs(srcPath("."))) {
    const code = readFileSync(srcPath(rel), "utf8");
    const mask = lexMask(code);
    for (const m of code.matchAll(re)) {
      const receiver = m.index; // 命中以接收者标识符起头：起点即 ctx/context 首字符坐标
      if (mask[receiver]) continue; // 接收者在注释/串内 → 非消费点
      const before = receiver > 0 ? code[receiver - 1] : "";
      if (/[A-Za-z0-9_$.]/.test(before)) continue; // foo.ctx / myctx 等别名接收者不算宿主注入面
      const name = m[1].slice(1, -1);
      const line = 1 + (code.slice(0, m.index).match(/\n/g) ?? []).length; // 1-based 行号=前置换行数+1
      hits.set(name, [...(hits.get(name) ?? []), `${rel}:${line}`]);
    }
  }
  return hits;
}

test("inject 完备性：src 内 ctx.get/context.get 的名字必须全部 ∈ src/index.js 的 inject 声明（宿主只注入声明面，P1-5）", () => {
  assert.ok(Array.isArray(inject) && inject.length > 0, "src/index.js 必须导出字符串数组 inject");
  assert.ok(
    inject.every((n) => typeof n === "string" && n.length > 0),
    `inject 每项必须是非空字符串，实得 ${JSON.stringify(inject)}`,
  );
  const declared = new Set(inject);
  const hits = collectCtxGetNames();
  // 收集面自证：credentials 实存调用点（index.js hostCredentials）必须被扫到，
  // 且注释坐标不得入账（index.js:163 的注释示例会先命中，若掩码失效其行号 163 会混入）。
  assert.ok(hits.has("credentials"), "扫描器必须至少收集到 credentials（src/index.js 的实调用点）");
  assert.ok(
    hits.get("credentials").every((at) => at !== "index.js:163"),
    "注释里的 ctx.get 示例不得算消费（防掩码失效假覆盖）",
  );
  const undeclared = [...hits.keys()].filter((n) => !declared.has(n)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `ctx.get 消费了未声明服务：${undeclared.map((n) => `${n}（${hits.get(n).join(", ")}）`).join("；")}。` +
      `真宿主只注入 inject=${JSON.stringify([...declared])} 声明的服务，未声明名字恒 undefined。` +
      "修复：把它加进 src/index.js 的 export const inject（dev 面），本用例即转绿。",
  );
});
