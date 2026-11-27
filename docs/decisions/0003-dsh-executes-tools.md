# 0003 工具统一由 DSH 执行，仅向 Cursor 开放自定义工具

Status: accepted
Date: 2026-11-25

## 背景

Cursor 的本地 agent 默认带有文件读写、终端命令、网页搜索等内置工具，同时支持从项目目录或用户目录自动加载 MCP 服务配置。与此同时，DSH 自身已经具备完整的工具体系、文件沙箱与用户审批机制。如果允许两套工具同时生效：

- 同一轮对话中可能出现两个运行时并发读写工作区，冲突与副作用难以追踪。
- Cursor 内置工具会在本地直接执行操作，完全绕过 DSH 的文件权限控制与交互式审批。
- 本地项目或用户目录下的外部 MCP 配置可能将未经审计的工具注入当前会话。

由于 DSH 会将当前允许使用的工具 Schema 传给模型适配器，并在收到 `tool-calls` 分块后自行调度执行，插件只需将 Cursor 的工具调用挂起转交 DSH 即可。

## 决策

初始化本地 Cursor agent 时固定传入以下配置：

```js
tools: ['mcp'],
local: {
  cwd,
  settingSources: [],
  fs: emptyFs(),
  store: createInMemoryStore(sdk),
},
```

- `tools: ['mcp']` 仅保留自定义工具通道，由 Cursor 后端按 `x-cursor-agent-allowed-tools` 限制可用工具集（对后端行为的信任假设）。
- `local.fs: emptyFs()` 作为客户端侧纵深防御：SDK 不注册宿主 `Shell`、`ReadLints`、`SemanticSearch`、`applyAgentDiff`、`recordScreen` 与 `computerUse` 执行器，文件类内置执行器被限制在空的只读内存虚拟树上，同时阻断宿主 Git 状态上报。
- `settingSources: []` 禁止读取项目级与用户级 MCP 配置、Hooks 或环境规则。
- 每次调用 `agent.send()` 时，仅将当次 DSH 请求传入的工具（`name`、`description`、`parameters`）注册为自定义工具；其 `execute` 回调只负责挂起请求并把参数传回 `bridge`，等 DSH 执行完毕后在下一轮按 `toolCallId` 回填结果。

## 影响

- 工具允许列表的第一道强制点在 Cursor 后端，而客户端侧通过 `emptyFs()` 与 `settingSources: []` 确保即便后端违约下发内置工具，也无法直接触及宿主工作区或启动默认 Shell。
- 会话中仅会出现 DSH 显式下发的工具，不会混入 Cursor 内置工具或外部隐式 MCP 工具，所有实际操作均受 DSH 的权限策略与用户审批约束。
- 若未来确需评估开放某类 Cursor 原生工具，必须作为独立的安全架构变更重新评审审批与沙箱方案。
- 单元测试需长期保留对 `tools: ['mcp']`、`settingSources: []` 以及 `fs` / `store` 透传的精确断言，防止重构时意外放宽。

## 备选方案

- **开启 Cursor 内置工具**：会直接绕过 DSH 的沙箱与审批策略，也违背本插件仅作为「模型提供方」的职责边界，放弃。
- **完全禁用所有工具**：虽无越权风险，但模型将无法在 DSH 中完成代码阅读、编辑等 Agent 任务，不满足核心使用场景，放弃。
- **允许 `settingSources` 加载本地 MCP**：会引入不受宿主管控的外部工具集合，破坏权限一致性，放弃。
