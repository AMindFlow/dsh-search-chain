#!/usr/bin/env node
// 0.1.x → 0.2.0 迁移：把 profile 层 cordis.patch.yml 中 id: search-chain 行的 name 字段
// 从旧包名 dsh-search-chain 改写为 dsh-fleetseek（宿主以 name 解析组件包目录）。
// 只碰 search-chain 行内的 name 字段；写入前自动备份；幂等。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('用法: node scripts/migrate-0.2.0.mjs <profile目录>'); process.exit(1); }
const file = path.join(dir, 'cordis.patch.yml');
if (!fs.existsSync(file)) { console.error(`找不到 ${file}`); process.exit(1); }

const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');
let inRow = false, touched = 0, already = 0;
const out = lines.map((line) => {
  if (/^- id:\s*search-chain\s*$/.test(line)) { inRow = true; return line; }
  if (/^- /.test(line)) inRow = false;
  if (inRow && /^(\s*)name:\s*'?dsh-search-chain'?\s*$/.test(line)) {
    touched += 1;
    return line.replace(/name:\s*'?dsh-search-chain'?/, 'name: dsh-fleetseek');
  }
  if (inRow && /^(\s*)name:\s*'?dsh-fleetseek'?\s*$/.test(line)) { inRow = false; already += 1; }
  return line;
});
if (touched === 0) {
  console.log(already ? '已是新 name，无需迁移。' : '未发现 search-chain 行（该 profile 未安装过本插件？），未做任何修改。');
  process.exit(0);
}
const bak = file + '.bak-migrate-0.2.0-' + Date.now();
fs.copyFileSync(file, bak);
fs.writeFileSync(file, out.join('\n'));
console.log(`已改写 ${touched} 处 name → dsh-fleetseek；备份：${bak}`);
