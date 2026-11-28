// Issue #88 第二批②/③（test(proxy)：不改骨架）：
//  ① writeConfig raw 保留面与面板清理面同一 secret 字段名闭集（递归、按名、引用形态豁免）——
//     降级保留故事（PX-009）只对非 secret 未知键成立；
//  ② 共享 helper（src/constants.js）语义钉：闭集路径收集 / 递归剥离 / 合法引用豁免。
// 全程合成凭据（syn-*.invalid），零真实网络。
import test from "node:test";
import assert from "node:assert/strict";
import { writeConfig } from "../src/config.js";
import {
  SECRET_KEY_CLOSURE,
  isSecretClosureKey,
  isLegitGlobalProxyRef,
  secretClosurePaths,
  stripSecretClosure,
} from "../src/constants.js";
import { createFakeHost, createHostShapeFakeHost } from "./helpers/fake-host.js";

const CLAUSES = "PX-001#3/CFG-W-003扩展";
const LEGIT_REF = "search_chain_global_proxy";

function rawDoc() {
  return {
    entries: [{ id: "d1", type: "tavily", name: "直连", enabled: true, credentialRef: "TAV" }],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
    globalProxyUrl: "http://u:p@h:1234", // top 层闭集命中（未知键面）
    extra: {
      apiKey: "sk-RAW-1", // 一级嵌套闭集命中
      meta: { token: "tok-RAW-2", note: "keep-me" }, // 二级嵌套闭集命中 + 非闭集幸存键
    },
    foreign_plugin_key: { keep: "me" }, // 非闭集未知键（PX-009 存续）
  };
}

test(`${CLAUSES} 共享helper：闭集路径收集递归任意深度、按字段名、引用形态豁免`, () => {
  const doc = {
    globalProxy: LEGIT_REF, // 精确键 + POSIX 引用 → 豁免
    globalProxyUrl: "http://u:p@h", // 族名命中
    extra: { api_key: "sk-x", meta: { password: "p", note: "keep" } },
    entries: [{ apiKey: "sk-y", name: "keep" }],
  };
  const paths = secretClosurePaths(doc, [], []).map((p) => p.join("/"));
  assert.deepEqual(
    paths.sort(),
    ["entries/0/apiKey", "extra/api_key", "extra/meta/password", "globalProxyUrl"].sort(),
    "闭集路径 = 任意深度的命中键（含数组下标），合法引用豁免",
  );
  assert.equal(isLegitGlobalProxyRef("globalProxy", LEGIT_REF), true, "精确键 + POSIX 引用 = 合法");
  assert.equal(isLegitGlobalProxyRef("globalproxy", LEGIT_REF), true, "精确键大小写不敏感");
  assert.equal(isLegitGlobalProxyRef("globalproxy", "http://u:p@h"), false, "URL 形态不合法（豁免仅引用名）");
  assert.equal(isLegitGlobalProxyRef("globalProxyUrl", LEGIT_REF), false, "族名非精确键不豁免");
  assert.equal(isSecretClosureKey("apiKey"), true);
  assert.equal(isSecretClosureKey("globalproxy"), true);
  assert.equal(isSecretClosureKey("name"), false);
  assert.equal(SECRET_KEY_CLOSURE.length, 2, "闭集恰两族（legacy secret + globalProxy 族）");
});

test(`${CLAUSES} 共享helper：stripSecretClosure 递归剥离返回新结构（不改原对象）`, () => {
  const doc = structuredClone(rawDoc());
  const stripped = stripSecretClosure(doc);
  assert.deepEqual(stripped.extra, { meta: { note: "keep-me" } }, "嵌套闭集键全清、非闭集幸存");
  assert.equal(stripped.globalProxyUrl, undefined, "top 层闭集键清除");
  assert.deepEqual(stripped.foreign_plugin_key, { keep: "me" }, "非闭集未知键存续");
  assert.deepEqual(stripped.entries, doc.entries, "非闭集结构原样");
  assert.ok(doc.extra.apiKey === "sk-RAW-1", "原对象未被修改（返回新结构）");
});

// 旧默认形态：raw 即整份行文档（raw 保留面的完整语义面）。
test(`${CLAUSES} 第二批②：writeConfig raw 保留面先递归剥离闭集再保留未知键（任意深度零闭集残留）`, async () => {
  const host = createFakeHost({ inject: ["configEditor"], config: structuredClone(rawDoc()) });
  await writeConfig(host.settingsPort, {
    entries: [{ id: "d1", type: "tavily", name: "直连改", enabled: true, credentialRef: "TAV" }],
    useOfficialDeepSeekSearch: false,
    timeoutMs: 1234,
  });
  const afterRaw = host.settingsPort.current();
  assert.equal(afterRaw.globalProxyUrl, undefined, "raw top 层全局代理明文字段族不留存");
  assert.deepEqual(afterRaw.extra, { meta: { note: "keep-me" } }, "raw 嵌套闭集键任意深度不留存；非闭集未知键存续（PX-009）");
  assert.deepEqual(afterRaw.foreign_plugin_key, { keep: "me" }, "非 secret 未知键按 PX-009 存续");
  assert.equal(afterRaw.useOfficialDeepSeekSearch, false, "自有键以本次写入为准");
  assert.equal(afterRaw.timeoutMs, 1234, "自有键以本次写入为准");
  assert.equal(afterRaw.entries[0].name, "直连改", "条目以归一化写入为准");
});

