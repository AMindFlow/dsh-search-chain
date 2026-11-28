// PX-001（读闸默认/两闸拒绝矩阵）· PX-002 验收1（闸层）· PX-006 验收4（钉死两闸拒绝）。
// Oracle 骨架（工作包 #88，docs/specs/draft/proxy-escalation-oracle.md）：实现前跑红属预期。
// 观测面：O1 normalizeConfig（src/config.js）、O2 Component.contract.validate（写闸镜像）。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { loadSection } from "./helpers/settings-panel-v02.js";

const CLAUSES = "PX-001/PX-002/PX-006";
const GLOBAL_REF = "search_chain_global_proxy";

function normResult(sample) {
  try {
    return { ok: true, config: normalizeConfig(structuredClone(sample)) };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

async function gatePair(tag) {
  const { Component } = await loadSection(tag);
  return {
    read: normResult,
    write: (sample) => {
      try {
        Component.contract.validate(structuredClone(sample));
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String(err?.message || err) };
      }
    },
  };
}

function assertBothReject(gates, sample, label, whereRe) {
  const r = gates.read(sample);
  const w = gates.write(sample);
  assert.equal(r.ok, false, `${label}：读闸必须拒绝`);
  assert.equal(w.ok, false, `${label}：写闸必须拒绝（CFG-W-001 等价钉）`);
  if (whereRe) {
    assert.match(r.message, whereRe, `读闸错误文本须定位字段（${label}）`);
    assert.match(w.message, whereRe, `写闸错误文本须定位字段（${label}）`);
  }
}

function assertBothAccept(gates, sample, label) {
  assert.equal(gates.read(sample).ok, true, `${label}：读闸必须接受（不得过度收紧）`);
  assert.equal(gates.write(sample).ok, true, `${label}：写闸必须接受（不得过度收紧）`);
}

// ─── PX-001 验收1：存量配置归一化默认值 ──────────────────────────────────────

test(`${CLAUSES}：存量无三新键配置 → 读闸输出 proxyEscalation=false、globalProxy 省略、条目 proxyPin="inherit"（PX-001 验收1 / PX-009 默认等价）`, () => {
  const out = normalizeConfig({
    entries: [
      { id: "a", type: "tavily", name: "A", enabled: true, credentialRef: "TAV" },
      { id: "b", type: "bing", name: "B", enabled: true, proxy: { pac: "http://syn-pac.invalid/x.pac" } },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  });
  assert.equal(out.proxyEscalation, false, "proxyEscalation 默认必须显式输出 false（PX-001 验收1）");
  assert.ok(!("globalProxy" in out), "globalProxy 未配置时必须省略（PX-001 验收1）");
  for (const e of out.entries) {
    assert.equal(e.proxyPin, "inherit", `存量条目 proxyPin 必须归一化为 "inherit"（PX-009 等价，A-PX-3）`);
  }
});

// ─── PX-001 验收4：proxyEscalation / globalProxy 非法形态两闸同拒 ────────────

test(`${CLAUSES}：proxyEscalation 非布尔（null/"true"/0/{}）两闸同拒并定位字段（PX-001 验收4，并入 CFG-W-002 矩阵）`, async () => {
  const gates = await gatePair("px001-switch");
  for (const bad of [null, "true", 0, {}, []]) {
    assertBothReject(
      gates,
      { entries: [], proxyEscalation: bad, globalProxy: GLOBAL_REF, useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
      `proxyEscalation=${JSON.stringify(bad)}`,
      /proxyEscalation/,
    );
  }
});

test(`${CLAUSES}：globalProxy 明文 URL/非 POSIX 名两闸同拒并定位字段；合法 POSIX 引用名两闸同受（PX-001 验收4）`, async () => {
  const gates = await gatePair("px001-ref");
  for (const bad of [
    "http://syn-user:syn-pass@syn-proxy.invalid:8080", // 明文 URL（含 :// 与 userinfo）
    "syn-proxy.invalid:8080", // 无 scheme 也非 POSIX 标识符
    "bad ref",
    "bad:ref",
    true,
    123,
  ]) {
    assertBothReject(
      gates,
      { entries: [], proxyEscalation: false, globalProxy: bad, useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
      `globalProxy=${JSON.stringify(bad)}`,
      /globalProxy/,
    );
  }
  assertBothAccept(
    gates,
    { entries: [], proxyEscalation: true, globalProxy: GLOBAL_REF, useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
    "合法组合（开关开+POSIX 引用名）",
  );
});

// ─── PX-002 验收1（闸层）：开关开+无引用终态两闸同拒 ─────────────────────────

test(`${CLAUSES}：终态 proxyEscalation=true 且 globalProxy 未配置 → 两闸同拒、错误定位 proxyEscalation、提示先保存地址（PX-002 验收1）`, async () => {
  const gates = await gatePair("px002-terminal");
  for (const raw of [
    { entries: [], proxyEscalation: true, useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
    { entries: [], proxyEscalation: true, globalProxy: "", useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
  ]) {
    const r = gates.read(raw);
    const w = gates.write(raw);
    assert.equal(r.ok, false, "读闸必须拒绝「开关开+无引用」终态（PX-002）");
    assert.equal(w.ok, false, "写闸必须拒绝「开关开+无引用」终态（PX-002）");
    assert.match(r.message, /proxyEscalation/, "错误文本必须定位 proxyEscalation（PX-002 验收1）");
    assert.match(r.message, /(先|重新)?.*(保存|配置).*(全局代理|代理地址)|全局代理.*(先|保存)/, "错误必须给出可操作指引");
  }
});

// ─── PX-006 验收4：proxyPin 非法/矛盾组合两闸同拒 ─────────────────────────────

test(`${CLAUSES}：proxyPin 三态外值（"bounce"/null/0/{}）两闸同拒并定位 entries[i].proxyPin（PX-006 验收4）`, async () => {
  const gates = await gatePair("px006-badpin");
  for (const bad of ["bounce", null, 0, {}, true]) {
    assertBothReject(
      gates,
      {
        entries: [{ id: "a", type: "bing", name: "A", enabled: true, proxyPin: bad }],
        useOfficialDeepSeekSearch: true,
        timeoutMs: 25000,
      },
      `proxyPin=${JSON.stringify(bad)}`,
      /entries\[0\]\.proxyPin/,
    );
  }
});

test(`${CLAUSES}：proxyPin 非默认值 + 自有 proxy（字符串与 {pac} 两形）矛盾组合两闸同拒并定位（PX-006 验收4 / PX-003 自治）`, async () => {
  const gates = await gatePair("px006-conflict");
  for (const pin of ["directOnly", "proxyOnly"]) {
    for (const proxy of ["http://own-proxy.invalid:3128", { pac: "http://syn-pac.invalid/x.pac" }]) {
      assertBothReject(
        gates,
        {
          entries: [{ id: "a", type: "bing", name: "A", enabled: true, proxy, proxyPin: pin }],
          useOfficialDeepSeekSearch: true,
          timeoutMs: 25000,
        },
        `pin=${pin}+proxy=${JSON.stringify(proxy)}`,
        /entries\[0\]\.proxyPin/,
      );
    }
  }
});

test(`${CLAUSES}：显式 proxyPin="inherit" + 自有 proxy 必须两闸同受（不得过度收紧，CFG-W-001 双向等价）`, async () => {
  const gates = await gatePair("px006-inherit-ok");
  assertBothAccept(
    gates,
    {
      entries: [{ id: "a", type: "bing", name: "A", enabled: true, proxy: "http://own-proxy.invalid:3128", proxyPin: "inherit" }],
      useOfficialDeepSeekSearch: true,
      timeoutMs: 25000,
    },
    "inherit（显式默认值）+自有 proxy",
  );
});
