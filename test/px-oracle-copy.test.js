// PX-010 出网承诺文案（README 最小句，新口径三要素；旧口径不孤立存在；无夸大表述）。
// Oracle 骨架（工作包 #88）：文案改写落地前跑红属预期。判定为关键词级自动化，「孤立形态」终判人工（上报#3）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLAUSES = "PX-010";
const readme = readFileSync(path.join(fileURLToPath(new URL("..", import.meta.url)), "README.md"), "utf8");
const lines = readme.split("\n");

test(`${CLAUSES} 验收1：headline/特性区存在新口径句且含三要素（默认关闭 / 可钉仅直连仅代理 / 升级事件可见）`, () => {
  const head = lines.slice(0, 80).join("\n");
  assert.match(head, /(出网路径|路径的改变|改变).{0,24}(可见|钉死)/, "README 顶部须存在「每一次出网路径的改变都可见、可钉死」口径句（PX-010）");
  const claim = lines
    .filter((l) => /(出网路径|全局代理|钉|升级)/.test(l) && !/^\s*$/.test(l))
    .join("\n");
  assert.match(claim, /默认(关闭|OFF|关)/, "三要素1：默认关闭");
  assert.match(claim, /仅直连|仅代理|钉死/, "三要素2：条目级钉死");
  assert.match(claim, /可见|状态行|诊断/, "三要素3：升级事件可见");
});

test(`${CLAUSES} 验收1/2：旧口径句不以孤立形态存在；无「默认开启/自动全条目」类夸大表述`, () => {
  const oldHits = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /(永不静默回退直连|绝不静默换路径)/.test(l));
  const contextOk = oldHits.every(({ i }) => {
    const window = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
    return /(改变.{0,12}可见|都可见|可钉死)/.test(window);
  });
  assert.ok(oldHits.length === 0 || contextOk, "旧口径句如仍存在，须被「出网路径改变都可见」上位表述覆盖（PX-010 要求2）");
  assert.ok(!/默认(开启|ON)/.test(readme), "不得出现「默认开启」失实表述（PX-010 验收2）");
  assert.ok(!/自动(为?)?(全部|所有)条目/.test(readme), "不得出现「自动全条目」失实表述（PX-010 验收2）");
});
