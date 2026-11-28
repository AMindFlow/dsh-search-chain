// 工作包 #86 · sol 明裁修复回归（自测，test(keypool): 前缀；非 oracle 骨架，骨架面零改动）。
// 覆盖 sol 三批并单：
//   P0  槽位稳定身份：删头/中/尾 × 保存 → credentialRefs 精确断言；删后原位补新 key（新 ref 落位、
//       存量身份不误删）；
//   P1  已分类 TIMEOUT 永不池措辞（error 分支：2 元池 401→TIMEOUT 终态无「全部 N 把 key 失败」）；
//   P1  SET-008 显式触碰：删槽后重挂复原（draftCacheApply 纯函数面）→ credFormOf 提交映射
//       = 剩余身份（组件内「卸载→重挂」不可达，按 v02 L1281 先例走纯函数面）；
//   P2  逐槽状态：已存槽「已保存（只写）」状态标 + placeholder 区分已有槽/新槽；
//   P1  schemastery ENTRY credentialRefs 数组节点序列化存在性钉（上限 8、元素 string、
//       旧 credentialRef role 节点零改动）。
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchChain } from "../src/search.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import {
  REF_GRAMMAR,
  ROLE,
  act,
  byRole,
  fire,
  leaksIn,
  loadSection,
  makeSettingsState,
  one,
  settle,
  withEnv,
} from "./helpers/settings-panel-v02.js";
import { credentialSeedFor, refName, refPoolOf } from "./helpers/pool-oracle-kit.js";
import { Config } from "../src/index.js";

const POOL_ROLE = Object.freeze({ add: "key-add", remove: "key-remove", status: "key-slot-status" });
const KEY1 = "sk-TEST-1111aaaa2222bbbb3333cccc4444dddd";
const REF_A = refName("A");
const REF_B = refName("B");
const REF_C = refName("C");

const keyFields = (tree) => byRole(tree, ROLE.field).filter((f) => f.props["data-field"] === "key");
const click = (view, tree, role, filter) => act(view, () => fire(one(tree, role, filter), "onClick"));

/** 三引用池条目（覆盖 fixture 首条）。 */
function seedPoolEntry(state) {
  state.user.entries[0] = {
    id: "tavily-a",
    type: "tavily",
    name: "Tavily 主",
    enabled: true,
    credentialRefs: [REF_A, REF_B, REF_C],
  };
}

/** 打开池条目编辑器 → 断言 3 槽 → 移除第 idx 槽 → 保存，返回保存后的 credentialRefs。 */
async function deleteSlotAndSave(view, tree, idx, { fetchStub }) {
  tree = await click(view, tree, ROLE.edit, { entryId: "tavily-a" });
  assert.equal(keyFields(tree).length, 3, "三引用池：每引用一槽");
  tree = await act(view, () => fire(byRole(tree, POOL_ROLE.remove)[idx], "onClick"));
  assert.equal(keyFields(tree).length, 2, "删槽后恰少一槽");
  tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
  const unsets = fetchStub.credentialCalls().filter((c) => c.kind === "credentials/unset");
  assert.equal(unsets.length, 0, "删槽不得删凭据（孤儿引用不回收）");
}

test("test(keypool): sol P0 删头槽保存——掉的是头引用，末位引用保留（旧 bug 掉末位）", async () => {
  const state = makeSettingsState();
  seedPoolEntry(state);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("sol-p0-del-head");
    let tree = await settle(view);
    await deleteSlotAndSave(view, tree, 0, { fetchStub });
    assert.deepEqual(state.user.entries[0].credentialRefs, [REF_B, REF_C], "删头：credentialRefs = [B, C]");
    assert.equal(fetchStub.credentialSets().length, 0, "纯删槽零新凭据写入");
    assert.equal(fetchStub.mutates().length, 1, "恰好一次 settings/mutate");
  });
});

