# 简单 Cursor（Simple Cursor）

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
[![支持的 DSH 版本: 0.2.2-rc.4+](https://img.shields.io/badge/DSH-0.2.2--rc.4%2B-4d6bfe)](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)

[English](README.en.md)

> 第三方社区插件，非 Cursor 官方出品，与 Cursor 官方无隶属或背书关系。

适用于 DSH 的 Cursor 模型提供方插件。通过官方 `@cursor/sdk` 将你自己的 Cursor 订阅接入 DSH，在模型选择器中提供 `Cursor` 选项，请求用量记入你自己的 Cursor 账号：

- **账号模型与上下文变体**：自动拉取账号可用模型，并将支持不同上下文窗口的模型展开为独立可选项（如 `300K`、`1M`），同步向 DSH 报告真实上下文容量以驱动自动压缩。
- **工具仍由 DSH 执行**：只向 Cursor 开放 DSH 传入的自定义工具，关闭 Cursor 内置的文件、终端与网页工具，避免两套运行时同时操作工作区或绕过 DSH 审批策略。
- **密钥托管与订阅用量**：在 **更多 → 设置 → Cursor** 中保存 API Key（存入 DSH 凭证服务，不落插件配置文件），并在同一页面查看当前套餐、计费周期、各类额度百分比与重置时间。

## 安装

本插件依赖 `@cursor/sdk` 与 `@deepseek-ai/schemastery`，安装前需先在插件目录拉取依赖：

```sh
cd /path/to/simple-cursor
npm install
```

随后可通过以下任一方式将本地目录安装到 DSH：

- **DSH Web 插件页面**：打开 **插件 → 添加插件**，选择本地 `simple-cursor` 目录即可直接加载生效（不改变当前默认模型）。
- **命令行安装**：在终端执行以下命令（会自动处理依赖并写入 profile），完成后重启一次 DSH 即可加载：
  ```sh
  dsh plugin --profile web add /path/to/simple-cursor
  ```

## 配置与用量查询

### 配置 API Key

1. 前往 [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations) 生成 API Key（个人密钥或团队服务账号密钥均可）。
2. 打开 DSH Web 的 **更多 → 设置 → Cursor**，粘贴密钥并点击 **保存**。

密钥以 `CURSOR_API_KEY` 为键名写入 DSH 的 `credentials` 凭证服务，不会写入 `cordis.patch.yml`，也不会回传给浏览器；修改后在下一次模型请求时立即生效。

插件代码本身不读取环境变量、profile 配置或 `~/.cursor/sdk/auth.json`。若运行环境中存在同名环境变量或 `.env` 条目，DSH 自身的本地凭证提供方可能会按「托管存储 > 环境变量 > `.env`」的优先级解析，并在设置页状态栏注明当前来源（如 `env`）；点击 **清除** 会移除托管存储中的密钥。

### 查看订阅用量

保存密钥后，**更多 → 设置 → Cursor** 页面会展示当前账号的订阅用量，包括套餐名称、计费周期、总用量、Auto + Composer 用量、API 模型用量、额度池、按量消费及下次重置时间。用量由服务端在后台换取短期令牌查询并缓存 30 秒，点击 **刷新** 可跳过缓存立即更新。

### 可选插件配置

如需调整高级选项，可在 profile 的 `cordis.patch.yml` 中为 `id: simple-cursor` 添加 `config`：

- `cwd`：本地 Cursor agent 存放运行状态的目录，须为已存在的绝对路径。默认使用系统临时目录下的 `dsh-simple-cursor`。
- `contextWindow`：当模型目录未返回 `context` 参数时的兜底上下文容量（单位 token），默认为 `128000`。

## 功能说明

### 模型目录与上下文窗口

安装加载后，模型选择器中会出现 **Cursor** 提供方。插件会使用已配置的密钥拉取账号模型列表（缓存 60 秒）：

- **上下文变体展开**：若模型提供多个 `context` 档位，选择器会将其拆分为独立条目（例如默认档位 `Claude Opus 5.5 · 1M` 与显式档位 `Claude Opus 5.5 · 300K`）。选中后会把完整变体参数（含 `context` 及必要的 `maxMode`）传给 SDK，并将对应容量报给 DSH 用于估算上下文压缩时机。
- **推理强度（Reasoning Effort）**：对暴露推理档位参数的模型，自动接入 DSH 的推理强度选择器。
- **离线兜底**：目录尚未拉取成功时，选择器先展示 `Composer 2.5`、`Auto` 等基础条目，待实际发起对话时再校验凭证与模型。

### 会话续接与工具往返

- **会话级本地 Agent**：每个 DSH 会话在内存中维护独立的本地 Cursor agent。发起工具调用时，当前 Cursor 运行保持挂起，交由 DSH 执行工具并把结果送回同一次运行，直到模型完成整轮回复。
- **按历史指纹续接**：连续对话时只发送新增的用户消息；当会话发生上下文压缩、回退或历史改写时，自动重建新 agent 并传入最新完整对话记录。
- **辅助请求隔离**：自动生成会话标题、上下文压缩等带 `purpose` 标记的后台请求使用独立 agent，不会混入当前主对话。

## 使用限制

- 仅在本机运行本地 agent，不使用 Cursor 云端虚拟机。
- Cursor Agent 接口不支持 `temperature`、`maxTokens` 与 `stop` 参数：普通对话若显式传入这三项会直接报错提示；会话标题、上下文压缩等 DSH 内部辅助请求会自动改用 Cursor 默认参数执行。
- 长上下文或 `Max Mode` 变体可能产生更高额度消耗或按长上下文档位计费，请以 Cursor 官方计费规则为准。
- SDK 独立 system prompt 字段需特定账号权限，插件统一将一次性系统提示词拼入首条请求正文发送。
- 多轮工具调用期间，Token 用量会在该次 Cursor 运行整体结束时统一上报。
- 发送图片依赖宿主的 `attachments` 服务；若当前部署未启用该服务，含图片的请求会报错中止。
- 仅供个人在自有 DSH 环境中使用，请遵守 Cursor 服务条款，勿将个人订阅用于共享或转售。

## 安全边界

- **密钥隔离**：API Key 只通过 `ctx.credentials.resolve('CURSOR_API_KEY')` 在服务端读取，浏览器端仅可写入与清除，无法读回明文或短期访问令牌。
- **受保护的用量接口**：`/api/dsh-simple-cursor/usage` 注册在 DSH `connection` 的认证通道上，复用宿主的同源校验、Cookie 鉴权与 Peer 授权，仅返回脱敏后的额度与百分比字段。
- **严格限制工具范围**：创建本地 agent 时固定设置 `tools: ['mcp']` 与 `settingSources: []`，禁止加载 Cursor 内置工具及本地项目/用户级 MCP 配置。

完整的威胁模型与安全规则见 [docs/SECURITY.md](docs/SECURITY.md)。

## 开发与验证

| 路径 | 职责 |
|---|---|
| `index.js` | Node 服务端入口：配置校验、注册 `cursor` 适配器、挂载用量路由、读取图片附件、卸载清理 |
| `adapter.js` / `catalog.js` | `LlmAdapter` 实现、账号模型目录缓存、上下文与推理强度变体解析、API Key 读取 |
| `bridge.js` / `transcript.js` | 会话级本地 agent 生命周期、历史指纹比对、请求渲染、工具调用挂起与恢复 |
| `chunks.js` / `queue.js` / `errors.js` | DSH 流式分块组装、事件队列、SDK 与网络错误码映射 |
| `sdk.js` / `config.js` / `schema.js` | `@cursor/sdk` 动态加载与 agent 参数封装、配置校验与 Schema 定义 |
| `usage.js` | 短期令牌兑换、Cursor 用量接口查询、数据归一化与 30 秒内存缓存 |
| `client.js` | 浏览器端入口：「更多 → 设置 → Cursor」面板、密钥保存/清除与订阅用量展示 |
| `tests/*.test.mjs` | 基于 `node:test` 的离线单元测试（覆盖目录、桥接、转录、路由、用量与前端组件） |

常用开发命令（CI 执行同一套检查）：

```sh
npm install      # 首次拉取 @cursor/sdk、schemastery 与 peer 依赖
npm run check    # 语法检查 + 单元测试 + npm pack 清单校验
npm test         # 仅运行单元测试（离线运行，不访问 Cursor 服务）
```

本地联调提示：

- 修改 `client.js`、`locale/*.json` 或 `icon.svg` 后，刷新浏览器页面即可看到更新（图标或文案若命中浏览器缓存可强制刷新）。
- 修改 `index.js`、`adapter.js`、`bridge.js` 等服务端文件后，因默认 Web profile 的 HMR 不会监听外部源码目录保存事件，需先移除再重新安装同一目录（`remove_bundle` → `install_bundle`）以触发模块重载，或直接重启 DSH。若包已安装，直接调用 `install_bundle` 会返回 `already-installed`，请先执行移除。

架构细节、调试指南与历史设计决策见 [docs/](docs/)（[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[DEVELOPMENT.md](docs/DEVELOPMENT.md)、[decisions/](docs/decisions/)），面向 Agent 的开发规范见 [AGENTS.md](AGENTS.md)，版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。
