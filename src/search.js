// WP5 — 搜索链编排（docs/specs/draft/fallback.md FB-001…FB-005）。
//
// 导出（contract.js A4）：
//   createSearchChain(deps) → { search(request, signal) }
//     deps = { getConfig, backends, transport, credentials, env, clock, log, legacyYaml? }
//     clock = { now, setTimeout, clearTimeout, abortSignal }（A8，受控时钟；本模块只用 now/setTimeout/clearTimeout）
//   classifyUpstreamFailure(info) → ENTRY_CODES 之一（info = { status?, upstreamCode?, phase?, error? }）
//
// 行为边界（实现只覆盖冻结测试与规格）：
//   - 搜索开始取一次配置快照，执行中不重读（CFG-004/FB-001）；
//   - 串行、每条目最多一次提交、首个有效来源即停（FB-001）；
//   - 条目预算 = floor(剩余总预算 / 该条目及其之后启用条目数)，含尚未检查凭据的启用条目（FB-003）；
//   - 条目到期中止其 signal，剩余预算允许时继续；迟到结果不得改变已收敛的搜索（FB-003）；
//   - 宿主取消传播到在途条目并立即终止整链，之后不再出站（FB-003）；
//   - 空列表/全停用/全缺 key/明确无结果/全链失败/内容策略拒绝的终态（FB-004/FB-005）；
//   - 程序违约（适配器 throw 无条目可降级码的错误）原样暴露，不包装、不再发起新请求（FB-005）；
//   - 条目执行期带 ENTRY_*/CONFIG_*（含 PAC_*）码的适配器错误按条目级失败降级，原码进 attempts（PR#35 裁决补充）；
//     TRANSPORT_RELEASED（停机释放）与全局 CONFIG_*（链级配置读取失败）仍裸上抛；
//   - 输出脱敏：错误与日志只含链自产的条目级文本，不带上游原始报文（CFG-003）。
//
// 运行时代码不 import test/；常量来自 ./constants.js（运行时共享常量唯一来源，与 test/helpers/contract.js 同值）。

import {
  ENTRY_CODES,
  CONFIG_CODES,
  SKIPPED_NO_KEY,
  CHAIN_CODES,
  KEY_ENV_BY_TYPE,
  LEGACY_YAML_SUPPLIERS,
  DEFAULT_TIMEOUT_MS,
  supplierOfToolType,
} from "./constants.js";

const ENTRY_CODE_VALUES = new Set(Object.values(ENTRY_CODES));

/**
 * 条目执行期可降级的带码错误（PR#35 lead 裁决补充）：ENTRY_* 与 CONFIG_*（含 PAC_*）。
 * 原码原样进 attempts，按条目级失败降级到下一条目；全败时终态 WebError.attempts 携各条原码。
 * 不在此集合内的带码错误走裸上抛（FB-005 程序违约原样暴露）：
 *   - TRANSPORT_RELEASED：停机释放语义，既有绿面（transport-passthrough P1-1 raw 行）要求裸上抛；
 *   - 全局 CONFIG_*（链级 getConfig 自身失败）：search() 入口同步上抛，无条目上下文，不经本路径。
 */
const ENTRY_PHASE_CODE_VALUES = new Set([...ENTRY_CODE_VALUES, ...Object.values(CONFIG_CODES)]);

/**
 * #86 POOL-004 轮替触发集（key-pool.md 设计决定 + lead 审阅批准）：仅凭据/额度/限流类上游失败
 * 指向「换一把 key 可能成功」，条目内在池序内换 key 重试；每把 key 至多一次提交（无二次轮转）。
 * 其余码（NETWORK/PROXY/TIMEOUT/CHANNEL_LIMIT/BAD_RESPONSE/CONTENT_POLICY/CONFIG_*）不轮替——
 * 换 key 不改变其归因，按 FB-001/FB-005 既有降级/终止语义处理（POOL-004④⑦）。
 */
const POOL_ROTATION_CODES = new Set([
  ENTRY_CODES.CREDENTIALS,
  ENTRY_CODES.QUOTA,
  ENTRY_CODES.RATE_LIMITED,
]);

// CONFIG_* 与 PAC_* 条目执行期码的诊断文案（仅链自产文本，不带上游原文，CFG-003）。
const CONFIG_PHASE_DESC = {
  [CONFIG_CODES.INVALID]: "配置违约",
  [CONFIG_CODES.CREDENTIALS_UNREADABLE]: "凭据配置不可读",
  [CONFIG_CODES.SAVE_FAILED]: "配置保存失败",
  [CONFIG_CODES.PAC_FETCH_FAILED]: "PAC 获取失败",
  [CONFIG_CODES.PAC_EVAL_FAILED]: "PAC 求值失败",
  [CONFIG_CODES.PAC_ROUTE_FAILED]: "PAC 路由/建连失败",
  [CONFIG_CODES.ROW_UNAVAILABLE]: "配置行不可用",
};

