// WP6 装配面（assembly）测试台——本 WP oracle 自建，只引用 main 的共享 helper（contract /
// fake-host / impl / clock），不改任何共享文件（铁律）。
//
// 职责：
//   1. hostApply(mod, cfg, testDeps, hostOpts)：真实宿主形态（createHostShapeFakeHost）+ 真实
//      src/index.js apply 的最小装配；provider 直接取自注册表（黑盒）。
//   2. withRowRemoval(host, rowId, removed)：运行时「行移除」面。共享 fake-host 的行集合在创建后
//      固定，无法模拟宿主行被移除/卸载（#12 清单 18、B1′ 需要该面）；此函数以宿主管线等价方式
//      覆写 editor.configuration() 的行集合（行移除 = 行不在 configuration() 中）。
//   3. countConfigReads(host)：给 editor.configuration() 计数——#12 清单 12「一次操作内快照」
//      的记录面（只记录不钉死次数；该条在清单中为「记录，非阻塞」）。
//   4. hermeticEnvKeys(t)：测试期间清除 TRUSTED_ENV_KEYS 全部环境变量（WP5 链的 CFG-002 env 层），
//      保证「缺 key」类断言不受本机环境串扰；t.after 恢复原值。
import * as C from "./contract.js";
import { createHostShapeFakeHost } from "./fake-host.js";

/**
 * @param {object} mod src/index.js 模块
 * @param {object} cfg 行初始 config（装载基线，inherited 层）
 * @param {object} [testDeps] 第三参注入面（A4：{ chain, official, officialRouteId, routeOf, ... }）
 * @param {Parameters<typeof createHostShapeFakeHost>[0]} [hostOpts] 宿主替身其余参数（extraRows 等）
 */
export function hostApply(mod, cfg, testDeps, hostOpts = {}) {
  const host = createHostShapeFakeHost({ ...hostOpts, config: structuredClone(cfg ?? {}) });
  const cleanup = mod.apply(host.ctx, structuredClone(cfg ?? {}), testDeps ?? {});
  return { host, cleanup, provider: host.searchRegistrations()[0] };
}

/** 官方 web-search-deepseek 行的默认合成配置（指向 RFC 2606 保留域，零真实网络）。 */
export function makeOfficialRowConfig(overrides = {}) {
  return {
    baseURL: "https://row.invalid/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    ...overrides,
  };
}

/**
 * 运行时行移除（宿主行被卸载/移除的等价面）。
 * @param {ReturnType<typeof createHostShapeFakeHost>} host
 * @param {string} rowId 行裸 id（options.id）；"own" 表示本插件行（search-chain）。
 * @param {boolean} removed 默认 true；false = 恢复（还原覆写）。
 */
export function withRowRemoval(host, rowId, removed = true) {
  if (host.__rowRemovalPatched !== true) {
    const original = host.editor.configuration.bind(host.editor);
    host.__originalConfiguration = original;
    host.editor.configuration = () => {
      const rows = host.__originalConfiguration();
      if (!host.__removeRowId) return rows;
      return rows.filter(
        (r) =>
          !(host.__removeRowId === "own"
            ? r.entry === host.entry
            : r.entry?.options?.id === host.__removeRowId),
      );
    };
    host.__rowRemovalPatched = true;
  }
  host.__removeRowId = removed ? rowId : undefined;
  return host;
}

/** 配置读取计数（#12-12 记录面）。返回 { reads, reset() }。 */
export function countConfigReads(host) {
  if (host.__readCountPatched !== true) {
    const original = host.editor.configuration.bind(host.editor);
    let n = 0;
    host.editor.configuration = () => {
      n += 1;
      return original();
    };
    host.__readCountPatched = true;
    host.__configReadCount = () => n;
    host.__resetConfigReadCount = () => {
      n = 0;
    };
  }
  host.__resetConfigReadCount();
  return { reads: host.__configReadCount.bind(host), reset: host.__resetConfigReadCount.bind(host) };
}

/** 清除 CFG-002 白名单环境变量（本机串扰隔离）；t.after 恢复。 */
export function hermeticEnvKeys(t) {
  const saved = {};
  for (const key of C.TRUSTED_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** 造一条合成 WebError（A7 形状，装配层终态/官方错误用）。 */
export function makeWebError(code, message, attempts = []) {
  const err = new Error(message);
  err.name = "WebError";
  err.code = code;
  err.details = { attempts };
  return err;
}