test("test(keypool): sol P0 删中槽保存——头尾引用均保留", async () => {
  const state = makeSettingsState();
  seedPoolEntry(state);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("sol-p0-del-mid");
    let tree = await settle(view);
    await deleteSlotAndSave(view, tree, 1, { fetchStub });
    assert.deepEqual(state.user.entries[0].credentialRefs, [REF_A, REF_C], "删中：credentialRefs = [A, C]");
    assert.equal(fetchStub.mutates().length, 1);
  });
});

test("test(keypool): sol P0 删尾槽保存——头部引用保序保留", async () => {
  const state = makeSettingsState();
  seedPoolEntry(state);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("sol-p0-del-tail");
    let tree = await settle(view);
    await deleteSlotAndSave(view, tree, 2, { fetchStub });
    assert.deepEqual(state.user.entries[0].credentialRefs, [REF_A, REF_B], "删尾：credentialRefs = [A, B]");
    assert.equal(fetchStub.mutates().length, 1);
  });
});

test("test(keypool): sol P0 删头后原位补新 key——新 ref 落尾位，B/C 身份不误删、A 不误留", async () => {
  const state = makeSettingsState();
  seedPoolEntry(state);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("sol-p0-refill");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.edit, { entryId: "tavily-a" });
    tree = await act(view, () => fire(byRole(tree, POOL_ROLE.remove)[0], "onClick")); // 删头 → [B, C]
    assert.equal(keyFields(tree).length, 2);
    tree = await act(view, () => fire(one(tree, POOL_ROLE.add), "onClick")); // 尾补新槽 → [B, C, 新]
    assert.equal(keyFields(tree).length, 3);
    tree = await act(view, () => fire(keyFields(tree)[2], "onChange", { target: { value: KEY1 } }));
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    const refs = state.user.entries[0].credentialRefs;
    assert.equal(refs.length, 3, "三槽全保留");
    assert.equal(refs[0], REF_B, "首位 = 原 B 身份（A 已删、不得回绑）");
    assert.equal(refs[1], REF_C, "次位 = 原 C 身份（旧 bug 在此误删）");
    assert.ok(![REF_A, REF_B, REF_C].includes(refs[2]), "补位 = 新受控 ref");
    assert.ok(REF_GRAMMAR.test(refs[2]), "新引用符合 POSIX 语法");
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "恰一次 credentials/set（新 key）");
    assert.ok(JSON.stringify(sets[0].body).includes(refs[2]), "set 写入新引用");
    assert.equal(fetchStub.credentialCalls().filter((c) => c.kind === "credentials/unset").length, 0, "零 unset");
    assert.deepEqual(leaksIn(tree, KEY1), [], "明文 key 不回显");
  });
});

test("test(keypool): sol P2 逐槽状态——已存槽「已保存（只写）」+ 已有槽 placeholder；新槽无状态标 + 新槽 placeholder", async () => {
  const state = makeSettingsState();
  state.user.entries[0] = {
    id: "tavily-a",
    type: "tavily",
    name: "Tavily 主",
    enabled: true,
    credentialRefs: [REF_A, REF_B],
  };
  await withEnv(state, async () => {
    const view = await loadSection("sol-p2-slot-status");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.edit, { entryId: "tavily-a" });
    const fields = keyFields(tree);
    assert.equal(fields.length, 2);
    for (const f of fields) {
      assert.equal(String(f.props.value ?? ""), "", "逐槽 write-only：值不回显");
      assert.equal(f.props.placeholder, "已有槽：留空保留", "存量槽 placeholder 区分保留语义");
      assert.deepEqual(leaksIn(f, REF_A), [], "状态面不回显引用名");
      assert.deepEqual(leaksIn(f, REF_B), [], "状态面不回显引用名");
    }
    const saved = byRole(tree, POOL_ROLE.status);
    assert.equal(saved.length, 2, "每已存槽一个状态标");
    for (const s of saved) {
      assert.equal(s.props["data-state"], "saved");
      assert.equal(s.children?.[0] ?? String(s.children), "已保存（只写）");
    }
    tree = await act(view, () => fire(one(tree, POOL_ROLE.add), "onClick")); // 新槽
    assert.equal(keyFields(tree).length, 3);
    assert.equal(byRole(tree, POOL_ROLE.status).length, 2, "新槽无状态标（仅已存槽有）");
    assert.equal(keyFields(tree)[2].props.placeholder, "新槽：留空丢弃", "新槽 placeholder 区分丢弃语义");
  });
});

