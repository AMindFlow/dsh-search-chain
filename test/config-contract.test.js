// WP0 验收 — CFG-001/002/003/004 + SET-005/FB-003 默认值（src/config.js 接缝，A4）。
// 覆盖条款：
//   CFG-001：proxy 仅 string(HTTP/HTTPS 正向代理)|{pac:string}|省略/空白=直连；其余一律 INVALID。
//            （“绝不触碰宿主/全局代理变量”属 transport 层，由 WP3 transport 验收覆盖。）
//   CFG-002：key 优先级 条目 credentialRef → 进程环境变量（仅 CAT-001 白名单名）→ DSH 托管记录
//            → 旧版 YAML（仅 openai/tavily/deepseek）；纯空白=缺失；免 key 类型零凭据读取；
//            凭据不可读/损坏 → CREDENTIALS_UNREADABLE 配置错误。
//   CFG-003：已保存配置只存引用；明文 key 绝不落盘、绝不回读。
//   CFG-004：宿主插件配置为唯一事实源；写入走 configEditor(ctx.fiber.entry)；读数为冻结快照；
//            保存失败已生效快照保持一致；顺序即 entries 数组顺序。
//   SET-005 / FB-003：缺省 useOfficialDeepSeekSearch=true、timeoutMs=25000。
// 实现方（WP1）不得弱化断言。settings 端口 = fake-host.settingsPort（A4）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { SYNTHETIC_KEY, SYNTHETIC_PROXY, SYNTHETIC_PAC } from "./helpers/fake-fetch.js";
import { assertNoSecrets } from "./helpers/redact.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP1 src/config.js";

async function load(t) {
  const res = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, res, WP, "CFG-001..004/SET-005")) return null;
  return res.module;
}

const SAVED_FIXTURE = loadFixture(FIXTURE_NAMES.savedConfig);
delete SAVED_FIXTURE.$comment;

async function expectConfigError(t, fn, code) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, "非法输入必须抛错，不得静默容忍");
  assert.ok(
    Object.values(C.CONFIG_CODES).includes(threw.code),
    `错误须携带 CONFIG_CODES 码，实际：${threw.code}`,
  );
  assert.equal(threw.code, code, `期望错误码 ${code}`);
}

test("CFG-004/SET-005/FB-003：normalizeConfig 保留顺序与字段，缺省即默认", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const out = mod.normalizeConfig(structuredClone(SAVED_FIXTURE));
  assert.deepEqual(
    out.entries.map((e) => e.id),
    ["e-openai-main", "e-tavily-pac", "e-bing-off", "e-deepseek-search"],
    "entries 顺序即搜索顺序，不得重排（CFG-004/SET-003）",
  );
  assert.equal(out.entries[0].credentialRef, SAVED_FIXTURE.entries[0].credentialRef);
  assert.equal(out.entries[0].proxy, SYNTHETIC_PROXY);
  assert.deepEqual(out.entries[1].proxy, { pac: SYNTHETIC_PAC });
  assert.equal(out.entries[2].enabled, false, "停用状态必须保留");
  assert.equal(out.useOfficialDeepSeekSearch, true);
  assert.equal(out.timeoutMs, 25000);

  const empty = mod.normalizeConfig({});
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.useOfficialDeepSeekSearch, true, "SET-005：缺省官方委托开启");
  assert.equal(empty.timeoutMs, C.DEFAULT_TIMEOUT_MS, "FB-003：缺省总预算 25000");
});

test("CFG-004/FB-003：非法结构一律携带 CONFIG_CODES 的配置错误", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  for (const bad of [0, -5, 2.5, "25000", Number.NaN]) {
    await expectConfigError(t, () => mod.normalizeConfig({ timeoutMs: bad }), C.CONFIG_CODES.TIMEOUT_INVALID);
  }
  for (const raw of [
    { entries: "abc" },
    { entries: [{}] },
    { entries: [{ id: "x" }] }, // 缺 type
    { entries: [{ id: "x", type: "not-a-tool" }] },
    { entries: [{ id: "x", type: "openai" }, { id: "x", type: "openai" }] }, // id 必须唯一稳定
    { useOfficialDeepSeekSearch: "yes" },
  ]) {
    await expectConfigError(t, () => mod.normalizeConfig(raw), C.CONFIG_CODES.INVALID);
  }
});

