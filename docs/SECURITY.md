# 安全说明

`dsh-simple-cursor` 负责保管与使用用户的 Cursor API Key、将对话上下文发往 Cursor 模型接口，并在设置面板中展示订阅用量。凭证隔离、工具执行边界与路由鉴权属于硬性安全约束，修改相关代码时不得放宽。

## 威胁模型

- **保护资产**：Cursor API Key、用于查询用量的短期访问令牌（Access Token）、账号套餐与消费数据、会话对话内容（提问、回复、图片附件、工具参数与执行结果）以及本机临时会话状态。
- **主要攻击面**：
  - 浏览器 ↔ 服务端：`/api/dsh-simple-cursor/usage` 路由与宿主的 `credentials` Remote 接口。
  - 服务端 ↔ Cursor 上游：`api2.cursor.sh` 的短期令牌兑换与 `DashboardService` 查询接口，以及 `@cursor/sdk` 发起的模型请求。
  - 服务端 ↔ DSH 工具层：工具 Schema 透传与工具调用结果回填。
  - 本机其他非授信进程、诱导访问本地端口的恶意网页、DNS Rebinding 与异常上游报文。
- **非目标场景**：远程多租户托管、公网裸露部署与跨操作系统用户隔离（本插件仅面向单用户本机 DSH 环境）。

## 信任链路

```text
浏览器设置页
  │  携带 DSH 签名的 HttpOnly Cookie，经 Host / Origin 同源校验
  ▼
DSH connection 的 /api 认证通道
  │  完成登录态认证与 owner Peer 权限校验
  ▼
用量路由处理函数（index.js）
  │  仅 owner Peer 请求可抵达，插件不自建第二套鉴权
  ▼
credentials.resolve("CURSOR_API_KEY") ──► Cursor 上游服务
  │                                        ├── 兑换短期令牌并查询用量（HTTPS Bearer）
  │                                        └── 发起模型推理请求（@cursor/sdk）
  ▼
脱敏后的归一化用量字段 / 模型流式分块
```

关于凭证来源优先级的说明：**插件代码只调用 `ctx.credentials.resolve('CURSOR_API_KEY')`，绝不直接读取 `process.env`、profile 配置文件或 `~/.cursor/sdk/auth.json`**。但 DSH 自身的本地 `credentials` 提供方默认支持多层数据源（优先级依次为：托管存储文件 > 进程启动环境变量 > 项目 `.env` > 用户目录 `.env`）：

- 在设置页点击「保存」会将密钥写入最高优先级的托管存储文件，设置页状态栏通过 `describe` 返回的 `source` 展示当前生效来源。
- 若宿主进程环境或 `.env` 中存在同名 `CURSOR_API_KEY`，即使未在设置页保存，`credentials.resolve` 也可能返回该环境值。这是宿主凭证服务的统一设计；如需禁用环境层解析，应在宿主 profile 的 `credentials` 提供方配置中收紧，而非修改插件绕过凭证服务。

## 凭证安全规则

