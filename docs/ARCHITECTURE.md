# 架构说明

本文档描述 `dsh-simple-cursor` 当前的实际架构，而非历史提案。如架构、凭证机制或安全边界发生调整，请同步更新本文。

插件通过官方 `@cursor/sdk` 将个人 Cursor 订阅接入 DSH，作为可选模型提供方。插件本身不接管工作区操作：Cursor 仅负责模型推理与工具调用决策，实际工具执行全部留在 DSH 内完成。

## 运行时结构

```text
DSH Agent / LLM 运行时
└── 提供方路由 "cursor"（adapter.js: CursorAdapter）
    ├── providerInfo          → { id: "cursor", name: "Cursor" }
    ├── listModels / resolveModel
    │   └── catalog.js        ← Cursor.models.list(apiKey)
    │         ├── 60 秒内存缓存 / 静态列表兜底
    │         ├── context 参数 → 按上下文容量拆分为独立模型条目
    │         └── reasoning 参数 → 暴露 efforts / defaultEffort
    ├── resolveApiKey         → ctx.credentials.resolve("CURSOR_API_KEY")
    └── stream(options)
        └── bridge.js
            ├── sessionKey    → 按会话与用途隔离本地 agent 实例
            ├── transcript.js → 历史指纹计算、续接分类、请求拼装
            ├── sdk.js        → @cursor/sdk Agent.create / agent.send
            │     └── tools: ["mcp"], settingSources: []
            ├── queue.js + chunks.js → 组装 DSH StreamChunk
            └── 工具调用挂起（park）→ 交由 DSH 执行 → 下一轮请求恢复同一次运行

DSH Web 页面
└── client.js（模块 ID "dsh-simple-cursor"）
    ├── settings.section "simple-cursor" → 「更多 → 设置 → Cursor」面板
    ├── ctx.remote.credentials.describe / set / unset
    └── GET /api/dsh-simple-cursor/usage（携带同源登录 Cookie）

Node 服务端入口（index.js）
├── resolveConfig 与 Config Schema 校验
├── ctx.llm.registerAdapter(["cursor"], adapter)（随 ctx.effect 生命周期卸载）
├── ctx.inject(["connection"]) → connection.fetch.register（挂载订阅用量路由）
├── ctx.get("attachments").readImage（按需读取图片附件）
└── 插件卸载时调用 bridge.dispose() 释放全部本地 agent
```

整体分为三条独立链路：

1. **模型推理链路**：DSH LLM 运行时 ↔ `adapter` ↔ `bridge` ↔ `@cursor/sdk`，完全在服务端进程内交互，不暴露额外 HTTP 路由。
2. **设置与用量链路**：浏览器面板通过宿主的 `credentials` Remote 保存或清除密钥，并通过 DSH `connection` 认证保护的 `/api/dsh-simple-cursor/usage` 查询脱敏用量。
3. **工具执行链路**：Cursor 提出工具调用后由 `bridge` 挂起当前运行，交由 DSH 执行工具并在下一轮请求中将结果回填至同一次运行；插件不开启任何 Cursor 内置工具。

## 模块职责与边界

