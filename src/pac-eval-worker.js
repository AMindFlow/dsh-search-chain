// PAC 沙箱求值子进程 worker（单发即退，ESM）。
//
// 威胁模型与边界设计（工单 5，Refs #58）：
//  - PAC 脚本来自远端配置（可能恶意、被攻陷或被劫持）。
//  - 受支持运行时（含 DSH 内嵌 Electron 44.7 / Node 24.21.0）上，accessor getter 触发的全局读取
//    （如 FindProxyForURL 或 __pacHost 的死循环 getter）完全不响应 node:vm 的 synchronous timeout，
//    会在进程内永久挂死事件循环。
//  - 因此求值必须移入可独立终止的子进程边界：父进程通过 wall deadline（PAC_EVAL_WALL_LIMIT_MS）
//    与看门狗兜底强杀挂死 worker；子进程内的 vm 沙箱与 PAC_EVAL_CPU_LIMIT_MS（500ms）作为纵深防御
//    保留——普通死循环由子内 vm timeout 快速失败，getter 类死循环则由父进程在边界外强杀。
//  - 全局代理继承面（工单 6，codex P2 @d1509e8）：vm context 内的 globalThis（全局代理）是宿主 realm
//    对象，其继承自宿主 Object.prototype 的成员（constructor / toString / valueOf / hasOwnProperty /
//    propertyIsEnumerable 等）会泄漏宿主 realm 函数，从而通过 .constructor 拿到宿主 Function 绕过
//    codeGeneration:{strings:false}。在沙箱 realm 内先执行 PAC_SEAL_SCRIPT 对有界闭集成员做不可配置/
//    不可写的自有属性遮蔽（值取沙箱 realm 自身 Object.prototype 成员），再执行 PAC_CANARY_SCRIPT
//    逐 context 实测逃逸探针，未通过则以 "E" fail-closed 退出。此机制为 Node 官方「vm 不是安全边界」
//    立场下的纵深防御，最终安全边界仍是子进程 + SIGKILL。
//  - 指令长度边界与 IPC 协议（工单 8，codex finding 4715638124 @85ae033）：
//    PAC 可通过 String.repeat 在运行时生成超大返回值绕过 2 MiB 下载闸经 IPC 放大父进程内存。
//    worker 返回前对指令长度设硬上限 PAC_DIRECTIVE_MAX_LEN = 4096（合法 `PROXY host:port; …` 列表
//    绰绰有余，超限整个指令判无效），在 vm 调用器内即拦截为哨兵 "L"，不构造成串也不跨 IPC 回传。
//    完整单字符前缀协议（outcome）：
//      "E" -> 沙箱密封/金丝雀自检未通过；"P" -> 脚本解析/顶层执行失败；"N" -> 缺少 FindProxyForURL；
//      "R" -> 调用期抛错或超时；"T" -> 返回值非 string；"L" -> 返回指令超 4096 字符上限；
//      "S" + directive -> 长度 ≤ 4096 的指令文本。
//  - stdio 由父进程设为 ignore，本 worker 不向 stdout/stderr 写入任何脚本或 URL 内容。

import vm from "node:vm";

/** 沙箱内每段同步求值的 CPU 护栏（毫秒）：普通死循环在此快速失败，不拖满墙上时钟上限。 */
const PAC_EVAL_CPU_LIMIT_MS = 500;
/** FindProxyForURL 返回指令文本的长度上限（合法 `PROXY host:port; …` 列表 4096 字符绰绰有余，超限整条判无效）。 */
const PAC_DIRECTIVE_MAX_LEN = 4096;

