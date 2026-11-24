// WP1 验收（oracle 增量）— src/config.js 中 WP0 test/config-contract.test.js 未锁定的边角条款。
//
// 去重说明：proxy 三形态校验、四层 key 优先级、TRUSTED_ENV_KEYS 白名单、免 key 类型零读取、
// 纯空白=缺失、明文 key 不落盘/不回读、冻结快照、写入唯一入口、保存失败后快照一致、SET-005/FB-003
// 默认值均已由 WP0 的 config-contract.test.js 锁定（该文件不在此重复）。本文件只补四处缺口：
//   CFG-004/SET-004 + A4：保存失败的返回错误须携带 CONFIG_CODES.SAVE_FAILED（A4 要求「失败抛携带
//            CONFIG_CODES 的错误」，SAVE_FAILED 正是为此存在），文本可操作且不含明文 key；回滚不是
//            「粘住」——失败之后读取仍为旧快照，且下一次合法保存仍能生效。
//   CFG-004：writeConfig 落盘的正是 normalizeConfig 认可的形状（无未规范化残留）；normalizeConfig
//            保留条目类型专有参数（如 openai 的 model），否则保存一次即静默丢参数。
//   CFG-002：真正可用的 key 须去掉首尾空白（内部空白保留），避免鉴权头带空白导致 ENTRY_CREDENTIALS。
//   CFG-002/A4：legacyYaml 允许为 undefined（契约原文「解析映射或 undefined」），此时第四层安全跳过。
//
// 条款编号：CFG-002 / CFG-003 / CFG-004 / SET-004（settings-ui.md）；seam 见 helpers/contract.js A4。
// 注意：本文件刻意不使用 CONFIG_CODES.TIMEOUT_INVALID —— WP0 的 config-contract.test.js 引用了
// contract.js 中并不存在的该常量（见 WP1 报告的契约缺陷清单），timeoutMs 校验面归 WP0 文件，待其修正。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { SYNTHETIC_KEY, SYNTHETIC_PROXY } from "./helpers/fake-fetch.js";
import { assertNoSecrets } from "./helpers/redact.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP1 src/config.js";

async function load(t) {
  const res = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, res, WP, "CFG-002/003/004 + SET-004（WP0 未覆盖缺口）")) return null;
  return res.module;
}

const SAVED_FIXTURE = loadFixture(FIXTURE_NAMES.savedConfig);
delete SAVED_FIXTURE.$comment;

test("CFG-004/SET-004：保存失败=带 SAVE_FAILED 的脱敏可操作错误；回滚不粘住，后续合法保存仍生效", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const plainKey = SYNTHETIC_KEY("openai");
  const host = createFakeHost({ config: structuredClone(SAVED_FIXTURE) });
  const port = host.settingsPort;
  const initialOrder = SAVED_FIXTURE.entries.map((e) => e.id);

  const candidate = structuredClone(SAVED_FIXTURE);
  candidate.entries[0].apiKey = plainKey; // 编辑页新输入的明文 key（只可转成凭据引用）
  // 宿主以「回显被拒负载」的形式报错：错误文本里带着明文 key，writeConfig 原样上抛即违反 CFG-003。
  host.editor.failNext = new Error(`synthetic host save rejected, payload=${JSON.stringify(candidate)}`);

  let err;
  try {
    await mod.writeConfig(port, candidate);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "保存失败必须上抛（SET-004：向用户显示可操作错误）");
  assert.ok(
    Object.values(C.CONFIG_CODES).includes(err?.code),
    `A4 要求 writeConfig 失败抛携带 CONFIG_CODES 的错误，实际错误码：${JSON.stringify(err?.code)}`,
  );
  assert.equal(err.code, C.CONFIG_CODES.SAVE_FAILED, `保存失败须归为 SAVE_FAILED（CONFIG_CODES 已备该码），实际：${err.code}`);
  assert.ok(String(err.message ?? "").length > 0, "错误文本须可操作（SET-004）");
  assertNoSecrets(t, err, [plainKey], "保存失败的返回错误（CFG-003：明文 key 不得进入返回错误）");

  const snap = await mod.readConfig(port);
  assert.deepEqual(snap.entries.map((e) => e.id), initialOrder, "保存失败后已生效快照保持一致（CFG-004/SET-004）");
  assertNoSecrets(t, JSON.stringify(host.editor.saved()), [plainKey], "失败后已保存配置文本（CFG-003）");

  const reordered = structuredClone(SAVED_FIXTURE);
  reordered.entries.reverse();
  await mod.writeConfig(port, reordered); // 失败不是粘住状态：下一次合法写入必须生效
  const next = await mod.readConfig(port);
  assert.deepEqual(next.entries.map((e) => e.id), [...initialOrder].reverse(), "下一次合法保存必须生效（CFG-004）");
});

