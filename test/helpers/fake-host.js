// dsh 宿主 API 替身（node:test 层，绝不含真实网络/profile 访问）。
// 复刻 dsh `web` 服务与插件生命周期在 WP0 条款验收中可观察的行为：
//   - web.registerSearchProvider：同 id 重复注册抛 WEB_DUPLICATE_PROVIDER（inspect 实证语义），
//     返回同步 () => void 反注册函数；反注册再注册 = 重新装载路径。
//   - web.registerFetchProvider / web.search / web.fetch / tools.register：陷阱计数。
//     DSH-001「只注册搜索 provider」与 设计决定「不得经 ctx.web.search 回流」用这些计数断言为零。
//   - configEditor + Entry/Fiber（configuration.md + PR#14 复审宿主实证）：
//       * Entry 对象：entry.options.id 为裸 id；entry.id 是带父路径前缀的 getter（include:<id>）；
//         Entry 携带 fiber。Fiber 无 id 属性，只有 uid（+entry）。
//       * editor.edit(target, change) 复刻宿主两重闸（探针实证）：
//         ① 首行身份校验：target 必须是当前 entries() 内的 Entry 且 target.fiber !== undefined，
//            否则抛 "Configuration entry is no longer available"（「把 ctx.fiber 当写入目标」的
//            接线（旧 B3）在宿主上必拒，本替身同样必拒）。
//         ② change 必须是变异函数 (raw, inherited) => newRawLayer（非对象第二参 →
//            TypeError("change is not a function")）。raw/inherited 深拷贝传入（改动输入不落存储）；
//            返回的新 raw 层【整体替换】该行自身层（override），非对象返回抛 TypeError。
//       * 宿主形态（hostShape，经 createHostShapeFakeHost）：configEditor.configuration() 返回行数组
//         [{entry, inherited, override}]（asar TS 声明终审：entry 与 fiber.entry 同一对象；
//         有效配置 = inherited ⊕ override；行集合【不含 saved()】）；编辑器不再暴露 saved()。
//         保存写入 override，configuration() 每次现读——下一次读取即新有效值（CFG-004）。
//         旧默认形态保留（含 editor.saved()），仅供既有纯 config 面测试使用。
//   - configEditor 支持注入保存失败（SET-004/CFG-004：失败后已生效快照保持一致）。
//   - ctx.effect/ctx.on/ctx.get + fakeHost.disposeAll()：模拟装载→卸载生命周期（DSH-001 release）。
//   - inject 收敛（P1-5，实机 P0 根因）：宿主只注入被测模块 inject 列表声明过的服务。
//     createFakeHost 按 opts.inject（调用方传入被测模块的 inject，或由 hostApply 读 mod.inject）挂载：
//     未声明的服务不挂载——ctx.get(name)、ctx.web/ctx.tools/ctx.configEditor 访问器、返回值
//     credentials 句柄一律 undefined。此前替身无条件全量挂载，掩盖「inject 漏声明 → 真宿主上
//     ctx.get("credentials") 恒 undefined」一类缺陷（WP13 实机 P0）。默认（不传 inject）= 零挂载，
//     强制调用方显式声明被测面；ctx.effect/ctx.on/ctx.fiber 与返回对象上的测试观测面
//     （editor/entry/configuration/settingsPort/traps/…）是宿主结构/替身自身面，不经 inject。
import { createFakeCredentials } from "./fake-credentials.js";

function webError(code, message) {
  const err = new Error(message);
  err.name = "WebError";
  err.code = code;
  return err;
}

/** 宿主实证 Entry 形态：裸 id 在 options.id；顶层 id 是带前缀的 getter；携带 fiber。 */
function makeEntryForm(id, name, fiberUid) {
  const entry = {
    name,
    options: { id },
    uid: `entry-uid-${fiberUid}`,
    get id() {
      return `include:${this.options.id}`;
    },
    fiber: undefined,
  };
  // 宿主 Fiber：无 id 属性，只有 uid（+entry）。曾有替身把 Fiber 当 Entry（有 id）用，掩盖 B3。
  const fiber = { uid: `fiber-uid-${fiberUid}`, entry };
  entry.fiber = fiber;
  return { entry, fiber };
}