1. **单一读取入口**：服务端统一通过 `ctx.credentials.resolve('CURSOR_API_KEY')` 实时获取密钥，每次请求动态读取，不落盘，仅在当次请求与活跃 SDK agent 生命周期内驻留（`bridge` 会话槽位仅保存密钥的 `sha256` 指纹用于轮换比对）。
2. **禁止旁路配置**：严禁新增 `process.env`、`Config.apiKey`、`Config.apiKeyEnv`、SDK 本地登录文件读取或硬编码密钥。`Config` Schema 仅保留 `cwd` 与 `contextWindow`，`resolveConfig` 显式拒绝任何未知字段，并校验 `cwd` 必须为非符号链接、当前用户所有且不属于系统目录或敏感凭证目录（如 `~/.ssh`、`~/.dsh`、`~/.cursor`、`~/.config` 等）。
3. **前端只写不读**：`client.js` 仅调用 `credentials.describe`、`set` 与 `unset`，无法读回密钥明文；输入框固定配置 `type="password"`、`autoComplete="off"` 与 `spellCheck={false}`，保存成功后立即清空输入状态；卸载时自动中止未完成的用量请求，并使用请求代际号防止过期响应覆盖当前视图。
4. **严禁回显泄露**：报错文本、终端日志与 HTTP 响应体中不得包含原始 API Key 或短期访问令牌。`normalizeApiKey` 在校验失败时仅提示「包含无法放入 HTTP 请求头的字符」，绝不拼接原值；`sanitizeErrorMessage` 会对上游错误信息中的 `Bearer` 令牌、密钥字面量、URL 查询参数与控制字符做脱敏并限制长度。
5. **轮换即时生效**：更新密钥后下一次模型请求即读取新值；`bridge` 检测到 `session.apiKeyFingerprint` 变更时会立即销毁旧的本地 agent 实例。
6. **空值按缺失或非法处理**：空白字符串会被 `normalizeApiKey` 拦截并归类为 `INVALID_CREDENTIAL`，不允许用占位符绕过凭证检查。

## 订阅用量路由约束

`index.js` 在宿主存在 `connection` 服务时注册：

```text
GET /api/dsh-simple-cursor/usage            # 命中 30 秒内存缓存
GET /api/dsh-simple-cursor/usage?refresh=1  # 跳过缓存重新查询（最小刷新间隔 3 秒）
```

- **必须走 `/api` 认证通道**：通过 `connection.fetch.register` 挂载精确路径，交由宿主 `connection` 统一执行 Host/Origin 校验、Cookie 鉴权与 owner Peer 授权；禁止注册裸 `webServer` 路由或编写本机免鉴权分支。
- **缺失服务时安全跳过**：宿主未启用 `connection` 时不挂载该路由，不影响模型推理主功能。
- **最小请求面**：仅允许 `GET` 方法（`requestBody: 'buffered'`），查询参数只识别 `refresh=1`，绝不从 URL 参数读取密钥或令牌。
- **禁止端侧缓存与原始报文透传**：所有响应均附带 `cache-control: no-store`；经 `normalizeUsage()` 白名单提取套餐、周期、百分比、额度与时间戳，丢弃上游其余字段，绝不回传 API Key 与短期访问令牌。
- **并发去重、取消传播与刷新限流**：`createUsageClient` 对同指纹并发请求共享同一条上游查询；路由将 `request.signal` 透传至上游请求；`?refresh=1` 强制刷新在服务端受 3 秒最小间隔限制，超出频率返回 `429`（`RATE_LIMIT`）及 `Retry-After` 头。
- **收敛错误输出**：仅透传 `UsageFailure` 与凭证读取阶段产生的安全错误码（`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`），未知异常统一返回固定文案，不透传上游原始报错正文。
- **哈希索引缓存**：30 秒内存缓存以 `sha256(apiKey)` 作为键名，不保存密钥明文，也不落盘。

## 工具执行边界

创建本地 Cursor agent 时，`sdk.js` 固定传入以下安全配置：

```js
{
  tools: ['mcp'],
  local: {
    cwd,
    settingSources: [],
    fs: emptyFs(),
    store: createInMemoryStore(sdk),
  },
}
```

