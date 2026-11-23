# 测试 fixture 约定（WP0 oracle 定义）

本目录只放**脱敏的合成样本**，随仓库入库（见 docs/README.md 存放位置表）。`test/helpers/fixtures.js`
统一加载；`test/fixtures-hygiene.test.js` 对全部文件做卫生检查，违反下列规则即为测试失败。

## 组织

| 目录 | 内容 | 消费方 |
| --- | --- | --- |
| `bing/` | RSS 正常/空/拦截/畸形样本 | WP4（BING-001/002） |
| `results/` | 归一化 `WebSearchResult` 形状样本（FB-002） | WP5 及所有适配器 WP |
| `upstream/` | 上游 HTTP 结局分类样本（FB-005 映射输入） | WP1/2/3/4/5/8/9/10/11 |
| `chain/` | CFG-004 已保存配置快照样本 | WP1/WP5/WP12 |

## 卫生规则（强制）

1. 一切 URL 的 host 只允许保留 TLD（`.invalid`/`.test`/`.example`）或 `localhost`；
   绝不指向真实供应商域名。合成供应商主机沿用 `api.<supplier>.invalid` 形状。
2. 禁止带认证信息的 URL（`user:pass@host`）、真实 key、代理口令、PAC 认证参数。
3. 配置类 fixture 的条目只带 `credentialRef`（不透明合成串），绝不带明文 key 字段。
4. `sk-` 形状的字符串必须包含 `synthetic` 标记（可辨识合成值约定见
   `test/helpers/fake-fetch.js` 的 `SYNTHETIC_KEY`）。
5. 供应商正文/响应体一律手写合成，不复述真实抓包；结构（字段名、层级）须与协议文档一致，
   内容（文本、URL、时间）必须虚构。
6. 新增 fixture 时同步登记 `test/helpers/fixtures.js` 的 `FIXTURE_NAMES`，并保证
   卫生测试覆盖它。

## 命名

`<供应商或维度>/<语义>.<扩展名>`；同一场景的多种结局放同一供应商目录，用后缀区分
（如 `rss-with-items.xml` / `rss-empty.xml`）。
