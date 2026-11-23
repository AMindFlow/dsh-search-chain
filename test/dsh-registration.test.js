// WP0 验收 — DSH-001 注册与退出 / DSH-003 安装只注册。
// 覆盖条款：
//   DSH-001：装载后经 ctx.web.registerSearchProvider 注册唯一 provider（id=search-chain）；
//            只注册搜索 provider（不注册 fetch provider/工具）；卸载反注册并 release；
//            重复装载（反注册后再注册路径）不产生双注册——宿主重复 id 抛 WEB_DUPLICATE_PROVIDER。
//   DSH-003：安装只完成注册；不写宿主设置（web.searchProvider 由用户选择）、不自动发起搜索、
//            不自动保存配置。配置行声明（cordis.patch.yml id: search-chain）做静态核对。
//   DSH-004：真实宿主端到端——不在 node:test 范围，见最终报告宿主核对项。
// 实现方（WP6）不得删断言/改 skip 使其通过；契约见 helpers/contract.js A1/A4。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "./helpers/contract.js";
import { createFakeHost } from "./helpers/fake-host.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP6 src/index.js";

function stubChain() {
  return {
    calls: [],
    released: 0,
    async search(request, signal) {
      this.calls.push({ request, signal });
      return { sources: C.makeSources(1), truncated: false };
    },
    release() {
      this.released += 1;
    },
  };
}

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "DSH-001/DSH-003")) return null;
  return res.module;
}

test("DSH-001/DSH-003：apply 注册唯一 search-chain provider，且不越界注册", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  assert.equal(mod.PROVIDER_ID, C.PROVIDER_ID, "index.js 必须导出 PROVIDER_ID=search-chain（A4）");
  assert.ok(mod.Config, "index.js 必须导出 Config 行 schema（A4）");

  const host = createFakeHost({ config: C.makeSavedConfig([]) });
  const chain = stubChain();
  await Promise.resolve(mod.apply(host.ctx, host.editor.saved(), { chain }));

  assert.equal(host.searchRegistrationCount(), 1, "装载后恰好一个搜索 provider（DSH-001）");
  assert.deepEqual(host.providerIds(), [C.PROVIDER_ID]);
  const provider = host.searchRegistrations()[0];
  assert.equal(provider.id, C.PROVIDER_ID);
  assert.equal(typeof provider.search, "function");
  assert.equal(typeof provider.available, "function");

  // 只注册搜索 provider（DSH-001）；不回流宿主搜索 seam（dsh-integration 设计决定）
  assert.equal(host.traps.fetchProviderRegistrations, 0, "不得注册 fetch provider");
  assert.equal(host.traps.toolRegistrations, 0, "不得注册工具");
  assert.equal(host.traps.webSearch, 0);
  // DSH-003：安装=注册。不自动保存、不写行外设置、不发搜索
  assert.equal(host.editor.calls.length, 0, "装载不得自动改写已保存配置");
});

test("DSH-001：卸载 = 反注册 + release；重新装载只保留单一注册", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  // 第一个装载周期
  const hostA = createFakeHost({ config: C.makeSavedConfig([]) });
  const chainA = stubChain();
  await Promise.resolve(mod.apply(hostA.ctx, hostA.editor.saved(), { chain: chainA }));
  await hostA.disposeAll();
  assert.equal(hostA.searchRegistrationCount(), 0, "卸载后注册表必须清空（DSH-001）");
  assert.equal(hostA.disposedCount(C.PROVIDER_ID), 1, "必须执行反注册，而非仅丢弃引用");
  assert.ok(chainA.released >= 1, "卸载必须释放链资源 release()（DSH-001/FB-003 连接释放）");

  // 重新装载（reload 路径）：新宿主实例 = 反注册后再注册
  const hostB = createFakeHost({ config: C.makeSavedConfig([]) });
  const chainB = stubChain();
  await Promise.resolve(mod.apply(hostB.ctx, hostB.editor.saved(), { chain: chainB }));
  assert.equal(hostB.searchRegistrationCount(), 1, "重载后仍是单一注册，无残留（DSH-001）");
  assert.equal(hostB.disposedCount(C.PROVIDER_ID), 0);
  assert.equal(chainB.released, 0);
});

test("DSH-001：未反注册就二次注册不得造成双注册（宿主 WEB_DUPLICATE_PROVIDER 语义）", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  const host = createFakeHost({ config: C.makeSavedConfig([]) });
  const chain1 = stubChain();
  const chain2 = stubChain();
  await Promise.resolve(mod.apply(host.ctx, host.editor.saved(), { chain: chain1 }));
  const first = host.searchRegistrations()[0];

  let threw = null;
  try {
    await Promise.resolve(mod.apply(host.ctx, host.editor.saved(), { chain: chain2 }));
  } catch (e) {
    threw = e;
  }
  // 允许两种正确结局：原样抛出宿主的重复注册错误，或不抛但保持单注册；
  // 绝不允许出现两个同 id 注册或把第一个注册弄丢。
  if (threw) {
    assert.equal(threw.name, "WebError");
    assert.equal(threw.code, "WEB_DUPLICATE_PROVIDER", "重复注册必须原样暴露宿主语义，不得吞错换注册");
  }
  assert.equal(host.searchRegistrationCount(), 1, "任何结局下都不得双注册（DSH-001）");
  assert.equal(host.searchRegistrations()[0], first, "既有注册不得被第二次 apply 悄悄替换");
});

test("DSH-001/DSH-003 配套：配置行声明存在且 id=search-chain（cordis.patch.yml 静态核对）", async (t) => {
  await load(t); // 与实现同批交付；src 缺失同样红
  let text;
  try {
    text = readFileSync(new URL("../src/cordis.patch.yml", import.meta.url), "utf8");
  } catch {
    t.diagnostic("[WP0 oracle] 等待 WP6：src/cordis.patch.yml 配置行声明（id: search-chain）");
    t.fail("src/cordis.patch.yml 缺失：DSH-001 要求插件声明配置行（模块不存在即红，勿改 skip）");
    return;
  }
  assert.match(text, /^\s*-?\s*id:\s*search-chain\s*$/m, "配置行 id 必须为 search-chain");
  assert.match(text, /dsh-search-chain/, "配置行归属 bundle dsh-search-chain");
});
