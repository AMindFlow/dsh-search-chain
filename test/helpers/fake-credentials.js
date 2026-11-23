// 宿主凭据服务（ctx.credentials，dsh inspect 实证：ref 与 record 两个 key 空间）的内存替身。
// CFG-002 两层：①条目凭据引用（resolve(ref)）③该名称的 DSH 托管记录（readRecord(name)）。
// 记录全部读取，供「停用条目不得导致读 key」（CFG-002 验收）与「只为实际尝试的条目解析 key」一类断言。
// 注意：替身 readRecord 返回 { name, value } | undefined；实现侧到宿主真实记录形状的映射归
// src/config.js（WP1），由 resolveEntryApiKey seam 隔离。

/**
 * @param {{ refs?: Record<string,string>, records?: Record<string,string>, failRefReads?: string[] }} [seed]
 *   refs: CredentialRef → key 值；records: 托管记录名（如 OPENAI_API_KEY）→ key 值；
 *   failRefReads: 读取这些 ref 时抛错（模拟凭据服务不可用，CFG-002 需报配置错误）。
 */
export function createFakeCredentials(seed = {}) {
  const refs = { ...(seed.refs ?? {}) };
  const records = { ...(seed.records ?? {}) };
  const failRefReads = new Set(seed.failRefReads ?? []);
  const resolveCalls = [];
  const recordCalls = [];

  async function resolve(ref) {
    resolveCalls.push(ref);
    if (failRefReads.has(ref)) throw new Error(`[fake-credentials] 合成凭据服务故障: ${ref}`);
    return Object.hasOwn(refs, ref) ? refs[ref] : undefined;
  }

  return {
    // —— 引用空间（条目凭据）——
    resolve,
    async describe(ref) {
      return { ref, present: Object.hasOwn(refs, ref) };
    },
    async set(ref, value) {
      refs[ref] = value;
    },
    async unset(ref) {
      delete refs[ref];
    },

    // —— 记录空间（按名称的托管凭据）——
    async readRecord(name) {
      recordCalls.push(name);
      return Object.hasOwn(records, name) ? { name, value: records[name] } : undefined;
    },
    async describeRecord(name) {
      return { name, present: Object.hasOwn(records, name) };
    },
    async listRecords() {
      return Object.keys(records).map((name) => ({ name }));
    },
    async modifyRecord(name, mutate) {
      const current = Object.hasOwn(records, name) ? { name, value: records[name] } : undefined;
      const next = await mutate(current);
      if (next === undefined) delete records[name];
      else records[name] = next.value;
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
