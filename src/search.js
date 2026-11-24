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
//   - 程序违约（适配器 throw 无 ENTRY_CODES 码的错误）原样暴露，不包装、不再发起新请求（FB-005）；
//   - 输出脱敏：错误与日志只含链自产的条目级文本，不带上游原始报文（CFG-003）。
//
// 运行时代码不 import test/；常量来自 ./constants.js（本地再导出，WP6 合并时统一）。

import {
  ENTRY_CODES,
  SKIPPED_NO_KEY,
  CHAIN_CODES,
  KEY_ENV_BY_TYPE,
  LEGACY_YAML_SUPPLIERS,
  DEFAULT_TIMEOUT_MS,
  supplierOfToolType,
} from "./constants.js";

const ENTRY_CODE_VALUES = new Set(Object.values(ENTRY_CODES));

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

        const outcome = await runEntry(entry, { query, maxResults, key, budgetMs, externalSignal, state });

        if (outcome.kind === "cancelled") {
          // FB-003：宿主取消须终止整链（拒绝），不得再请求。
          throw abortError(externalSignal);
        }
        if (outcome.kind === "timeout") {
          recordFailure(entry, ENTRY_CODES.TIMEOUT, FAILURE_REASON[ENTRY_CODES.TIMEOUT](entry, budgetMs));
          continue; // FB-003：剩余总预算允许时继续下一条
        }
        if (outcome.kind === "error") {
          const code = isEntryCode(outcome.error?.code) ? outcome.error.code : null;
          if (code === null) {
            // A5/FB-005：程序违约（无 ENTRY_CODES 码）原样暴露，不包装、不再发起新上游请求。
            throw outcome.error;
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

    function recordFailure(entry, code, reason) {
      attempts.push(attemptOf(entry, code, reason));
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
     * @returns {Promise<{kind:"success", value:object}|{kind:"error", error:object}|{kind:"timeout"}|{kind:"cancelled"}>}
     */
    async function runEntry(entry, { query, maxResults, key, budgetMs, externalSignal, state }) {
      const backend = backends.get?.(entry.type);
      if (!backend || typeof backend.search !== "function") {
        // 目录与后端不一致属内部程序违约：无 code，原样暴露（FB-005）。
        throw new TypeError(`[search-chain] 条目 ${entry.id}（${entry.type}）没有可用的后端适配器（程序违约）`);
      }
      const entryAc = new AbortController();
      const handle = transport.open(entry);
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

  /** CFG-002 优先级：条目引用 → 进程环境变量 → DSH 托管记录 → 旧版 YAML 顶层（最后兼容）。纯空白等同未提供。 */
  async function resolveKey(entry, envName) {
    const ref = typeof entry.credentialRef === "string" ? entry.credentialRef.trim() : "";
    if (ref) {
      const hit = await credentials.resolve(ref);
      const value = hit?.value;
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    if (Object.hasOwn(env, envName)) {
      const value = env[envName];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    const hosted = await credentials.resolve(envName);
    const hostedValue = hosted?.value;
    if (typeof hostedValue === "string" && hostedValue.trim() !== "") return hostedValue;
    if (legacyYaml) {
      const supplier = supplierOfToolType(entry.type);
      if (LEGACY_YAML_SUPPLIERS.includes(supplier)) {
        const value = legacyYaml[supplier];
        if (typeof value === "string" && value.trim() !== "") return value;
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

function attemptOf(entry, code, reason) {
  return { entryId: entry.id, entryType: entry.type, entryName: entry.name, code, reason };
}

function isEntryCode(code) {
  return typeof code === "string" && ENTRY_CODE_VALUES.has(code);
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
