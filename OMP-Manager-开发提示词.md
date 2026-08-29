# OMP Manager 开发提示词

> 用法：本文件已经位于现有 OMP Manager 仓库根目录。把它与《OMP Manager 完整需求文档》一起交给编码 Agent。需求文档是产品事实来源；`README.md`、`docs/architecture.md` 和 `docs/omp-compatibility.md` 是当前实施与兼容性事实来源；本提示词规定续作方法、顺序和质量门槛。  
> 文档版本：1.1  
> 当前入口（2026-08-28）：M0 已完成，默认从 M1 纵向闭环继续。

## 你的角色

你是一名资深桌面应用架构师、Rust/TypeScript 工程师和应用安全工程师。请在本仓库已有 M0 骨架上增量实现一个可运行、可测试、可打包的 **OMP Manager**，用于图形化管理 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) 的项目目录、Profile、历史会话、账号凭证、模型角色和启动终端。

这不是静态原型，也不是只画界面。最终结果必须能在 Windows 与 Linux 上实际探测并启动本机 OMP。不要重写 OMP 的 Agent 功能；应用是 OMP 的安全编排与管理层。

先完整阅读根目录的 `OMP-Manager-完整需求文档.md` 并将其视为权威产品需求。本提示词与其冲突时优先遵守需求文档；对 OMP 能力的事实判断则以目标二进制的安全探测和 `docs/omp-compatibility.md` 为准。

## 工作方式

1. 先检查现有仓库、适用的 `AGENTS.md`（若存在）、`README.md`、`docs/`、构建脚本、锁文件和未提交改动；保护用户已有工作。当前目录可能不是 Git 仓库，不能把 Git 命令成功当作前置条件。
2. 先确认当前里程碑和已有实现，再从最小未完成纵向切片继续。当前基线是 M0 已完成、M1 待实现；禁止重搭 Tauri/React/Rust 骨架、清空已有文档/fixture 或用另一套平行架构替换现有契约。
3. 每个里程碑都必须包含真实实现、测试、错误处理和文档；禁止用假数据冒充已完成集成。
4. 遇到 OMP 版本差异时使用能力探测和适配器，不靠散落的版本判断。
5. 只有会改变产品方向、造成不可逆影响或确实阻塞实现的事项才询问用户；普通技术选择按本文推荐方案直接推进，并记录理由。
6. 不要声称“全部凭证管理”已经完成，除非目标 OMP 版本上的列出、添加/登录、禁用、注销/删除和测试均有可验证行为。缺少安全接口时应明确降级，而不是直接操作内部数据库。
7. 对已有源码、迁移、接口、兼容结论和锁文件采用最小增量修改。若确需破坏性迁移或大规模重构，先给出证据、迁移/回滚方案和影响范围，不因目标目录示例而机械搬家。
8. 每完成一个里程碑，报告：完成项、改动文件、运行方法、测试结果、需求/验收条目映射、仍受 OMP 能力限制的部分。不得只修改 README 中的里程碑文字来宣称完成。

## 产品结论（不要再次询问）

- 桌面平台：Windows 与 Linux。
- 第一版本机运行；架构预留 WSL/SSH，但本轮不实现远程连接。
- 项目以本地目录为核心。进入项目后先列出当前搜索范围（默认绑定 Profile，可显式包含其他已确认且已授权 Profile）内该路径的全部可读 OMP 历史会话，并显示范围与发现完整性，由用户选择。
- 恢复会话时显示原模型与账号设置，可原样继续，也可修改后启动。
- 新会话保存项目固定默认值，启动前可临时修改。
- 同时支持内嵌 PTY 终端和外部系统终端。
- 在后端真实能力范围内完整管理 OMP 本地账号与凭证；默认检查不发送聊天补全，但联网 usage/Gateway 检查仍需用户触发并说明 OAuth 刷新等副作用。
- 支持常见外部本地管理器/文件的一键导入，以及用户主动触发的单向重新同步。
- 模型角色默认只展示常用角色，高级设置展示 OMP 当前版本的全部角色。
- 账号选择默认交给 OMP 自动调度；可按项目固定 Profile，有稳定接口时才允许固定具体凭证。
- OMP 缺失或过旧时支持一键安装、升级和重新检测。
- 本机在线项目提供键盘可达的“用 Cursor 打开”应用内动作；只允许固定 Cursor 适配器，不接受任意编辑器命令。
- 用户可选择在操作系统文件管理器中，为任意本地文件夹安装“用 Cursor 打开”右键入口；它不要求目录已添加为项目。Linux 必须按文件管理器适配并如实公布支持矩阵。
- 先自用，但代码、权限、迁移和打包按未来公开发布设计。
- UI 默认简体中文，从第一天使用 i18n key，并预留英文。

## 当前仓库基线（先核对，禁止假设空仓）

截至 2026-08-28，仓库应包含以下 M0 成果。开始时逐项核对；若实际仓库已经前进，以代码、测试和当前文档为准，不回退：

- npm workspace + Cargo workspace，桌面应用位于 `apps/desktop`。
- Tauri 2 + React + strict TypeScript + Vite 骨架。
- Rust 领域契约：`ExecutionTarget`、`OmpAdapter`、`CredentialBackend`、`CredentialImporter`、`LaunchPlan` 与结构化错误。
- 只暴露 `probe_omp` 和固定 `pty_spike` 等最小 IPC；WebView 没有通用 shell/文件权限。
- OMP 能力探测、集中脱敏、合成 stub/fixture 和 Linux PTY smoke test。
- `docs/architecture.md`、`docs/threat-model.md`、`docs/omp-compatibility.md`、`docs/development.md`。
- SQLite `0001_initial.sql` 草案已经存在，但运行时持久化应从 M1 以迁移/备份/事务方式接通。
- 当前界面是 M0 探测工作台，不是业务功能假数据；M1 应增量演进而非先删除再重做。

开始续作前必须：

1. 读取根 `package.json`，确认真实脚本；当前完整质量门为 `npm run check`。
2. 读取 `docs/omp-compatibility.md`，保留 OMP 18.0.3、`can_pin = false`、本地精确凭证 CRUD 不可用、Windows 未实机验证等结论。
3. 检查现有迁移、Rust trait/DTO、IPC 和前端测试，复用现有错误码、脱敏器和 fixture 约定。
4. 记录本次要完成的最小需求/AC 范围；不要在一次改动里顺手进入 M2。
5. 若基线文件缺失或与本节不符，先报告实际差异并按实际状态续作，不自动生成一套同名替代实现。

## 实现前必须核对的官方资料

不要凭记忆实现 OMP 集成。开始编码前读取当时最新的官方文档和目标版本源代码，至少核对：