/**
 * FB-002 内容模式判定（oracle 假设③，裁决：规格沉默 → 链侧本地表）。
 * BING-001 只映射 link/title/description/pubDate，是纯来源适配器；
 * 其供应商生成的正文不得作为通用 content（FB-002 第 15 行）。
 * 其余类型按各适配规格返回的 content 透传。
 */
const SOURCES_ONLY_TYPES = new Set(["bing"]);

/** 条目级失败 → 可核查的脱敏 reason（CFG-003：只写条目与配置项，不带上游原文）。 */
const FAILURE_REASON = {
  [ENTRY_CODES.CREDENTIALS]: (entry) =>
    `凭据或权限被上游拒绝：请检查条目「${entry.name}」的 key 是否有效、未过期且与该供应商匹配`,
  [ENTRY_CODES.QUOTA]: (entry) => `额度不足（上游 402 或 insufficient_quota）：请检查条目「${entry.name}」对应服务的余额`,
  [ENTRY_CODES.RATE_LIMITED]: (entry) => `触发限流（上游 429）：请稍后重试或检查条目「${entry.name}」的限流策略`,
  [ENTRY_CODES.PROXY]: (entry) => `代理失败：请检查条目「${entry.name}」的 proxy 配置（该条目不会自动改走直连）`,
  [ENTRY_CODES.NETWORK]: (entry) => `直连网络失败：请检查条目「${entry.name}」所在网络的可达性`,
  [ENTRY_CODES.CHANNEL_LIMIT]: (entry) => `通道参数限制：请检查条目「${entry.name}」的类型参数（模型/模式等）`,
  [ENTRY_CODES.TIMEOUT]: (entry, budgetMs) =>
    `条目超时：未在其预算 ${budgetMs}ms 内返回（该条目请求已被取消）`,
  [ENTRY_CODES.BAD_RESPONSE]: (entry) => `上游响应异常：响应无法按该条目的适配规格解析`,
  [ENTRY_CODES.CONTENT_POLICY]: (entry) =>
    `上游内容策略明确拒绝（此类失败不降级，搜索链已终止）：条目「${entry.name}」`,
};
for (const [code, desc] of Object.entries(CONFIG_PHASE_DESC)) {
  FAILURE_REASON[code] = (entry) =>
    `${desc}（${code}）：请检查条目「${entry.name}」的配置项（条目执行期失败，链已降级到下一条目，原码保留于 attempts）`;
}

/** FB-002 接管提示里对前序条目的一字概括（脱敏）。 */
const ISSUE_DESC = {
  [ENTRY_CODES.CREDENTIALS]: "凭据或权限失败",
  [ENTRY_CODES.QUOTA]: "额度不足",
  [ENTRY_CODES.RATE_LIMITED]: "被限流",
  [ENTRY_CODES.PROXY]: "代理失败",
  [ENTRY_CODES.NETWORK]: "网络失败",
  [ENTRY_CODES.CHANNEL_LIMIT]: "通道参数受限",
  [ENTRY_CODES.TIMEOUT]: "超时",
  [ENTRY_CODES.BAD_RESPONSE]: "响应异常",
  [ENTRY_CODES.CONTENT_POLICY]: "内容策略拒绝",
};
for (const [code, desc] of Object.entries(CONFIG_PHASE_DESC)) ISSUE_DESC[code] = `${desc}（${code}）`;

/** 终态 WebError（A7 形状；宿主类的最终封装属宿主核对项 HOST-5，见文末待办）。 */
class WebError extends Error {
  constructor(code, message, attempts) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.details = { attempts: attempts.map((a) => ({ ...a })) };
  }
}

/** #12-5 额度证据码（upstreamCode）：出现即归 QUOTA，与状态码无关。 */
const QUOTA_EVIDENCE_CODES = new Set([
  "insufficient_quota",
  "resource_exhausted",
  "RESOURCE_EXHAUSTED",
  "QUOTA_LIMITED",
]);

/**
 * FB-005 上游结局 → 条目级分类码。
 * 判定顺序（优先级自上而下）：
 *   - phase "timeout" → TIMEOUT；
 *   - 响应解析失败（A4 解析失败信号 = phase "response" + error 为 SyntaxError）→ BAD_RESPONSE；
 *   - phase "transport"（无 HTTP 状态的网络层失败）→ NETWORK；
 *   - 上游 code ∈ QUOTA_EVIDENCE_CODES（insufficient_quota / resource_exhausted / QUOTA_LIMITED）→ QUOTA（#12-5，无论有无状态码，额度优先）；
 *   - HTTP 402 → QUOTA；
 *   - HTTP 429 → RATE_LIMITED；
 *   - HTTP 401/403 → CREDENTIALS；
 *   - 其他 HTTP 4xx（含 400、432、433 等厂商码，裁决：不做通用特例）→ CHANNEL_LIMIT；
 *   - 其余 HTTP 状态（5xx 等）→ BAD_RESPONSE；
 *   - 已到响应相位（phase "response"）但无状态码、无 error → BAD_RESPONSE；
 *   - 无阶段、无状态码的未知失败 → NETWORK（直连网络兜底，可定位到条目）。
 * PROXY / CONTENT_POLICY 的上游输入信号形态尚未定名，本分类器不产出；
 * 它们只能由适配器按各 backends 规格在抛出时直接赋码（A5），链按码消费。
 */
