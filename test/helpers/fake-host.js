// dsh 宿主 API 替身（node:test 层，绝不含真实网络/profile 访问）。
// 复刻 dsh `web` 服务与插件生命周期在 WP0 条款验收中可观察的行为：
//   - web.registerSearchProvider：同 id 重复注册抛 WEB_DUPLICATE_PROVIDER（inspect 实证语义），
//     返回同步 () => void 反注册函数；反注册再注册 = 重新装载路径。
//   - web.registerFetchProvider / web.search / web.fetch / tools.register：陷阱计数。
//     DSH-001「只注册搜索 provider」与 设计决定「不得经 ctx.web.search 回流」用这些计数断言为零。
//   - configEditor + fiber.entry（configuration.md 实证）：插件保存自身配置的唯一入口；
//     支持注入保存失败（SET-004/CFG-004：失败后已生效快照保持一致）。
//   - ctx.effect/ctx.on/ctx.get + fakeHost.disposeAll()：模拟装载→卸载生命周期（DSH-001 release）。
import { createFakeCredentials } from "./fake-credentials.js";

function webError(code, message) {
  const err = new Error(message);
  err.name = "WebError";
  err.code = code;
  return err;
}

/**
 * @param {{
 *   entry?: { id?: string, name?: string },            // 插件配置行（cordis.patch.yml 装载产物）
 *   config?: Record<string, any>,                       // 行初始 config
 *   credentials?: any,                                  // 默认 createFakeCredentials()
 *   validate?: (candidate: any) => void,                // 模拟宿主 Config 校验（抛错=保存拒绝）
 * }} [opts]
 */
export function createFakeHost(opts = {}) {
  const entry = { id: "search-chain", name: "dsh-search-chain", ...opts.entry };
  const services = {
    credentials: opts.credentials ?? createFakeCredentials(),
  };

  // —— web 服务 ——
  const searchProviders = new Map(); // id → { provider, disposedCount }
  const disposalCounts = new Map(); // id → 累计反注册次数（跨装载周期）
  const traps = {
    fetchProviderRegistrations: 0,
    webSearch: 0,
    webSearchReady: 0,
    webFetch: 0,
    toolRegistrations: 0,
  };
  services.web = {
    registerSearchProvider(provider) {
      if (typeof provider?.id !== "string" || provider.id.length === 0) {
        throw webError("WEB_INVALID_PROVIDER", "provider.id 必须是非空字符串");
      }
      if (searchProviders.has(provider.id)) {
        throw webError("WEB_DUPLICATE_PROVIDER", `搜索 provider ${provider.id} 已注册`);
      }
      const rec = { provider, disposedCount: 0 };
      searchProviders.set(provider.id, rec);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        rec.disposedCount += 1;
        disposalCounts.set(provider.id, (disposalCounts.get(provider.id) ?? 0) + 1);
        if (searchProviders.get(provider.id) === rec) searchProviders.delete(provider.id);
      };
    },
    registerFetchProvider() {
      traps.fetchProviderRegistrations += 1;
      return () => {};
    },
    async search() {
      traps.webSearch += 1;
      throw webError("HOST_TRIPWIRE", "插件不得经 ctx.web.search 发起搜索（会选回自身，见 dsh-integration 设计决定）");
    },
    async searchReady() {
      traps.webSearchReady += 1;
      return true;
    },
    async fetch() {
      traps.webFetch += 1;
      throw webError("HOST_TRIPWIRE", "本插件不涉及抓取路径");
    },
    listProviders() {
      return {
        search: [...searchProviders.keys()].map((id) => ({ id })),
        fetch: [],
      };
    },
  };

  services.tools = {
    register(definition) {
      traps.toolRegistrations += 1;
      traps.lastTool = definition?.name ?? "(anonymous)";
      return () => {};
    },
  };

  // —— 配置编辑（插件保存自身配置的唯一入口）——
  let saved = structuredClone(opts.config ?? {});
  const editorCalls = [];
  const editor = {
    calls: editorCalls,
    failNext: null, // 注入保存失败：Error 实例；消费一次后清空
    saved: () => saved,
    async edit(target, change) {
      editorCalls.push({ target, at: editorCalls.length });
      if (editor.failNext) {
        const err = editor.failNext;
        editor.failNext = null;
        throw err; // 保存失败：已生效快照保持不变（CFG-004/SET-004）
      }
      const current = structuredClone(saved);
      const candidate = await change(current);
      if (opts.validate) opts.validate(candidate); // 抛错 = 宿主拒绝，保存不生效
      saved = candidate;
    },
  };
  services.configEditor = editor;
  services.fiber = entry;

  // —— 生命周期 ——
  const effects = [];
  const eventListeners = [];
  const ctx = {
    get web() {
      return services.web;
    },
    get tools() {
      return services.tools;
    },
    get configEditor() {
      return editor;
    },
    get fiber() {
      return entry;
    },
    get(name) {
      return services[name];
    },
    effect(fn) {
      const cleanup = fn();
      effects.push(typeof cleanup === "function" ? cleanup : null);
      return cleanup;
    },
    on(name, handler) {
      eventListeners.push({ name, handler });
      return () => {};
    },
  };

  return {
    ctx,
    services,
    credentials: services.credentials,
    /** 当前在注册的搜索 provider 数组（按注册顺序）。 */
    searchRegistrations: () => [...searchProviders.values()].map((r) => r.provider),
    searchRegistrationCount: () => searchProviders.size,
    providerIds: () => [...searchProviders.keys()],
    /** 某 id 被反注册的累计次数（跨装载周期的卸载检查）。 */
    disposedCount: (id) => disposalCounts.get(id) ?? 0,
    traps,
    editor,
    entry,
    /** A4 配置端口：readConfig/writeConfig(settings) 消费的最小面。 */
    get settingsPort() {
      return { editor, entry, current: () => structuredClone(saved) };
    },
    /** 模拟卸载/停用：按登记逆序执行全部 effect cleanup（宿主语义级近似，可观察即可）。 */
    async disposeAll() {
      while (effects.length) {
        const cleanup = effects.pop();
        if (cleanup) await cleanup();
      }
    },
  };
}