- [OMP 仓库与安装说明](https://github.com/can1357/oh-my-pi)
- [CLI Reference](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md)
- [Settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
- [Models](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md)
- [Session Format](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)
- [Auth Broker and Gateway](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md)
- [Secrets](https://github.com/can1357/oh-my-pi/blob/main/docs/secrets.md)
- [文件夹自动选择 Profile 的公开议题](https://github.com/can1357/oh-my-pi/issues/9655)
- [Tauri Shell Plugin](https://v2.tauri.app/plugin/shell/)（只用于核对权限模型，不向 WebView 开放通用执行）
- [Tauri Capabilities](https://v2.tauri.app/security/capabilities/)
- [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/)
- [Cursor Agent CLI](https://cursor.com/docs/cli/overview)（只用于区分独立 `agent` CLI；桌面启动参数仍需对目标安装实测）
- [Microsoft File Explorer Context Menu](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/integrate-packaged-app-with-file-explorer)
- [Microsoft Creating Shell Extension Handlers](https://learn.microsoft.com/en-us/windows/win32/shell/handlers)
- [GNOME Nautilus MenuProvider](https://gnome.pages.gitlab.gnome.org/nautilus-python/nautilus-python-overview-example.html)
- [KDE Dolphin Service Menus](https://develop.kde.org/docs/apps/dolphin/service-menus/)
- [Desktop Entry `Exec` 规范](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html)

维护并增量更新已有 `docs/omp-compatibility.md`，记录：

- 实际验证的 OMP 版本与可执行路径。
- 每个命令、参数、JSON 字段和退出码的验证结果。
- 哪些能力来自 CLI，哪些来自 Auth Broker/Gateway，哪些只能调用 OMP 自身交互流程。
- 最低支持版本和降级行为。
- 使用的脱敏 fixture 来源；不得提交真实账号、Token、项目会话或用户路径。

把证据分为 `observed_safe`、`observed_active`、`documented`、`unsupported_or_failed`。官方 `main` 文档、目标版本源码和本机运行时结果必须分开记录；文档出现某参数不等于当前二进制已可安全执行。没有新证据时不得清空或改写已有兼容性结论。

自动探测禁止运行登录/注销、真实 usage、Gateway check、模型刷新、导入/迁移、安装/升级、会话启动/恢复/分叉/导出，也不能在真实 Profile 上无提示运行可能迁移损坏配置的 `config list --json`。有副作用的验证必须由用户明确授权，并把影响、隔离方式和结果写入兼容性记录。

## 推荐技术栈

除非现有仓库已确定了等价技术栈，否则使用：

- Tauri 2.x 桌面壳。
- React + TypeScript + Vite 前端，启用严格 TypeScript。
- Rust 后端，负责进程、PTY、文件、SQLite、脱敏和安全边界。
- xterm.js 渲染内嵌终端。
- Rust `portable-pty` 提供 Windows ConPTY 与 Linux PTY。
- SQLite 保存项目绑定、会话索引、别名、导入记录、回收站和设置。
- i18n 框架，默认 `zh-CN`，提供最小 `en` 资源占位但不硬编码中文到组件逻辑。
- 使用当前稳定版本并锁定依赖；不要未经评估混用多个状态管理、UI 或数据库框架。

若采用组件库，应满足键盘可用、深浅主题、对话框焦点锁定和中文排版；不要为了视觉效果引入需要远端运行的组件。

## 目标目录结构

以下是终态职责蓝图，不是强制搬迁清单。保留现有路径和可工作的 M0 `ProbeWorkbench`/adapter/fixture，在实现真实功能时按需增量增加目录；不要仅为了对齐树形结构而重命名、复制或删除已有模块：

```text
apps/desktop/
  src/
    app/                 # 路由、布局、i18n、主题
    features/
      dashboard/
      projects/
      sessions/
      credentials/
      models/
      imports/
      terminals/
      integrations/       # Cursor 与系统右键状态/设置
      diagnostics/
      trash/
    components/
    bindings/            # 生成/封装的 Tauri 调用类型
  src-tauri/
    src/
      commands/          # 最小白名单 IPC
      domain/            # 领域类型和规则
      services/
      adapters/
        omp/
        editors/
        shell_integrations/
        importers/
        targets/
      infrastructure/
        db/
        fs/
        process/
        pty/
        secrets/
        logging/
      bin/                 # 最小 open-cursor helper（可按 Cargo/Tauri 打包约定调整）
    capabilities/
tests/
  fixtures/omp/          # 合成、脱敏、多版本 fixture
docs/
  architecture.md
  threat-model.md
  omp-compatibility.md
  development.md
```

仓库已经使用 workspace/monorepo。保持根目录脚本为唯一常用入口；除非有充分理由，不新增第二套包管理器或平行构建命令。

## 第一原则：不要绕过 OMP

按以下优先级集成：

1. OMP 官方 CLI 的结构化 JSON 输出。
2. OMP Auth Broker/Gateway 的公开接口。
3. OMP 自身交互流程（例如 OAuth/登录），在内嵌或外部终端中安全承载。
4. 只有在 M0 证明公开接口确实不足时，才实现一个最小、版本化的 companion bridge；它必须调用 OMP 的公开包/导出接口，有契约测试和严格版本门控。

当前 M0 没有证明需要或能够安全实现 companion bridge，因此 M1 不得自行加入。先按 `docs/omp-compatibility.md` 的降级结论工作；只有新的、可复现证据才能改变它。

严禁：

- 直接写 `agent.db`。
- 根据未声明的 SQLite 表结构实现凭证 CRUD。
- 手工改写会话 JSONL 来恢复、分叉或切换模型。
- 从 WebView 暴露任意 shell 执行。
- 为了“看起来完成”而静默选择别的账号或模型。
- 把 `auth-broker list --json` 的提供商目录当作已存凭证清单。
- 把 Broker snapshot 原文、`config get` 结果或子进程原始输出传给前端/日志。
- 默认扫描整个主目录寻找 Profile、项目或凭证。

可以只读解析会话 JSONL 以建立列表和预览，但解析器必须容忍未知字段、截断文件和正在追加的文件，且永不写回。

## 架构契约

### 1. ExecutionTarget

业务层不能直接依赖本机文件系统和进程 API。定义异步 `ExecutionTarget` 抽象，至少覆盖：

- `probe()`
- `canonicalize_path(path)`
- `resolve_git_identity(path)`
- `run_omp(validated_request, cancellation, limits)`
- `spawn_pty(launch_plan)`
- `open_external_terminal(launch_plan)`
- `read_allowed_file(request)`
- `atomic_write_allowed_file(request)`
- `health_check()`

第一版只实现 `LocalTarget`，但所有项目、Profile、会话和安装记录都包含 `target_id`。不要在 UI 中放置不能工作的 WSL/SSH 开关。用文档和接口测试证明以后可以加入 `WslTarget`、`SshTarget`。

### 2. OmpAdapter

定义单一 OMP 适配层，至少提供：

- 安装发现、版本与能力探测。
- Profile/Agent 目录发现。
- 有效配置和配置架构读取。
- 模型列表与角色列表。
- 项目会话扫描、会话预览和状态解析。
- 凭证引用列表、健康检查与受支持的管理操作。
- 新建/恢复/分叉/导出 LaunchPlan。
- 安装、升级、重新检测。

所有管理操作结果使用领域 DTO，不把原始 CLI 文本直接传给前端。错误对象包含：稳定错误码、用户可读的中文消息、可执行建议、已脱敏技术信息和是否可重试。内嵌 PTY 是单独、显式的透明流式通道，不得复用为普通命令输出 API。

### 3. CredentialBackend

至少支持以下实现/模式：

- `BrokerCredentialBackend`：通过官方 Auth Broker/Gateway snapshot 和 credential API，按探测能力提供列出/投影、导入/upsert、刷新、禁用、用量和检查；只有观察到精确端点时才提供重新启用或永久删除。
- `NativeInteractiveCredentialBackend`：当本机 Profile 没有安全 CRUD API 时，启动 OMP 自身认证流程，完成后刷新清单。
- 可选 `VersionedCompanionBackend`：仅在 M0 确认需要且有公开包接口时加入。

每个后端返回能力标志，例如 `can_list`、`can_login`、`can_disable`、`can_delete`、`can_pin`、`can_safe_check`、`can_strict_check`。UI 只显示真实能力。

对已验证的 OMP 18.0.3：

- 本地原生模式不能结构化列出并精确 CRUD 每条凭证；使用 OMP 官方交互流程降级。
- Broker snapshot 可能包含 API Key/Access Token，必须在 Rust 内存中立即投影为无秘密 DTO，原始 body 不跨 IPC、不落盘、不进错误。
- 没有稳定公开的精确凭证启动参数，固定 `can_pin = false`。恢复会话由 OMP 自己使用会话中的 pin，管理器不能把 pin 哈希当作账号 ID。

### 4. CredentialImporter

每个导入适配器实现：

- `detect(source)`
- `preview(source)`
- `import(preview_id, target_profile, conflict_policy)`
- `resync(source_id)`
- `capabilities()`

预览保存在短期内存会话中，不能把秘密写入 SQLite、前端状态或日志。重新同步为用户主动触发的单向 `来源 → OMP` 操作，绝不修改来源。

### 5. TaskSupervisor 与变更计划

所有扫描、探测、导入、同步、测试、安装、升级、导出和长时间文件操作由 Rust `TaskSupervisor` 拥有：

- 任务有不透明 ID、目标 scope、阶段、可得进度、超时、可取消性声明、取消状态和脱敏结果；底层无法可靠取消时明确显示。
- 同一目标的变更使用 scope lock；只读任务有界并发，前端重复点击不会创建重复变更。
- 前端只订阅状态，任务快照/事件带单调 revision，采用“先快照、再续传、缺口重取快照”；WebView reload 后可重新查询，不把 Rust future 或原始进程句柄暴露给前端。
- 安装、导入、删除、配置保存和 LaunchPlan 执行使用一次性计划 ID/幂等键；IPC 超时后先查询原任务，禁止盲目重试。
- 应用启动时只对账未完成任务；无法证明目标和进程身份时标记“待核对”，不自动继续或终止。

### 6. ExternalEditorAdapter 与 FolderContextMenuAdapter

应用内项目动作与系统文件夹右键共用固定 `cursor` 适配器和经验证的 Cursor 桌面启动器身份，但权限模型不同：应用内动作从 `project_id` 解析 `AuthorizedRoot`；系统 helper 可对未登记项目的本机目录执行一次打开，完整应用可能未运行。

- `probe_cursor()` / `validate_cursor(binary_identity)`
- `build_open_project_plan(project_id)` / `open_project(validated_plan)`
- `probe_support()` / `status()`
- `install_cursor_entry()` / `repair_cursor_entry()` / `remove_cursor_entry()`
- 前端打开项目只传 `project_id + editor_id`；禁止传可执行文件、cwd、参数数组或命令模板。
- Windows Explorer、GNOME Files（Nautilus）、KDE Dolphin 分别实现版本化适配器并实机验证；Nemo、Thunar 等只有存在独立适配器和测试时才声明支持。
- Windows 第一版分别写入 `HKCU\Software\Classes\Directory\shell\<stable-id>` 和 `HKCU\Software\Classes\Directory\Background\shell\<stable-id>` 的静态 verb；`command` 只使用固定 helper 及 `%1`（选中目录）/`%V`（背景），不调用 `cmd.exe`/PowerShell，helper 以原生规则解析后必须恰好收到一个目录。
- Nautilus 使用已探测的 MenuProvider API 直接 argv 调 helper；Dolphin Service Menu 的 `%f`/等价单目录字段码必须作为独立 `Exec` 参数，不能嵌入引号或 shell 表达式。缺依赖/版本不兼容时明确降级。
- 注册项始终指向随应用打包的固定最小辅助程序，不接受用户定义命令模板。helper 正常路径只实现 `open_cursor_folder(path)`，不连接数据库、不扫描目录、不自动启动完整 OMP Manager；错误 UI 可提供由用户点击的固定修复页入口。
- 不尝试把父进程/文件管理器身份作为授权依据；任何本机进程都可调用 helper，但它只接受一个现存绝对本地目录并直接打开 Cursor，不授予 Manager 权限。
- 安装/修复/移除必须幂等并限定当前用户范围；记录 artifact 指纹，只管理本应用命名空间下身份仍匹配的稳定注册 ID。

## 能力探测

至少验证下列官方能力，但不要假设所有版本都存在：

- `omp --version`
- `omp --help`
- `omp config path`
- `omp config list --json`
- `omp models --json --no-extensions`（被动模式）
- `omp usage` 的 JSON/脱敏能力（先通过 `--help` 探测精确参数）
- `omp --profile <name>`
- `omp --cwd <dir>`
- `omp --resume <id或路径>`
- `omp --fork <session>`
- `omp --export <session>`
- `omp auth-broker ... --json`
- `omp auth-gateway check ... --json`
- `omp update`

列表是候选能力，不是允许在真实用户环境自动执行的命令清单。`config list --json` 可能初始化设置并移动损坏配置；usage、Gateway check、模型 refresh 和 update 可能联网或写入；它们只能在隔离上下文验证，或由用户在知情后主动触发。

缓存探测结果时同时保存 OMP 二进制规范路径、版本、mtime/大小/hash、探测方法、证据等级、退出码/响应形状、是否联网/写入和探测时间。二进制变化后使缓存失效。每个功能由 capability flag 控制，不把版本号判断散落在组件中。

当前兼容性基线还要求：

- 18.0.3 的根帮助没有列出 `--fork`，即使目标源码/当前文档存在该参数，也要保持未验证/禁用，直到有安全证据。
- `auth-broker list --json` 返回可登录提供商目录，不是已存账号。
- Profile 没有公开 `list` 命令；发现结果必须注明来源和是否完整。
- `omp usage --json --redact` 是用户触发的联网摘要，不是冷启动凭证枚举。
- 模型 refresh 和扩展发现不是被动探测；M1 先使用无扩展、无刷新列表。

## 路径与 Profile 绑定规则

实现一个外置、可迁移的项目绑定系统：

1. 项目使用规范化绝对路径标识，同时保存用户输入的展示路径。
2. 处理 Windows 盘符、目录实际大小写语义、UNC/长路径前缀、空格、中文、符号链接/联接点、尾部分隔符以及不存在路径；不能用全局 lower-case 代替 Windows 路径身份。
3. 项目主身份是 `target_id + canonical_path`。Git shared/common directory 加仓库内相对子路径仅作为 `git_identity`，用于提示/共享绑定；不能替代路径授权或把另一 worktree 的目录自动加入授权根。
4. 支持路径前缀规则；最长前缀优先，子目录覆盖父目录。
5. 绑定保存在应用数据目录，不写入项目仓库。
6. 每个绑定可以保存：Profile、常用/高级模型角色、允许模型、禁用提供商、账号策略、默认终端方式。
7. 默认账号策略为 OMP 自动选择。固定 Profile 是稳定功能；固定具体凭证仅在 capability `can_pin` 为真时开放。
8. 项目必须通过系统目录选择或等价用户动作形成 `AuthorizedRoot`。不存在路径可作为离线记录，但不能扫描、启动或授予写入。
9. 每次启动/删除/写入都重新解析现有祖先和符号链接/Windows junction，验证没有从授权后发生路径替换。
10. 会话默认按头部 `cwd` 的规范路径归入等于项目根或位于其下的项目；嵌套项目采用最长根，其他 worktree 不默认合并。离线/无法规范化的 `cwd` 只按词法路径显示为未确认，不能扩大授权。

启动设置优先级从高到低：

1. 本次启动弹窗显式覆盖。
2. 恢复会话原模型、思考等级和 credential pin。
3. 项目路径绑定。
4. Profile 默认配置。
5. OMP 全局默认值。

在 UI 和领域对象中保留每个值的 `source`，例如 `launch_override`、`session`、`project`、`profile`、`global`。

## LaunchPlan：先预览，再执行

所有启动必须先生成不可变、可验证、可脱敏展示的 `LaunchPlan`。它至少包含：

```text
target_id
plan_id
created_at
expires_at
input_fingerprint
omp_executable
omp_binary_identity
cwd
profile
action: new | resume | fork | export
session_ref?
model_roles
thinking_level?
credential_policy
terminal_mode: embedded | external
args[]
env_allowlist
env_source_metadata_without_values
temporary_config?
display_preview_redacted
warnings[]
```

执行前后再次校验：

- 可执行文件仍是探测过的 OMP。
- `cwd` 是已授权项目路径。
- Profile 和 session_ref 属于当前 target。
- 模型使用精确 `provider/modelId`。
- 参数数组中没有秘密。
- 环境只包含后端允许的必要系统变量与明确 OMP/提供商变量；计划和 IPC 中只有变量名/来源/存在性，没有值。
- 临时配置位于应用私有临时目录、权限受限且不含凭证。
- 会话/配置/项目身份与预览时一致，capability evidence 仍属于同一 OMP 二进制。
- `plan_id` 未过期、未消费并绑定当前 IPC 调用；成功或不确定提交后不能直接重放。

通过系统进程 API 直接传 `executable + args[]`，禁止使用用户可控的 `sh -c`、`cmd /c`、PowerShell 拼接字符串。安装器是单独的高风险流程，也必须使用固定官方来源、明确预览和用户确认。

## 页面与交互

### 概览

- OMP 路径、版本、能力和更新状态。
- Profile、凭证健康、最近项目/会话、运行中终端。
- 快速选择项目、新建、继续和重新检测。

### 项目

- 添加文件夹；从已有会话 `cwd` 自动发现候选项目。
- 项目卡片显示 Profile、默认模型、会话数、最近使用和健康摘要。
- 项目详情可编辑路径绑定与默认值。
- 点击项目后进入当前 Profile 搜索范围内该项目的全部可读会话列表，显示范围与发现完整性，不自动恢复最新会话。

### 应用内外部编辑器（Cursor）

- 项目卡片/列表项上下文菜单提供“用 Cursor 打开”，同一动作放入可聚焦的更多操作菜单并支持菜单键/`Shift+F10`；系统右键开关不影响此动作。
- 第一版只实现固定 `cursor` 适配器。前端 IPC 只传 `project_id + editor_id`，不能传可执行文件、命令、cwd 或参数数组。
- 后端重新读取项目规范路径，确认它存在、属于 `LocalTarget` 且仍在 `AuthorizedRoot`，再复核 Cursor 桌面启动器身份。具体目录参数协议以目标桌面版本的帮助/平台元数据实测为准，不把独立 Cursor Agent CLI（`agent`）当作桌面启动器。
- 自动检测失败时，用户只能通过系统文件选择器登记 Cursor 程序，后端仍需验证类型并记录文件身份；Cursor 缺失、被替换、项目离线或目标非本机时禁用动作，不回退到其他编辑器或 shell。
- 使用系统进程 API 直接传经验证的可执行文件和单独路径参数，以最小必要环境启动并剥离 OMP/模型提供商/Broker 秘密变量；不执行 shell profile，不把 Cursor 纳入 OMP/PTY 运行注册表，也不随管理器退出而终止。
- 首次启动前说明第三方边界：Manager 不上传项目内容，Cursor 后续的文件访问、联网、索引和遥测由其自身设置与隐私政策决定。

### 操作系统文件夹右键集成（Cursor）

- 设置页提供默认关闭的开关，为操作系统文件管理器安装“用 Cursor 打开”；目标是任意可访问的本地文件夹，不要求目录已添加为 OMP Manager 项目。
- 在平台接口允许时，同时覆盖右键某个文件夹和在当前文件夹空白处右键。只接受单个本地目录；文件、多选、虚拟位置或无法转换为绝对路径的对象不显示或安全拒绝。
- Windows 使用当前用户级稳定注册 ID，分别处理目录项和背景入口；固定注册模板不调用 `cmd.exe`/PowerShell，Explorer 占位符经原生解析后 helper 仍要求恰好一个目录。Windows 11 若只能出现在“显示更多选项”，设置页和支持矩阵必须说明。
- Linux 没有统一协议。Nautilus 使用探测到的 MenuProvider API 以 argv 调 helper；Dolphin Service Menu 的 `%f`/等价单目录字段码作为独立 `Exec` 参数，不能嵌入引号或 shell 表达式。两者分别实机验证，不能用通用 shell 脚本猜测其他文件管理器。
- 右键入口指向随应用打包的固定辅助程序，完整应用不必运行。helper 只读取权限受限、固定 schema 的 Cursor 身份配置，不连接通用数据库；以原生 OS 字符串读取且只接受一个目录参数，验证为现存绝对本地目录后，将原始路径作为单独参数直接传给经验证的 Cursor 桌面启动器。
- 不要把 Cursor Agent CLI（`agent`）误当成桌面启动器。实际启动参数以目标 Cursor 版本的桌面启动器帮助为准；自动检测失败时可让用户通过系统文件选择器指定程序，但仍须验证版本/平台程序元数据并复核文件身份。
- 严禁 `sh -c`、`cmd /c`、PowerShell、URI 拼接、用户命令模板或回退到其他编辑器。路径中的空格、中文、emoji、引号、`&`、分号和换行等平台合法字符必须始终保持为一个参数。
- 右键动作仅授权本次把目录交给 Cursor，不创建 `AuthorizedRoot`、不自动添加项目，也不允许辅助程序读取或扫描目录。首次启用时说明 Cursor 后续文件访问、联网、索引和遥测受其自身设置与隐私政策约束。
- 不信任也不尝试认证 helper 的父进程；任意本机进程都可能直接调用它，但调用只可打开一个现存目录，不授予 Manager 权限或执行附加命令。
- 启用、修复、升级迁移、禁用和卸载均须幂等；记录所写 artifact 的路径/注册 ID 与内容指纹，只修改身份仍匹配的本应用项。同名冲突不得覆盖，Cursor 丢失/被替换时显示本地化修复提示，未支持的 Linux 文件管理器明确显示“不支持”。

### 会话

- 默认搜索项目绑定 Profile；用户可显式包含其他已确认且已授权 Profile。始终展示当前范围、Profile 发现完整性和每条会话所属 Profile。
- 字段：标题、Profile、首条消息摘要、创建/修改时间、状态、模型、提供商、账号掩码、消息数和大小。
- 始终搜索标题/结构化元数据；全文本地索引默认关闭，按 Profile/项目明确授权后才持久化首条消息/正文。关闭时首条摘要按需有界读取，不写入 SQLite；提供关闭、清除和残留说明。支持按状态、日期、模型和账号筛选。
- 只读预览、收藏、标签、显示别名、恢复、分叉、HTML 导出、打开文件位置、移入回收站。
- 收藏、标签和别名只写管理器 SQLite，不改 OMP JSONL。
- 截断/损坏 JSONL 显示部分可读，不影响其他会话。
- 列表显示索引新鲜度；正在追加的文件仅索引完整行，扫描可取消且单个坏文件不阻塞其他结果。

### 启动弹窗

- 显示项目路径、Profile、新建/恢复/分叉、模型角色、思考等级、账号策略、终端方式。
- 恢复时同时显示“原设置”和“本次设置”。
- 每项显示来源；临时修改不默认保存到项目。
- 提供脱敏命令预览和警告。
- 允许“启动并保存为项目默认值”，但要明确列出将永久修改的字段。

### 账号与凭证

- 按 Profile 和提供商分组。
- 记录类别：OAuth、登录型 API Key、环境变量、`models.yml`、Auth Broker、导入来源。
- 显示当前后端能安全发现的掩码身份、组织、类型、来源、有效期、最后检查、健康、禁用/退避和用量摘要，并说明清单是否完整。
- 状态：未知、可用、即将过期、过期、禁用、退避、失败、来源不可用。
- 根据能力显示登录/添加、编辑元数据、刷新、禁用/启用、注销/删除和测试。
- 登录必须承载 OMP 官方流程。完整密钥默认永不显示。
- 环境变量来源只显示允许传给受控 OMP 子进程的变量名/存在性，不执行 shell profile、不枚举全部环境、不把值发到前端。

### 凭证测试

- 默认层只做本地格式、已知到期时间和被动状态检查；刷新、usage 或 Auth Gateway 非严格检查属于用户主动触发的联网层，通常不发送聊天补全。
- 严格检查若会调用模型，按钮和确认框都写明“可能消耗额度”。
- 支持取消、超时、有限并发和提供商级退避。
- 只保存状态、错误分类和时间，不保存响应正文。
- 非严格 Gateway/usage 检查仍可能联网、刷新并持久化 OAuth；标成“联网安全检查”，不能描述为完全无副作用。

### 导入与同步

第一批适配器：

1. OMP 原生 Profile/本地存储迁移。
2. OMP Auth Broker 支持的 CLIProxyAPI 风格 JSON 文件或目录。
3. 在格式可安全识别时支持 Codex、Claude、Gemini CLI 本地认证/配置。
4. 通用 JSON、YAML、`.env`、单文件、目录和手动 API Key。

任何“一键导入”都先显示预览：来源、提供商、掩码身份、类型、有效期、目标 Profile 和冲突。策略为跳过、替换、保留两份；默认按提供商 + 稳定身份指纹跳过重复。格式不确定时 fail closed。

秘密派生的去重指纹使用带用途/版本域分离的本机 keyed HMAC，不保存原始值或无盐哈希，也不跨安装导出。安全密钥不可用时停止持久化去重并报告，不能把 Key 写入 SQLite 作为回退。

### 模型

- 从 `omp models --json` 获取列表，选择器始终为 `provider/modelId`。
- 显示上下文窗口、最大输出、推理/输入能力、费用和认证可用性（若 OMP 提供）。
- 默认角色：`default`、`smol`、`slow`、`plan`。
- 高级设置根据配置架构/能力列出全部角色，例如 `vision`、`designer`、`commit`、`tiny`、`task`、`advisor`；不要把示例永久硬编码为完整集合。
- 支持 Profile 默认和项目覆盖，显示配置层级。
- 自定义提供商用表单 + `models.yml` 预览；保存前验证、备份、原子写入。

### 终端

- 内嵌终端使用真实 PTY 与 xterm.js，支持多标签、resize、Ctrl+C、复制粘贴、颜色、退出码、正常/强制终止。
- Windows 使用 ConPTY；Linux 使用本机 PTY。
- 外部终端优先 Windows Terminal，回退到 PowerShell/命令提示符；Linux 使用系统默认终端并检测常见终端。
- 外部终端缺失时允许切换内嵌终端。
- 关闭仍在运行的内嵌终端先确认并优雅终止。
- PTY 输出走有界队列和背压，限制滚动缓冲并正确处理 UTF-8 分片；终端原始输出不进入普通日志。
- PTY 帧带运行 ID/单调序号并支持有界重放；重连发生序号缺口时明确显示输出已截断。
- WebView reload 后通过 Rust 运行 ID 恢复状态展示；应用崩溃后不能声称可重新附着到已经丢失的 PTY，也不能只凭可能重用的 PID 强杀。
- 外部终端使用逐终端测试过的参数协议或固定私有启动器；不得把项目路径拼入通用 shell 字符串。
- PTY 可能短暂显示/接收 OMP 自行输出/请求的秘密，不对交互字节做会破坏协议的通用替换；只保留在对应 xterm/Rust 有界缓冲，标签关闭后清除，不写日志、SQLite、诊断、通知或搜索索引。
- 键盘输入不记录；API Key/密码交给 OMP 的 no-echo TTY 提示。剪贴板仅由用户显式复制，生产构建关闭 WebView 开发工具。

### 设置、诊断和回收站

- 设置：语言、主题、OMP 路径、默认终端、系统文件夹右键集成状态、文件管理器适配器、Cursor 检测状态/可执行文件路径、日志级别、隐私、全文索引开关。
- 诊断：OMP 版本/能力、Agent 目录、配置解析、路径权限、PTY、外部终端、会话扫描、凭证检查。
- 诊断导出默认不含会话正文和环境变量，并把用户名、主目录、项目/Profile/导入路径及账号掩码替换为包内一致占位符；导出前进行第二次秘密扫描。
- 会话删除时只处理独占 JSONL 与同名 artifact；全局共享 blob 不随单会话移动。同文件系统用原子 rename，跨文件系统用日志化复制/校验/提交/删源流程；可恢复。清空回收站显示数量和大小并确认。
- 全局任务区显示扫描、导入、测试、安装等任务的阶段、取消和脱敏结果；页面切换/重载不重复创建任务。
- 外链只经 Rust 白名单交给系统浏览器；WebView 禁止任意导航和远程脚本。
- 核心流程以 WCAG 2.2 AA 为目标，覆盖键盘、焦点锁定/返回、屏幕阅读器名称、200% 缩放、对比度和减少动态效果；高频 PTY 输出不通过 live region 逐行播报。

## 数据存储

已有 `0001_initial.sql` 草案，先审查再接通运行时，不创建平行数据库或用 ORM 自动重建覆盖它。使用显式 SQLite migrations，至少包含或演进出：

- `execution_targets`
- `omp_installations`
- `capability_evidence`
- `authorized_roots`
- `external_editors`
- `shell_integrations`
- `projects`
- `project_bindings`
- `project_role_defaults`
- `session_index`
- `session_annotations`
- `credential_aliases`
- `import_sources`
- `import_records`
- `trash_items`
- `operation_history`
- `app_settings`

强制规则：

- 已进入仓库基线的 migration 视为只追加；除非能证明从未被任何环境应用，否则新增编号 migration，不原地改写 `0001_initial.sql`。
- 所有关联数据带 `target_id`。
- OMP session id、Profile 名和 credential opaque ref 不视为全局唯一；会话至少按 `target_id + profile_ref + canonical_session_path` 定位，凭证引用绑定 `target_id + profile_ref + backend`。
- 数据库绝不出现 API Key、Access Token、Refresh Token、Cookie 或完整授权头。
- 元数据数据库不是秘密保险库，不实现自创加密。必要的 Broker bearer 只在用户同意后使用 OS Keychain/等价安全存储；安全存储失败时不回退到 SQLite 或明文配置。
- 只缓存 opaque credential reference、掩码身份、别名、状态和时间。
- Cursor 桌面启动器身份与系统注册 artifact/指纹分开存储；只存固定 adapter/registration ID，不存用户可编辑命令模板。
- 迁移前用 SQLite Backup API 或停写检查点生成包含 WAL 状态的一致备份；迁移失败回滚并保留旧文件。
- 会话全文索引默认关闭，优先使用可独立删除且不进入普通元数据备份的 FTS 数据库；关闭并清理后处理 WAL/临时文件，不保留正文或首条消息副本。
- 可重建的索引与不可替代的项目绑定、注释、导入记录分开设计备份优先级。
- 单主实例之外仍启用外键、事务、唯一约束和明确的 WAL/busy timeout；禁止迁移并发执行。
- SQLite、WAL、备份和错误副本都纳入合成秘密/会话正文保留测试。

## 配置写入

- 先读取 OMP 配置架构和有效层级。
- 对真实 Profile 调用 `config list --json` 前说明其可能初始化设置/移动损坏配置，先保存文件身份并准备可恢复备份；禁止使用可能返回秘密的通用 `config get`。
- 基础表单和高级 YAML 共用同一验证层。
- 预览时记录源文件身份，提交前重新比较；发现外部修改即停止并展示冲突。
- 写入同目录临时文件，保留/验证权限与 ACL，刷新后原子 rename；写入前创建时间戳备份。
- 尽可能保留 YAML 注释与键顺序。
- 数组是替换而非追加时在 UI 差异预览中明确说明。
- 凭证不写项目配置；使用 OMP 原生认证、Broker、环境引用或不受版本控制的安全覆盖。
- 本次启动的临时覆盖放应用私有目录，通过 OMP `--config` 传入，退出后清理；不得包含秘密。

## 安装与升级

检测顺序：用户指定路径 → `PATH` → 平台常见安装位置。使用 `omp --version` 验证，不因文件名相同就信任。

一键安装/升级必须：

1. 使用 OMP 官方来源和当时官方推荐命令。
2. 先显示 URL、命令、目标和安全说明，获得明确确认。
3. 不把任何项目路径或凭证插入安装 shell 命令。
4. 优先把固定官方脚本下载到权限受限临时文件、验证下载成功后由明确的解释器执行；若选择官方管道命令，必须隔离为固定模板且无用户插值。
5. 捕获并脱敏日志，允许取消；完成后重新探测。
6. 升级失败时保持现有 OMP 可运行，不删除未知文件。
7. 应用不捆绑固定 OMP 版本，维护已验证能力矩阵。

OMP Manager 自身更新与 OMP 更新是两个独立功能、任务类型和确认流程。应用自动更新只有在签名清单和签名产物都已配置并验证时才能启用；否则只显示官方发布页入口，不能把 OMP 的 `update` 命令用于更新管理器。

## 安全硬要求

这些要求不可用“后续优化”代替：

1. Tauri capability 最小化，禁止 WebView 任意 shell、任意文件和任意 URL 权限。
2. 所有 IPC 输入在 Rust 侧重新验证；TypeScript 类型不是安全边界。
3. 允许目录基于已授权项目、OMP Agent 目录、明确选择的导入/导出路径；处理 `..`、符号链接逃逸和 TOCTOU。
4. 进程统一使用参数数组。用包含空格、中文、`&`、引号、分号、换行和 `$()` 的路径做注入测试。
5. 结构化前端状态、SQLite、URL、日志、错误、通知、自动剪贴板写入、遥测和应用崩溃报告中不出现秘密。透明 PTY 流是受限的短暂例外，绝不复制进这些通道。
6. 实现集中式脱敏器，覆盖 Bearer、常见 Key、Cookie、URL 查询参数、JSON/YAML 敏感字段和 OMP 配置字段。
7. 原始凭证只在 Rust 内存中停留最短时间；能力允许时使用 zeroize。不要在 Redux/Zustand/localStorage 持有。
8. 默认无遥测、无公网监听。OAuth 回调/Broker 仅绑定回环地址并校验 state/bearer。
9. 外部导入只读，限制文件大小、数量、递归、符号链接和解析深度；不执行脚本、模板或 hook。
10. 删除、覆盖、严格测试和网络安装器都要显示精确目标并确认。
11. 会话正文不进入诊断包；用户明确选择时也要警告和脱敏。
12. 不默认请求管理员/root 权限；需要时交给操作系统针对单一步骤授权。
13. Tauri 设置严格 CSP、导航/协议/外链白名单；项目、会话和终端内容不能触发 WebView 导航、远程脚本或任意本地文件打开。
14. Broker snapshot 和任何声称已脱敏的外部载荷都先按秘密处理；在 Rust 内立即投影，原始 body 永不进入 IPC、日志、SQLite、panic 或测试快照。
15. 所有变更操作使用一次性计划或幂等键并在目标级加锁；防止双击、IPC 重放、前端断线重连和超时重试造成重复副作用。
16. 所有解析先实施字节、条目、深度、时间限制；所有进程/PTY/HTTP 流使用有界队列和背压。
17. 运行中进程使用后端拥有的句柄和运行 ID；不得仅凭 PID 操作可能已被系统重用的进程。
18. 秘密、账号身份或会话正文派生的持久指纹按敏感元数据处理；秘密去重使用本机 keyed HMAC，禁止无盐哈希、诊断导出或 fixture 泄露。
19. 不执行 `.bashrc`、PowerShell profile 等初始化脚本来发现环境。OMP 子进程只继承后端固定允许列表；秘密环境值不传给安装器或无关辅助进程。
20. 系统右键集成只写入命名空间化、当前用户级、内容固定的注册项并指向随应用发布的辅助程序。辅助程序只接受一个原生目录参数，以最小环境启动经验证的 Cursor；拒绝附加参数、命令模板、相对路径、非目录、注册劫持和辅助程序身份变化。
21. 文件管理器中的明确右键动作只授权本次打开所选目录，不构成项目授权。辅助程序不得读取目录内容、连接管理器数据库、继承秘密环境值或自动启动完整应用。
22. 应用内动作和 helper 启动 Cursor 时都使用最小必要环境，显式剥离 OMP/模型提供商/Broker 秘密变量；不得把管理器完整环境默认继承给外部编辑器。

维护并增量更新已有 `docs/threat-model.md`，至少持续覆盖：恶意项目路径、恶意会话内容导致 XSS、日志泄密、导入源投毒、配置竞态、临时文件窃取、Broker Token 泄露、幂等/重放、外链导航和依赖供应链。

## 错误与降级体验

每个页面都要能处理：加载、空状态、部分成功、取消、超时、权限拒绝、版本不兼容和可重试错误。

特别要求：

- OMP 缺失：显示安装/选路径/重新检测，不展示假清单。
- JSON 能力缺失：明确进入受限模式；只在解析安全且有测试时使用文本回退。
- 会话损坏：部分预览、只读、建议备份。
- 账号被限流：显示退避截止时间，停止该提供商批量检查。
- 导入源消失：保留历史，不删除目标。
- `can_pin = false`：禁用固定具体凭证，仍允许 Profile 固定和自动选择。
- PTY 失败：保留脱敏错误并提供外部终端回退。
- 更新失败：保留旧 OMP 并重新探测。
- Cursor 不可用：已安装的右键辅助程序显示本地化错误和修复入口；设置页允许重新检测/重新选择，不回退到 shell 或其他编辑器。
- Linux 文件管理器无受支持适配器：不安装猜测性配置，显示当前检测结果和已验证支持矩阵。
- 预览后目标变化：拒绝旧计划，显示冲突并要求刷新。
- 重复点击/重试：返回原任务状态或拒绝已消费计划，不重复执行。
- 数据库被占用/迁移失败：不创建空库掩盖旧数据，提供只读诊断和备份路径。
- 重启发现未完成操作：只读对账并标记待核对；无法证明安全时不自动继续、回滚或杀进程。

## 测试要求

### Rust 单元测试

- Windows/Linux 路径规范化、UNC/长路径、默认与目录级大小写语义、符号链接/联接点。
- Git worktree/common-dir 身份与最长前缀匹配。
- 项目会话归属：根/子目录、嵌套项目最长根、离线路径和其他 worktree 隔离。
- Windows Explorer/Nautilus/Dolphin 右键适配器的支持检测、幂等注册/修复/移除和只删除自身稳定 ID。
- Cursor 桌面启动器检测、可执行文件身份变化，以及辅助程序对单个原生目录参数的验证和参数数组构建。
- LaunchPlan 合并优先级与来源标记。
- 参数数组构建与命令注入阻断。
- JSONL 正常、未知记录、截断、损坏、运行中追加。
- OMP JSON 多版本 fixture 解析和 capability 映射。
- 配置验证、备份、原子写入与回滚。
- 脱敏器的正向、负向和嵌套数据测试。
- 导入检测、去重、冲突和 fail-closed。
- 回收站移动、恢复和冲突。
- 后台任务去重、scope lock、取消、幂等键、计划过期和崩溃对账。
- SQLite 迁移并发、WAL/备份、磁盘满和外部文件修改冲突。
- Broker 秘密载荷在 Rust 投影后不出现在 DTO、错误、日志和数据库。

### TypeScript 测试

- 配置来源展示和启动弹窗状态。
- 项目 → 当前 Profile 搜索范围内全部可读会话（范围/完整性可见）→ 恢复/覆盖流程。
- 凭证 capability 控制和严格测试确认。
- 导入预览与冲突选择。
- 错误、空状态、键盘和焦点行为。
- 设置页正确显示右键适配器支持/已安装/失效状态，以及启用、修复、移除和 Cursor 不可用原因。
- i18n key 完整性，组件中无关键硬编码字符串。
- WebView reload 后任务/PTY 状态恢复，重复点击不重复创建操作。
- 恶意 HTML/SVG/URL/终端转义仅作为文本呈现，不能导航或执行。

### 集成测试

- 使用临时 Agent 目录和 stub `omp` 可执行文件，覆盖各命令、退出码、超时、无效 JSON 和 stderr。
- 使用合成凭证与会话 fixture，绝不读取测试机器真实 `~/.omp`。
- PTY 启动、输入、resize、Ctrl+C、退出码和终止。
- 合成秘密经 PTY 输出后只存在于对应有界终端缓冲，关闭标签后不出现在应用状态、日志、SQLite、诊断或通知。
- SQLite 迁移、崩溃中断、重启恢复。
- Tauri IPC 对未授权路径和命令的拒绝。
- 用 stub 文件管理器与 Cursor 启动器验证辅助程序在完整应用未运行时只传递一个原生目录参数；文件、多选、相对路径、附加参数、任意可执行文件和注册劫持均被拒绝。
- LaunchPlan 在 OMP 二进制、会话或项目路径预览后变化时拒绝执行。
- 全文索引默认关闭，启用/关闭/清除后检查 SQLite、WAL 和备份中的正文边界。
- 第二实例不会并行迁移或重复执行目标变更。

### 端到端场景

1. OMP 缺失 → 用户确认安装 → 通过固定 stub 安装器/隔离测试源完成 → 重新检测；自动化测试不访问真实官方安装器。
2. 添加两个项目 → 绑定不同 Profile → 分别新建会话。
3. 点击项目 → 列出全部历史会话 → 选择一条 → 查看原设置 → 覆盖模型 → 内嵌终端恢复。
4. 同一流程改用外部终端。
5. 在合成 Broker 或明确具备能力的后端上：导入预览 → 冲突跳过 → 同步 → 安全检查 → 禁用/恢复；无能力后端验证按钮禁用和解释。
6. 会话移入回收站 → 恢复。
7. 老版本 OMP → 部分能力禁用且解释清楚。
8. 双击启动/导入/删除 → 只执行一次；WebView reload → 恢复原任务状态。
9. 预览 LaunchPlan → 外部替换 OMP/会话/项目路径 → 执行被拒并要求重新预览。
10. 全文索引默认关闭 → 明确启用 → 搜索 → 关闭并清除 → 正文副本验证不存在。
11. 安装系统右键入口 → 关闭 OMP Manager → 对未登记为项目的任意测试目录选择“用 Cursor 打开” → Cursor 收到单个原生路径；重复修复不产生重复项，禁用/卸载清理自身注册。
12. Cursor 缺失/身份变化 → 右键辅助程序显示修复提示；未支持的 Linux 文件管理器 → 设置页拒绝伪安装并展示支持矩阵。

测试路径必须包含：空格、中文、emoji、`&`、单/双引号、分号、换行或平台允许的其他危险字符。使用假 Key 验证任何构建产物、日志和诊断包都不包含该字符串。

## 性能基线

- 先显示缓存框架，再后台探测；不要让冷启动被所有 OMP 子进程串行阻塞。
- 1,000 个会话时列表快速可交互；会话扫描并发有界，解析在后台完成。
- 全文索引增量更新、可暂停、可关闭和可清除。
- UI 主线程不读大文件、不运行子进程。
- 批量凭证检查默认总并发不超过 3，同一提供商不超过 1，并尊重退避。
- 性能报告记录 OS/硬件/存储/fixture/冷热缓存条件，列表与搜索基线至少运行 5 次并报告 p95，不用单次最佳值宣称达标。

## 每次续作的执行协议

1. 先用只读方式列出现状：当前里程碑、相关代码/测试、需求 ID、已有未提交改动和本次明确不做的范围。
2. 在现有架构内完成一个最小真实切片；不要同时创建全站静态页面，不要用 fixture 作为生产回退。
3. 测试默认使用临时 Agent 目录和 stub OMP。除非用户明确授权，不对真实 Profile 执行 usage、Gateway check、登录/注销、导入、配置修改、会话启动或安装/升级。
4. 修改过程中先跑相关的最小测试；交付前从仓库根运行 `npm run check`。若因平台依赖无法执行某项，报告准确命令、错误和未验证范围，不能把未运行写成通过。
5. 涉及 Windows/Linux 分支时，当前主机只能证明当前平台。另一平台必须由 CI/实机结果证明；仅通过编译或代码审查标为“实现、未实测”。
6. 涉及新依赖时说明必要性，使用现有包管理器安装并更新锁文件；不手工猜版本，不引入与已有方案重叠的状态/UI/数据库框架。
7. 涉及 IPC、权限、持久化、凭证、外链、进程或网络边界时，同步更新相应测试和 `docs/architecture.md`/`docs/threat-model.md`；只有 OMP 能力证据变化时才更新兼容矩阵。
8. 收尾时检查源码中新增的 TODO、空 handler、吞错 catch、硬编码中文、任意 shell/路径/URL 权限和假数据。范围外事项记录为后续任务，不伪装完成。

## 里程碑实施顺序

### M0：事实验证与骨架（已完成基线，不重做）

已有交付：

- Tauri/React/Rust 可运行骨架和最小权限配置。
- `ExecutionTarget`、`OmpAdapter`、`CredentialBackend`、`CredentialImporter` 接口。
- OMP 能力探测 CLI 与脱敏 fixture。
- `docs/architecture.md`、`docs/threat-model.md`、`docs/omp-compatibility.md`。
- Linux PTY spike；Windows 代码路径存在但仍需真实 Windows 验证。
- 明确本地凭证 CRUD 与 credential pin 的安全实现结论。

先运行现有质量门确认 M0 未回归，再进入 M1。没有新证据时保持 `can_pin = false`、本地精确凭证 CRUD 不可用、无 companion bridge 的结论；不要把 Windows 未实测改成已完成。

### M1：纵向可运行版本

当前默认工作入口。按以下依赖顺序做小步、可测试的真实切片：

1. **持久化与任务基础**：接通已有 SQLite migration、备份/回滚、单实例/连接管理、`AuthorizedRoot`、`TaskSupervisor` 和结构化任务事件。
2. **项目与绑定**：目录选择授权、跨平台规范化、Git identity、Profile 来源标记、最长前缀绑定、项目 UI，以及只接受 `project_id` 的应用内“用 Cursor 打开”；M1 不安装系统文件夹右键项。
3. **会话只读链路**：安全发现、固定标题槽/未知记录/截断容错、增量索引、新鲜度、列表和只读预览；不写 JSONL。
4. **模型与启动设置**：无扩展/无刷新的模型列表、常用角色、设置来源合并、`can_pin` 降级和启动弹窗。
5. **LaunchPlan**：短期一次性 ID、输入/二进制指纹、脱敏预览、授权校验、过期/重放/TOCTOU 拒绝。
6. **内嵌 PTY**：Rust 运行注册表、xterm.js、输入/resize/退出/优雅与强制终止、有界输出/背压、WebView reload 状态恢复。

交付完整闭环：

`检测 OMP → 添加项目 → 绑定 Profile → 列出会话 → 选择新建/恢复 → 选择模型 → 预览 LaunchPlan → 内嵌 PTY 启动`

M1 明确不包含凭证写操作、外部导入、安装/升级、外部终端、系统文件夹右键集成、回收站和配置编辑；它们保留到 M2。不要为了页面完整提前引入空按钮。

同时交付 SQLite migration、错误模型、任务生命周期、脱敏日志、自动化测试，并更新 README 当前里程碑和相关架构/威胁/兼容性文档。只有上述闭环及需求 AC-02、AC-03、AC-04、AC-07 的内嵌部分、AC-09 和 AC-11 相关项通过后，才把 M1 标为完成。

### M2：第一版功能完成

- 外部终端、操作系统任意文件夹的“用 Cursor 打开”右键集成、分叉、导出、回收站。
- 凭证总览、登录/管理、安全/严格测试。
- 外部导入、预览、冲突、重新同步。
- 模型角色基础/高级设置和自定义提供商。
- 安装、升级、诊断导出、中文 UI、主题。
- Windows/Linux 可安装测试构建；未签名构建明确标记为非公开发布包。

### M3：发布质量

- Windows x64 安装包。
- Linux x64 AppImage 与至少一种发行版包。
- CI 中的 lint、typecheck、unit、integration、build。
- 依赖审计、许可证清单、隐私说明、数据清除说明。
- 为签名、自动更新、ARM64 和英文完整翻译保留清晰任务；不要假装未配置的签名已经完成。

## Definition of Done

一个功能只有同时满足以下条件才算完成：

- 连接真实领域服务，不是 UI 假数据。
- 有加载、空、成功、取消、错误和能力缺失状态。
- 有对应测试，且测试不读取真实用户数据。
- 日志和错误已脱敏。
- 权限范围已审查。
- 中英文 i18n key 已加入。
- 文档说明数据位置、恢复方式和已知限制。
- Windows 与 Linux 的差异被抽象或明确测试。
- 重复点击、取消、超时、重连和目标在预览后变化均有确定行为。
- 真实 OMP 能力由证据开启；`documented` 或失败探测不会被当作已支持。

第一版整体完成时，必须做到：

1. 从干净 clone 按 README 能启动开发环境、运行测试并构建安装包。
2. 所有 lint、format、typecheck、单元和集成测试通过。
3. 核心流程没有 TODO、空按钮、静态假清单或吞掉错误的 catch。
4. 需求文档中的 AC-01 至 AC-12 有自动化测试或可复现的人工验收记录。
5. 给出已验证 OMP 版本、能力差异和明确的降级清单。
6. 用合成秘密执行扫描，确认源码、构建产物、SQLite、日志和诊断包无泄露。
7. 不直接写 `agent.db`，不改写 OMP 会话 JSONL，不从前端执行任意 shell。
8. 全文索引默认关闭，数据保留、清除和卸载边界可验证。
9. 安装、导入、删除、配置写入和启动计划具备幂等/一次性语义与崩溃对账。

## 最终交付清单

- 可运行源代码与锁文件。
- Windows/Linux 开发与打包说明。
- 数据库 migrations。
- 合成测试 fixture 与完整测试。
- `README.md`。
- `docs/architecture.md`。
- `docs/threat-model.md`。
- `docs/omp-compatibility.md`。
- `docs/development.md`。
- 用户数据位置、备份、卸载和回收站说明。
- 当前限制与下一步 WSL/SSH 执行目标设计说明。

开始时先输出一份简洁的仓库检查结果和基线回归结果。按当前记录应制定本次 M1 最小切片计划并立即在已有代码上落地；若代码、测试与文档已共同证明 M1 完成，则报告证据并选择下一个未完成里程碑的最小切片，不回退重做。不要重复询问上面已经确定的产品偏好，也不要越过本次明确切片顺手实现后续范围。