test("CFG-004：writeConfig 落盘形状即 normalizeConfig 输出；normalizeConfig 保留条目类型专有参数", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const raw = {
    entries: [
      { id: "e1", type: "openai", name: "合成 OpenAI", enabled: true, credentialRef: "ref:e1", model: "gpt-5.6-luna", proxy: SYNTHETIC_PROXY },
      { id: "e2", type: "bing", name: "合成 Bing RSS", enabled: true },
    ],
    useOfficialDeepSeekSearch: false,
    timeoutMs: 9000,
    someUnknownTopLevel: "宿主负载里的未知字段",
  };

  const normalized = mod.normalizeConfig(structuredClone(raw));
  assert.equal(normalized.entries[0].model, "gpt-5.6-luna", "条目类型专有参数必须随条目保留（CFG-004「适用参数」），保存一次不得静默丢参数");
  assert.equal(normalized.entries[1].type, "bing");
  assert.equal(normalized.useOfficialDeepSeekSearch, false);
  assert.equal(normalized.timeoutMs, 9000);
  assert.deepEqual(normalized.entries.map((e) => e.id), ["e1", "e2"], "顺序即搜索顺序（CFG-004）");

  const host = createFakeHost({ config: {} }); // 空起点：区分「替换写入」与「合并写入」的干扰
  await mod.writeConfig(host.settingsPort, structuredClone(raw));
  assert.deepEqual(
    host.editor.saved(),
    normalized,
    "writeConfig 落盘的必须是 normalizeConfig 认可后的形状：不得留下未规范化残留，也不得漏掉已认可字段（CFG-004：宿主配置是唯一事实源）",
  );

  const fixtureOut = mod.normalizeConfig(structuredClone(SAVED_FIXTURE));
  assert.equal(fixtureOut.entries[3].type, "deepseek-search", "fixture 的 DeepSeek 模式字段须在归一化后保留");
  assert.equal(fixtureOut.entries[3].credentialRef, SAVED_FIXTURE.entries[3].credentialRef);
});

test("CFG-002：解析出的 key 去掉首尾空白（内部空白保留），不得把带空白的 key 交给供应商", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const K = SYNTHETIC_KEY("openai");
  for (const padded of [`  ${K}\n`, `\t${K} `, `\r\n${K}`]) {
    const creds = createFakeCredentials({ refs: { "ref:e1": padded } });
    const out = await mod.resolveEntryApiKey(C.makeEntry({ id: "e1", type: "openai", credentialRef: "ref:e1" }), {
      env: {},
      credentials: creds,
      legacyYaml: {},
    });
    assert.deepEqual(out, { key: K }, `层值须去首尾空白后返回（CFG-002「纯空白=未提供」的补集：带空白须归一化），实际：${JSON.stringify(out)}`);
  }
  const inner = `${SYNTHETIC_KEY("keep")} inner`;
  // 第三层＝托管 ref（WP7 凭据轮裁决）：以裸 env 名 seed refs，值经 resolve(envName) 命中取 hit.value。
  const creds = createFakeCredentials({ refs: { OPENAI_API_KEY: inner } });
  const out = await mod.resolveEntryApiKey(C.makeEntry({ id: "e2", type: "openai" }), {
    env: {},
    credentials: creds,
    legacyYaml: {},
  });
  assert.deepEqual(out, { key: inner }, "只去首尾空白：托管 ref 值内部空白原样保留（规格未授权改写 key 内容）");
});

test("CFG-002/A4：legacyYaml 为 undefined 时第四层安全跳过，不得抛错", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const K_REC = SYNTHETIC_KEY("rec");
  // 第三层＝托管 ref（WP7 凭据轮裁决）：readRecord 不在解析链，托管 key 经 resolve(TAVILY_API_KEY) 提供。
  const creds = createFakeCredentials({ refs: { TAVILY_API_KEY: K_REC } });
  assert.deepEqual(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e1", type: "tavily" }), { env: {}, credentials: creds, legacyYaml: undefined }),
    { key: K_REC },
    "无旧版兼容层时上层命中的 key 仍须解析成功（A4：legacyYaml 可为 undefined）",
  );
  assert.equal(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e2", type: "tavily" }), {
      env: {},
      credentials: createFakeCredentials(),
      legacyYaml: undefined,
    }),
    null,
    "全层缺失且无旧版层 → null（由链按 SKIPPED_NO_KEY 处理），不得抛错或崩溃",
  );
  // openai/tavily/deepseek 之外的类型没有第四层；undefined 与给定映射都必须等价跳过
  assert.equal(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e3", type: "brave" }), {
      env: {},
      credentials: createFakeCredentials(),
      legacyYaml: { brave: SYNTHETIC_KEY("brave-legacy") },
    }),
    null,
    "brave 不在旧版兼容名单（LEGACY_YAML_SUPPLIERS），第四层不得读它",
  );
});