test("CFG-001：proxy 三形态合法；越界形态 INVALID；空白=直连", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const ok = (proxy) => {
    const out = mod.normalizeConfig({ entries: [C.makeEntry({ id: "e", type: "openai", proxy })] });
    return out.entries[0].proxy;
  };
  assert.equal(ok(SYNTHETIC_PROXY), SYNTHETIC_PROXY);
  assert.deepEqual(ok({ pac: SYNTHETIC_PAC }), { pac: SYNTHETIC_PAC });
  for (const blank of ["", "   "]) {
    const got = ok(blank);
    assert.ok(!got, `空白=直连：normalize 后 proxy 须省略/置空，实际：${JSON.stringify(got)}`);
  }

  for (const bad of ["syn-proxy.invalid:8080", "ftp://syn-proxy.invalid:21", 42, { bogus: 1 }, { pac: "not-an-url" }, { pac: "   " }]) {
    await expectConfigError(t, () => mod.normalizeConfig({ entries: [C.makeEntry({ id: "e", type: "openai", proxy: bad })] }), C.CONFIG_CODES.INVALID);
  }
});

test("CFG-003：明文 key 不落盘、不回读（normalize + 读写两层）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const K = SYNTHETIC_KEY("openai");
  const raw = { entries: [C.makeEntry({ id: "e1", type: "openai", credentialRef: "ref:e1", apiKey: K })] };
  const out = mod.normalizeConfig(structuredClone(raw));
  assert.equal(out.entries[0].apiKey, undefined, "配置只存引用（CFG-003）");
  assertNoSecrets(t, out, [K], "normalizeConfig 输出");

  const host = createFakeHost({ config: {} });
  await mod.writeConfig(host.settingsPort, raw);
  assertNoSecrets(t, JSON.stringify(host.editor.saved()), [K], "已保存配置文本");

  const host2 = createFakeHost({
    config: { entries: [C.makeEntry({ id: "e1", type: "openai", apiKey: K })], useOfficialDeepSeekSearch: true },
  });
  const snap = await mod.readConfig(host2.settingsPort);
  assertNoSecrets(t, snap, [K], "readConfig 快照（历史脏数据也不得回读出 key）");
});

test("CFG-004：readConfig 冻结快照；writeConfig 经 fiber.entry；保存失败一致性", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const host = createFakeHost({ config: structuredClone(SAVED_FIXTURE) });
  const port = host.settingsPort;

  const snap1 = await mod.readConfig(port);
  assert.deepEqual(snap1.entries.map((e) => e.id), SAVED_FIXTURE.entries.map((e) => e.id));
  assert.ok(Object.isFrozen(snap1) && Object.isFrozen(snap1.entries), "读数必须是冻结快照（CFG-004：在途不受改写）");

  const swapped = structuredClone(SAVED_FIXTURE);
  swapped.entries.reverse();
  await mod.writeConfig(port, swapped);
  assert.equal(host.editor.calls.at(-1).target, host.entry, "写入必须走 configEditor(ctx.fiber.entry)（唯一入口）");
  assert.deepEqual(snap1.entries.map((e) => e.id), SAVED_FIXTURE.entries.map((e) => e.id), "旧快照不受后续写入影响（CFG-004）");
  const snap2 = await mod.readConfig(port);
  assert.deepEqual(snap2.entries.map((e) => e.id), [...SAVED_FIXTURE.entries.map((e) => e.id)].reverse(), "新顺序生效");
  assert.throws(() => snap2.entries.splice(0, 1), TypeError, "冻结快照不可被就地改写");

  host.editor.failNext = new Error("synthetic save failure");
  await assert.rejects(mod.writeConfig(port, structuredClone(SAVED_FIXTURE)), "保存失败必须上抛");
  const snap3 = await mod.readConfig(port);
  assert.deepEqual(snap3.entries.map((e) => e.id), [...SAVED_FIXTURE.entries.map((e) => e.id)].reverse(), "保存失败后已生效快照保持一致（CFG-004/SET-004）");

  await expectConfigError(t, () => mod.writeConfig(port, { entries: [{ id: "x" }] }), C.CONFIG_CODES.INVALID);
  const snap4 = await mod.readConfig(port);
  assert.deepEqual(snap4.entries.map((e) => e.id), [...SAVED_FIXTURE.entries.map((e) => e.id)].reverse(), "非法写入不得生效");
});