test("test(keypool): sol P2 新建条目首槽=新槽形态（无状态标、新槽 placeholder）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async () => {
    const view = await loadSection("sol-p2-new-entry");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.add);
    const editor = one(tree, ROLE.editor);
    const select = (function findSelect(node) {
      const stack = [node];
      while (stack.length) {
        const n = stack.pop();
        if (n && n.type === "select") return n;
        if (Array.isArray(n?.children)) stack.push(...n.children);
      }
      throw new Error("编辑器缺少厂商选择下拉框");
    })(editor);
    fire(select, "onChange", { target: { value: "tavily" } });
    tree = await settle(view);
    const fields = keyFields(tree);
    assert.equal(fields.length, 1, "新建 keyed 条目恰一槽");
    assert.equal(fields[0].props.placeholder, "新槽：留空丢弃");
    assert.equal(byRole(tree, POOL_ROLE.status).length, 0, "新建条目无已存槽状态标");
  });
});

test("test(keypool): sol P1 SET-008 复原——删尾槽记录的 credDirty 与身份随 draftCacheApply 复原，提交映射=剩余身份", async () => {
  const view = await loadSection("sol-set008-pure");
  const C = view.rec.Component.contract;
  assert.equal(typeof C.credFormOf, "function", "credFormOf 在纯函数面可直测");
  const entry = { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "" };
  const persisted = { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRefs: [REF_A, REF_B, REF_C] };
  // 删尾槽后的 SET-008 记录：两槽全空（无明文可反推），显式 credDirty + 身份槽位。
  const rec = {
    mode: "edit",
    type: "tavily",
    fields: { name: "Tavily 主", credentialRef: "", credentialRefs: [REF_A, REF_B, REF_C] },
    key: "",
    poolKeys: [{ value: "", keptRef: REF_A }, { value: "", keptRef: REF_B }],
    credDirty: true,
    baseRevision: 7,
  };
  const out = C.draftCacheApply(new Map([["tavily-a", rec]]), { revision: 7, base: {}, user: {} }, {
    entries: [{ ...persisted }],
    useOfficial: true,
    timeoutText: "25000",
  });
  assert.deepEqual(out.poolKeys["tavily-a"], [{ value: "", keptRef: REF_A }, { value: "", keptRef: REF_B }], "复原槽位=剩余身份，零臆测");
  assert.equal(out.credDirty["tavily-a"], true, "显式触碰标志复原（旧实现从明文反推 → 全空=未触碰=删槽意图丢失）");
  const form = C.credFormOf(out.draft.entries[0], persisted, out.poolKeys["tavily-a"], Boolean(out.credDirty["tavily-a"]), (v, ord) => `NEW_${ord}`);
  assert.deepEqual(form, { kind: "pool", refs: [REF_A, REF_B] }, "复原提交 = 剩余身份精确映射（删尾语义保留）");
  // 对照：未触碰记录（无 credDirty）= 惰性迁移原样（POOL-002③ 不变）。
  const rec2 = { ...rec, poolKeys: [{ value: "", keptRef: REF_A }, { value: "", keptRef: REF_B }, { value: "", keptRef: REF_C }], credDirty: undefined };
  const out2 = C.draftCacheApply(new Map([["tavily-a", rec2]]), { revision: 7, base: {}, user: {} }, {
    entries: [{ ...persisted }],
    useOfficial: true,
    timeoutText: "25000",
  });
  assert.equal(out2.credDirty["tavily-a"], undefined, "未触碰记录不虚构触碰");
  assert.deepEqual(C.credFormOf(out2.draft.entries[0], persisted, out2.poolKeys["tavily-a"], false, (v, ord) => `NEW_${ord}`), { kind: "pool", refs: [REF_A, REF_B, REF_C] }, "未触碰=池原样（零 diff）");
  // 旧形态字符串槽位记录降级归一（不崩、不臆测身份）。
  const rec3 = { ...rec, poolKeys: [""] };
  const out3 = C.draftCacheApply(new Map([["tavily-a", rec3]]), { revision: 7, base: {}, user: {} }, {
    entries: [{ ...persisted }],
    useOfficial: true,
    timeoutText: "25000",
  });
  assert.deepEqual(out3.poolKeys["tavily-a"], [{ value: "", keptRef: null }], "旧字符串槽位 → 无身份新槽");
});

