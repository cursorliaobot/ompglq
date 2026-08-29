# Cursor 账号管理

Cursor 本机多账号扩展，支持安全保存与切换账号、查看额度、管理设备会话、浏览器授权，以及可恢复的 Sand/Grok 补丁。

侧栏名称为“账号管理”，扩展 ID 为 `local.cursor-account-manager`。

## 3.0 安全改造

- 账号元数据保存在 `globalState`，并在扩展全局存储中维护跨窗口权威 revision；access token、refresh token、Cookie 等凭据只保存在 Cursor/VS Code `SecretStorage`。
- 旧 `cursorAccountManager.accounts`、`keepchat.accounts` 和 `manualCursorToken` 会幂等迁移。只有凭据写入并读回验证成功后，才删除旧明文。
- 若不同配置作用域存在互相冲突的旧手动 Token，扩展不会猜测或删除任何一个值，而是锁定联网和登录态写入并提示处理。
- 账号导出默认使用 `scrypt + AES-256-GCM` 加密。旧明文 JSON 只能在明确警告并确认后导入。
- 切号使用 SQLite 一致备份、事务内前像校验、原子 JSON 替换和恢复 journal；只修改固定鉴权键，不覆盖布局、通知、遥测或 `cursorai/serverConfig`。恢复发现 journal 之外的新登录态时会零写入并保留恢复依据。
- 启动时不再修改或删除 `~/.cursor/mcp.json`。

## 功能

| 功能 | 行为 |
|---|---|
| 账号管理 | 浏览器授权、Token 导入、本机登录态导入、备注和加密备份 |
| 安全切号 | 校验身份和 Token，备份 `state.vscdb` 与 `storage.json`，写后读回验证 |
| 恢复 | 启动时恢复中断事务；命令“恢复最近切号前的登录态”只恢复鉴权键 |
| 额度与计费 | 读取 Auto / Other / Bot 用量，并在确认后修改超额设置 |
| 设备管理 | 查看登录会话，并在双重确认后撤销指定会话 |
| Sand / Grok | 事务化注入与严格恢复；版本、commit、路径或哈希冲突时拒绝写入 |

切号后必须完整退出并重新打开 Cursor；`Reload Window` 不足以刷新进程内鉴权缓存。只有 web token 的账号不能自动续期，建议使用浏览器授权升级为带 refresh token 的账号。

## 网络声明

`cursorAccountManager.networkMode` 有三种模式：

- `off`：在读取凭据前拒绝所有扩展网络请求，不启动后台任务。
- `manual`（新安装默认）：只在用户主动授权、刷新、打开控制台或管理设备时联网。
- `automatic`：允许手动操作，并启用后台额度刷新和临期令牌续期。

扩展 HTTP 客户端只允许 HTTPS 访问以下官方主机和固定路径：

- `cursor.com`：`/api/auth/me`、`/api/auth/stripe`、`/api/auth/sessions`、`/api/auth/sessions/revoke`、`/api/usage-summary` 和列出的 dashboard 额度接口。
- `api2.cursor.sh`：`/auth/usage-summary`、`/auth/poll`、`/oauth/token`。

浏览器授权会打开 `https://cursor.com`，临时 CDP 端口只绑定 `127.0.0.1`，并使用独立 profile。扩展不联系第三方统计、代理或遥测端点。

## 迁移与恢复

升级前可保留一份现有数据备份。首次启动时若显示“安全迁移被阻止”：

1. 不要删除旧设置或存储文件。
2. 检查用户、工作区和文件夹作用域中的旧 `manualCursorToken`；若值不同，先确定要保留的账号。
3. 重新加载扩展，让迁移再次执行。成功前扩展保持网络 `off`，并拒绝账号存储或登录态写入。

若显示“切号恢复失败”，不要继续手工编辑 `state.vscdb`。保留扩展全局存储中的 journal 与备份，再通过命令“恢复最近切号前的登录态”处理。恢复成功后完整重启 Cursor。

## Sand / Grok 风险

Sand 会修改 Cursor 安装文件，可能触发完整性校验、更新冲突、兼容问题或账号风控。所有入口都需要 Webview 与宿主确认；自动逻辑只检测和提示，不会静默补丁或提权。

内置提权使用结构化参数、私有临时目录、nonce、哈希和结果校验，但它只是“尽力加固”。没有受操作系统保护的签名原生 Helper 时，无法彻底消除同用户恶意进程替换提权 JavaScript、Node/Electron 可执行文件或输入的风险。高风险环境应禁用此功能。

## 配置与命令

设置：

- `cursorAccountManager.networkMode`
- `cursorAccountManager.autoRefreshAccountTokens`
- `cursorAccountManager.cursorOAuthClientId`
- `cursorAccountManager.sandAppRoot`（仅使用 machine/global 值，忽略工作区覆盖）

手动 Token 不再是明文设置。请使用命令“账号管理: 安全设置手动 Token”“清除手动 Token”或“查看手动 Token 状态”。旧 `keepchat.*` 命令别名暂时保留用于兼容。

## 构建与验证

要求安装 Node.js 与 npm：

```bash
npm ci
npm test
npm run build
npm run verify
npm run package
```

先运行 `npm run build` 原子更新 `dist`。`npm run package` 不会掩盖漂移，而是把源码、测试和运行文件复制到私有快照，在同一快照上执行语法检查、故障测试、`src`/`dist` 一致性、包内容白名单和 VSIX 校验。成品还会校验原始 ZIP 路径、文件类型、逐文件哈希、XML manifest 与 Content Types；源码、测试、构建脚本和敏感夹具不会进入安装包。

不要在主力 Cursor 或真实账号上测试破坏性路径。自动测试使用临时目录、模拟安装以及真实 SQLite WAL 夹具；Windows、macOS 和 Linux 的真实提权对话、安装权限与完整重启仍需分别进行人工确认。

安全问题请参阅 [SECURITY.md](SECURITY.md)，许可证见 [LICENSE](LICENSE)。
