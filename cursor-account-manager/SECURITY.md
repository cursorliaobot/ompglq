# 安全策略

## 支持范围

仅 3.x 最新版本接收安全修复。旧版可能把 Token 存在明文配置或扩展状态中，应先备份并升级。

## 报告漏洞

请优先通过仓库的 [GitHub Security Advisory](https://github.com/kuk-888/cursor-account-manager/security/advisories/new) 私下报告，不要在公开 Issue 中粘贴 Token、Cookie、备份、`state.vscdb` 或个人账号信息。

报告请包含受影响版本、平台、最小复现步骤、预期影响和已做的缓解。请使用虚构凭据或脱敏夹具。

## 数据与网络边界

- 账号元数据保存在扩展 `globalState`，并由扩展全局存储中的 revision 文件协调多窗口更新；Token、Cookie 和 refresh token 保存在 VS Code/Cursor `SecretStorage`。
- 导出默认采用 `scrypt + AES-256-GCM`；弱密码仍可能遭到离线猜解。
- 扩展只允许访问 `https://cursor.com` 与 `https://api2.cursor.sh` 的固定接口。`off` 模式在读取凭据前拒绝所有扩展网络请求。
- 浏览器授权会启动隔离的本机浏览器 profile，并通过仅绑定回环地址的 CDP 临时注入会话 Cookie。
- 扩展不会在启动时修改或删除 `~/.cursor/mcp.json`。

## 登录态文件的并发边界

SQLite 鉴权键在 `BEGIN IMMEDIATE` 事务内校验前像；恢复只覆盖 journal 明确记录的版本。`storage.json` 使用内容快照、写前比较、同目录临时文件和原子替换，并会合并比较前发现的非鉴权更新。

便携 Node.js 文件 API 不提供“比较内容并条件 rename”的单一原子系统调用。因此，若 Cursor 本体恰好在最终比较与 rename 之间写入同一个 `storage.json`，仍存在极短的竞争窗口。切号时应关闭其他 Cursor 窗口，完成后完整重启；发现恢复冲突时扩展会零写入并保留 journal，不能保证消除该操作系统级窗口。

## Sand / Grok 残余风险

Sand 功能会修改 Cursor 安装文件，可能触发完整性校验、更新冲突、兼容问题或账号风控。恢复只在 manifest、版本、commit、路径和哈希全部匹配时执行。

内置管理员提权采用结构化参数、私有临时目录和结果完整性校验，但它只是“尽力加固”。没有受操作系统保护的签名原生 Helper 时，无法彻底消除同用户恶意进程替换扩展 JavaScript、Node/Electron 可执行文件或提权前输入的攻击面。高风险环境应禁用 Sand，并由管理员使用独立、签名的部署机制。

## 不应提交的材料

不要提交真实账号 Token、Cookie、加密备份密码、未脱敏数据库、浏览器 profile、私钥或包含这些内容的日志。若怀疑凭据已泄露，请立即在 Cursor 中撤销相关会话并轮换凭据。
