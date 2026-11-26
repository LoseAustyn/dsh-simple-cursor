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

1. **单一读取入口**：服务端统一通过 `ctx.credentials.resolve('CURSOR_API_KEY')` 实时获取密钥，每次请求动态读取，不在内存中长期缓存明文。
2. **禁止旁路配置**：严禁新增 `process.env`、`Config.apiKey`、`Config.apiKeyEnv`、SDK 本地登录文件读取或硬编码密钥。`Config` Schema 仅保留 `cwd` 与 `contextWindow`，`resolveConfig` 显式拒绝任何未知字段。
3. **前端只写不读**：`client.js` 仅调用 `credentials.describe`、`set` 与 `unset`，无法读回密钥明文；输入框固定配置 `type="password"`、`autoComplete="off"` 与 `spellCheck={false}`，保存成功后立即清空输入状态。
4. **严禁回显泄露**：报错文本、终端日志与 HTTP 响应体中不得包含原始 API Key 或短期访问令牌。`normalizeApiKey` 在校验失败时仅提示「包含无法放入 HTTP 请求头的字符」，绝不拼接原值。
5. **轮换即时生效**：更新密钥后下一次模型请求即读取新值；`bridge` 检测到 `session.apiKey !== extras.apiKey` 时会立即销毁旧的本地 agent 实例。
6. **空值按缺失或非法处理**：空白字符串会被 `normalizeApiKey` 拦截并归类为 `INVALID_CREDENTIAL`，不允许用占位符绕过凭证检查。

## 订阅用量路由约束

`index.js` 在宿主存在 `connection` 服务时注册：

```text
GET /api/dsh-simple-cursor/usage            # 命中 30 秒内存缓存
GET /api/dsh-simple-cursor/usage?refresh=1  # 强制刷新上游数据
```

- **必须走 `/api` 认证通道**：通过 `connection.fetch.register` 挂载精确路径，交由宿主 `connection` 统一执行 Host/Origin 校验、Cookie 鉴权与 owner Peer 授权；禁止注册裸 `webServer` 路由或编写本机免鉴权分支。
- **缺失服务时安全跳过**：宿主未启用 `connection` 时不挂载该路由，不影响模型推理主功能。
- **最小请求面**：仅允许 `GET` 方法（`requestBody: 'buffered'`），查询参数只识别 `refresh=1`，绝不从 URL 参数读取密钥或令牌。
- **禁止端侧缓存与原始报文透传**：所有响应均附带 `cache-control: no-store`；经 `normalizeUsage()` 白名单提取套餐、周期、百分比、额度与时间戳，丢弃上游其余字段，绝不回传 API Key 与短期访问令牌。
- **收敛错误输出**：预期异常统一封装为 `UsageFailure`（仅输出安全的 `code` 与固定英文/前端本地化提示），不拼接上游返回的原始错误正文。
- **哈希索引缓存**：30 秒内存缓存以 `sha256(apiKey)` 作为键名，不保存密钥明文，也不落盘。

## 工具执行边界

创建本地 Cursor agent 时，`sdk.js` 固定传入以下安全配置：

```js
{
  tools: ['mcp'],
  local: { cwd, settingSources: [] },
}
```

- **禁用全部 Cursor 内置工具**：`tools: ['mcp']` 仅保留自定义工具通道，关闭 Cursor 自带的文件读写、Shell 终端与网页访问能力，防止绕过 DSH 的文件沙箱与用户审批策略。
- **隔离外部环境配置**：`settingSources: []` 禁止自动加载项目目录或用户主目录下的 MCP 服务与规则文件，防止未审计的外部工具注入会话。
- **工具交由 DSH 执行**：自定义工具的 `execute` 回调仅将调用请求挂起（park）转交给 DSH，实际执行、权限判定与用户审批全部由 DSH 完成，结果仅按 `toolCallId` 精确回填。

## 出站数据说明

当用户主动选择 `Cursor` 作为模型提供方并发起对话时，以下内容会通过加密连接发送至 Cursor 服务：

- 对话消息记录（首轮或重建实例时发送完整可见历史，`follow-up` 阶段仅发送新增消息）及一次性系统提示词。
- 当前会话可用的 DSH 工具名称、描述、参数 Schema，以及工具执行完毕后返回的文本或图片结果。
- 消息中附带的图片字节（通过宿主 `attachments` 服务读取）及所选模型变体参数。

插件不会自行扫描或上传工作区文件，发往 Cursor 的内容严格限于 DSH 运行时在当次请求中传入的数据。插件不对提示词或工具输出做自动脱敏，请避免在对话或工具输出中主动打印敏感凭据。

## 本机状态与日志约束

- `bridge` 启动本地 agent 前会确保 `cwd` 目录存在（默认使用系统临时目录下的 `dsh-simple-cursor`）。由于内置工具已关闭，该目录仅用于存放 SDK 本地运行状态，不指向用户工作区。
- 会话槽位与用量缓存均保存在当前 Node 进程内存中，插件卸载或进程退出时自动释放，不向 DSH 会话日志写入私有凭据或额外状态。
- 插件唯一的主动控制台日志是模型目录拉取失败时输出一次 `console.warn('[dsh-simple-cursor] model list unavailable: …')`；新增代码严禁打印密钥、短期令牌或完整上游响应。

## 已知限制

- 请求鉴权完全依托 DSH `connection` 服务，反向代理或非回环部署下的 Host 白名单由宿主的 `trustedHosts` 与绑定配置决定。
- 插件未内置独立的调用频率限制，依赖上游服务自身的限流保护。
- 模型目录缓存（60 秒）采用单槽设计，未按密钥分桶；切换账号密钥后推理请求立即使用新密钥，但模型选择器列表最多可能有 60 秒延迟。
- 无法防范用户在终端侧主动泄露浏览器登录 Cookie 或 API Key。

## 安全改动核对要求

修改凭证读取、用量路由、SDK 初始化参数或工具挂起逻辑时，必须逐项核对 `.agents/skills/simple-cursor-verify/references/provider-checklist.md`，并确保：

- `tests/adapter.test.mjs` 持续覆盖单一凭证来源及环境变量不回退断言。
- `tests/index.test.mjs` 与 `tests/usage.test.mjs` 持续验证路由挂载、401/403 错误归类以及序列化响应中无密钥和短期令牌泄露。
- `tests/support.test.mjs` 持续断言 `tools: ['mcp']` 与 `settingSources: []` 未被改动。
- 所有新增异常分支仅向外返回受控错误码与安全说明，不透传上游原始报错体。