export function classifyUpstreamFailure(info = {}) {
  const { status, upstreamCode, phase, error } = info;
  if (phase === "timeout") return ENTRY_CODES.TIMEOUT;
  if (error instanceof SyntaxError) return ENTRY_CODES.BAD_RESPONSE;
  if (phase === "transport") return ENTRY_CODES.NETWORK;
  // #12-5 额度统一规则：任意状态码 + 额度证据 → QUOTA（证据优先于状态码，429 亦然）。
  if (QUOTA_EVIDENCE_CODES.has(upstreamCode)) return ENTRY_CODES.QUOTA;
  if (typeof status === "number") {
    if (status === 402) return ENTRY_CODES.QUOTA;
    if (status === 429) return ENTRY_CODES.RATE_LIMITED;
    if (status === 401 || status === 403) return ENTRY_CODES.CREDENTIALS;
    if (status >= 400 && status <= 499) return ENTRY_CODES.CHANNEL_LIMIT;
    return ENTRY_CODES.BAD_RESPONSE;
  }
  if (phase === "response") return ENTRY_CODES.BAD_RESPONSE;
  // 无阶段、无状态码的未知失败：按直连网络兜底（可定位到条目，FB-005）。
  return ENTRY_CODES.NETWORK;
}

export function createSearchChain(deps) {
  const { getConfig, backends, transport, credentials, clock, log } = deps;
  const env = deps.env ?? {};
  const legacyYaml = deps.legacyYaml;

  return { search };

  /**
   * 执行一次搜索（一次搜索 = 一条查询，FB-003/DSH-002）。
   * @param {{ query: string, maxResults?: number }} request
   * @param {AbortSignal} [externalSignal] 宿主取消信号（FB-003）
   * @param {object} [configSnapshot] 装配层快照注入（#12 每操作契约）：由 provider 入口一次读取的规范化快照；
   *   缺省时链自读 getConfig()（独立使用的兼容默认）。
   */
  function search(request, externalSignal, configSnapshot) {
    // CFG-004/FB-001：搜索开始取一次快照（深拷贝——中途保存是同一对象的就地改写，
    // 快照必须独立），执行中不重读。
    const rawConfig = (configSnapshot !== undefined ? configSnapshot : getConfig()) ?? {};
    const snapshotEntries = deepClone(Array.isArray(rawConfig.entries) ? rawConfig.entries : []);
    const totalBudget = normalizeBudget(rawConfig.timeoutMs);
    const startAt = clock.now();

    const query = request?.query;
    if (typeof query !== "string" || query.trim() === "") {
      // 参数违约（宿主判定查询无效的边界在 provider 层，DSH-002）：无出站请求，原样暴露（FB-005）。
      throw new TypeError("search(request): query 必须为非空字符串");
    }
    // 链层下限守则：整数 maxResults ≤0 钳到 1；非整数/缺省视为不限制（null）。
    const maxResults = Number.isInteger(request.maxResults) ? Math.max(1, request.maxResults) : null;

    if (externalSignal?.aborted) return rejectAborted(externalSignal);

    const state = { cancelled: false };
    // FB-003：宿主取消登记在本次搜索上；结算（成功/失败/取消）后摘除，不在宿主信号上留下悬挂监听（P2-3）。
    const onExternalAbort = () => { state.cancelled = true; };
    if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const attempts = []; // A7/FB-004：跳过与失败条目，按尝试顺序
    const issues = []; // FB-002：此前被跳过/失败的启用条目（接管提示素材）
    let failed = 0;
    let stoppedByBudget = false;
    let anyExplicitEmpty = false; // FB-004：是否有已尝试条目明确无结果

    const run = async () => {
      for (let i = 0; i < snapshotEntries.length; i++) {
        if (state.cancelled) break;
        const remaining = totalBudget - (clock.now() - startAt);
        if (remaining <= 0) {
          stoppedByBudget = true; // FB-003：总预算耗尽，不得再请求
          break;
        }
        const entry = snapshotEntries[i];
        if (entry?.enabled !== true) continue; // 停用条目：不解析凭据、不 open、不记录（FB-001/FB-002）

        // FB-003：该条目及其之后的启用条目数（含尚未检查凭据的启用条目），向下取整。
        let denominator = 0;
        for (let j = i; j < snapshotEntries.length; j++) {
          if (snapshotEntries[j]?.enabled === true) denominator += 1;
        }
        const budgetMs = Math.floor(remaining / denominator);
        if (budgetMs <= 0) continue; // FB-003：无可用时间不得发出请求（不计入 attempts）

        // CFG-002：只为实际准备尝试的启用条目解析 key；免 key 类型（bing）不读凭据。
        // #86 POOL-004/007：credentialRefs 池形态 = 唯一轮替候选集；池全 absent → 下层兜底单 key。
        const envName = KEY_ENV_BY_TYPE[entry.type];
        let plan = null;
        let credentialReadError = null;
        if (envName) {
          try {
            plan = await resolvePoolPlan(entry, envName);
          } catch (err) {
            credentialReadError = err;
          }
        }
        // FB-003 取消闸：await resolvePoolPlan 期间宿主可能已取消；此处复查，已取消则零出站、不进入 transport.open。
        if (externalSignal?.aborted || state.cancelled) throw abortError(externalSignal);
        if (credentialReadError) {
          // CFG-002「需要读取但无法访问或解析的凭据文件须报告配置错误」：
          // 链级映射为该条目凭据失败（可降级），原文不入错误/日志（CFG-003）。
          const reason = "凭据引用读取失败（凭据服务不可用或引用损坏，内容已脱敏）";
          recordFailure(entry, ENTRY_CODES.CREDENTIALS, reason);
          continue;
        }
        if (envName && plan === null) {
          const reason = `缺少凭据：${envName} 未配置（条目引用、环境变量与 DSH 托管记录均未提供）`;
          attempts.push(attemptOf(entry, SKIPPED_NO_KEY, reason));
          issues.push({ kind: "skip", name: entry.name, envName });
          continue;
        }

        const outcome = await runEntryPool(entry, { query, maxResults, plan, budgetMs, externalSignal, state });

        if (outcome.kind === "cancelled") {
          // FB-003：宿主取消须终止整链（拒绝），不得再请求。
          throw abortError(externalSignal);
        }
        if (outcome.kind === "timeout") {
          recordFailure(entry, ENTRY_CODES.TIMEOUT, FAILURE_REASON[ENTRY_CODES.TIMEOUT](entry, budgetMs), poolOf(outcome));
          continue; // FB-003：剩余总预算允许时继续下一条
        }
        if (outcome.kind === "error") {
          const code = isEntryPhaseCode(outcome.error?.code) ? outcome.error.code : null;
          if (code === null) {
            // A5/FB-005：程序违约（无条目可降级的码，含 TRANSPORT_RELEASED）原样暴露，不包装、不再发起新上游请求。
            throw outcome.error;
          }
          // POOL-006①：池耗尽文案（「全部 N 把 key 失败」）仅限池形态且实际尝试 ≥2 把；
          // 单 key（含 1 元池、下层兜底单 key）维持 v0.2.0 基准文案，不得出现池字样。
          const reason = outcome.fromPool && outcome.tried >= 2
            ? `全部 ${outcome.tried} 把 key 失败：${FAILURE_REASON[code](entry, budgetMs)}`
            : FAILURE_REASON[code](entry, budgetMs);
          recordFailure(entry, code, reason, poolOf(outcome));
          if (code === ENTRY_CODES.CONTENT_POLICY) break; // FB-001/FB-005：终止类，不降级（POOL-004⑦ 零轮替）
          continue;
        }
        // 成功结果（A5 resolve）：非空有效来源 → 首个返回有效来源的条目结束搜索（FB-001）；
        // 空数组 = 明确无结果 → 总预算内继续下一条（FB-001/FB-004，POOL-004⑤ 空结果停止轮次）。
        const built = buildSuccessResult(entry, outcome.value, { maxResults, issues });
        if (built.sources.length > 0) {
          if (outcome.fromPool && outcome.switched && outcome.poolSize > 1) {
            // POOL-006②：换 key 命中成功 → content 首行冠「已使用第 N/M 把 key」（FB-002 同一渠道）。
            const note = `已使用第 ${outcome.usedIndex}/${outcome.poolSize} 把 key`;
            built.content = built.content ? `${note}\n${built.content}` : note;
          }
          log?.("debug", "search-chain 条目命中", { entryId: entry.id, type: entry.type });
          return built;
        }
        anyExplicitEmpty = true;
        continue;
      }
      if (state.cancelled) {
        // FB-003：宿主取消发生在条目间隙时同样须以拒绝终止，不得落入终态判定。
        throw abortError(externalSignal);
      }
      if (totalBudget - (clock.now() - startAt) <= 0) stoppedByBudget = true;
      return terminalResult();
    };

    function recordFailure(entry, code, reason, pool) {
      attempts.push(attemptOf(entry, code, reason, pool));
      issues.push({ kind: "fail", name: entry.name, code });
      failed += 1;
      log?.("warn", "search-chain 条目失败", { entryId: entry.id, type: entry.type, code });
    }

    // FB-004 终态判定（成功/取消已在 run 内收敛）。
    function terminalResult() {
      const enabledCount = snapshotEntries.filter((e) => e?.enabled === true).length;
      if (enabledCount === 0) {
        // 空列表或全停用：未配置可用工具（attempts 必为空）。
        return Promise.reject(
          new WebError(CHAIN_CODES.NOT_CONFIGURED, "未配置可用搜索工具：列表为空或全部条目已停用", []),
        );
      }
      if (failed === 0) {
        if (anyExplicitEmpty) {
          // FB-004：已尝试条目中至少一条明确无结果且没有失败 → 空成功终态（跳过不是失败）。
          return { sources: [], truncated: false };
        }
        if (attempts.length > 0) {
          // 全部启用条目均因缺必要凭据跳过（没有任何条目被尝试）：说明缺失项（凭据名）。
          const missingNames = [
            ...new Set(
              attempts.map((a) => a.reason.match(/缺少凭据：(\S+)/)?.[1]).filter(Boolean),
            ),
          ];
          return Promise.reject(
            new WebError(
              CHAIN_CODES.ALL_KEYS_MISSING,
              `全部启用条目因缺少必要凭据被跳过：${missingNames.join("、")}`,
              attempts,
            ),
          );
        }
        // 规格沉默项：启用条目全部「预算为 0 未出站」（无尝试、无失败、无空结果）时
        // 同样收敛为空成功终态——无失败可言，FB-004 无其他适用终态。
        return { sources: [], truncated: false };
      }
      if (attempts.some((a) => a.code === ENTRY_CODES.CONTENT_POLICY)) {
        const culprit = attempts.find((a) => a.code === ENTRY_CODES.CONTENT_POLICY);
        return Promise.reject(
          new WebError(
            CHAIN_CODES.CONTENT_POLICY,
            `上游内容策略明确拒绝（条目「${culprit.entryName}」），搜索链已终止`,
            attempts,
          ),
        );
      }
      if (stoppedByBudget) {
        return Promise.reject(
          new WebError(
            CHAIN_CODES.BUDGET_EXHAUSTED,
            `总预算 ${totalBudget}ms 已耗尽且未获得有效来源（见 details.attempts 的逐条原因）`,
            attempts,
          ),
        );
      }
      return Promise.reject(
        new WebError(
          CHAIN_CODES.UPSTREAM_FAILURES,
          "全链未获得有效来源：尝试过的条目均失败或被跳过（见 details.attempts 的逐条原因）",
          attempts,
        ),
      );
    }

    /**
     * 实际尝试一个条目（A6：transport.open → 适配器 ctx.fetch → close）。
     * #86 POOL-004 池轮替：候选集内按池序逐 key 尝试——每把 key 至多一次提交；每把 key 独立
     * open→search→close 生命周期；条目预算为全部 key 共享（分母不因池 >1 改变，POOL-005），
     * 逐次 race = min(名义预算, 本次尝试开始时剩余)；触发集外（POOL_ROTATION_CODES）不轮替；
     * 单 key / 单引用 / 下层兜底 = 单候选，行为与 v0.2.0 逐位一致。
     * @returns {Promise<{kind:"success", value, switched, usedIndex, fromPool, poolSize}
     *                  |{kind:"error", error, tried, fromPool, poolSize, triedList}
     *                  |{kind:"timeout", tried, fromPool, poolSize, triedList}
     *                  |{kind:"cancelled"}>}
     */
    async function runEntryPool(entry, { query, maxResults, plan, budgetMs, externalSignal, state }) {
      const backend = backends.get?.(entry.type);
      if (!backend || typeof backend.search !== "function") {
        // 目录与后端不一致属内部程序违约：无 code，原样暴露（FB-005）。
        throw new TypeError(`[search-chain] 条目 ${entry.id}（${entry.type}）没有可用的后端适配器（程序违约）`);
      }
      const candidates = Array.isArray(plan?.candidates) && plan.candidates.length > 0
        ? plan.candidates
        : [{ ref: null, key: null, index: 0 }];
      const fromPool = Boolean(plan?.fromPool);
      const poolSize = Number.isInteger(plan?.poolSize) ? plan.poolSize : 0;
      const entryStartAt = clock.now();
      const triedList = []; // 逐 key 脱敏明细 { index, code }：index 为池内序号（1 起），下层兜底单 key 为 0
      const meta = () => ({ tried: triedList.length, fromPool, poolSize, triedList });
      const poolDetail = () => (fromPool ? { size: poolSize, tried: triedList.length, outcomes: triedList.map((t) => ({ index: t.index, code: t.code })) } : undefined);
      const rotateOrEnd = (code, prevCand, nextCand) => {
        // POOL-004 脱敏轮替事件：每次换 key 恰一条（事件数 = 换 key 次数）；只含条目 id 与池内序号，
        // 不得携带引用名/key 明文（CFG-003/POOL-006③）。
        log?.("warn", "search-chain key 轮替", { entryId: entry.id, type: entry.type, fromIndex: prevCand.index, toIndex: nextCand.index, code });
      };
      for (let ci = 0; ci < candidates.length; ci++) {
        if (state.cancelled) return { kind: "cancelled" };
        const cand = candidates[ci];
        const remaining = budgetMs - (clock.now() - entryStartAt);
        if (remaining <= 0) {
          // 条目预算（全 key 共享）耗尽：不得再出站，ENTRY_TIMEOUT 归因（POOL-005①a）。
          return { kind: "timeout", ...meta() };
        }
        const entryAc = new AbortController();
        // A6 seam 前：open 失败时尚无句柄、适配器未触及。open 错误不是换 key 的触发集
        // （传输/代理/配置问题与 key 无关）——带码按本 key 失败归因后整条终结，
        // 无码/TRANSPORT_RELEASED 裸上抛（A5/FB-005）。
        let handle;
        try {
          handle = transport.open(entry);
        } catch (error) {
          if (!isEntryPhaseCode(error?.code)) return { kind: "error", error };
          triedList.push({ index: cand.index, code: error.code });
          const nextCand = candidates[ci + 1];
          if (nextCand && POOL_ROTATION_CODES.has(error.code)) {
            rotateOrEnd(error.code, cand, nextCand);
            continue;
          }
          return { kind: "error", error, ...meta() };
        }
        const ctx = {
          entry,
          query,
          maxResults,
          key: cand.key,
          fetch: handle.fetch,
          budgetMs, // 名义条目预算恒为 FB-003 公式值（ctx 面不改，POOL-005①a 钉）
          signal: entryAc.signal,
          clock,
          log,
        };
        let outcome;
        try {
          outcome = await raceEntry(backend, ctx, {
            budgetMs: remaining, // 共享预算：race 只取本次尝试开始时剩余的时间（POOL-005①a 在途取消钉）
            externalSignal,
            state,
            onTimeout: () => {
              // FB-003：条目到期须取消当前请求。
              const reason = new Error(`条目预算 ${budgetMs}ms 到期`);
              reason.name = "TimeoutError";
              entryAc.abort(reason);
            },
            onExternalAbort: () => {
              // FB-003：宿主取消须取消在途操作。
              entryAc.abort(externalSignal.reason);
            },
          });
        } finally {
          handle.close(); // A6/CFG-004：每把 key 结束（成功/失败/超时/取消）后释放传输句柄
        }
        if (outcome.kind === "cancelled") return { kind: "cancelled" };
        if (outcome.kind === "timeout") {
          // 预算到期取消在途：已出站者计为已尝试（POOL-005①b tried 口径），ENTRY_TIMEOUT 归因。
          triedList.push({ index: cand.index, code: ENTRY_CODES.TIMEOUT });
          return { kind: "timeout", ...meta() };
        }
        if (outcome.kind === "success") {
          // 成功即止（含空结果：停止轮次、非池耗尽，POOL-004⑤）——usedIndex 供「已使用第 N/M 把 key」。
          return { kind: "success", value: outcome.value, switched: ci > 0, usedIndex: cand.index, fromPool, poolSize };
        }
        const code = isEntryPhaseCode(outcome.error?.code) ? outcome.error.code : null;
        if (code === null) {
          // A5/FB-005：程序违约（无条目可降级的码，含 TRANSPORT_RELEASED）原样暴露。
          return { kind: "error", error: outcome.error };
        }
        triedList.push({ index: cand.index, code });
        const nextCand = candidates[ci + 1];
        if (nextCand && POOL_ROTATION_CODES.has(code)) {
          rotateOrEnd(code, cand, nextCand);
          continue;
        }
        return { kind: "error", error: outcome.error, ...meta() };
      }
      return { kind: "cancelled" }; // 防御性：循环内所有路径均已收敛
    }

    /**
     * 适配器结果与「条目超时」「宿主取消」竞速（只走受控时钟，FB-003 验收）。
     * 适配器 promise 无论何时落定都有处理分支，不产生未处理拒绝；
     * 超时/取消已收敛后，迟到的 resolve/reject 一律忽略（FB-003 迟到结果）。
     */
    function raceEntry(backend, ctx, { budgetMs, externalSignal, state, onTimeout, onExternalAbort }) {
      return new Promise((resolve) => {
        let done = false;
        let timerId = null;
        let abortListener = null;
        const finish = (outcome) => {
          if (done) return;
          done = true;
          if (timerId !== null) clock.clearTimeout(timerId);
          if (abortListener && externalSignal) externalSignal.removeEventListener("abort", abortListener);
          resolve(outcome);
        };
        // A5：resolve { sources, content? }（空数组=明确无结果，FB-004）；
        // 失败 throw 携带 .code ∈ ENTRY_CODES；程序违约 throw 无 code 错误。
        backend.search(ctx).then(
          (value) => finish({ kind: "success", value }),
          (error) => finish({ kind: "error", error }),
        );
        timerId = clock.setTimeout(() => {
          if (state.cancelled) {
            finish({ kind: "cancelled" });
            return;
          }
          onTimeout();
          finish({ kind: "timeout" });
        }, budgetMs);
        if (externalSignal) {
          if (externalSignal.aborted || state.cancelled) {
            finish({ kind: "cancelled" });
            return;
          }
          abortListener = () => {
            onExternalAbort();
            finish({ kind: "cancelled" });
          };
          externalSignal.addEventListener("abort", abortListener, { once: true });
        }
      });
    }

    // 结算即摘除外部信号监听（成功、终态拒绝、取消均经此路径）。
    return run().finally(() => {
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    });
  }

  /**
   * #86 POOL-004/007：条目凭据候选计划（v0.2.0 单 key resolveKey 的池化替代）：
   *   - 池形态（credentialRefs 数组，1..8 个引用）= 唯一轮替候选集：选取期逐 ref resolve 各一次
   *     （absent 项跳过、零「空 key 提交」）；池内命中 → 下层（env/托管/YAML）零参与、零重读
   *     （POOL-007②：池耗尽不得引发凭据层重新读取）；
   *   - 池全 absent → 下层兜底恰好一个单 key（POOL-007①/②b），index 0、无池明细、非轮替候选；
   *   - legacy 形态（单 credentialRef）：v0.2.0 逐层解析链原样（条目引用 → env → 托管 → YAML，
   *     POOL-007④ 回归钉）；
   *   - 免 key 类型（bing，envName undefined）：零凭据读取（POOL-007③/CFG-002），key null。
   * R-1 镜像：宿主对超语法引用抛 TypeError 时按本层未命中处理；合法名的其他凭据服务故障
   * 保留 hard-failure（上抛 → 条目凭据失败降级，CFG-002）。
   * @returns {Promise<{candidates: Array<{ref: string|null, key: string|null, index: number}>, poolSize: number, fromPool: boolean}|null>}
   *   null = 各层均无 key（调用方按 v0.2.0 语义记 SKIPPED_NO_KEY 并继续）。
   */
  async function resolvePoolPlan(entry, envName) {
    if (!envName) return { candidates: [{ ref: null, key: null, index: 0 }], poolSize: 0, fromPool: false };
    const resolveRef = async (ref) => {
      let hit;
      try {
        hit = await credentials.resolve(ref);
      } catch (error) {
        // dsh-credentials 以 POSIX 标识符校验引用；R-1 约定语法错误只是本层未命中。
        // 对于合法名的其他凭据服务故障仍保留原有 hard-failure 行为。
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || !(error instanceof TypeError)) throw error;
        return null;
      }
      const value = typeof hit?.value === "string" ? hit.value.trim() : "";
      return value === "" ? null : value;
    };
    const refs = Array.isArray(entry.credentialRefs)
      ? entry.credentialRefs.filter((r) => typeof r === "string" && r.trim() !== "").map((r) => r.trim())
      : [];
    if (refs.length > 0) {
      // POOL-007：池 = 唯一候选集；选取期各 ref 读一次，失败/未命中不重读层。
      const candidates = [];
      for (let i = 0; i < refs.length; i++) {
        const key = await resolveRef(refs[i]);
        if (key !== null) candidates.push({ ref: refs[i], key, index: i + 1 });
      }
      if (candidates.length > 0) return { candidates, poolSize: refs.length, fromPool: true };
      const fallback = await lowerLayerKey(entry, envName);
      return fallback === null ? null : { candidates: [{ ref: null, key: fallback, index: 0 }], poolSize: 0, fromPool: false };
    }
    // legacy 单引用：v0.2.0 逐层链逐位不变（POOL-007④）。
    const ref = typeof entry.credentialRef === "string" ? entry.credentialRef.trim() : "";
    if (ref) {
      const value = await resolveRef(ref);
      if (value !== null) return { candidates: [{ ref, key: value, index: 1 }], poolSize: 0, fromPool: false };
    }
    const fallback = await lowerLayerKey(entry, envName);
    return fallback === null ? null : { candidates: [{ ref: null, key: fallback, index: 0 }], poolSize: 0, fromPool: false };
  }

  /** 下层兜底（进程环境变量 → DSH 托管记录 → 旧版 YAML 顶层）：只参与选取期降级，不进轮替候选集（POOL-007）。 */
  async function lowerLayerKey(entry, envName) {
    if (Object.hasOwn(env, envName)) {
      const value = typeof env[envName] === "string" ? env[envName].trim() : "";
      if (value !== "") return value;
    }
    const hosted = await credentials.resolve(envName);
    const hostedValue = typeof hosted?.value === "string" ? hosted.value.trim() : "";
    if (hostedValue !== "") return hostedValue;
    if (legacyYaml) {
      const supplier = supplierOfToolType(entry.type);
      if (LEGACY_YAML_SUPPLIERS.includes(supplier)) {
        const value = typeof legacyYaml[supplier] === "string" ? legacyYaml[supplier].trim() : "";
        if (value !== "") return value;
      }
    }
    return null;
  }
}