- **后端允许列表与客户端纵深防御**：`tools: ['mcp']` 会随请求头 `x-cursor-agent-allowed-tools` 发往 Cursor 后端，由后端限制模型可见工具集为自定义 MCP 工具通道；**这一层允许列表由 Cursor 后端单点强制**，属于对上游服务端的信任假设。作为客户端侧纵深防御，插件同时传入 `local.fs: emptyFs()`（使 SDK 不注册本机 `Shell`、`ReadLints`、`SemanticSearch`、`applyAgentDiff`、`recordScreen`、`computerUse` 执行器，并将内置文件类执行器限制在只读空的内存虚拟文件树上，同时阻断宿主 Git 状态读取）以及 `settingSources: []`（禁止加载项目/用户级 MCP、Hooks 与规则配置），并受 SDK 自身的权限决策层约束。
- **隔离外部环境配置**：`settingSources: []` 禁止自动加载项目目录或用户主目录下的 MCP 服务与规则文件，防止未审计的外部工具注入会话。
- **工具交由 DSH 执行**：自定义工具的 `execute` 回调仅将调用请求挂起（park）转交给 DSH，实际执行、权限判定与用户审批全部由 DSH 完成，结果仅按 `toolCallId` 精确回填；重复 `toolCallId`、超出单轮挂起上限（128）或等待超时（默认 10 分钟）时一律 fail-closed 并销毁会话。

## 出站数据说明

当用户主动选择 `Cursor` 作为模型提供方并发起对话时，以下内容会通过加密连接发送至 Cursor 后端（默认 `https://api2.cursor.sh`）：

- 对话消息记录（首轮或重建实例时发送完整可见历史，`follow-up` 阶段仅发送新增消息）及一次性系统提示词（拼入用户消息正文）。
- 当前会话可用的 DSH 工具名称、描述、参数 Schema，以及工具执行完毕后返回的文本或图片结果。
- 消息中附带的图片字节（通过宿主 `attachments` 服务读取）及所选模型变体参数。
- **SDK 伴随元信息与遥测**（`@cursor/sdk@1.4.2` 内置行为）：
  - **运行遥测（`sdk.run.created` 等）**：发送至 Cursor 分析接口，包含提示词的 `sha256` 哈希（`prompt_hash`，resume 时省略）、`prompt_length`、模型与参数、agent/run/request ID、`has_images`/`is_resume`/`mcp_server_count`、OS 平台/架构与 SDK 版本；`agent.dispose()` 时触发异步 flush（最长约 2 秒）。
  - **请求上下文（request-context）**：包含 OS 版本、Shell、时区、配置的工作目录路径与 `process.cwd()`（启用 `local.fs: emptyFs()` 后，宿主 Git 仓库状态不会发送给模型）。
  - **Statsig Bootstrap**：SDK 初始化时向 Cursor 后端请求 `BootstrapStatsig`（Bearer 短期令牌，空请求体 `{}`）；`@cursor/sdk@1.4.2` 已显式启用 `disableLogging: true`、`disableStorage: true` 与 `preventAllNetworkTraffic: true`，不向 Statsig 第三方域名直连。

插件不会自行扫描或上传工作区文件，发往 Cursor 的内容严格限于 DSH 运行时在当次请求中传入的数据及上述 SDK 元信息。插件不对提示词或工具输出做自动脱敏，请避免在对话或工具输出中主动打印敏感凭据。

## 本机状态、依赖与日志约束