| 文件 | 对外契约 | 职责边界 |
|---|---|---|
| `index.js` | 导出 `name`、`inject=['llm']`、`Config`、`apply(ctx, config)`；通过 `ctx.effect` 注册 `cursor` 适配器并在卸载时释放 `bridge`；`connection` 可用时挂载用量路由；通过 `attachments.readImage` 读取图片 | 不实现流式分块协议，不直接保存或缓存密钥，不执行工具 |
| `adapter.js` | `CursorAdapter extends LlmAdapter`，实现 `providerInfo`、`listModels`、`resolveModel`、`stream`；导出 `resolveApiKey` | 不直接调用 SDK，不维护会话级 agent，不解析 SDK 流回调 |
| `catalog.js` | 60 秒目录缓存、`toModelInfo(s)`、`contextOf`、`reasoningOf`、`modelSelection`、`modelRouteOf`、`contextModelId`、`contextTokensOf` 及离线兜底模型 | 纯函数与内存缓存模块；不依赖 `ctx`、HTTP、凭证服务或 SDK |
| `bridge.js` | 会话级 agent 生命周期管理、`fresh`/`follow-up`/`tools` 决策、工具调用挂起与恢复、队列消费、中途取消与统一释放 | 不读取凭证、不拉取模型目录、不接触路由或 DOM |
| `transcript.js` | `canonicalMessages`、`classify`、`renderTranscript`、`withSystemPrompt`、`toolResultPayload` | 纯数据转换模块；不依赖网络、SDK 对象或 `ctx` |
| `chunks.js` | `createBlockWriter`、`mapUsage`、`finishStop`、`finishToolCalls` | 无会话状态，不调用 SDK |
| `queue.js` | 连接 SDK 回调与 DSH 异步生成器的有序事件队列（`push` / `fail` / `next(signal)`） | 不感知模型或工具业务语义 |
| `sdk.js` | `localAgentOptions`、`createSdkClient`；首次调用时动态导入 `@cursor/sdk`；映射自定义工具与 `Cursor.models.list` | 不参与会话续接判定，不管理凭证来源 |
| `errors.js` | `BridgeFailure`、`failure`、`failureFromUnknown`，将 SDK 与网络异常映射为稳定错误码 | 不打印日志，不直接面向前端 UI |
| `config.js` | 提供方与凭证常量、`resolveConfig`、`contextWindowOf`、`unsupportedCallOption`、`rejectedCallOption`、`defaultCwd` | 不依赖 SDK 或 `ctx` |
| `schema.js` | Cordis `Config` Schema（`cwd`、`contextWindow`） | 细粒度运行时校验交给 `config.js` |
| `usage.js` | `USAGE_ROUTE_PATH`、`UsageFailure`、`normalizeUsage`、`fetchCursorUsage`、`createUsageClient`；负责短期令牌兑换、`DashboardService` 查询、字段归一化与 30 秒缓存 | 不负责宿主请求鉴权，不涉及前端渲染 |
| `client.js` | 通过 `__ModuleLoader__.load({ id: 'dsh-simple-cursor', factory })` 注册 `settings.section`；内置中英字典，处理密钥保存/清除与用量展示 | 不读取密钥明文，不自行实现鉴权，不发起模型请求 |
| `tests/*.test.mjs` | 基于 `node:test` 的离线行为测试（规范见 `tests/AGENTS.md`） | 不连接真实 Cursor、外网、浏览器或运行中的 DSH |
| `locale/*.json` | 插件详情页标题 `meta.title` 与简介 `meta.description` | 不存放设置页运行时文案 |
| `cordis.patch.yml` | 声明 `id: simple-cursor` / `name: dsh-simple-cursor` 插件挂载项 | 不存放配置默认值 |
| `package.json` | 包清单、检查脚本、`files`、`dsh` 字段、引擎约束与依赖声明 | 不含业务逻辑 |

## 核心请求流程

### 1. 模型对话与工具往返

1. DSH 选定提供方 `cursor` 与目标模型 ID（可能带有 `::context=` 内部后缀），先调用 `resolveModel` 获取展示名称、`context.contextWindow` 与可选的 `reasoning` 档位；若目录拉取失败，则回退到静态模型列表并使用配置的 `contextWindow`。
2. 调用 `CursorAdapter.stream(options)` 时按顺序执行：
   - **参数检查**：`rejectedCallOption(options)` 拦截普通对话中传入的 `temperature`、`maxTokens` 或非空 `stop` 并抛出 `UNSUPPORTED_OPTION`；带非空 `purpose` 的辅助请求跳过此检查。
   - **密钥读取**：`resolveApiKey(ctx)` 每次从 `credentials` 服务实时解析密钥，不在适配器内缓存。
   - **目录加载**：`catalog.load(apiKey)` 读取 60 秒缓存；若拉取失败则仅打印一次警告，此时若请求显式指定了 `reasoningEffort`，因无法校验合法性直接报错中止，否则继续执行。
   - **变体解析**：`modelSelection(model, reasoningEffort, models)` 校验上下文与推理强度，生成传给 SDK 的 `{ id, params, maxMode }`。
   - **转发桥接**：调用 `bridge.stream(options, { apiKey, model, loadImage })`。
3. `bridge` 根据 `sessionKey(request)` 定位会话槽位：
   - 若该槽位正处于 `running` 状态，直接抛出 `INVALID_REQUEST`（同一会话禁止并发请求）。
   - `fresh`：销毁已有旧会话（如有），确保 `cwd` 目录存在，调用 `Agent.create` 新建实例，将完整对话历史拼成单条用户消息发送。
   - `follow-up`：槽位处于 `idle`、历史前缀指纹完全一致，且新增后缀仅含 `user` / `developer` / `system` 消息时，仅发送新增后缀。
   - `tools`：槽位处于 `holding` 且新增后缀恰好对应全部挂起的工具调用结果时，兑现挂起的 Promise，唤醒同一次运行继续输出。
