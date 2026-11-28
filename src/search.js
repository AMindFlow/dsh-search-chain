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
  PROXY_PINS,
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

/** #88 第五批⑤（Refs #88）：全局引用 resolve 与预算截止竞速的耗尽哨兵（模块级——工厂体在 return 后全用提升函数声明，局部 const 不可达）。 */
const RESOLVE_EXPIRED = Symbol("global-proxy-resolve-expired");

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
    const escalationEnabled = rawConfig.proxyEscalation === true;
    const globalProxyRef = typeof rawConfig.globalProxy === "string" ? rawConfig.globalProxy.trim() : "";
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
    let escalationFailed = false; // #88 第三批①：是否有全局代理升级实际出站且失败（终态 WebError 带「升级失败」要素；OFF 态不可达，逐字 legacy）

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
        const envName = KEY_ENV_BY_TYPE[entry.type];
        let key = null;
        let credentialReadError = null;
        if (envName) {
          try {
            key = await resolveKey(entry, envName);
          } catch (err) {
            credentialReadError = err;
          }
        }
        // FB-003 取消闸：await resolveKey 期间宿主可能已取消；此处复查，已取消则零出站、不进入 transport.open。
        if (externalSignal?.aborted || state.cancelled) throw abortError(externalSignal);
        if (credentialReadError) {
          // CFG-002「需要读取但无法访问或解析的凭据文件须报告配置错误」：
          // 链级映射为该条目凭据失败（可降级），原文不入错误/日志（CFG-003）。
          const reason = "凭据引用读取失败（凭据服务不可用或引用损坏，内容已脱敏）";
          recordFailure(entry, ENTRY_CODES.CREDENTIALS, reason);
          continue;
        }
        if (envName && key === null) {
          const reason = `缺少凭据：${envName} 未配置（条目引用、环境变量与 DSH 托管记录均未提供）`;
          attempts.push(attemptOf(entry, SKIPPED_NO_KEY, reason));
          issues.push({ kind: "skip", name: entry.name, envName });
          continue;
        }

        const entryStartAt = clock.now();
        const hasOwnProxy =
          typeof entry.proxy === "string"
            ? entry.proxy.trim() !== ""
            : Boolean(entry.proxy && typeof entry.proxy === "object");
        const pin =
          !hasOwnProxy && (entry.proxyPin === PROXY_PINS.DIRECT_ONLY || entry.proxyPin === PROXY_PINS.PROXY_ONLY)
            ? entry.proxyPin
            : PROXY_PINS.INHERIT;

        // PX-006（正交于全局升级开关）：未配置自有代理且钉死 proxyOnly 时，仅经 globalProxy 解析出的代理出站，绝不直连。
        if (pin === PROXY_PINS.PROXY_ONLY) {
          // PX #88 第五批⑤：钉死路径同受条目/总剩余预算与宿主取消约束（悬挂 resolve 不得越预算）。
          const gp = await resolveGlobalProxy(
            globalProxyRef,
            Math.min(budgetMs - (clock.now() - entryStartAt), totalBudget - (clock.now() - startAt)),
            externalSignal,
          );
          if (externalSignal?.aborted || state.cancelled) throw abortError(externalSignal);
          if (!gp.ok) {
            recordFailure(
              entry,
              ENTRY_CODES.NETWORK,
              "条目钉死仅代理：全局代理不可用（未配置、不可读或地址无效），未直连出站",
            );
            continue;
          }
          const pinBudget = Math.min(budgetMs - (clock.now() - entryStartAt), totalBudget - (clock.now() - startAt));
          if (pinBudget <= 0) {
            recordFailure(entry, ENTRY_CODES.NETWORK, "条目钉死仅代理：剩余预算不足，未执行全局代理出站");
            continue;
          }
          const outcome = await runEntry(entry, {
            query,
            maxResults,
            key,
            budgetMs: pinBudget,
            externalSignal,
            state,
            routeOpts: { kind: gp.kind, proxyUrl: gp.url, viaGlobal: true },
          });
          if (outcome.kind === "cancelled") throw abortError(externalSignal);
          if (outcome.kind === "timeout") {
            recordFailure(entry, ENTRY_CODES.TIMEOUT, `条目钉死仅代理：全局代理失败（${gp.target}，在途超时已取消）`);
            continue;
          }
          if (outcome.kind === "error") {
            const rawCode = isEntryPhaseCode(outcome.error?.code) ? outcome.error.code : null;
            if (rawCode === null) throw outcome.error;
            const code = rawCode === ENTRY_CODES.PROXY ? ENTRY_CODES.NETWORK : rawCode;
            // #88 第三批③：非 NETWORK 相位失败同样保留原码，并带钉死要素（强制代理事实+脱敏目标+安全原因）。
            const reason =
              code === ENTRY_CODES.NETWORK
                ? `条目钉死仅代理：全局代理失败（${gp.target}，失败阶段：${rawCode}）`
                : `条目钉死仅代理：全局代理失败（${gp.target}，${FAILURE_REASON[code](entry)}）`;
            recordFailure(entry, code, reason);
            if (code === ENTRY_CODES.CONTENT_POLICY) break;
            continue;
          }
          const built = buildSuccessResult(entry, outcome.value, { maxResults, issues });
          if (built.sources.length > 0) {
            log?.("debug", "search-chain 条目命中", { entryId: entry.id, type: entry.type });
            return built;
          }
          anyExplicitEmpty = true;
          continue;
        }

        const outcome = await runEntry(entry, { query, maxResults, key, budgetMs, externalSignal, state });

        if (outcome.kind === "cancelled") {
          // FB-003：宿主取消须终止整链（拒绝），不得再请求。
          throw abortError(externalSignal);
        }
        if (outcome.kind === "timeout") {
          // PX-005（Refs #88，lead 裁决①）：直连失败恰在条目预算耗尽同 tick 落定时（race 胜负无关），
          // 剩余 ≤0 不得发出升级请求：以预算要素文案落定（零升级出站）；升级条件不满足时 v0.2.0 纯 TIMEOUT 呈现原样。
          const remAtTimeout = Math.min(
            budgetMs - (clock.now() - entryStartAt),
            totalBudget - (clock.now() - startAt),
          );
          if (!hasOwnProxy && pin === PROXY_PINS.INHERIT && escalationEnabled && globalProxyRef && remAtTimeout <= 0) {
            recordFailure(entry, ENTRY_CODES.NETWORK, "直连失败；剩余预算不足，未执行全局代理升级");
            continue;
          }
          recordFailure(entry, ENTRY_CODES.TIMEOUT, FAILURE_REASON[ENTRY_CODES.TIMEOUT](entry, budgetMs));
          continue; // FB-003：剩余总预算允许时继续下一条
        }
        if (outcome.kind === "error") {
          const code = isEntryPhaseCode(outcome.error?.code) ? outcome.error.code : null;
          if (code === null) {
            // A5/FB-005：程序违约（无条目可降级的码，含 TRANSPORT_RELEASED）原样暴露，不包装、不再发起新上游请求。
            throw outcome.error;
          }
          // PX-002..PX-008：仅当开关开 + 无自有代理 + 继承态 + 直连 ENTRY_NETWORK 时，尝试至多一次全局代理升级。
          if (!hasOwnProxy && pin === PROXY_PINS.INHERIT && escalationEnabled && code === ENTRY_CODES.NETWORK) {
            const remBeforeResolve = Math.min(
              budgetMs - (clock.now() - entryStartAt),
              totalBudget - (clock.now() - startAt),
            );
            if (remBeforeResolve <= 0) {
              recordFailure(entry, ENTRY_CODES.NETWORK, "直连失败；剩余预算不足，未执行全局代理升级");
              continue;
            }
            // #88 第五批⑤：升级 resolve 与 remBeforeResolve 截止竞速；耗尽按不可读面收敛（零出站）。
            const gp = await resolveGlobalProxy(globalProxyRef, remBeforeResolve, externalSignal);
            if (externalSignal?.aborted || state.cancelled) throw abortError(externalSignal);
            if (!gp.ok) {
              const reason =
                gp.kind === "expired"
                  ? "直连失败；剩余预算不足，未执行全局代理升级"
                  : gp.kind === "unreadable"
                    ? "直连失败；全局升级已开启，全局代理凭据不可读，未执行升级（请在设置中重新保存全局代理地址）"
                    : "直连失败；全局升级已开启，全局代理未配置或不可读，未执行升级（请在设置中重新保存全局代理地址）";
              recordFailure(entry, ENTRY_CODES.NETWORK, reason);
              continue;
            }
            const remAfterResolve = Math.min(
              budgetMs - (clock.now() - entryStartAt),
              totalBudget - (clock.now() - startAt),
            );
            if (remAfterResolve <= 0) {
              recordFailure(entry, ENTRY_CODES.NETWORK, "直连失败；剩余预算不足，未执行全局代理升级");
              continue;
            }
            log?.("debug", "search-chain 全局代理升级", { entryId: entry.id, type: entry.type, target: gp.target });
            const escOutcome = await runEntry(entry, {
              query,
              maxResults,
              key,
              budgetMs: remAfterResolve,
              externalSignal,
              state,
              routeOpts: { kind: gp.kind, proxyUrl: gp.url, viaGlobal: true },
            });
            if (escOutcome.kind === "cancelled") throw abortError(externalSignal);
            if (escOutcome.kind === "timeout") {
              escalationFailed = true;
              recordFailure(
                entry,
                ENTRY_CODES.TIMEOUT,
                `直连失败；经全局代理升级（${gp.target}）在途时条目预算到期（已取消）`,
                "升级失败",
              );
              continue;
            }
            if (escOutcome.kind === "error") {
              const escRawCode = isEntryPhaseCode(escOutcome.error?.code) ? escOutcome.error.code : null;
              if (escRawCode === null) throw escOutcome.error;
              const reportedPhase = escRawCode === ENTRY_CODES.PROXY ? ENTRY_CODES.NETWORK : escRawCode;
              escalationFailed = true;
              recordFailure(
                entry,
                ENTRY_CODES.NETWORK,
                `直连失败；经全局代理升级仍失败（${gp.target}，失败阶段：${reportedPhase}）`,
                "升级失败",
              );
              if (escRawCode === ENTRY_CODES.CONTENT_POLICY) break;
              continue;
            }
            const escBuilt = buildSuccessResult(entry, escOutcome.value, {
              maxResults,
              issues,
              escalationTarget: gp.target,
            });
            if (escBuilt.sources.length > 0) {
              log?.("debug", "search-chain 条目命中（全局代理升级）", {
                entryId: entry.id,
                type: entry.type,
                target: gp.target,
              });
              return escBuilt;
            }
            // #88（lead 升裁·空结果可见性）：升级路径已实际出网但返回空——改道事实必须可查（attempts 呈现面）；
            // 空成功终态对象形状由 FB-004 deepEqual 锁死，不得加键，故事实只入 attempts（失败终态经 WebError details 可见）。
            attempts.push(
              attemptOf(entry, "ESCALATED_EMPTY", `直连失败；经全局代理升级（${gp.target}）已出站但未返回结果`),
            );
            anyExplicitEmpty = true;
            continue;
          }
          recordFailure(entry, code, FAILURE_REASON[code](entry));
          if (code === ENTRY_CODES.CONTENT_POLICY) break; // FB-001/FB-005：终止类，不降级
          continue;
        }
        // 成功结果（A5 resolve）：非空有效来源 → 首个返回有效来源的条目结束搜索（FB-001）；
        // 空数组 = 明确无结果 → 总预算内继续下一条（FB-001/FB-004）。
        const built = buildSuccessResult(entry, outcome.value, { maxResults, issues });
        if (built.sources.length > 0) {
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

    function recordFailure(entry, code, reason, issueSummary) {
      attempts.push(attemptOf(entry, code, reason));
      issues.push(issueSummary ? { kind: "fail", name: entry.name, code, issueSummary } : { kind: "fail", name: entry.name, code });
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
      // #88 第三批①：升级实际出站且失败终态带「升级失败」要素（仅呈现面）；OFF 态 escalationFailed 恒 false，逐字 legacy。
      const escNote = escalationFailed ? "，含经全局代理升级仍失败条目" : "";
      if (stoppedByBudget) {
        return Promise.reject(
          new WebError(
            CHAIN_CODES.BUDGET_EXHAUSTED,
            `总预算 ${totalBudget}ms 已耗尽且未获得有效来源${escNote}（见 details.attempts 的逐条原因）`,
            attempts,
          ),
        );
      }
      return Promise.reject(
        new WebError(
          CHAIN_CODES.UPSTREAM_FAILURES,
          `全链未获得有效来源：尝试过的条目均失败或被跳过${escNote}（见 details.attempts 的逐条原因）`,
          attempts,
        ),
      );
    }

    /**
     * 实际尝试一个条目（A6：transport.open → 适配器 ctx.fetch → close）。
     * @returns {Promise<{kind:"success", value:object}|{kind:"error", error:object}|{kind:"timeout"}|{kind:"cancelled"}>}
     */
    async function runEntry(entry, { query, maxResults, key, budgetMs, externalSignal, state, routeOpts }) {
      const backend = backends.get?.(entry.type);
      if (!backend || typeof backend.search !== "function") {
        // 目录与后端不一致属内部程序违约：无 code，原样暴露（FB-005）。
        throw new TypeError(`[search-chain] 条目 ${entry.id}（${entry.type}）没有可用的后端适配器（程序违约）`);
      }
      const entryAc = new AbortController();
      // A6 seam 前：open 失败时尚无句柄、适配器未触及；带码错误交由下游 outcome.error 分支按条目降级，
      // 无码/TRANSPORT_RELEASED 仍经同一分支裸上抛（不改全局位）。
      let handle;
      try {
        handle = routeOpts !== undefined ? transport.open(entry, routeOpts) : transport.open(entry);
      } catch (error) {
        return { kind: "error", error };
      }
      const ctx = {
        entry,
        query,
        maxResults,
        key,
        fetch: handle.fetch,
        budgetMs,
        signal: entryAc.signal,
        clock,
        log,
      };
      try {
        return await raceEntry(backend, ctx, {
          budgetMs,
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
        handle.close(); // A6/CFG-004：条目结束（成功/失败/超时/取消）后释放传输句柄
      }
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

  /** #88 第五批⑤（Refs #88）：全局引用 resolve 不得越过条目/总剩余预算，也不得逃脱宿主取消——
   * 与预算截止（受控时钟定时器）及宿主 abort 信号竞速；耗尽即按不可读收敛（零出站）。 */
  async function raceWithinBudget(promise, budgetLeftMs, signal) {
    if (!promise || typeof promise.then !== "function") return promise;
    let timerId;
    const deadline = new Promise((resolve) => {
      if (typeof budgetLeftMs === "number" && budgetLeftMs > 0) {
        timerId = clock.setTimeout(() => resolve(RESOLVE_EXPIRED), budgetLeftMs);
      } else {
        resolve(RESOLVE_EXPIRED); // 剩余 ≤ 0：不等待任何 resolve
      }
    });
    let abortListener;
    const abortP = signal
      ? new Promise((resolve) => {
          if (signal.aborted) return resolve(RESOLVE_EXPIRED);
          abortListener = () => resolve(RESOLVE_EXPIRED);
          signal.addEventListener("abort", abortListener, { once: true });
        })
      : null;
    let winner;
    try {
      winner = await Promise.race([promise, deadline, ...(abortP ? [abortP] : [])]);
    } finally {
      if (timerId !== undefined) clock.clearTimeout(timerId);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    return winner;
  }

  async function resolveGlobalProxy(ref, budgetLeftMs, signal) {
    if (!ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return { ok: false, kind: "missing" };
    let hit;
    try {
      hit = await raceWithinBudget(credentials?.resolve?.(ref), budgetLeftMs, signal);
    } catch {
      return { ok: false, kind: "unreadable" };
    }
    if (hit === RESOLVE_EXPIRED) return { ok: false, kind: "expired" };
    const raw = typeof hit?.value === "string" ? hit.value.trim() : "";
    if (!raw) return { ok: false, kind: "missing" };
    let u;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, kind: "invalid" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, kind: "invalid" };
    return {
      ok: true,
      url: raw,
      kind: u.protocol === "https:" ? "https-proxy" : "proxy",
      target: `${u.protocol}//${u.host}`,
    };
  }

  /** CFG-002 优先级：条目引用 → 进程环境变量 → DSH 托管记录 → 旧版 YAML 顶层。宿主对超语法引用抛 TypeError 时按未设置处理（R-1）。 */
  async function resolveKey(entry, envName) {
    const ref = typeof entry.credentialRef === "string" ? entry.credentialRef.trim() : "";
    if (ref) {
      let hit;
      try {
        hit = await credentials.resolve(ref);
      } catch (error) {
        // dsh-credentials 以 POSIX 标识符校验引用；R-1 约定语法错误只是本层未命中。
        // 对于合法名的其他凭据服务故障仍保留原有 hard-failure 行为。
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || !(error instanceof TypeError)) throw error;
      }
      const value = typeof hit?.value === "string" ? hit.value.trim() : "";
      if (value !== "") return value;
    }
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
function buildSuccessResult(entry, value, { maxResults, issues, escalationTarget }) {
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
  if (escalationTarget || issues.length > 0) {
    const parts = issues.map((it) =>
      it.kind === "skip"
        ? `「${it.name}」缺少凭据（${it.envName}）`
        : `「${it.name}」${it.issueSummary ?? ISSUE_DESC[it.code]}`,
    );
    const viaClause = escalationTarget ? `经全局代理升级出站（${escalationTarget}）` : "";
    const issueClause = parts.length > 0 ? `（此前${parts.join("；")}）` : "";
    const marker = `已由「${entry.name}」${viaClause}返回结果${issueClause}`;
    content = adapterContent ? `${marker}\n${adapterContent}` : marker;
  } else {
    content = adapterContent;
  }

  const result = { sources: outSources, truncated };
  if (content !== undefined) result.content = content;
  return result;
}

function attemptOf(entry, code, reason) {
  return { entryId: entry.id, entryType: entry.type, entryName: entry.name, code, reason };
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