- **工作目录（`cwd`）**：`bridge` 启动本地 agent 前会以 `0700` 权限创建或收紧默认临时目录（`/tmp/dsh-simple-cursor`），并校验其非符号链接且归属当前用户。由于启用了 `emptyFs()` 且内置工具关闭，该目录仅作 SDK 作用域标识，默认保持为空。
- **内存存储与磁盘清理**：会话槽位、用量缓存及 SDK `local.store`（通过自定义内存 `LocalAgentStore` 接管，不生成 `sdk-agent-store` SQLite 数据库）均保存在当前 Node 进程内存中，卸载或释放时回收；`@cursor/sdk` 在运行期仍可能向 `~/.cursor/projects/<cwd-slug>/agent-transcripts/`（受 `CURSOR_DATA_DIR` 影响）写入对应 agent 的 JSONL 转录副本（极端大工具输出还可能涉及 `agent-tools/`），插件在 `dispose()` / `drop()` 时会按 `agentId` 自动清理对应 `agent-transcripts` 目录；若进程异常崩溃残留历史文件，可手动清理 `~/.cursor/projects/tmp-dsh-simple-cursor/`（清理不影响 DSH 自身会话存储）。
- **环境变量与外部配置文件**：插件代码不读取环境中的密钥，但 `@cursor/sdk` 会响应 `CURSOR_BACKEND_URL`、`CURSOR_DATA_DIR`、`CURSOR_RIPGREP_PATH` 等进程环境变量以及 `~/.cursor/sandbox.json`。**特别注意**：当 `CURSOR_BACKEND_URL` 指向 `localhost` / `127.0.0.1` 时，`@cursor/sdk` 会在整个 Node 进程范围内设置 `NODE_TLS_REJECT_UNAUTHORIZED="0"`，影响同进程所有 HTTPS 连接校验；插件在检测到非空 `CURSOR_BACKEND_URL` 时会于启动阶段输出警告，生产环境应禁止在宿主进程中配置本地或非 HTTPS `CURSOR_BACKEND_URL`。
- **专有依赖与原生二进制**：插件依赖闭源专有许可的 `@cursor/sdk@1.4.2`（遵循 Cursor Terms of Service，已精确锁定版本）及其平台可选包（如 `@cursor/sdk-linux-x64`），其中包含进程内加载的 `tree-sitter` 原生 `.node` 扩展以及作为子进程按需调用的独立 ELF 可执行文件（`rg`、`cursorsandbox`），无法像纯 JS 源码一样逐行静态审计。
- **控制台日志约束**：除启动阶段检测 `CURSOR_BACKEND_URL` 告警外，插件主动输出的运行期日志仅为模型目录拉取失败时输出一次经脱敏的 `console.warn('[dsh-simple-cursor] model list unavailable: …')`；新增代码严禁打印密钥、短期令牌或完整上游响应。

## 已知限制

- 请求鉴权完全依托 DSH `connection` 服务，反向代理或非回环部署下的 Host 白名单由宿主的 `trustedHosts` 与绑定配置决定。
- 模型目录缓存（60 秒）采用单槽设计，未按密钥分桶；切换账号密钥后推理请求立即使用新密钥，但模型选择器列表最多可能有 60 秒延迟。
- 无法防范用户在终端侧主动泄露浏览器登录 Cookie 或 API Key，亦不提供同系统用户内的恶意同权限进程隔离。

## 安全改动核对要求

修改凭证读取、用量路由、SDK 初始化参数或工具挂起逻辑时，必须逐项核对 `.agents/skills/simple-cursor-verify/references/provider-checklist.md`，并确保：

- `tests/adapter.test.mjs` 持续覆盖单一凭证来源及环境变量不回退断言。
- `tests/index.test.mjs` 与 `tests/usage.test.mjs` 持续验证路由挂载、`refresh=1` 冷却限流、取消信号传播、401/403 错误归类以及序列化响应中无密钥和短期令牌泄露。
- `tests/support.test.mjs` 持续断言 `tools: ['mcp']`、`settingSources: []`、`fs` / `store` 透传、内存清理、敏感 `cwd` 拒绝以及错误脱敏。
- `tests/bridge.test.mjs` 持续覆盖 `holding` 阶段取消、空闲过期、重复 `toolCallId` 拒绝、挂起超时、`sessionKey` 转义与密钥指纹轮换。
- `tests/client.test.mjs` 持续验证密码框属性（含 `spellCheck={false}`）、无 HTML/存储注入点、保存清空草稿、卸载取消请求及过期响应防护。
- 升级 `@cursor/sdk` 版本前，必须核对：1) `StatsigClient` 仍保持 `disableLogging: true`、`disableStorage: true` 与 `preventAllNetworkTraffic: true`；2) `local.store` 与 `local.fs: emptyFs()` 行为及 `agent-transcripts` 目录布局未变化；3) 遥测与 `request-context` 字段范围；4) 原生二进制包版本与哈希校验。
