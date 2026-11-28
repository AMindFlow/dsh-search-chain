# PAC 求值 Worker OS 级最小权限沙箱

本规格定义 `src/transport.js` 启动 `src/pac-eval-worker.js`（[CFG-005](config-network.md#cfg-005-pac-代理路由)）时的操作系统级最小权限隔离、能力探测回退与验收条件。

## OSB-001 平台适用范围、能力探测与回退

- **要求** 仅当运行平台为 `process.platform === "darwin"` 且 `/usr/bin/sandbox-exec` 能力探测通过时，`src/transport.js` 才必须使用 `/usr/bin/sandbox-exec -p <profile>` 包裹 PAC 求值 worker。能力探测必须在进程生命周期内最多执行一次并缓存结果（按运行时路径实路径与 worker 路径缓存）。若运行于非 `darwin` 平台、`/usr/bin/sandbox-exec` 缺失、路径 `realpath` 解析失败或能力探测失败（包括外层进程已处于更严格沙箱导致 `sandbox_apply: Operation not permitted`，或该运行时组合无法以最小豁免集正常完成空转 IPC 往返），实现必须自动回退到现状直 spawn（`spawnProcess(process.execPath, [...])`），且对外路由结果、`TransportError` 错误码与错误文本必须与未包裹时逐字节一致，不得让合法 PAC 求值变脆。
- **来源** [GitHub Issue #64](https://github.com/AMindFlow/dsh-fleetseek/issues/64)、codex Security Review finding `4715314739`。
- **验收**
  1. 通过注入 `deps.spawnProcess` 桩分别验证：`darwin` 且能力探测通过时，`spawnProcess` 首参为 `"/usr/bin/sandbox-exec"`，参数前缀为 `["-p", profile, execPath, "--max-old-space-size=24", workerPath]`；非 `darwin` 或探测失败时首参为 `process.execPath` 且不含 `-p`。
  2. 连续触发多次未命中缓存的 PAC 求值时，能力探测只执行一次并复用缓存结论。
  3. 探测失败回退直 spawn 后，合法 PAC 求值成功且错误语义与直 spawn 逐字节一致。

## OSB-002 Seatbelt 最小权限 Profile 与 PID 语义

- **要求** 包裹模式必须由 `/usr/bin/sandbox-exec -p <profile> <execPath> ...` 直接 `exec` 替换执行目标运行时，不得引入 `sh -c` 等额外包装壳进程，确保父进程持有的 `child.pid` 即 worker 进程 PID（保障父侧 `ps -o rss= -p child.pid` RSS 轮询与 `SIGKILL` 强杀语义不变）。Seatbelt profile 必须以 `(version 1)` 与 `(deny default)` 起步，遵循最小豁免原则：
  1. 显式禁止文件系统写入（`(deny file-write*)`，仅保留 `/dev/null` 等无状态标准设备节点写操作免于误杀运行时），禁止网络访问（`(deny network*)`），禁止创建子进程（`(deny process-fork)`）；
  2. 放行首跳执行：`process-exec` 仅允许 `process.execPath` 经 `realpath` 解析后的规范路径（`literal`）；
  3. 放行路径解析与代码加载：`process.execPath` 及其 `realpath`、worker 脚本及其所属包根/宿主 `node_modules` 挂载路径沿途所有目录节点放行 `file-read-metadata`，包根目录与 worker 路径放行 `file-read*`；系统 dyld 公共面（`/usr/lib`、`/System/Library`、`/Library/Apple`、`/usr/share`、`/private/var/db/dyld` 等系统映射/只读面）及 `/dev/null`、`/dev/zero`、`/dev/random`、`/dev/urandom`、`/dev/fd` 放行必要读取与 `file-map-executable`；Electron-as-node 运行时（位于 `.app/Contents/MacOS/` 下）额外放行同包 `.app/Contents/Frameworks` 整目录只读与 `file-map-executable`；
  4. 放行 V8 JIT 与运行时基础系统调用：`dynamic-code-generation`、`sysctl-read`、`mach-lookup` 最小必要集合（含诊断/通知与 Crashpad/CF 最小服务名）。
- **来源** [GitHub Issue #64](https://github.com/AMindFlow/dsh-fleetseek/issues/64)、codex Security Review finding `4715314739`。
- **验收**
  1. 在 `darwin` 真机（非嵌套沙箱）下运行包裹后的 worker，验证其内部尝试写文件（如临时文件/工作区文件）、建立出站 TCP/UDP 网络连接或监听端口、调用 `child_process.spawn`/`fork` 均被操作系统拒绝（返回 `EACCES` 或 `EPERM`）。
  2. 合法 `FindProxyForURL`（`DIRECT`、`PROXY`、标准助手及沙箱密封用例）在包裹模式下行为不变，且 `ps -o rss=` 与超时/`SIGKILL` 强杀正常工作。

## OSB-003 继承 IPC 通道与纵深防御边界保持

- **要求** Seatbelt profile 的网络封禁规则（`deny network*`）不得阻断父子进程间通过已继承文件描述符（`stdio[3]="ipc"` / `NODE_CHANNEL_FD` socketpair）收发 IPC 消息，也不得破坏父进程断开时 worker 触发 `disconnect` 自救退出的行为。既有 `node:vm` 密封与金丝雀自检、`--max-old-space-size=24` 堆帽、144 MiB 父侧 RSS 看门狗、2000 ms 墙钟上限与模块级单槽位串行闸必须全部维持既有行为不变。
- **来源** [GitHub Issue #64](https://github.com/AMindFlow/dsh-fleetseek/issues/64)、[CFG-005](config-network.md#cfg-005-pac-代理路由)。
- **验收** 包裹模式下完整运行 `test/pac-sandbox.test.js`，包括 IPC 往返、`disconnect` 自救、逃逸拦截、堆帽 OOM、RSS 看门狗与 `closeAll()` 强杀用例，全部通过且行为与直 spawn 一致。

## 设计决定

- **OSB-001（能力探测与缓存）**：`src/transport.js` 仅在 `process.platform === "darwin"` 且 `/usr/bin/sandbox-exec` 存在时，以实际构造的 profile 同步或一次性探测启动目标运行时执行最小无害 IPC/退出探针（或验证 `sandbox-exec` 可正常完成目标二进制启动与 IPC 握手），并将探测结果按 `(execPathRealpath, workerPathRealpath)` 缓存于模块内。探测失败（如测试/代理终端本身运行在嵌套 Seatbelt 沙箱内、或特定 Electron 打包形态缺少额外系统豁免）时静默回退直 spawn，确保零可用性回归。
- **OSB-002（`realpath` 沿途放行与首跳 `exec`）**：Seatbelt 的 `(literal ...)` 不跟随 symlink。主仓库 checkout、NVM/Homebrew Node、以及 DSH 宿主 profile 经 `node_modules` symlink 挂载插件时，路径上存在多级符号链接；构造 profile 前先对 `process.execPath`、`PAC_WORKER_PATH` 及包根目录执行 `fs.realpathSync`，同时收集原路径与实路径的每一级祖先目录放行 `file-read-metadata`（含 `/private` 等 macOS firmlink 映射前缀），并仅对 `execPathRealpath` 放行 `process-exec`，既解决 `sandbox-exec` `execvp` 首跳被拦问题，又防止 worker 再次 `exec` 任意系统二进制。
- **OSB-002（无包装壳保持 PID）**：直接将 `"/usr/bin/sandbox-exec"` 作为 `spawnProcess` 首参传入，`sandbox-exec` 完成 `sandbox_init` 后以 `execvp` 原地替换为 Node / Electron-as-node 进程，PID 与父侧监控目标完全一致。

## 残留风险

- **明确不做 `rlimit` / `RLIMIT_AS`（`ulimit -v`）**：V8 启用指针压缩（Pointer Compression）时，进程启动即须 `mmap` 数 GiB（典型 4 GiB 起）连续虚拟地址空间用于隔离笼（Pointer Compression Cage）。施加 `RLIMIT_AS` / `ulimit -v` 虚存上限必然导致 V8 在初始化阶段直接分配失败崩溃，因此明确不在 worker 中使用 `RLIMIT_AS`。物理内存边界继续由两层用户态/进程内边界承担：`--max-old-space-size=24`（V8 老生代堆帽即时 `SIGABRT`）与父进程 144 MiB RSS 轮询看门狗（`ps -o rss=`，25 ms 周期，`SIGKILL` 强杀）。
- **非 `darwin` 平台与嵌套沙箱回退**：Linux / Windows 目前无 `sandbox-exec` 对等实现，以及外层已施加不可嵌套沙箱导致 `sandbox_apply` 拒绝时，worker 回退到现有直 spawn（仍受 `vm` 密封 + 金丝雀 + 单发无权限 IPC 协议 + 内存/CPU 上限约束）。
- **`sandbox-exec` 平台演进风险**：Apple 将 `sandbox-exec` 标记为 deprecated（尽管当前 macOS 仍随系统内置并可用）；若未来 macOS 大版本移除或收紧 `sandbox_apply`，能力探测机制保证自动降级回直 spawn 而不阻断 PAC 功能。