// ── 全局代理密封与逐次求值金丝雀（工单 6，纵深防御）─────────────────────────────
// value 取沙箱 realm 自身的 Object.prototype 成员本身：语义对合法 PAC 零变化，调用链路落回
// 沙箱 realm 后被 codeGeneration:{strings:false} 掐死；configurable:false/writable:false
// 使不受信脚本无法解封。这是 Node 官方「vm 不是安全边界」立场下的纵深防御，最终边界仍是子进程 + kill。
const PAC_SEAL_SCRIPT = new vm.Script(`(function () {
  var names = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
    "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__defineSetter__",
    "__lookupGetter__", "__lookupSetter__"];
  for (var i = 0; i < names.length; i++) {
    try {
      Object.defineProperty(globalThis, names[i], {
        value: Object.prototype[names[i]],
        writable: false, configurable: false, enumerable: false,
      });
    } catch (e) { /* 单个失败交给 canary 兜底 fail-closed */ }
  }
  try {
    // 访问器对方案错误：Object.prototype.__proto__ 的 realm getter 在 globalThis 上返回的是
    // 全局代理的真实原型（宿主原型链），遮蔽等于没断链。改用自有数据属性直接指向沙箱 realm 的
    // Object.prototype，使 g.__proto__.constructor → realm Object → .constructor → realm Function → EvalError。
    Object.defineProperty(globalThis, "__proto__", {
      value: Object.prototype,
      writable: false, configurable: false, enumerable: false,
    });
  } catch (e) {}
  // 用户裁定 64 MiB 池与外部内存类（ArrayBuffer/SharedArrayBuffer/TypedArray/DataView/TextEncoder/Atomics）
  // 不属 PAC 规范（Netscape/D4.0 仅需字符串与判等函数），在 globalThis 封为不可写/不可配置的 undefined，
  // 切断外部内存分配入口；JSON.parse/字符串等堆内分配仍受 24 MiB 老生代堆帽管辖。
  var extMemNames = [
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "TextEncoder",
    "Int8Array", "Uint8Array", "Uint8ClampedArray",
    "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Atomics"
  ];
  if (typeof Float16Array !== "undefined") extMemNames.push("Float16Array");
  for (var j = 0; j < extMemNames.length; j++) {
    try {
      Object.defineProperty(globalThis, extMemNames[j], {
        value: undefined,
        writable: false, configurable: false, enumerable: false,
      });
    } catch (e) { /* 单个失败交给 canary 兜底 fail-closed */ }
  }
})()`, { filename: "pac-seal.js" });

// 每次求值、密封之后、任何用户代码与 prelude 之前在当前 context 实测逃逸通道，而非信任平台假设。
// 教训：canary 必须测「链的可达闭包」而非链的头几跳——任何一条通往宿主 realm 的链都要测到「能构造代码」那一步。
const PAC_CANARY_SCRIPT = new vm.Script(`(function () {
  var g = globalThis;
  function bad(f) { try { var v = f(); return !!(v && v.versions && v.versions.node); } catch (e) { return false; } }
  var holes = 0;
  if (bad(function () { return g.constructor.constructor("return process")(); })) holes++;
  if (bad(function () { return constructor("return process")(); })) holes++; // 裸标识符走全局属性
  if (bad(function () { return g.toString.constructor("return process")(); })) holes++;
  if (bad(function () { return g.valueOf.constructor("return process")(); })) holes++;
  if (bad(function () { return g.hasOwnProperty.constructor("return process")(); })) holes++;
  if (bad(function () { return g.propertyIsEnumerable.constructor("return process")(); })) holes++;
  if (bad(function () { var p = g.__proto__; return p && p.constructor("return process")(); })) holes++;
  if (bad(function () { var p = g.__proto__; return p && p.constructor.constructor("return process")(); })) holes++;
  var parent = Object.getPrototypeOf(g);
  if (parent && bad(function () { return parent.constructor("return process")(); })) holes++;
  try { eval("1"); holes++; } catch (e) {}
  try { new Function("return 1")(); holes++; } catch (e) {}
  try { Object.constructor("return 1")(); holes++; } catch (e) {}
  // 链闭包：原型/描述符通道测到可构造代码那一步
  var gp = Object.getPrototypeOf(g);
  if (gp && bad(function () { return gp.constructor.constructor("return process")(); })) holes++;
  var rgp = Reflect.getPrototypeOf(g);
  if (rgp && bad(function () { return rgp.constructor.constructor("return process")(); })) holes++;
  if (bad(function () { var d = Object.getOwnPropertyDescriptor(g, "toString"); return d && d.value && d.value.constructor.constructor("return process")(); })) holes++;
  if (bad(function () { return ({}).__proto__ && ({}).__proto__.constructor.constructor("return process")(); })) holes++;
  // 外部内存分配入口必须为 undefined
  if (typeof ArrayBuffer !== "undefined") holes++;
  if (typeof SharedArrayBuffer !== "undefined") holes++;
  if (typeof Uint8Array !== "undefined") holes++;
  if (typeof TextEncoder !== "undefined") holes++;
  return holes === 0 ? "SEALED" : "LEAK";
})()`, { filename: "pac-canary.js" });