4. `start()` 拼装提示词（仅当一次性辅助调用传入 `options.system` 时将其前置到正文开头），通过 `loadImage` 加载图片字节，再调用 `agent.send({ text, images, model, tools }, listeners)` 将增量文本、思考过程和工具调用推入有序队列。
5. `consume()` 从队列消费事件并产出 DSH `StreamChunk`：
   - 文本与思考块依次发出 `block-start`、增量 `*-delta`，切换类型或收尾时发出 `block-end`。
   - 工具调用先进入缓冲区，在最后一次回调后静默 30 ms（`TOOL_BATCH_MS`）合并为同一批次统一发出 `block-start`、`tool-call-delta`、`block-end` 与 `finish { kind: 'tool-calls' }`，同时将会话置为 `holding`。
   - 整次运行正常完成时，依次发出 `usage`（若 SDK 返回了有效计数）与 `finish { kind: 'stop' }`。
   - 未产出任何内容块时抛 `EMPTY_RESPONSE`，以错误状态结束时抛 `TRANSPORT`，`run.wait()` 异常时通过 `failureFromUnknown` 映射为 `AUTH`、`RATE_LIMIT` 等稳定错误码，收到取消信号时抛 `ABORTED`。
6. 在多轮工具往返中，DSH 执行完工具后会在下一轮请求附带 `tool` 角色消息；`bridge` 按 `toolCallId` 将结果回填给挂起的回调，使同一运行继续生成后续回复。若带回的工具结果与挂起集合不一致，`classify` 会自动判定为 `fresh`，销毁旧实例并重开新 agent。
7. 发生异常、取消或插件卸载时，`drop(session)` 会取消底层运行、销毁 agent、拒绝所有未决回调并清理会话表。

## 会话隔离与历史指纹

### 会话槽位键（`sessionKey`）

```text
session:<sessionId>                 # 普通对话（缺省 sessionId 时为 session:default）
purpose:<sessionId>:<purpose>       # 后台辅助请求（会话标题、上下文压缩、评审等）
```

- 普通主对话与后台辅助请求严格隔离，绝不共用本地 agent。
- 不同 DSH 会话之间互不共享本地 agent。
- 同一槽位同一时刻只允许一个运行中请求，并发调用直接报错，不做隐式排队。
- 本地 agent 仅驻留进程内存，宿主重启或插件重载后自动从 `fresh` 重新开始，不向 DSH 会话日志写入私有状态。

### 历史指纹与续接判定

`canonicalMessages()` 将消息列表提取为可确定性比对的规范结构：保留消息 `role` 与内容块核心字段（文本与思考正文、工具调用的 `id`/`name`/`arguments`、图片附件 ID 与 `offloaded` 标记、文件附件 ID、工具增删名称，以及 `tool` 消息的 `toolCallId` 与 `isError`），忽略原始图片字节与展示层元数据。

`classify(seen, messages, pendingIds)` 按以下顺序判定：

1. `seen` 为空、新消息列表变短，或任意前缀消息指纹不一致 → `fresh`。
2. 无新增后缀消息 → `fresh`。
3. 存在待决工具调用，且新增后缀恰好提供这些调用的全部结果（允许夹带 `assistant` 消息）→ `tools`。
4. 无待决工具调用，且新增后缀全部为 `user`、`developer` 或 `system` 消息 → `follow-up`。
5. 其他情况（如上下文压缩改写了历史、替换了助手回复等）→ `fresh`。

走 `fresh` 路径时，完整对话会按角色标签渲染为单条用户消息发给新 agent：

```text
System:
…                         # 仅在一次性调用显式传入 options.system 时前置

User:
…

Assistant:
…

Tool result (call-1):
…
```

历史中的工具调用渲染为 `[tool call <name> <id>]` 加参数文本；图片在正文中记为 `[image N]` 占位，原始字节通过 `images` 数组传给 SDK（已卸载的图片记为 `[image offloaded: <name>]`）。

插件自身不对对话历史做截断，上下文压缩完全由 DSH 根据 `resolveModel` 返回的 `context.contextWindow` 触发；压缩完成后因前缀指纹变化会自动走 `fresh` 将压缩后的新上下文传给新 agent。

## 模型目录与变体解析

