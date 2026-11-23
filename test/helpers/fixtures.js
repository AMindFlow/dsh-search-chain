// 脱敏 fixture 加载器。目录规则见 test/fixtures/README.md。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL("../fixtures/", import.meta.url)));

/** fixture 相对路径 → 绝对路径（防止越界）。 */
export function fixturePath(name) {
  const abs = path.resolve(FIXTURES_DIR, name);
  if (abs !== FIXTURES_DIR && !abs.startsWith(FIXTURES_DIR + path.sep)) {
    throw new Error(`fixture 越界: ${name}`);
  }
  return abs;
}

/** 加载 fixture：.json 解析为对象，其余返回文本。 */
export function loadFixture(name) {
  const abs = fixturePath(name);
  const text = readFileSync(abs, "utf8");
  if (abs.endsWith(".json")) return JSON.parse(text);
  return text;
}

/** 列出全部 fixture 相对路径（不含 README.md，供完整性/卫生检查）。 */
export function listFixtures(dir = FIXTURES_DIR, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir)) {
    const abs = path.join(dir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    if (statSync(abs).isDirectory()) out.push(...listFixtures(abs, rel));
    else if (e !== "README.md") out.push(rel);
  }
  return out.sort();
}

export const FIXTURE_NAMES = {
  bingResults: "bing/rss-with-items.xml",
  bingEmpty: "bing/rss-empty.xml",
  bingNotRss: "bing/block-not-rss.html",
  bingMalformed: "bing/rss-malformed.xml",
  resultBasic: "results/search-result-basic.json",
  bingUpstream: "upstream/bing-outcomes.json",
  upstreamErrors: "upstream/http-outcomes.json",
  savedConfig: "chain/saved-config.json",
};
