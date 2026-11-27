# 变更日志

`dsh-simple-cursor` 所有值得注意的用户可见变更。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号与
`package.json` 保持一致。影响协作与开发流程的面向 Agent 变更也会一并记录。

[English](CHANGELOG.en.md)

## [1.0.0] - 2026-11-27

### 新增

- 新增英文版说明与变更日志（`README.en.md`、`CHANGELOG.en.md`），与中文版互相链接，并将 `README.en.md` 纳入打包清单。
- 补充完整的工程与协作文档：`AGENTS.md`、`tests/AGENTS.md`、`.agents/skills/simple-cursor-{change,verify,release}` 工作流、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/SECURITY.md` 以及 `docs/decisions/` 下的 7 篇架构决策记录（ADR）。
- 新增 `check:pack`（`npm pack --dry-run`）并纳入 `npm run check`，搭配 `.editorconfig` 与 GitHub Actions 工作流（固定 Action Commit SHA 并启用 `npm ci --ignore-scripts`）统一本地和 CI 检查入口。
- 补充订阅用量、桥接边界、凭证脱敏及设置页竞争条件测试：覆盖密钥兑换返回 403、`DashboardService` 返回 401/403、并发去重、冷却限流、`holding` 取消、空闲与工具超时回收、敏感 `cwd` 校验、错误脱敏及组件卸载中止等场景。

### 变更

- **安全与资源边界加固**：
  - `sdk.js` 为本地 Cursor agent 传入自定义内存 `LocalAgentStore` 与 `fs: emptyFs()`，消除 SQLite 磁盘持久化并作为客户端纵深防御禁用本机文件/Shell 执行器及宿主 Git 状态读取；`dispose()` 按 `agentId` 自动清理 SDK 运行期生成的对应 `agent-transcripts` 目录。
  - `bridge.js` 默认临时目录以 `0700` 创建并校验所有权且拒绝符号链接；会话槽位仅保存 API Key 的 `sha256` 指纹；对 `sessionKey` 参数做 `encodeURIComponent` 转义；为挂起工具（上限 128、超时 10 分钟、拒绝重复 `toolCallId`）与空闲/挂起会话（默认 15 分钟 TTL、`holding` 阶段监听取消信号）增加超时与生命周期回收。
  - `config.js` 收紧 `cwd` 校验，拒绝符号链接、非当前用户所有目录、系统根目录及 `~/.ssh`、`~/.dsh`、`~/.cursor`、`~/.config` 等敏感目录。
  - `queue.js` 为事件队列增加有界上限（10,000 条）并在溢出时 fail-closed；`errors.js`、`adapter.js`、`bridge.js` 与 `index.js` 对上游错误信息执行 `sanitizeErrorMessage` 脱敏并收敛非预期异常输出。
  - `usage.js`、`index.js` 与 `client.js` 为用量查询增加并发请求去重、请求取消信号传播、`?refresh=1` 服务端 3 秒最小冷却限流（返回 `429` + `Retry-After`）、组件卸载取消及请求代际号防乱序覆盖；`index.js` 在检测到 `CURSOR_BACKEND_URL` 环境变量时输出启动安全警告。
  - `.gitignore` 补充常见私钥与 `.env` 忽略模式；`README.md` 与 `docs/SECURITY.md` 补充 `@cursor/sdk` 专有许可、原生二进制依赖与 SDK 遥测/本地残留说明。
- 重写全部中英文文档、Agent 开发规范与 Skill 流程说明，统一术语与行文风格，移除 `README.md` 与开发文档中硬编码的本地开发目录路径。
- `README.md` 明确区分插件自身的密钥读取方式与 DSH `credentials` 服务底层的来源优先级，补充本地安装与模块重载说明。
- `npm test` 改为精确匹配 `tests/*.test.mjs`，避免误将辅助模块当作测试文件执行。
- `usage.js` 请求头的 `user-agent` 改为直接读取 `package.json` 版本号，移除硬编码的 `0.2` 并补充防漂移测试。

### 说明

- 真实 Cursor 请求、设置页交互与订阅用量展示需在接入真实账号后人工确认，具体检查项见 `docs/DEVELOPMENT.md`。