每个 `CursorAdapter` 实例持有一个单槽目录缓存（有效期 60 秒，并发请求复用同一个 Promise，失败不缓存）。缓存不按密钥分桶：更换密钥后模型推理会立即使用新密钥，但模型选择器在最多 60 秒内可能仍展示旧缓存列表，这在单用户本机场景下属于已知取舍。

`toModelInfos(provider, model)` 将带有 `context` 参数的目录项展开为独立可选项：

| 目录条目形态 | 生成的选择器条目 | 上下文容量来源 |
|---|---|---|
| 不含 `context` 参数 | 单个条目，ID 为原始 Cursor 模型 ID | 回退使用配置的 `contextWindow`（默认 `128000`） |
| 含 `context` 参数 | 默认档位保持原始模型 ID；其余档位使用 `<model>::context=<encodeURIComponent(value)>`，展示名统一带 ` · <档位名>` 后缀 | `contextTokensOf()` 解析档位真实容量（支持 `300k`、`1m`、`1.5m` 及纯数字，无法识别时回退 `contextWindow`） |

`modelSelection()` 优先匹配同时满足所选 `context` 与 `reasoningEffort` 的目录变体，保留其完整 `params` 与 `maxMode`；若目录未列出精确组合，则以对应 `context` 的基础变体为底合并参数，且仅在该 `context` 下所有变体都要求 `Max Mode` 时才自动置 `maxMode: true`。`reasoningOf()` 自动识别 `reasoning`、`reasoning_effort`、`effort`、`thinking` 参数并映射为有序推理档位。

## 流式分块与用量统计

`chunks.js` 严格按以下顺序产出分块：

```text
block-start { index, blockType }
text-delta | reasoning-delta { index, text }
block-end { index, block }
tool-call-delta { index, id, name, argumentsDelta }
usage { usage }
finish { reason: { kind: 'stop' | 'tool-calls' } }
```

- 每个 `block-start` 必有对应的 `block-end`，`index` 按内容块首次出现顺序递增。
- 工具调用参数始终序列化为原始 JSON 字符串。
- 工具挂起阶段以 `finish { kind: 'tool-calls' }` 结束当轮流，不提前发送 `usage`；整次运行最终完成时才在 `finish { kind: 'stop' }` 前发送一次完整的 `usage`。
- `mapUsage()` 仅在 `inputTokens` 与 `outputTokens` 均为非负有限数时产出统计；当 `totalTokens` 已等于 `input + output` 时视为缓存已折算进输入，不再重复附带缓存字段。

## 凭证与订阅用量

### 凭证解析

API Key 唯一读取路径为 `ctx.credentials.resolve('CURSOR_API_KEY')`：

```text
设置页输入 → ctx.remote.credentials.set("CURSOR_API_KEY", value)
           → DSH 凭证存储
           → 每次请求实时调用 ctx.credentials.resolve("CURSOR_API_KEY")
           → normalizeApiKey() 去除首尾空白并拦截非法 HTTP Header 字符
```

`Config` Schema 不设密钥字段，`resolveConfig` 显式拒绝 `apiKey`、`apiKeyEnv` 等未知配置项。凭证服务缺失、未配置或格式非法时分别抛出 `MISSING_CREDENTIAL` 或 `INVALID_CREDENTIAL`，引导用户前往「更多 → 设置 → Cursor」。

### 订阅用量路由与设置面板

当宿主存在 `connection` 服务时，`index.js` 通过 `connection.fetch.register` 挂载精确路由：

- `GET /api/dsh-simple-cursor/usage`：读取 30 秒内存缓存（按 `sha256(apiKey)` 索引）。
- `GET /api/dsh-simple-cursor/usage?refresh=1`：跳过缓存重新查询。

服务端先调用 `POST https://api2.cursor.sh/auth/exchange_user_api_key` 将 API Key 兑换为短期访问令牌，再并行请求 `GetCurrentPeriodUsage` 与 `GetPlanInfo`（单次超时 15 秒），经 `normalizeUsage()` 清洗后仅返回套餐名、价格、周期、起止时间、各项百分比、额度池、按量消费与 `fetchedAt`，响应头固定附带 `cache-control: no-store`。

该路由完全依托 DSH `connection` 的 `/api` 认证通道完成同源检查、登录态校验与 owner Peer 授权；若宿主未启用 `connection`，用量路由不会挂载，但模型提供方功能本身不受影响。