// 宿主形态：config 是 inherited 基线；override（行自身层）= 插件过往写入面——
// 旧版本写入的闭集命中键（顶层 globalProxyUrl + 嵌套明文）在下一次 writeConfig 时被剥离；
// inherited 基线的非闭集未知键不受影响（分层语义下 PX-009 存续）。
test(`${CLAUSES} 第二批②（宿主形态）：override 层旧版本写入的闭集键在下一次保存被剥离；基线不受影响`, async () => {
  const host = createHostShapeFakeHost({
    inject: ["configEditor"],
    config: {
      entries: [{ id: "d1", type: "tavily", name: "直连", enabled: true, credentialRef: "TAV" }],
      useOfficialDeepSeekSearch: true,
      timeoutMs: 25000,
      foreign_plugin_key: { keep: "me" },
    },
  });
  // 模拟旧版本插件写入行自身层（携带闭集命中键）。
  await host.editor.edit(host.settingsPort.entry, () => ({
    globalProxyUrl: "http://u:p@h:1234",
    extra: { apiKey: "sk-OLD-1", meta: { token: "tok-OLD-2", note: "keep-me" } },
  }));
  const midRaw = host.settingsPort.current();
  assert.equal(midRaw.globalProxyUrl, "http://u:p@h:1234", "前置：旧写入在场");
  // 新版本保存：raw（override 层）先递归剥离闭集再落盘。
  await writeConfig(host.settingsPort, {
    entries: [{ id: "d1", type: "tavily", name: "直连改", enabled: true, credentialRef: "TAV" }],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  });
  const afterRaw = host.settingsPort.current();
  assert.equal(afterRaw.globalProxyUrl, undefined, "override 层旧版全局代理明文不留存");
  assert.deepEqual(afterRaw.extra, { meta: { note: "keep-me" } }, "override 层嵌套闭集键任意深度不留存");
  assert.deepEqual(afterRaw.foreign_plugin_key, { keep: "me" }, "inherited 基线非闭集未知键存续（PX-009）");
  assert.equal(afterRaw.entries[0].name, "直连改", "条目以归一化写入为准");
});

test(`${CLAUSES} 第二批②：未知结构内的合法引用形态豁免；顶层 globalProxy 为自有键以归一化写入为准`, async () => {
  const doc = rawDoc();
  doc.extra.globalProxy = LEGIT_REF; // 未知父结构内的精确键 + POSIX 引用 → 豁免
  doc.extra.globalProxyText = "http://u:p@h:4321"; // 同结构族名命中 → 剥离
  const host = createFakeHost({ inject: ["configEditor"], config: structuredClone(doc) });
  const result = await writeConfig(host.settingsPort, {
    entries: doc.entries,
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
    proxyEscalation: true,
    globalProxy: LEGIT_REF,
  });
  const afterRaw = host.settingsPort.current();
  assert.equal(afterRaw.extra.globalProxy, LEGIT_REF, "未知结构内合法引用形态豁免剥离（refs-only 契约）");
  assert.equal(afterRaw.extra.globalProxyText, undefined, "同结构族名明文字段剥离");
  assert.equal(afterRaw.globalProxy, LEGIT_REF, "顶层 globalProxy 以归一化写入为准（自有键）");
  assert.equal(result.proxyEscalation, true, "新字段族经 writeConfig 落盘（OWN_CONFIG_KEYS）");
  assert.equal(result.globalProxy, LEGIT_REF, "读回呈引用形态");
});

// 面板面 × writeConfig 面清理一致性：同一嵌套明文形（与面板侧 px-cleanup-cross 第二批①同形）——
// 共享闭集剥离后的存续结构必须与面板面离散保存流的终层 extra 期望同构（零闭集命中 + 同键存续）。
test(`${CLAUSES} 面一致性：同形嵌套明文经 writeConfig 面剥离后与面板面终层期望同构`, () => {
  const shape = {
    globalProxyUrl: "http://u:p@h:4321",
    extra: { apiKey: "sk-NESTED-9", meta: { token: "tok-NESTED-7", note: "keep-me" } },
  };
  const stripped = stripSecretClosure(shape);
  assert.deepEqual(stripped, { extra: { meta: { note: "keep-me" } } }, "writeConfig 面：同形输入 → 与面板面终层相同的存续结构");
  assert.equal(secretClosurePaths(stripped, [], []).length, 0, "writeConfig 面终层零闭集命中（任意深度）");
  // 面板面的同一闭集镜像（client-entry.js 零导入经典脚本内联）由 px-cleanup-cross 第二批①以同形断言终层
  // deepEqual { meta: { note: "keep-me" } }——两面对同一形给出同一存续结构，即一致性钉。
});