test("test(keypool): sol P1 2 元池 401→TIMEOUT 终态——无池措辞、轮替恰一次、TIMEOUT 不再轮替", async () => {
  const entries = [{ id: "p", type: "openai", name: "池条目", enabled: true, credentialRefs: refPoolOf("AB") }];
  const h = createChainHarness(createSearchChain, {
    entries,
    credentialRefs: credentialSeedFor("AB"),
  });
  let n = 0;
  h.deps.backends.set("openai", {
    type: "openai",
    calls: [],
    ctxFor: () => undefined,
    callCount: () => 0,
    async search() {
      n += 1;
      const err = new Error(n === 1 ? "synthetic 401" : "synthetic in-flight timeout");
      err.code = n === 1 ? ENTRY_CODES.CREDENTIALS : ENTRY_CODES.TIMEOUT; // 适配器抛出时直接赋码（A5 面）
      throw err;
    },
  });
  const err = await h.runToError(h.search());
  const attempt = err.details.attempts[0];
  assert.equal(attempt.code, ENTRY_CODES.TIMEOUT, "终态码 = 末次候选已分类 TIMEOUT");
  assert.ok(!/全部\s*\d+\s*把/.test(attempt.reason), `TIMEOUT 终态不得出现池措辞「全部 N 把 key 失败」（实得：${attempt.reason}）`);
  assert.ok(/超时/.test(attempt.reason), "终态原因保留超时可操作信息");
  assert.deepEqual(attempt.pool, {
    size: 2,
    tried: 2,
    outcomes: [
      { index: 1, code: ENTRY_CODES.CREDENTIALS },
      { index: 2, code: ENTRY_CODES.TIMEOUT },
    ],
  }, "attempts.pool 逐 key 脱敏明细（TIMEOUT 计已尝试、不再出站）");
  const rotationMsgs = h.logCapture.entries.filter((e) => JSON.stringify(e).includes("search-chain key 轮替"));
  assert.equal(rotationMsgs.length, 1, "恰一条脱敏轮替事件（401 触发一次；TIMEOUT 非轮替码）");
});

test("test(keypool): sol P1 schemastery ENTRY credentialRefs 数组节点序列化存在性——上限 8、元素 string、旧 role 节点零改动", async () => {
  const refs = Config.toJSON().refs;
  const entryNodes = Object.values(refs).filter((n) => n && n.dict && n.dict.credentialRefs !== undefined);
  assert.equal(entryNodes.length, 1, "恰一个 ENTRY 节点携带 credentialRefs");
  const node = refs[entryNodes[0].dict.credentialRefs];
  assert.equal(node.type, "array", "credentialRefs = 数组节点");
  assert.equal(node.meta?.max, 8, "数组上限 8（POOL_MAX 镜像）");
  const item = refs[node.inner];
  assert.equal(item.type, "string", "元素 = string 节点（引用名，非明文）");
  const legacy = refs[entryNodes[0].dict.credentialRef];
  assert.equal(legacy.type, "string", "旧 credentialRef 节点保留");
  assert.equal(legacy.meta?.role, "credential-ref", "旧 credentialRef role 零改动");
  assert.ok(legacy.meta?.max === undefined, "旧 credentialRef 未获得数组上限（零混入）");
});