// ── PAC 标准助手（纯字符串语义，不触网）────────────────────────────────────────
// realm 泄漏修复（codex Security Review P2，Refs #58）：vm context 不得注入任何宿主函数对象——
// 任何宿主对象（函数/RegExp/数组/日期等）都是 realm 泄漏面：宿主函数的 .constructor 是宿主
// realm 的 Function，可在宿主 realm 编译代码，绕过 codeGeneration:{strings:false} 拿到 process。
// 三个标准助手因此改为源码字符串 prelude：编译一次（vm.Script 可跨 context 复用），每次求值
// 先在全新 context 内运行，再运行用户脚本。沙箱内可见的助手是沙箱 realm 自身的函数，
// .constructor / eval / new Function 等一切路径都落在沙箱 realm，出不了沙箱。
//
// isPlainHostName / dnsDomainIs 为原实现逐行转写（纯字符串操作，守卫一致：非 string 返回 false）。
// shExpMatch 为原实现 new RegExp("^" + 变换 + "$")（无 i/m/s flag）的无 RegExp 等价实现，
// 采用迭代式双指针回溯（无递归，栈深度 O(1)，长文本不溢出沙箱调用栈；worst-case O(p·t)
// 时间由 PAC_EVAL_CPU_LIMIT_MS 护栏兜底，有意的防线交换）：
//   * → 任意长度任意字符，但不得越过行终止符（\n \r \u2028 \u2029，等价于 JS 正则点号不匹配行终止符）；
//   ? → 单个非行终止符 UTF-16 码元；
//   其余字符（含正则元字符与行终止符字面）一律字面量；大小写敏感；text/pattern 任一非 string → false。

const PAC_HELPERS_PRELUDE = String.raw`
var __pacLineTerminator = { 10: true, 13: true, 0x2028: true, 0x2029: true };
function isPlainHostName(host) {
  return typeof host === "string" && host.indexOf(".") === -1;
}
function dnsDomainIs(host, domain) {
  if (typeof host !== "string" || typeof domain !== "string") return false;
  return host.toLowerCase().endsWith(domain.toLowerCase());
}
function shExpMatch(text, pattern) {
  if (typeof text !== "string" || typeof pattern !== "string") return false;
  // 迭代式双指针回溯（ti/pi/star/matchPos 四指针，LC44 形态）：无递归、无 memo 大对象，
  // 栈深度 O(1)——长文本（万字符级 URL）不撑爆沙箱调用栈。
  // worst-case O(p·t) 时间由 500ms CPU 护栏兜底（有意的防线交换：栈溢出 → CPU 护栏，
  // 与旧 RegExp 实现防灾难性回溯的防线同量级）。
  var ti = 0;
  var pi = 0;
  var star = -1;
  var matchPos = 0;
  while (ti < text.length) {
    var pc = pi < pattern.length ? pattern.charCodeAt(pi) : -1;
    var tc = text.charCodeAt(ti);
    if (pc === 42) {
      // "*"：先记位置（可零消耗）
      star = pi;
      matchPos = ti;
      pi += 1;
    } else if ((pc === 63 && !__pacLineTerminator[tc]) || pc === tc) {
      // "?" 单个非行终止符码元；其余字符（含行终止符字面，如 pattern 里的 \n）一律字面量，
      // 大小写敏感。通配判定先于字面判定：pattern 的 * / ? 永作通配（text 同位恰为 * 时
      // 不得被字面消耗，否则通配星失效）
      ti += 1;
      pi += 1;
    } else if (star !== -1) {
      // 回溯推进：星每轮多吞一个码元；待吞字符是行终止符（\n \r \u2028 \u2029）则星
      // 不可再吞，整体失配（等价于正则 .* / . 不匹配行终止符）
      if (matchPos >= text.length || __pacLineTerminator[text.charCodeAt(matchPos)]) return false;
      pi = star + 1;
      matchPos += 1;
      ti = matchPos;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern.charCodeAt(pi) === 42) pi += 1;
  return pi === pattern.length;
}
`;