/** 环境映射替身：记录读取到的名字（白名单断言用）。 */
function trackedEnv(values = {}) {
  const reads = [];
  const env = new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== "string") return undefined;
        reads.push(name);
        return values[name];
      },
      has(_t, name) {
        reads.push(name);
        return Object.hasOwn(values, name);
      },
    },
  );
  return { env, reads };
}

function trackedLegacy(values = {}, { broken = false } = {}) {
  const reads = [];
  const legacy = new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== "string") return undefined;
        reads.push(name);
        if (broken) throw new Error("synthetic legacy yaml parse failure");
        return values[name];
      },
    },
  );
  return { legacy, reads };
}

test("CFG-002：credentialRef → 环境 → 托管记录 → 旧版YAML 四层优先级，逐层撤除核对", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const K_REF = SYNTHETIC_KEY("ref");
  const K_ENV = SYNTHETIC_KEY("env");
  const K_REC = SYNTHETIC_KEY("rec");
  const K_LEG = SYNTHETIC_KEY("legacy");
  const entry = C.makeEntry({ id: "e1", type: "openai", credentialRef: "ref:e1" });

  const creds = createFakeCredentials({
    refs: { "ref:e1": K_REF },
    records: { OPENAI_API_KEY: K_REC },
  });
  const e1 = trackedEnv({ OPENAI_API_KEY: K_ENV });
  const l1 = trackedLegacy({ openai: K_LEG });
  assert.deepEqual(
    await mod.resolveEntryApiKey(entry, { env: e1.env, credentials: creds, legacyYaml: l1.legacy }),
    { key: K_REF },
    "第一层：条目 credentialRef 最高优先",
  );
  assert.equal(e1.reads.length, 0, "上层命中后不得再读环境变量（只解析实际需要的层）");
  assert.deepEqual(creds.recordCalls, [], "上层命中后不得读托管记录");

  creds.removeRef("ref:e1");
  const e2 = trackedEnv({ OPENAI_API_KEY: K_ENV });
  assert.deepEqual(
    await mod.resolveEntryApiKey(entry, { env: e2.env, credentials: creds, legacyYaml: l1.legacy }),
    { key: K_ENV },
    "第二层：环境变量（须先于托管记录）",
  );
  assert.deepEqual(creds.recordCalls, [], "环境命中不得再读托管记录");

  const e3 = trackedEnv({});
  const creds3 = createFakeCredentials({ records: { OPENAI_API_KEY: K_REC } });
  assert.deepEqual(
    await mod.resolveEntryApiKey(entry, { env: e3.env, credentials: creds3, legacyYaml: l1.legacy }),
    { key: K_REC },
    "第三层：DSH 托管记录",
  );
  assert.deepEqual(creds3.recordCalls, ["OPENAI_API_KEY"]);

  const creds4 = createFakeCredentials({});
  const e4 = trackedEnv({});
  const l4 = trackedLegacy({ openai: K_LEG });
  assert.deepEqual(
    await mod.resolveEntryApiKey(entry, { env: e4.env, credentials: creds4, legacyYaml: l4.legacy }),
    { key: K_LEG },
    "第四层：旧版 YAML（openai 在兼容名单内）",
  );
  assert.deepEqual(l4.reads, ["openai"], "旧版层只查所属供应商键");

  const l5 = trackedLegacy({});
  assert.equal(
    await mod.resolveEntryApiKey(entry, { env: trackedEnv({}).env, credentials: createFakeCredentials(), legacyYaml: l5.legacy }),
    null,
    "全层缺失 → null（由链按 SKIPPED_NO_KEY 处理）",
  );
});

test("CFG-002：纯空白一律视为缺失（各层同规则）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const K_ENV = SYNTHETIC_KEY("env");
  const creds = createFakeCredentials({ refs: { "ref:e1": "   " } });
  const env = trackedEnv({ OPENAI_API_KEY: K_ENV });
  assert.deepEqual(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e", type: "openai", credentialRef: "ref:e1" }), {
      env: env.env,
      credentials: creds,
      legacyYaml: trackedLegacy({}).legacy,
    }),
    { key: K_ENV },
    "ref 解析为空白 = 缺失",
  );
  const creds2 = createFakeCredentials({ records: { OPENAI_API_KEY: "" } });
  const l2 = trackedLegacy({ openai: SYNTHETIC_KEY("legacy") });
  assert.deepEqual(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e", type: "openai" }), {
      env: trackedEnv({}).env,
      credentials: creds2,
      legacyYaml: l2.legacy,
    }),
    { key: SYNTHETIC_KEY("legacy") },
    "托管记录空串 = 缺失，继续下一层",
  );
});

