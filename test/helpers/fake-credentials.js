// 宿主凭据服务（ctx.get("credentials")，dsh-credentials @0.2.2-rc.5）的内存替身。
// CFG-002 两层（WP7 凭据轮裁决）：①条目凭据引用 resolve(ref)；③同名 DSH 托管 ref resolve(envName)——
// README「a reference doubles as the environment name it resolves through」；真宿主记录 key 语法 <owner>/<id>
// 无法承载裸 env 名，readRecord 已移出解析链，但记录面作为宿主能力保留（SET-002 等非解析面仍用，读取全部留痕，
// 供「解析不得经记录空间」「停用条目不得导致读 key」一类断言）。
//
// 真宿主形状（dsh-credentials README/types.ts @0.2.2-rc.5，WP7 实机发现）——服务边界处的返回值必须与之逐字段一致：
//   resolve(ref) → { value, source } | undefined（不是裸字符串；空 stored 值 = absent，resolve 跳过）。
//   set(ref, 空串) 被拒（「An empty value cannot be stored」）；unset(ref) 缺失时 no-op。
//   readRecord(name) → CredentialRecord | undefined：
//     api-key 记录 = { kind: "api-key", key?, env? }（值在记录顶层 key，README「既无 key 也无环境值」）；
//     grant 记录 = { kind: "grant", payload }（payload 为属主自定义 JSON，seam 原样存取）。
//   记录侧无空值规则——存在即事实（README），空值 = absent 只约束引用侧。
//   modifyRecord 是唯一记录写路径：mutate 返回 undefined 保持原状（README）；删除走 deleteRecord。
// 实现侧到宿主形状的映射归 src/config.js resolveEntryApiKey seam（WP1 / WP7 修正轮）。
// 测试侧 seed 面仍为 name→value 字符串便捷糖；真宿主形状转换只发生在服务边界（本文件内完成），
// 也可直接 seed 真形对象（resolve 的 {value, source}、records 的 CredentialRecord）以核对透传。

/** 引用侧默认来源层（本地 provider 实际层名：env / file / project-env / user-env）。 */
const DEFAULT_SOURCE = "user-env";

/**
 * 凭据引用名语法（R-1）：POSIX 标识符，与 dsh-credentials src/index.ts L19 REF_PATTERN 逐字一致。
 * 冒号、连字符、点号等一律不合法；record key 的 `<scope>/<id>` 空间与之互斥。
 */
export const CREDENTIAL_REF_GRAMMAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {{ refs?: Record<string, string | {value: string, source: string}>,
 *           records?: Record<string, string | {kind: "api-key", key?: string, env?: object} | {kind: "grant", payload: unknown}>,
 *           failRefReads?: string[] }} [seed]
 *   refs: CredentialRef → key 值（字符串糖，resolve 时套上 source 成真形 hit）或 {value, source} 直供；
 *   records: 托管记录名（如 OPENAI_API_KEY）→ key 值糖或 CredentialRecord 真形；
 *   failRefReads: 读取这些 ref 时抛错（模拟凭据服务不可用，CFG-002 需报配置错误）。
 */
export function createFakeCredentials(seed = {}) {
  const refs = { ...(seed.refs ?? {}) };
  const records = { ...(seed.records ?? {}) };
  const failRefReads = new Set(seed.failRefReads ?? []);
  // R-1（opt-in，默认关闭以保留既有 "ref:x" 类合成引用）：开启后引用侧与真宿主 credentialRef() 同形——
  // 不合 POSIX grammar 的引用名抛 TypeError（dsh-credentials src/index.ts L29-34，@0.2.2-rc.5）。
  const strictRefGrammar = seed.strictRefGrammar === true;
  const assertRefGrammar = (ref) => {
    if (strictRefGrammar && !CREDENTIAL_REF_GRAMMAR.test(String(ref))) {
      throw new TypeError(`[fake-credentials] 引用名不合语法（真宿主 credentialRef 规则）`);
    }
  };
  const resolveCalls = [];
  const recordCalls = [];

  /** 字符串糖 → 真宿主 ResolvedCredential；真形对象原样透传。 */
  const toRefHit = (v) => (typeof v === "string" ? { value: v, source: DEFAULT_SOURCE } : v);
  /** 字符串糖 → 真宿主 ApiKeyRecord；CredentialRecord 真形原样透传。 */
  const toRecord = (v) => (typeof v === "string" ? { kind: "api-key", key: v } : v);

  async function resolve(ref) {
    resolveCalls.push(ref);
    assertRefGrammar(ref);
    if (failRefReads.has(ref)) throw new Error(`[fake-credentials] 合成凭据服务故障: ${ref}`);
    if (!Object.hasOwn(refs, ref)) return undefined;
    const hit = toRefHit(refs[ref]);
    // 真宿主规则（README）：空的 stored 值等于不存在——resolve 跳过它，绝不返回 {value:""}。
    if (hit.value === "") return undefined;
    return hit;
  }

  return {
    // —— 引用空间（条目凭据）——
    resolve,
    async describe(ref) {
      assertRefGrammar(ref);
      const configured = Object.hasOwn(refs, ref) && toRefHit(refs[ref]).value !== "";
      return {
        configured,
        ...(configured ? { source: toRefHit(refs[ref]).source } : {}),
        writable: true,
      };
    },
    async set(ref, value) {
      assertRefGrammar(ref);
      // 真宿主规则（README）：空串不可存——移除密钥走 unset。
      if (typeof value !== "string" || value === "") {
        throw new Error("[fake-credentials] 空串不可存储（真宿主规则：移除走 unset）");
      }
      refs[ref] = value;
    },
    async unset(ref) {
      delete refs[ref];
    },

    // —— 记录空间（按名称的托管凭据）——
    async readRecord(name) {
      recordCalls.push(name);
      return Object.hasOwn(records, name) ? toRecord(records[name]) : undefined;
    },
    async describeRecord(name) {
      const rec = Object.hasOwn(records, name) ? toRecord(records[name]) : undefined;
      return {
        configured: rec !== undefined,
        ...(rec !== undefined ? { kind: rec.kind } : {}),
        writable: true,
      };
    },
    async listRecords() {
      return Object.keys(records).map((name) => ({ key: name, kind: toRecord(records[name]).kind }));
    },
    async modifyRecord(name, mutate) {
      const current = Object.hasOwn(records, name) ? toRecord(records[name]) : undefined;
      const next = await mutate(current);
      // 真宿主规则（README）：mutate 返回 undefined 保持原状——删除走 deleteRecord，不经此路。
      if (next === undefined) return current;
      records[name] = next;
      return next;
    },
    async deleteRecord(name) {
      delete records[name];
    },

    // —— 测试操纵与观测 ——
    /** 撤掉某层来源（CFG-002 验收：逐层撤掉核对真正收到的 key）。 */
    removeRef(ref) {
      delete refs[ref];
    },
    removeRecord(name) {
      delete records[name];
    },
    setRef(ref, value) {
      refs[ref] = value;
    },
    setRecord(name, value) {
      records[name] = value;
    },
    resolveCalls,
    recordCalls,
    totalReads() {
      return resolveCalls.length + recordCalls.length;
    },
  };
}