/**
 * @param {{
 *   inject?: string[],                                  // 被测模块声明的宿主服务面（如 src/index.js 的 export const inject）；
 *                                                       //   只挂载列表内的服务，越界 ctx.get → undefined（P1-5）；缺省 = 零挂载
 *   entry?: { id?: string, name?: string },            // 插件配置行（cordis.patch.yml 装载产物）
 *   config?: Record<string, any>,                       // 行初始 config
 *   credentials?: any,                                  // inject 含 credentials 时的服务体，默认 createFakeCredentials()
 *   validate?: (candidate: any) => void,                // 模拟宿主 Config 校验（抛错=保存拒绝）
 *   configSchema?: any,                                 // 运行时 Config（Standard Schema）：change 返回后、落盘前
 *                                                       //   过 ["~standard"].validate（宿主 resolveConfig 时序）
 *   hostShape?: boolean,                                // true：宿主形态 configuration()，无 editor.saved()
 *   extraRows?: Array<{ entryId: string, config: Record<string, any> }>, // 宿主形态：其它挂载行
 * }} [opts]
 */
export function createFakeHost(opts = {}) {
  if (opts.inject !== undefined && !Array.isArray(opts.inject)) {
    throw new TypeError("createFakeHost：opts.inject 必须是字符串数组（被测模块的宿主服务声明）");
  }
  // P1-5 inject 收敛：真宿主只注入模块 inject 声明的服务（WP13 实机 P0 根因）。
  // 缺省零挂载——用哪个声明哪个，忘记声明的调用方立刻红，而不是被全量挂载掩盖。
  const declared = new Set(opts.inject ?? []);
  const hostShape = opts.hostShape === true;
  const { entry, fiber } = makeEntryForm(
    opts.entry?.id ?? "search-chain",
    opts.entry?.name ?? "dsh-search-chain",
    "search-chain",
  );
  const services = {};
  // 服务体照常构建（观测面/注册表恒可用），但只把 inject 声明过的挂进 services——
  // ctx 访问器与 ctx.get 统一查 services，未声明即 undefined（越界）。
  const credentialsImpl = opts.credentials ?? createFakeCredentials();
  if (declared.has("credentials")) services.credentials = credentialsImpl;

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
  // web 服务体恒构建（注册表/traps 是测试观测面的载体）；是否挂到 ctx 由 inject 决定。
  const webImpl = {
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
  if (declared.has("web")) services.web = webImpl;

  const toolsImpl = {
    register(definition) {
      traps.toolRegistrations += 1;
      traps.lastTool = definition?.name ?? "(anonymous)";
      return () => {};
    },
  };
  if (declared.has("tools")) services.tools = toolsImpl;

  // —— 配置编辑（插件保存自身配置的唯一入口）——
  let saved = structuredClone(opts.config ?? {});
  const editorCalls = [];
  // 宿主形态分层（终审行形状）：inherited=装载基线（不随保存变），override=本次及以后保存值；
  // 有效配置 = {...inherited, ...override}。旧形态仍用单层 saved。
  const inheritedBaseline = structuredClone(opts.config ?? {});
  const overrideByEntry = new Map(); // 宿主形态：每行自身层（override），edit 返回的新 raw 整体替换之
  // 宿主形态的其它挂载行（如官方 web-search-deepseek）：行 entry 也是宿主形态 Entry；
  // opts.extraRows[].config 作为该行的 inherited 层装载。
  const extraRows = (opts.extraRows ?? []).map((r, i) => {
    const row = makeEntryForm(r.entryId, r.entryId, `extra-${i}-${r.entryId}`);
    return { entry: row.entry, inherited: structuredClone(r.config ?? {}), override: {} };
  });
  overrideByEntry.set(entry, {});
  for (const r of extraRows) overrideByEntry.set(r.entry, {});
  const configuration = () => [
    {
      entry,
      inherited: structuredClone(inheritedBaseline),
      override: structuredClone(overrideByEntry.get(entry)), // 活层：保存后下一次读取即新有效值（CFG-004）
    },
    ...extraRows.map((r) => ({
      entry: r.entry,
      inherited: structuredClone(r.inherited),
      override: structuredClone(overrideByEntry.get(r.entry)),
    })),
  ];
  const entries = () => [entry, ...extraRows.map((r) => r.entry)];
  const editor = {
    calls: editorCalls,
    failNext: null, // 注入保存失败：Error 实例；消费一次后清空
    entries,
    // 宿主首行身份校验：目标必须仍是当前挂载的 Entry 且携带 fiber（Fiber 无 fiber 属性 → 拒）。
    async edit(target, change) {
      if (!entries().includes(target) || target.fiber === undefined) {
        throw new Error("Configuration entry is no longer available");
      }
      // 探针实证原文：edit(entry, {config}) → 「change is not a function」。
      if (typeof change !== "function") {
        throw new TypeError("change is not a function");
      }
      const rawLayer = hostShape ? overrideByEntry.get(target) : saved;
      const inheritedLayer = hostShape
        ? (target === entry ? inheritedBaseline : extraRows.find((r) => r.entry === target).inherited)
        : {};
      editorCalls.push({ target, at: editorCalls.length });
      if (editor.failNext) {
        const err = editor.failNext;
        editor.failNext = null;
        throw err; // 保存失败：已生效快照保持不变（CFG-004/SET-004）
      }
      // 深拷贝传入：change 内对 raw/inherited 的原地改动不得泄漏回存储。
      const next = await change(structuredClone(rawLayer), structuredClone(inheritedLayer));
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new TypeError("change 必须返回新 raw 层整体对象（宿主变异函数语义）");
      }
      // 宿主时序（asar 实证）：resolveConfig 在 change 返回后、落盘前跑 runtime Config 的
      // ["~standard"].validate；issues 即抛（宿主 ValidationError 等价）——保存不生效。
      if (opts.configSchema) {
        const vr = opts.configSchema["~standard"].validate(next);
        if (vr.issues) {
          throw new Error(
            "Configuration validation failed: " + vr.issues.map((i) => i.message).join("; "),
          );
        }
      }
      if (opts.validate) opts.validate(next); // 抛错 = 宿主拒绝，保存不生效
      if (hostShape) overrideByEntry.set(target, next); // 整体替换该行自身层；inherited 不动
      else saved = next;
    },
  };
  if (hostShape) {
    // 宿主实证形态：活配置的唯一读取面是 configuration()（行 {entry, inherited, override}）；不暴露 saved()。
    editor.configuration = configuration;
  } else {
    // 旧默认形态保留：仅供既有纯 config 面测试与断言 saved() 的自测使用。
    editor.saved = () => saved;
  }
  if (declared.has("configEditor")) services.configEditor = editor;
  // fiber 是宿主注入的装载结构（ctx.fiber 恒可得）；仅当被测模块显式把 fiber 列入 inject 时
  // 才同时经 ctx.get("fiber") 可达——真宿主没有这个服务名，声明它没有意义，收敛后默认拿不到。
  if (declared.has("fiber")) services.fiber = fiber;

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
      // 经 inject 挂载面取用（未声明 = undefined）；editor 测试观测面恒在返回对象上，不在此旁路。
      return services.configEditor;
    },
    get fiber() {
      // 装载结构非注入服务：ctx.fiber 恒可得（index.js 的 inject 不含 fiber 也依赖它）。
      return fiber;
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
    fiber,
    /** 宿主形态才有的活行数组便捷面（等价 editor.configuration()）。 */
    configuration: hostShape ? () => editor.configuration() : undefined,
    /**
     * A4 配置端口：readConfig/writeConfig(settings) 消费的最小面。
     * 接线语义（PR#14 B1 教训）：current() 读【活配置】——宿主语义是保存后下一次读取即新配置
     * （CFG-004「后续保存只影响下一次查询」）。生产 src/index.js 的 apply 内 settings.current 必须同样
     * 读实时宿主配置；若绑死 apply 装载入参 config（装载快照永不更新），本替身无法代查该缺陷——
     * 生产形状甄别测试见 dsh-official-routing.test.js 尾部（真实 apply + 真实 writeConfig 接线）。
     * 宿主形态下 current() 经由 configuration() 的行读取本行（没有 saved() 捷径可走）。
     */
    get settingsPort() {
      if (hostShape) {
        return {
          editor,
          entry,
          current: () => {
            const row = editor.configuration().find((r) => r.entry === entry);
            if (!row) throw new Error("own configuration row missing");
            return { ...row.inherited, ...row.override }; // 有效值 = 分层合并（终审语义）
          },
        };
      }
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

/**
 * 宿主形态替身（asar TS 声明终审语义）：configEditor.configuration() 返回
 * [{entry, inherited, override}] 行数组（有效值 = inherited ⊕ override；
 * entry.options.id 裸 id；entry.id 前缀 getter；Fiber 无 id 只有 uid），行集合不含 saved()，
 * editor.edit 带宿主身份校验。生产接线甄别测试必须用本形态。
 * @param {Parameters<typeof createFakeHost>[0] & { extraRows?: Array<{ entryId: string, config: any }> }} [opts]
 */
export function createHostShapeFakeHost(opts = {}) {
  return createFakeHost({ ...opts, hostShape: true });
}
