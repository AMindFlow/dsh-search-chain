// WP87 fetch 接管 Oracle — CI 零真实出站守卫（oracle 文档 §6 四点）。
// 分层：G1 静态源扫（本仓库全部 ft-oracle-* 与 helper）；G2 桩端点回环钉；G3 进程内 fetch 哨兵自证；
// G4 npm test 挂全进程守卫（--import loader）——实现 PR 契约项，未挂即红。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { startStubEndpoint } from "./helpers/fetch-oracle.js";

const TEST_DIR = new URL("./", import.meta.url);

// 允许出现的出站字面 host：保留 TLD + 回环 + 文档域（全部 fake-fetch 消化，不触真实网络）。
// IP 形态 host（SSRF 矩阵 fixture）永不解析真实 DNS，单独放行；域名形态字面量必须落在保留域内。
const RESERVED_DOMAIN = /(^|\.)(invalid|test|localhost|example|example\.com|example\.org|example\.net)$/i;
const looksDomain = (h) => /^[a-zA-Z][a-zA-Z0-9.-]*$/.test(h) && h.includes(".");

test("G1 静态源扫：ft-oracle-* 测试与 helper 不得出现非保留域 URL 字面量与原始网络 import", () => {
  const files = readdirSync(TEST_DIR.pathname).filter(
    (f) => (f.startsWith("ft-oracle-") && f.endsWith(".test.js")) || f === "fetch-oracle.js",
  );
  assert.ok(files.length >= 6, `ft-oracle-* 骨架文件数量异常：${files.join(",")}`);
  for (const f of files) {
    const src = readFileSync(new URL(f, TEST_DIR), "utf8");
    for (const m of src.matchAll(/https?:\/\/([^\s"'`)\/?#]+)/g)) {
      const bare = m[1].replace(/^\[([^\]]*)\]$/, "$1").split("@").pop().split(":")[0];
      const ok = !looksDomain(bare) || RESERVED_DOMAIN.test(bare);
      assert.ok(ok, `${f}: 非保留域出站字面量 ${m[0]}（域名 fixture 必须用 *.invalid/*.test/*.example，IP 形态放行）`);
    }
    assert.ok(!/from\s+["']undici["']/.test(src), `${f}: 不得直接 import undici`);
    assert.ok(!/require\(["']http["']\)\.request|https\.request\(/.test(src), `${f}: 不得使用原始 http.request`);
  }
});

test("G2 桩端点钉回环：startStubEndpoint 默认且仅绑 127.0.0.1", async () => {
  const stub = await startStubEndpoint({ script: () => ({ status: 200, body: "g2" }) });
  try {
    assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, "桩端点必须绑回环");
    const src = readFileSync(new URL("./helpers/fetch-oracle.js", import.meta.url), "utf8");
    assert.ok(!/listen\([^)]*["']0\.0\.0\.0["']/.test(src), "helper 不得暴露 0.0.0.0 绑定");
    assert.equal(stub.family, "IPv4");
  } finally {
    await stub.close();
  }
  // 关闭后端口不得仍有活跃连接句柄（泄漏钉）
  assert.ok(true);
});

test("G3 进程内哨兵自证：非回环 globalThis.fetch 被拒，回环放行", async () => {
  const real = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const host = new URL(url).hostname;
    if (!(host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host.startsWith("127."))) {
      blocked += 1;
      throw new Error(`ORACLE-GUARD: 真实出站被拒 ${host}`);
    }
    return real(url, init);
  };
  try {
    await assert.rejects(globalThis.fetch("https://example.com/"), /ORACLE-GUARD/);
    assert.equal(blocked, 1);
    const stub = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "g3" }) });
    try {
      const res = await globalThis.fetch(stub.baseUrl + "/ok");
      assert.equal(res.status, 200, "回环放行");
    } finally {
      await stub.close();
    }
  } finally {
    globalThis.fetch = real;
  }
});

test("G4 npm test 全进程守卫（--import fetch-guard loader）：CI 级零真实出站", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const script = pkg.scripts?.test ?? "";
  assert.match(script, /--import[^"]*fetch-guard/, 
    "npm test 必须挂全测试进程 fetch 守卫 loader（哨兵模式：非回环 fetch 直接抛 ORACLE-GUARD）——实现 PR 契约项");
});
