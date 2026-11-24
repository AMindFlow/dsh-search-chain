# Gemini Google Search grounding

## GMI-001 搜索请求与证据

- **要求** Gemini 条目使用支持 Google Search grounding 的 Gemini 模型。向 `https://generativelanguage.googleapis.com/v1beta/interactions` 发一次单查询 POST，使用 `x-goog-api-key`，启用 `google_search`，设置 `store: false`。保留本次返回的 Grounded Result、引用与关联 Search Suggestions 供 [GMI-002](#gmi-002-宿主展示与发布条件)处理。
- **要求** 只有实际完成服务端搜索且具有可展示的 grounded 结果，才算搜索成功。缺少该证据或收到上游错误时按[降级规格](fallback.md)处理。配置说明须标明模型与搜索产品的计费受所选模型和账户影响。
- **来源** [用户补充的 Gemini 要求 R11](../../project/requirements.md)。 [Google Search grounding](https://aistudio.google.com/docs/google-search) · [Interactions API](https://aistudio.google.com/docs/interactions-overview)
- **验收** 用替身核对鉴权、单查询、模型、`store: false` 和服务端工具形态。用有引用与建议、仅模型文本及上游失败样本验证结果或降级。

## GMI-002 宿主展示与发布条件

- **要求** Gemini 的发布路径须按 Google 对 Grounding with Google Search 的要求，将完整结果和关联搜索建议一起展示给该次查询的用户，保持引用可点击。由宿主客户端受支持的方式展示，避免把上游 HTML 放入模型文本或普通来源摘要。验明宿主的传递、呈现和留存符合接口使用条件后，才能将该适配器标为可用。
- **来源** [用户补充的 Gemini 首期要求 R11](../../project/requirements.md)。 [Google Grounding 使用限制](https://aistudio.google.com/docs/terms#grounding-with-google-search)
- **验收** 在测试 profile 运行真实 `web_search` 的展示原型，核对当前用户能同时看到完整反馈、引用和建议，并检查宿主记录及模型输出边界。通过后再用获准的账号和调用预算验证实际结果。

## GMI-003 厂商失败载荷本地重分类特例

- **要求** 按 [FB-005](fallback.md#fb-005-失败分类与排查提示)「具体接口的厂商码可由适配器按适配规格在本地重分类」的授权，Gemini 适配器必须维护本规格的本地特例，链按适配器抛出的码消费。额度特例（码判据，范围与 FB-005 一致）：响应体 `error` 包络的 `code` 或 `status` 字段为字符串且大小写不敏感地命中 `insufficient_quota` 或 `resource_exhausted` 时，条目必须分类为额度失败而非限流；该判据不受 HTTP 状态码限制，是否为 `429` 均命中即额度优先——与 FB-005「上游码 `insufficient_quota`……无论有无状态码均按额度优先判定」及链层统一额度证据码规则（`src/search.js` 的 `QUOTA_EVIDENCE_CODES` 先于状态码判定，#12-5 额度统一）同口径：交付实现在 `429` 由适配器先行判定并覆盖 `error.status` 形态与大小写不敏感，`429` 外由字符串 `error.code` 经链层规则额度优先。其余不满足任何额度判据的 `429` 属限流（FB-005 字面原文不变）。内容安全拦截的判定先于额度判定。
- **要求** 响应体顶层或其 `error` 包络的 `code`、`status` 字段为字符串且大小写不敏感地命中官方 generation-blocked 码族 `safety`、`recitation`、`prohibited_content`、`spii`、`blocklist`、`content_policy` 时，必须分类为内容策略拒绝，不依赖 HTTP 状态码：HTTP 错误响应与 `status` 非 `completed` 的响应体（含冻结形状 `status: "failed"`、`error.code: "SAFETY"`）均适用，并按 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)终止该链尝试。冻结测试只钉 `SAFETY` 单码；扩展为码族的依据是官方 API errors 文档。
- **要求** 消息级额度判据（单列，低置信）：`error.message` 含子串 `quota`（大小写不敏感）时按额度失败处理。该判据是消息启发而非厂商错误码，授权面弱于上条码判据——FB-005 的本地重分类授权针对「厂商码」，本条只是该授权下在 `429` 额度预判定内的启发扩展（交付实现不在 `429` 外的状态码使用消息单独判定），且其 Interactions 实机响应样本尚未取得。该判据与 [FB-005](fallback.md#fb-005-失败分类与排查提示)的 `QUOTA_LIMITED` 同列待证认清单，须在 [WP7 首期发布验收](https://github.com/AMindFlow/dsh-search-chain/issues/13)用实机样本复核；复核否定该判据时，判定必须收敛到仅剩 `insufficient_quota`/`resource_exhausted` 码判据，其余分类行为不变。
- **来源** [WP7 首期发布验收 Issue #13](https://github.com/AMindFlow/dsh-search-chain/issues/13) 差距 P2-5（把 WP11 已落地实现如实入规格，源码 P-10b/P-11 裁决）。先例：Tavily 用量超限码本地额度特例（[FB-005](fallback.md#fb-005-失败分类与排查提示)正文单向引用 [TAV-002](tavily.md#tav-002-结果映射与正常空结果)；TAV-002 正文未回引 FB-005）。 [Google API errors](https://ai.google.dev/gemini-api/docs/errors)
- **验收** 用替身分别构造 `429` + `error.code: "insufficient_quota"`、`429` + `error.status: "RESOURCE_EXHAUSTED"`、`429` 且仅消息含 `quota`（码/状态字段不命中）、`429` 且无上述载荷，观察前三者条目按额度失败降级、第四者按限流；另构造非 `429` 状态码配额度证据码的组合，观察同按额度优先判定。构造 `status: "failed"` + `error.code: "SAFETY"` 与 HTTP 错误体内带 `error.status: "PROHIBITED_CONTENT"`（非冻结状态码形态），观察内容策略拒绝并终止对该条目的后续处理。已覆盖 fixture 见 `test/gemini-pending.test.js`（P-10b 冻结面 `SAFETY`、P-11 复合额度体：`RESOURCE_EXHAUSTED` 与配额消息同现）与 `test/gemini-failure.test.js`（`402`、`429` + `insufficient_quota`、其他 `429`→限流）。待覆盖（fixture 尚无，本轮不作通过依据）：`SAFETY` 外的安全码族扩展成员（`PROHIBITED_CONTENT`/`BLOCKLIST`/`RECITATION`/`CONTENT_POLICY` 经 `error.code` 或 `error.status` 命中的样本）、HTTP 错误响应体内出现的安全码（非冻结 `status: "failed"` 面的形态）、消息级 `quota` 启发单独生效（无码/状态命中）的样本、码判据在非 `429` 状态码下的单独形态。消息级 `quota` 判据的实机复核在 WP7 发布验收按待证认清单执行，本轮不作通过依据。

## 设计决定

- dsh `0.2.2-rc.5` 默认搜索结果只投影 `sources`、`content` 和 `truncated`。先验证有无支持单独呈现的插件接口；仅把 Gemini 引用抽出到普通来源列表不足以作为本条发布验收。
- （draft 定案提案，裁决日期 2026-11-25；本条待 WP7（#13）实机证认后转正式规格）GMI-003 将 WP11 交付中已实现的 Gemini 本地重分类特例登记为规格条款，判据以交付实现（`src/backends/gemini.js`）为准；授权来自 FB-005 的厂商码本地重分类条款，格式随 Tavily `432`/`433` 本地额度特例先例（FB-005→TAV-002 单向引用）。原 P-11 裁决记录的「与 FB-005 字面『其他 429 属限流』冲突、待统一定案」由本条消解：额度证据码（`insufficient_quota`/`resource_exhausted`，大小写不敏感，含 `error.status` 形态）不受状态码限制、命中即额度优先，与 FB-005「无论有无状态码均按额度优先判定」同口径而非违例；「其他 429 属限流」保持 FB-005 字面原文，指不满足任何额度判据的 `429`。`src/backends/gemini.js` 当前临时口径注记（P-11）以本条为定案去向，WP7 实机证认后随本条转正式。`quota` 消息启发与 `QUOTA_LIMITED` 同属缺第一手实机样本的待证认判据（消息启发非厂商码，授权面弱于码判据），WP7（#13）复核前仅作临时口径。