test("CFG-002/CAT-001：环境变量只读白名单名；免 key 类型零凭据读取", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const { env, reads } = trackedEnv({
    OPENAI_API_KEY: SYNTHETIC_KEY("env"),
    HTTPS_PROXY: "http://leak-me.invalid:9", // 白名单外：即便有值也绝不能被读/用
    DEEPSEEK_API_KEY: SYNTHETIC_KEY("ds"),
  });
  await mod.resolveEntryApiKey(C.makeEntry({ id: "e", type: "openai" }), {
    env,
    credentials: createFakeCredentials(),
    legacyYaml: trackedLegacy({}).legacy,
  });
  assert.ok(reads.every((n) => C.TRUSTED_ENV_KEYS.includes(n)), `环境变量读取越出白名单：${JSON.stringify(reads)}`);
  assert.ok(!reads.includes("HTTPS_PROXY"), "CFG-001/002：绝不得偷读全局代理变量当 key/代理来源");

  const ds = trackedEnv({ DEEPSEEK_API_KEY: SYNTHETIC_KEY("ds") });
  const out = await mod.resolveEntryApiKey(C.makeEntry({ id: "e2", type: "deepseek-agentic-search" }), {
    env: ds.env,
    credentials: createFakeCredentials(),
    legacyYaml: trackedLegacy({}).legacy,
  });
  assert.deepEqual(out, { key: SYNTHETIC_KEY("ds") }, "DeepSeek 两模式共用 DEEPSEEK_API_KEY（CAT-001）");

  const creds = createFakeCredentials();
  const bingEnv = trackedEnv({});
  const bingLegacy = trackedLegacy({});
  const bing = await mod.resolveEntryApiKey(C.makeEntry({ id: "e3", type: "bing" }), {
    env: bingEnv.env,
    credentials: creds,
    legacyYaml: bingLegacy.legacy,
  });
  assert.equal(bing, null, "免 key 类型：无凭据概念，返回 null（可用性由链按 KEYLESS_TYPES 判定）");
  assert.equal(creds.totalReads(), 0, "bing 零凭据读取（CFG-002）");
  assert.equal(bingEnv.reads.length, 0);
  assert.deepEqual(bingLegacy.reads, [], "bing 无旧版层");

  const exaLegacy = trackedLegacy({ exa: "sk-synthetic-exa-NOPE-DO-NOT-LOG" });
  assert.equal(
    await mod.resolveEntryApiKey(C.makeEntry({ id: "e4", type: "exa" }), {
      env: trackedEnv({}).env,
      credentials: createFakeCredentials(),
      legacyYaml: exaLegacy.legacy,
    }),
    null,
  );
  assert.deepEqual(exaLegacy.reads, [], "旧版 YAML 仅限 openai/tavily/deepseek（CFG-002）");
});

test("CFG-002：凭据不可读/损坏 = CREDENTIALS_UNREADABLE 配置错误（不是静默缺失）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const creds = createFakeCredentials({ failRefReads: ["ref:bad"] });
  await expectConfigError(
    t,
    () =>
      mod.resolveEntryApiKey(C.makeEntry({ id: "e", type: "openai", credentialRef: "ref:bad" }), {
        env: trackedEnv({}).env,
        credentials: creds,
        legacyYaml: trackedLegacy({}).legacy,
      }),
    C.CONFIG_CODES.CREDENTIALS_UNREADABLE,
  );
  const brokenLegacy = trackedLegacy({}, { broken: true });
  await expectConfigError(
    t,
    () =>
      mod.resolveEntryApiKey(C.makeEntry({ id: "e", type: "tavily" }), {
        env: trackedEnv({}).env,
        credentials: createFakeCredentials(),
        legacyYaml: brokenLegacy.legacy,
      }),
    C.CONFIG_CODES.CREDENTIALS_UNREADABLE,
  );
});
