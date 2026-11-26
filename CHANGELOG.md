# 变更日志

`dsh-simple-cursor` 所有值得注意的用户可见变更。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号与
`package.json` 保持一致。影响协作与开发流程的面向 Agent 变更也会一并记录。

[English](CHANGELOG.en.md)

## [Unreleased]

### 新增

- 新增英文版说明与变更日志（`README.en.md`、`CHANGELOG.en.md`），与中文版互相链接，并将 `README.en.md` 纳入打包清单。
- 补充完整的工程与协作文档：`AGENTS.md`、`tests/AGENTS.md`、`.agents/skills/simple-cursor-{change,verify,release}` 工作流、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/SECURITY.md` 以及 `docs/decisions/` 下的 7 篇架构决策记录（ADR）。
- 新增 `check:pack`（`npm pack --dry-run`）并纳入 `npm run check`，搭配 `.editorconfig` 与 GitHub Actions 工作流统一本地和 CI 检查入口。
- 补充订阅用量测试：覆盖密钥兑换返回 403，以及 `DashboardService` 返回 401/403 时归类为 `INVALID_CREDENTIAL` 的场景。

### 变更

- 重写全部中英文文档、Agent 开发规范与 Skill 流程说明，统一术语与行文风格，移除 `README.md` 与开发文档中硬编码的本地开发目录路径。
- `README.md` 明确区分插件自身的密钥读取方式与 DSH `credentials` 服务底层的来源优先级，补充本地安装与模块重载说明。
- `npm test` 改为精确匹配 `tests/*.test.mjs`，避免误将辅助模块当作测试文件执行。
- `usage.js` 请求头的 `user-agent` 改为直接读取 `package.json` 版本号，移除硬编码的 `0.2` 并补充防漂移测试。

### 说明

- 本次未改动模型推理、工具往返、凭证存储或设置页的运行时行为。
- 真实 Cursor 请求、设置页交互与订阅用量展示需在接入真实账号后人工确认，具体检查项见 `docs/DEVELOPMENT.md`。
