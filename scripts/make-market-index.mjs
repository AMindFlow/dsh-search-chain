// 发布插件市场索引（format 1）到 artifacts/market-index.json：AMindFlow 自有索引源。
// 索引是给 DSH「Discover」页读的公开 JSON——只列名字/版本/commit/展示元数据，不含代码。
// 每次发布：git tag v<version> 之后跑 `node scripts/make-market-index.mjs`
//   已有线上索引时 `INDEX_URL=<现索引 raw URL> node scripts/make-market-index.mjs`
//   ——取回线上索引再 upsert 自己，取不回就中止，绝不本地盲写抹掉既有版本条目。
// 生成后用宿主随装校验器自检（见末尾输出提示）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const repoUrl = 'https://github.com/AMindFlow/dsh-search-chain.git'

// 展示元数据（Discover 卡片与详情页标题区）。正文详情以仓库 README 为准。
const meta = {
  title: {
    zh: '网页搜索链',
    en: 'Web Search Chain',
  },
  description: {
    zh: '多厂商搜索降级链：利用各厂商免费额度聚合出一个高额度、确保可用的 web_search。按你保存的顺序逐个尝试条目（供应商×端点），失败或无结果才降级，比裸 Bing 或 web_fetch 的结果更可用；条目级代理出站与 PAC 沙箱，配了代理的条目绝不静默回退直连。',
    en: 'An ordered multi-provider web_search chain: aggregate free quotas from Bing, Brave, Exa, Tavily, OpenAI, Gemini and DeepSeek into one high-quota, always-available search tool. Entries are tried in your saved order with fallback only on failure or empty results; per-entry proxy egress with a sandboxed PAC evaluator that never silently falls back to direct.',
  },
  keywords: ['web-search', 'fallback', 'multi-provider', 'proxy', 'pac', 'search'],
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const icon = `data:image/svg+xml;base64,${readFileSync(join(root, 'src/icon.svg')).toString('base64')}`

// commit 必须是 v<version> 标签指向的那个提交——Discover 安装的就是它
const commit = execFileSync('git', ['rev-parse', `v${manifest.version}^{commit}`], { cwd: root }).toString().trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`v${manifest.version} 的 commit 不合法：${commit}`)
const timestamp = Number(execFileSync('git', ['log', '-1', '--format=%ct', commit], { cwd: root }).toString().trim())

const ourEntry = {
  name: manifest.name,
  title: meta.title,
  description: meta.description,
  icon,
  author: 'AMindFlow',
  homepage: repoUrl.replace(/\.git$/u, ''),
  repository: { url: repoUrl.replace(/\.git$/u, '') },
  keywords: meta.keywords,
  versions: [
    {
      version: manifest.version,
      publishTimestamp: timestamp,
      source: { type: 'git', url: repoUrl, commit },
      engines: { dsh: manifest.engines.dsh },
    },
  ],
}

// —— 线上索引存在就必须先取回再 upsert；首次初始化显式 --init ——
const indexUrl = (process.env.INDEX_URL ?? '').trim()
let existing
if (indexUrl) {
  const res = await fetch(indexUrl, { redirect: 'follow' })
  if (!res.ok) throw new Error(`取不回线上索引（HTTP ${res.status}）：${indexUrl}\n拒绝盲写以免抹掉既有版本条目。`)
  existing = await res.json()
  if (existing?.format !== 1 || !Array.isArray(existing.plugins)) throw new Error('线上索引形状不认识（format/plugins），拒绝改动')
} else if (process.argv.includes('--init')) {
  existing = { format: 1, title: { zh: 'AMindFlow 插件索引', en: 'AMindFlow Plugin Index' }, description: { zh: 'AMindFlow 出品插件的 DSH 市场索引。', en: 'DSH market index for plugins by AMindFlow.' }, plugins: [] }
} else {
  throw new Error('缺少 INDEX_URL：已有线上索引时用 INDEX_URL=<raw URL> 取回后 upsert；首次生成加 --init')
}

const plugins = existing.plugins.map((plugin) => {
  if (plugin.name !== manifest.name) return plugin
  const kept = (plugin.versions ?? []).filter((item) => item.version !== manifest.version)
  return { ...ourEntry, versions: [...ourEntry.versions, ...kept].sort((a, b) => (a.publishTimestamp < b.publishTimestamp ? 1 : -1)) }
})
if (!plugins.some((plugin) => plugin.name === manifest.name)) plugins.push(ourEntry)
const index = { ...existing, plugins }

mkdirSync(join(root, 'artifacts'), { recursive: true })
const out = join(root, 'artifacts', 'market-index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`${out}`)
console.log(`  upsert ${manifest.name}@${manifest.version} → commit ${commit}（tag v${manifest.version} 解引用提交，发布后此 SHA 不变）`)
console.log(`  索引共 ${index.plugins.length} 个插件：${index.plugins.map((p) => p.name).join(', ')}`)
console.log('  官方校验（本机 DSH 随装的验证器，DSH_INSTALL_DIR 指向宿主 app.asar/dsh）：')
console.log('    ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e "const p=require(\'node:path\').dirname(require.resolve(\'@deepseek-ai/dsh-plugin-market-index/package.json\',{paths:[process.env.DSH_INSTALL_DIR]}));const i=require(p);i.parseMarketIndex(JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\')),\'https://example.com/index.json\');console.log(\'index OK\')" -- artifacts/market-index.json')