/** #86 POOL-005①b/POOL-006①：条目终态 pool 明细（仅池形态；单 key/legacy 不带，v0.2.0 形状零变化）。 */
function poolOf(outcome) {
  if (!outcome?.fromPool) return undefined;
  const triedList = Array.isArray(outcome.triedList) ? outcome.triedList : [];
  return {
    size: Number.isInteger(outcome.poolSize) ? outcome.poolSize : 0,
    tried: triedList.length,
    outcomes: triedList.map((t) => ({ index: t.index, code: t.code })),
  };
}

// ─── 纯函数工具 ───────────────────────────────────────────────────────────────

/** FB-002：有效来源必须是可解析的绝对 HTTP(S) URL。 */
function isAbsoluteHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const SOURCE_FIELDS = ["title", "snippet", "summary", "publishedAt"];

/**
 * FB-002 成功结果：按成功条目的供应商顺序保留有效来源；超过 maxResults 截断并置 truncated；
 * 此前有启用条目被跳过/失败时 content 首行标明实际使用的条目；纯来源适配器的供应商正文不透出。
 */
function buildSuccessResult(entry, value, { maxResults, issues }) {
  const rawSources = Array.isArray(value?.sources) ? value.sources : [];
  const sources = [];
  for (const s of rawSources) {
    if (!s || typeof s.url !== "string" || !isAbsoluteHttpUrl(s.url)) continue;
    const out = { url: s.url };
    for (const f of SOURCE_FIELDS) {
      if (typeof s[f] === "string") out[f] = s[f];
    }
    sources.push(out);
  }
  let outSources = sources;
  let truncated = false;
  if (maxResults !== null && outSources.length > maxResults) {
    outSources = outSources.slice(0, maxResults);
    truncated = true;
  }

  const isSourcesOnly = SOURCES_ONLY_TYPES.has(entry.type);
  const adapterContent =
    !isSourcesOnly && typeof value?.content === "string" && value.content !== "" ? value.content : undefined;
  let content;
  if (issues.length > 0) {
    const parts = issues.map((it) =>
      it.kind === "skip" ? `「${it.name}」缺少凭据（${it.envName}）` : `「${it.name}」${ISSUE_DESC[it.code]}`,
    );
    const marker = `已由「${entry.name}」返回结果（此前${parts.join("；")}）`;
    content = adapterContent ? `${marker}\n${adapterContent}` : marker;
  } else {
    content = adapterContent;
  }

  const result = { sources: outSources, truncated };
  if (content !== undefined) result.content = content;
  return result;
}

