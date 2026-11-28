// 共享常量（与 test/helpers/contract.js 保持同值；见 PR 交付记录的「常量复制」说明）。
// 运行时代码不得 import test/ 下的任何文件，故在此复制一份。

export const BUNDLE_NAME = "dsh-fleetseek";
export const PROVIDER_ID = "search-chain";

/** dsh 宿主官方 DeepSeek Messages 搜索路由 id（inspect `web` 服务实证）。 */
export const OFFICIAL_ROUTE_ID = "deepseek-official";
/** 账号模式路由 id：DSH-005 要求走自定义链。 */
export const DEEPSEEK_ACCOUNT_ROUTE_ID = "deepseek-account";

/** CAT-001 八个类型 id（DeepSeek 两模式各占一个）。 */
export const TOOL_TYPES = Object.freeze([
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
]);

/** 类型 → 目录供应商（deepseek-* 归并到 deepseek）。 */
export function supplierOfToolType(type) {
  return type.startsWith("deepseek") ? "deepseek" : type;
}

/** CAT-001 凭据环境变量名 / 托管记录名。 */
export const KEY_ENV_BY_TYPE = Object.freeze({
  openai: "OPENAI_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  gemini: "GEMINI_API_KEY",
  "deepseek-search": "DEEPSEEK_API_KEY",
  "deepseek-agentic-search": "DEEPSEEK_API_KEY",
});

/** CFG-002：免 key 类型。 */
export const KEYLESS_TYPES = Object.freeze(["bing"]);

/** CFG-002：允许读取的进程环境变量白名单。 */
export const TRUSTED_ENV_KEYS = Object.freeze([...new Set(Object.values(KEY_ENV_BY_TYPE))]);

/** CFG-002：仅这三个供应商有旧版 YAML 顶层兼容。 */
export const LEGACY_YAML_SUPPLIERS = Object.freeze(["openai", "tavily", "deepseek"]);

/** FB-005 条目级失败分类。 */
export const ENTRY_CODES = Object.freeze({
  CREDENTIALS: "ENTRY_CREDENTIALS",
  QUOTA: "ENTRY_QUOTA",
  RATE_LIMITED: "ENTRY_RATE_LIMITED",
  PROXY: "ENTRY_PROXY",
  NETWORK: "ENTRY_NETWORK",
  CHANNEL_LIMIT: "ENTRY_CHANNEL_LIMIT",
  TIMEOUT: "ENTRY_TIMEOUT",
  BAD_RESPONSE: "ENTRY_BAD_RESPONSE",
  CONTENT_POLICY: "ENTRY_CONTENT_POLICY",
});

/** FB-001 跳过诊断标记（非失败分类）。 */
export const SKIPPED_NO_KEY = "SKIPPED_NO_KEY";

/** FB-004 链级终态码。 */
export const CHAIN_CODES = Object.freeze({
  NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED",
  ALL_KEYS_MISSING: "CHAIN_KEYS_MISSING",
  UPSTREAM_FAILURES: "CHAIN_UPSTREAM_FAILURES",
  BUDGET_EXHAUSTED: "CHAIN_BUDGET_EXHAUSTED",
  CONTENT_POLICY: "CHAIN_CONTENT_POLICY",
});

/** CFG 配置与 PAC 阶段码。 */
export const CONFIG_CODES = Object.freeze({
  INVALID: "CONFIG_INVALID",
  CREDENTIALS_UNREADABLE: "CONFIG_CREDENTIALS_UNREADABLE",
  SAVE_FAILED: "CONFIG_SAVE_FAILED",
  PAC_FETCH_FAILED: "PAC_FETCH_FAILED",
  PAC_EVAL_FAILED: "PAC_EVAL_FAILED",
  PAC_ROUTE_FAILED: "PAC_ROUTE_FAILED",
  // B1′：宿主配置端口不可用或本行不在活行中——显式失败，禁止回退装载快照（回退即恢复 B1）。
  ROW_UNAVAILABLE: "CONFIG_ROW_UNAVAILABLE",
});

/**
 * 响应体字节上限（PAC 下载与六家供应商正文的跨模块单源；BING-002 先例同值 2MiB）。
 * 超限即 reader.cancel 早停，不读满全量（见下方 readBoundedText）。修改须同步 test/body-size-cap.test.js 的 MAX_EXPECTED。
 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** FB-003 默认总预算（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 25000;

/** 传输层释放语义码（src/transport.js fetch() 的 closed 分支）。 */
export const TRANSPORT_CODES = Object.freeze({
  RELEASED: "TRANSPORT_RELEASED",
});

const PASSTHROUGH_CODE_VALUES = new Set([
  ...Object.values(ENTRY_CODES),
  ...Object.values(CONFIG_CODES),
  TRANSPORT_CODES.RELEASED,
]);

/**
 * P1-1 透传判定：err 已带 ENTRY_CODES / CONFIG_CODES / TRANSPORT_RELEASED 之一的 code 时，
 * 传输层与适配器 fetch-catch 必须原样上抛，不得压成 ENTRY_NETWORK（FB-005 代理/直连归因与程序违约暴露）。
 * 无码错误（含宿主取消的无码 AbortError）返回 false，仍按既有分类走。
 */
export function carriesPassthroughCode(err) {
  return typeof err?.code === "string" && PASSTHROUGH_CODE_VALUES.has(err.code);
}

// ─── 响应体有界读取（PAC 与六家正文共用；BING-002 先例）────────────────────────────────────
// 流式主路超限即 reader.cancel 早停（tooLarge），退化路只能读后判长。超限不是异常：调用方据 tooLarge 归类。
// 放在 constants.js 而非独立模块：staging 测试只复制 backends/<name>.js 与 constants.js（见 classifier-*.test.js）。

/**
 * @param {unknown} response 含 body 流或 text() 的响应对象
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ text: string, tooLarge: boolean, limit: number, observedBytes: number }>}
 *   tooLarge=false：text 为完整正文；tooLarge=true：text 为空串，observedBytes 为已观测字节数（流式为下界）。
 */
export async function readBoundedText(response, { maxBytes = MAX_RESPONSE_BYTES } = {}) {
  const stream = response?.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let out = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        total += bytes.byteLength;
        if (total > maxBytes) {
          await reader.cancel("body too large").catch(() => {});
          return { text: "", tooLarge: true, limit: maxBytes, observedBytes: total };
        }
        out += decoder.decode(bytes, { stream: true });
      }
      out += decoder.decode();
      return { text: out, tooLarge: false, limit: maxBytes, observedBytes: total };
    } catch (err) {
      // 读取异常：尽力终止底层流后原样上抛（cancel 失败不覆盖原因）。
      await reader.cancel(err).catch(() => {});
      throw err;
    }
  }

  const text = await response.text();
  // UTF-8 字节数 ≥ UTF-16 长度，故长度已超限即可直接判定，免去编码开销。
  if (text.length > maxBytes || utf8ByteLength(text) > maxBytes) {
    return { text: "", tooLarge: true, limit: maxBytes, observedBytes: utf8ByteLength(text) };
  }
  return { text, tooLarge: false, limit: maxBytes, observedBytes: utf8ByteLength(text) };
}

/** 超限诊断文本（不含正文内容，仅尺寸线索；CFG-003）。 */
export function bodyTooLargeMessage(limit) {
  return `响应体超出大小上限（${limit} 字节），已中止读取，按异常响应处理`;
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}