`client.js` 在页面模块加载器下注册 `dsh-simple-cursor`，声明注入 `['slots', 'locale', 'remote', 'remote.credentials']`，向 `settings.section` 插入 `Cursor` 分区（`order: 12`，位于 Models 与 Plugins 之间），使用 `--dsw-alias-*` 主题变量渲染密码框、保存/清除按钮与订阅用量进度条。

## 错误码对照表

| 错误码 | 产生模块 | 触发条件 |
|---|---|---|
| `UNSUPPORTED_OPTION` | `adapter.js` | 普通对话请求包含 `temperature`、`maxTokens` 或非空 `stop` |
| `UNSUPPORTED_REASONING_EFFORT` | `catalog.js` | 目标模型不支持所选推理强度，或目录拉取失败时仍显式传入了推理强度 |
| `UNSUPPORTED_CONTEXT` | `catalog.js` | 目标模型不支持所选上下文窗口变体（插件自有错误码） |
| `MISSING_CREDENTIAL` | `adapter.js` | 宿主缺少 `credentials` 服务、未保存密钥或读取失败 |
| `INVALID_CREDENTIAL` | `adapter.js` / `usage.js` | 密钥为空、含非法 Header 字符，或上游返回 `401`/`403` |
| `INVALID_REQUEST` | `bridge.js` / `sdk.js` | 同一会话并发请求、工具缺失名称或存在重名工具 |
| `EMPTY_RESPONSE` | `bridge.js` | 运行正常结束但未产出任何文本、思考或工具块 |
| `STREAM_CLOSED` | `bridge.js` | 工具结果尚未回填前运行已提前结束，或流状态异常关闭 |
| `ABORTED` | `bridge.js` / `queue.js` | 请求 `signal` 触发取消、运行被中止或会话被释放 |
| `AUTH` | `errors.js` | 携带密钥请求模型时上游返回 `401`/`403` |
| `ACCOUNT_QUOTA` | `errors.js` | 上游返回 `429` 且错误信息指向配额或用量耗尽 |
| `RATE_LIMIT` | `errors.js` | 其他 `429` 限流错误 |
| `SERVER` | `errors.js` | 上游返回 `5xx` 服务端错误 |
| `UNKNOWN_MODEL` | `errors.js` | SDK 配置错误且明确指向未知模型 |
| `CONTEXT_WINDOW_EXCEEDED` | `errors.js` | 错误信息表明超出上下文窗口上限 |
| `TRANSPORT` | `errors.js` / `bridge.js` | 未归类的网络传输或底层运行异常 |
| `USAGE_TIMEOUT` | `usage.js` | 上游用量查询超时或被取消 |
| `USAGE_UNAVAILABLE` | `usage.js` | 上游用量接口不可达、拒绝访问或返回格式无效 |

## 测试分层

| 层级 | 测试方式 | 覆盖重点 |
|---|---|---|
| 纯逻辑模块 | 直接导入 `catalog.js`、`transcript.js`、`chunks.js`、`config.js`、`schema.js`、`sdk.js` | 目录展开、历史指纹分类、分块拼装、配置校验、SDK 参数 |
| 模型适配器 | 注入模拟 `bridge`、`listModels` 与 `resolveApiKey` | 变体解析、容量上报、离线回退、单一凭证来源 |
| 会话桥接 | 注入模拟 SDK 客户端与可控 `defer` 调度器 | 首轮、`follow-up`、工具挂起与恢复、历史改写、辅助隔离、取消与释放 |
| 服务端入口 | 模拟 `ctx` 捕获 `connection.fetch.register` 路由并替换 `fetch` | 适配器挂载、用量路由响应、凭证缺失与字段脱敏 |
| 浏览器设置页 | 挂载模拟 `__ModuleLoader__` 与精简版 React | 分区注册、表单与密码框属性、按钮状态、中英文文案 |
| 订阅用量 | 注入模拟 `fetch`、`now` 与 `ttlMs` | 短期令牌兑换、数据归一化、缓存控制、错误归类与防泄露 |

## 非目标

- 不使用 Cursor 云端虚拟机，仅在本机运行本地 agent。
- 不启用 Cursor 内置文件、终端或网页工具，工具执行权始终留在 DSH。
- 不向浏览器暴露原始模型目录报文、上游用量原始响应、API Key 或短期访问令牌。
- 不自建独立鉴权、限流或跨用户隔离机制，统一复用 DSH 的 `connection` 与 `credentials` 基础设施。
- 不做跨进程或持久化会话恢复，本地 agent 仅保存在当前进程内存中。