function attemptOf(entry, code, reason, pool) {
  const out = { entryId: entry.id, entryType: entry.type, entryName: entry.name, code, reason };
  // #86 POOL-005①b/POOL-006①：池条目终态附逐 key 脱敏明细（size/tried/outcomes）；
  // 单 key（含 legacy 单引用、下层兜底）不带该键——v0.2.0 attempts 形状逐位不变。
  if (pool && typeof pool === "object") out.pool = { size: pool.size, tried: pool.tried, outcomes: pool.outcomes.map((o) => ({ index: o.index, code: o.code })) };
  return out;
}

function isEntryPhaseCode(code) {
  return typeof code === "string" && ENTRY_PHASE_CODE_VALUES.has(code);
}

/** FB-003：总预算须为正整数毫秒，默认 25000（非法快照值防御性回退默认）。 */
function normalizeBudget(raw) {
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** 深拷贝配置快照（纯数据）：执行期与活配置对象隔离（CFG-004）。 */
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out;
  }
  return value;
}

function abortError(externalSignal) {
  const reason = externalSignal?.reason;
  const err = new Error(typeof reason === "string" ? reason : "搜索被宿主取消");
  err.name = "AbortError";
  err.reason = reason;
  return err;
}

function rejectAborted(externalSignal) {
  return Promise.reject(abortError(externalSignal));
}
