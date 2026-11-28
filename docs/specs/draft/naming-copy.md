# 中文显示名与文案翻新（品牌落地）

本规格定义 FleetSeek 中文显示名「千帆」的落地口径，以及用户可见文案中 `chain` / 「链」措辞的替换要求、不变量红线与历史归档例外。编号前缀 `NAM-`，不与现有 `DSH-`、`SET-`、`CFG-`、`CFG-W-`、`FB-`、`CAT-`、`GMI-`、`PAC-`、`POOL-`、`FT-`、`PX-` 冲突。来源 Issue：[#102](https://github.com/AMindFlow/dsh-fleetseek/issues/102)。

## NAM-001 用户可见文案的定义

- **要求** 本规格所称「用户可见文案」，指终端用户随安装产物或对外渠道能读到、看到的文本，具体限于：`README.md`、`INSTALL.md`、`docs/user/`（`evidence/` 复测材料除外，见 NAM-004）、设置面板与注册 displayName 文案（`src/client.js`、`src/settings/`、`src/index.js` 中的字符串字面量，含 `src/settings/catalog.js` 的 `SECTION_TITLE` 与官方搜索开关说明、`src/cordis.patch.yml` 的配置行 `name` 字段）、`package.json` 的 `description` 字段、市场索引 headline 与标题/描述文案（`scripts/make-market-index.mjs` 的 `meta.title` / `meta.description`，即 Discover 卡片与详情页展示的文本）。凡不在上述清单内的文本（代码注释、内部日志、测试断言表、`test/`、`docs/specs/official|draft` 本体、`docs/project`、`releases/`）不属于本规格的强制改写对象。
- **来源** [#102 正文「范围（文案层）」](https://github.com/AMindFlow/dsh-fleetseek/issues/102)（README、INSTALL、docs/user/、设置面板与注册 displayName、市场索引 headline、Discover 口径）。
- **验收** 给定 `git grep -l` 按上表清单列文件，与 `git show --stat` 实施 PR 的改动文件清单对照：PR 不得改动清单外文件的用户可见文案；清单内每个文件的改写处均能在 NAM-003 矩阵中找到对应行。

## NAM-002 标识符与配置不变量

- **要求** 本规格的任何改写不得改动以下标识符：provider id、配置命名空间、行 id 一律保持 `search-chain`；npm 包名与仓库名一律保持 `dsh-fleetseek`；错误码族（`CHAIN_*`、`ENTRY_*`、`CONFIG_*`、`PAC_*`、`SKIPPED_NO_KEY`、`TRANSPORT_RELEASED`）、环境变量名、`SEARCH_CHAIN_CREDENTIAL_*` 引用前缀、`web.searchProvider` 取值、代码内导出符号与文件路径一律原样。改写后的文案不得以措辞误导用户去把配置里的 `search-chain` 改成中文或其它值；涉及「把 `web.searchProvider` 设为 `search-chain`」这类指令句时，标识符必须以原样反引号形态出现，且邻近措辞明确指出这是配置取值而非插件显示名。代码注释与内部命名中的 chain/「链」不强制改写。
- **来源** [#102 正文红线](https://github.com/AMindFlow/dsh-fleetseek/issues/102)；[HANDOFF-20261128 · 设计不变量红线](../project/HANDOFF-20261128.md)（行 id / 配置命名空间 / provider id 永久 = `search-chain`）。
- **验收** 实施 PR 合入前跑 `git diff origin/main…HEAD -U0 -- src package.json | grep -E '^[+-]' | grep -v '^[+-]{3}'`，人工核对：`search-chain`、`dsh-fleetseek`、全部错误码与引用前缀在 `-` 行与 `+` 行中逐字节一致（只允许出现在未被改写的行或改写句中原样引用）；`node -e` 读取改后 `package.json` 的 `name` 仍为 `dsh-fleetseek`；`grep -rn 'id: search-chain' src/cordis.patch.yml` 仍然命中。

## NAM-003 替换矩阵与新闻案口径

- **要求** 实施前必须实跑枚举命令得到完整矩阵，矩阵逐行登记：文件、行号、现文案片段、新措辞。基线枚举命令（在仓库根执行）：

  ```bash
  grep -rn "链\|[Cc]hain" README.md INSTALL.md docs/user/ package.json \
    src/client.js src/settings/ src/index.js scripts/make-market-index.mjs src/cordis.patch.yml \
    | grep -v docs/user/evidence
  ```

  对命中行逐条判定：纯标识符引用（如 `search-chain`、`CHAIN_*`、`createSearchChain`）判「不动」；产品名义 / 编排概念义的 chain/「链」措辞判「改写」，新措辞必须通顺、不含 chain/「链」（引用 `search-chain` 等标识符处除外——标识符原样），且护城河三声称不得降级：**出网边界最严格（配了代理绝不静默换路径）、保存即校验明文清零、凭据 write-only**。术语统一：中文显示名「千帆」，组合展示「千帆 FleetSeek」；「网页搜索链」→「千帆网页搜索」；「多源搜索链」→「多源搜索」；「回退链 / 有序链 / 降级链」→「有序回退 / 顺序尝试 / 降级序列」；「条目链 / 工具链」→「条目序列 / 搜索工具」；「链级」→「整次搜索」；「链侧」→「插件侧」；「链路」→「路径」；「走了本链」→「走了千帆」。市场 headline 采用「出网边界最严格的多源搜索·千帆」型句式（以通顺为准）。矩阵由本草案首版按基线 `2ad3cb7` 实跑预填（见 NAM-007 附表）；实施 PR 必须以实施当日实跑结果重新对表，行号漂移以内容匹配为准。
- **来源** [#102 语义](https://github.com/AMindFlow/dsh-fleetseek/issues/102)；[裁决评论 issuecomment-7239969703](https://github.com/AMindFlow/dsh-fleetseek/issues/102#issuecomment-7239969703)（定名「千帆」，组合展示「千帆 FleetSeek」，内部标识与包名不动）；护城河三声称出处 [HANDOFF-20261128 · 竞品与渠道巡查](../project/HANDOFF-20261128.md)。
- **验收** 实施后对 NAM-001 清单文件重跑 NAM-003 枚举命令：除标识符原样引用（`search-chain`、`dsh-fleetseek`、错误码族、`createSearchChain` 等代码符号所在行）外，用户可见文案零「链 / chain」残留；逐行对照矩阵，新措辞与矩阵一致或更优且三声称语义不降级；README 首段与市场 headline 中出现「千帆 FleetSeek」组合展示。

## NAM-004 历史归档例外

- **要求** 不可动文件——`scripts/oracle-style-50.mjs` 及其内 `CATALOG_TEXT`、`docs/project/` 历史文件（含 [HANDOFF-20261128.md](../project/HANDOFF-20261128.md)）、`docs/project/releases/*`——中的旧文案一律保留原样，实施 PR 不得顺手改写其中任何 chain/「链」措辞；这些文件是历史事实归档，其旧品牌口径不构成对新文案的约束。`docs/user/evidence/` 复测 fixture 与复测日志同理：日志是历史观测记录，禁止追改；若运行时文案日后翻新，只允许重跑生成新日志，不覆写旧文件。`docs/user/upgrade.md` 迁移小节中引用**当时界面实际显示名**的引号文本（如卸载「网页搜索链 (dsh-search-chain)」卡片名）属操作指认，保留原名并加「（旧版当时显示名）」注，避免升级用户按新名找不到旧卡片。
- **来源** [#102 正文红线「不可动文件」](https://github.com/AMindFlow/dsh-fleetseek/issues/102)；[HANDOFF-20261128 · 不可动文件](../project/HANDOFF-20261128.md)。
- **验收** 实施 PR 的 `git diff origin/main…HEAD --name-only` 不含上述任何文件；`git diff origin/main…HEAD -- docs/user/upgrade.md` 中旧卡片名引号文本仍存在。

## NAM-005 oracle 一致性

- **要求** 文案改写合入前必须实跑 `node scripts/oracle-style-50.mjs`，输出仍与 `src/` 注册目录一致（oracle 校验的对象是目录/形状，oracle 文件本身不可动，见 NAM-004）。若改写与 oracle 冲突，本条为阻塞项：不得改 oracle 迁就文案，必须停下上报 lead 裁决。
- **来源** [#102 正文红线](https://github.com/AMindFlow/dsh-fleetseek/issues/102)；`scripts/oracle-style-50.mjs` 头注与 `src/client.js` 头注（改名须同 PR 同步 oracle 并给理由——本工作包不改导出面，不适用该豁免）。
- **验收** PR 描述附实施当日 `node scripts/oracle-style-50.mjs` 的完整结尾输出（PASS 行与退出码 0）。草案阶段预判（基线 `2ad3cb7` 实跑，见 NAM-007 附表）：`CATALOG_TEXT` 为搜索目录条目文本，不含「链」措辞，`SECTION_TITLE` 改动是否进入 oracle 比对以实跑结果为准；实跑结论若为「oracle 比对 `SECTION_TITLE` 常量」，则实施 PR 需评估 oracle 是否在只读清单内冲突并上报。

## NAM-006 渠道同步后置

- **要求** 对外渠道同步不属于本规格的验收范围，按 [HANDOFF-20261128 · 发布配方第 4 步](../project/HANDOFF-20261128.md)在发布阶段执行：自建 market-index 替换（NAM-003 的新闻案经 `make-market-index.mjs` 生成后 PUT）、官方 Discussion deepseek-ai/deepseek-harness#14418 正文、dshopen polang233/dsh-plugin-index#830 追评、awesome#19545 落地后按需追。本规格合入仅要求仓库内文案与生成脚本口径一致；线上渠道与新文案的短暂不一致不判违约。
- **来源** [#102 正文「渠道同步在发布阶段执行」](https://github.com/AMindFlow/dsh-fleetseek/issues/102)。
- **验收** 发布阶段验收项（不阻塞本规格 PR）：market-index.json 线上 `title.zh` / `description.zh` 与仓库 `make-market-index.mjs` 一致；Discussion 与 #830 追评含「千帆 FleetSeek」组合展示。

## 设计决定

- 关联 NAM-003：#88 已先行给出对外承诺句「每一次出网路径的改变都可见、可钉死」（[HANDOFF-20261128 · 红线](../project/HANDOFF-20261128.md)），本次新闻案沿用该句不重造；#102 文案翻新在 #88 规格合入后 rebase，rebase 后对全部清单文件做全文翻新（矩阵按 rebase 当日重跑，见 NAM-003），依赖方向取 PR #103 的 PX-010：#102 依赖 #88 的出网承诺措辞定型，反向不依赖。
- 关联 NAM-001：`src/client-entry.js` 为入库的 client 产物镜像（含 `SECTION_TITLE` 与面板文案副本）；实施 PR 需同步该产物的文案镜像，同步方式为重新构建或等量替换，不引入新构建系统。
- 关联 NAM-003：`src/cordis.patch.yml` 配置行 `name: 'dsh-fleetseek'` 属宿主配置行显示名，是否改为「千帆 FleetSeek」以宿主语义核实为前提（行以 `id` 为主键、`name` 仅展示时才可改），核实前保持原样——开放问题 O-3。

## NAM-007 基线矩阵预填（实跑于基线 2ad3cb7）

枚举命令见 NAM-003。判定分三类：**改**（产品名义/概念义措辞）、「例外保留」（历史/操作指认，依 NAM-004）、「不动（纯标识符）」（不计入下表「改」数）。下表「现文案」为片段。

### 按文件处数（判定为「改」的行）

| 文件 | 处数 | 行号 |
| --- | --- | --- |
| README.md | 6 | 1, 3, 4, 6, 19, 26 |
| INSTALL.md | 3 | 37, 51, 52 |
| docs/user/README.md | 1 | 5 |
| docs/user/getting-started.md | 7 | 16, 55, 69, 74, 76, 96, 102 |
| docs/user/troubleshooting.md | 14 | 19, 26, 30, 32, 49, 55, 57, 63, 71, 73, 75, 85, 91, 93 |
| docs/user/upgrade.md | 4（另有 1 处例外保留：7） | 32, 36, 46, 63 |
| package.json | 1 | 6 |
| src/settings/catalog.js | 2 | 23, 150 |
| scripts/make-market-index.mjs | 4 | 18, 19, 22, 23 |
| src/cordis.patch.yml | 0（候选 1 处，开放问题 O-3） | — |
| src/client.js / src/index.js | 0（命中均为注释，依 NAM-002 不强制） | — |
| **合计（改）** | **42** | |

例外保留 2 处：docs/user/upgrade.md:7（旧卡片名操作指认）、docs/user/evidence/*（NAM-004）。纯标识符命中（`search-chain`、`CHAIN_*`、`createSearchChain`、`dsh-search-chain` 等）一律不动，不逐行列举。

### 代表性改写行（完整矩阵实施时补全）

| 文件:行 | 现文案（片段） | 新措辞 |
| --- | --- | --- |
| README.md:1 | `# FleetSeek · 网页搜索链` | `# 千帆 FleetSeek · 多源网页搜索` |
| README.md:3 | `**出网边界最严格的多源搜索链**…组成一条有序回退链` | `**出网边界最严格的多源搜索**…组成一条有序回退序列`（headline 口径：出网边界最严格的多源搜索·千帆） |
| README.md:6 | `搜索 provider 插件「网页搜索链」…宿主官方搜索和自定义链之间切换` | `搜索 provider 插件「千帆 FleetSeek」…宿主官方搜索和千帆自定义搜索之间切换` |
| README.md:19 | `「设置 → 网页搜索链」` | `「设置 → 千帆网页搜索」`（与新 `SECTION_TITLE` 一致；`search-chain` 取值原样） |
| README.md:26 | `原型链与外部内存对象封固` | `原型访问与外部内存对象封固`（技术名词从严规避「链」字，开放问题 O-1） |
| INSTALL.md:37/51 | `「设置 → 网页搜索链」` | `「设置 → 千帆网页搜索」` |
| INSTALL.md:52 | `若走了本链` | `若走了千帆` |
| docs/user/README.md:5 | `代理/PAC 实际链路` | `代理/PAC 实际路径` |
| getting-started.md:16 | 选择「FleetSeek 网页搜索链」 | 选择「千帆 FleetSeek · 网页搜索」（与新闻案 `title.zh` 一致） |
| getting-started.md:55 / upgrade.md:32 | `链侧保留了这一层的代码` | `插件侧保留了这一层的代码` |
| getting-started.md:69/74、troubleshooting.md:71、upgrade.md:63 | `条目链` | `条目序列` |
| getting-started.md:76、catalog.js:150 | `关闭后相关会话改用下方工具链` | `关闭后相关会话改用下方搜索工具` |
| getting-started.md:96 | `PAC 链路真实执行` | `PAC 路径真实执行` |
| getting-started.md:102、upgrade.md:36/46 | `「网页搜索链」区域/面板` | `「千帆网页搜索」区域/面板` |
| troubleshooting.md:19/26/32/49/55/57/63/85 | `链会继续 / 链在它之前已经成功返回 / 链已终止` 等 | `千帆会继续 / 在它之前已经成功返回 / 整次搜索已终止`（逐行以通顺为准） |
| troubleshooting.md:30/91/93 | `链侧证据码 / 链级` | `插件侧证据码 / 整次搜索层面` |
| troubleshooting.md:49/85 | `链不会继续尝试后面的条目 / 链已终止` | `千帆不会继续尝试后面的条目 / 整次搜索已终止`（同行错误码 `CHAIN_CONTENT_POLICY` 原样） |
| troubleshooting.md:73 | `搜索链没有 release 接口` | `搜索编排（`createSearchChain` 返回值）没有 release 接口`（符号原样） |
| troubleshooting.md:75 | 小节标题 `链级终态（CHAIN_*）` | `整次搜索终态（\`CHAIN_*\`）`（码名原样） |
| package.json:6 | `DSH 网页搜索链插件（自定义多供应商回退链）` | `千帆 FleetSeek · DSH 多供应商网页搜索插件（按保存顺序逐个尝试，失败自动降级）` |
| catalog.js:23 | `SECTION_TITLE = "网页搜索链"` | `SECTION_TITLE = "千帆网页搜索"` |
| make-market-index.mjs:18/19 | title `FleetSeek 网页搜索链` / `FleetSeek Web Search Chain` | `千帆 FleetSeek · 网页搜索` / `Qianfan FleetSeek · Web Search`（en 口径待定，开放问题 O-2） |
| make-market-index.mjs:22/23 | `多厂商搜索降级链：…` / `…web_search chain: …` | `多厂商有序降级搜索：…` / `…web_search fallback: …`（三声称不降级） |

### oracle 预判与实跑

`CATALOG_TEXT` 实 grep「链」计 0 处——预判 oracle 不校验含「链」目录文本。基线 `2ad3cb7` 实跑 `node scripts/oracle-style-50.mjs`：结果见 PR 描述（实跑进行中，结论以退出码与结尾输出为准）。

## 开放问题（上报 lead，不阻塞本草案评审）

- **O-1 技术名词边界**：「原型链」（README.md:26）、「链接」（`src/backends/bing.js` reason 文本，超出 NAM-001 清单）等技术通用词含「链」字但非品牌义。NAM-003 按字面「不含链」从严改写（原型链→原型访问），是否改为「仅禁产品名义」口径请 lead 裁决。
- **O-2 英文口径**：`make-market-index.mjs` 的 `title.en` / `description.en` 与英文用户可见文案是否采用「Qianfan」罗马化，还是英文面保留纯 `FleetSeek`。草案暂按 `Qianfan FleetSeek · Web Search`。
- **O-3 配置行显示名**：`src/cordis.patch.yml` 行 `name: 'dsh-fleetseek'` 改为「千帆 FleetSeek」需先确认宿主以 `id` 为主键、`name` 纯展示；确认前不动（存量 profile 的行 `name` 是否被迁移脚本/宿主同步也需核）。
- **O-4 运行时 reason 文案**：`src/search.js:343`「全链未获得有效来源…」、`src/official.js:40`「…未回退自定义链」等运行时错误文本含「链」，但不在 #102 范围清单内；而 troubleshooting.md 多处引用真实 reason 文本。若运行时文案不动，文档侧引用行只能原样引；是否扩大范围请 lead 裁决。
- **O-5 client 产物镜像**：`src/client-entry.js` 为入库产物，含 `SECTION_TITLE` 与面板文案字符串副本及内嵌断言表；实施 PR 同步方式（重新构建 or 手工等量替换）与断言表中显示名相关判据是否需同步，待实施确认。
- **O-6 Discover 标题时间差**：getting-started.md:16 引用 Discover 卡片标题；渠道同步（NAM-006）落地前线上仍是旧标题，文档先行更新是否可接受。草案按「发布阶段整体切」接受。