/** 沙箱 prelude：编译一次，跨 context 复用（vm.Script 与创建它的 context 无关）。 */
const PAC_HELPERS_SCRIPT = new vm.Script(PAC_HELPERS_PRELUDE, { filename: "pac-helpers.js" });

/**
 * 沙箱调用器：静态脚本跨 context 复用。在计时 vm 调用内完成 FindProxyForURL 存在性检查、
 * 参数读取、返回值类型与长度校验，返回带前缀的纯字符串原始值哨兵，宿主零 property 访问：
 *   "N" -> 缺少 FindProxyForURL；"R" -> 调用期抛错；"T" -> 返回值非 string；
 *   "L" -> 返回指令超过 PAC_DIRECTIVE_MAX_LEN（4096 字符，整条判无效）；
 *   "S" + directive -> 长度不超过上限的正常指令。
 * 前缀 "S" 构造使恶意返回值（哪怕恰为 "N"/"T"/"R"/"L"）不可能伪造哨兵归因。
 */
const PAC_CALL_SCRIPT = new vm.Script(`(function () {
  if (typeof FindProxyForURL !== "function") return "N";
  try {
    var r = FindProxyForURL(__pacUrl, __pacHost);
    if (typeof r !== "string") return "T";
    if (r.length > ${PAC_DIRECTIVE_MAX_LEN}) return "L";
    return "S" + r;
  } catch (e) { return "R"; }
})()`, { filename: "pac-call.js" });

/**
 * 在隔离 vm 上下文中求值单份 PAC 脚本，返回协议哨兵字符串：
 *   "E" -> 沙箱密封或逐次求值逃逸金丝雀自检未通过（fail-closed，不再运行 prelude 与用户脚本）
 *   "P" -> 脚本无法解析或顶层执行失败
 *   "N" -> 缺少 FindProxyForURL
 *   "R" -> 调用期抛错或超时
 *   "T" -> 返回值非 string
 *   "L" -> 返回指令超过 PAC_DIRECTIVE_MAX_LEN（4096 字符，整条判无效）
 *   "S" + directive -> 成功返回且长度 ≤ 4096 的指令文本
 */
function evaluatePacInVm(script, targetUrl, host) {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  context.__pacUrl = String(targetUrl);
  context.__pacHost = String(host);
  let canaryResult;
  try {
    PAC_SEAL_SCRIPT.runInContext(context, { timeout: PAC_EVAL_CPU_LIMIT_MS });
    canaryResult = PAC_CANARY_SCRIPT.runInContext(context, { timeout: PAC_EVAL_CPU_LIMIT_MS });
  } catch {
    return "E";
  }
  if (canaryResult !== "SEALED") {
    return "E";
  }
  try {
    // 保持「编译用户脚本 Script 在前」的顺序：用户脚本语法错误归因不变（仍 PAC_EVAL_FAILED）。
    const userScript = new vm.Script(String(script), { filename: "proxy.pac" });
    PAC_HELPERS_SCRIPT.runInContext(context, { timeout: PAC_EVAL_CPU_LIMIT_MS });
    userScript.runInContext(context, { timeout: PAC_EVAL_CPU_LIMIT_MS });
  } catch {
    return "P";
  }
  let outcome;
  try {
    outcome = PAC_CALL_SCRIPT.runInContext(context, { timeout: PAC_EVAL_CPU_LIMIT_MS });
  } catch {
    return "R";
  }
  if (outcome === "N" || outcome === "R" || outcome === "T" || outcome === "L") return outcome;
  if (typeof outcome === "string" && outcome.startsWith("S")) {
    return outcome.length - 1 <= PAC_DIRECTIVE_MAX_LEN ? outcome : "L";
  }
  return "R";
}

// 父进程正常断开 IPC（或意外退出导致通道关闭）时自救退出，避免孤儿常驻。
process.on("disconnect", () => process.exit(0));

let handled = false;
process.on("message", (msg) => {
  if (handled) return;
  handled = true;
  const id = msg && typeof msg === "object" ? msg.id : undefined;
  let outcome = "R";
  try {
    outcome = evaluatePacInVm(msg?.script ?? "", msg?.url ?? "", msg?.host ?? "");
  } catch {
    outcome = "R";
  }
  if (typeof process.send === "function") {
    try {
      process.send({ id, outcome }, () => process.exit(0));
      return;
    } catch {
      process.exit(0);
    }
  }
  process.exit(0);
});
