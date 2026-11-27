# AGENTS.md

`dsh-simple-cursor` 是 DSH 的第三方模型提供方插件：通过官方 `@cursor/sdk` 将个人 Cursor 订阅接入 DSH 的 `cursor` 路由。Node 服务端负责模型适配、目录缓存、会话级本地 agent 生命周期、工具调用挂起与恢复、凭证解析及订阅用量查询；浏览器端（`client.js`）负责「更多 → 设置 → Cursor」面板中的密钥保存与用量展示。

## 必读文档

- 修改代码前：先看 `docs/ARCHITECTURE.md`
- 涉及凭证读取、用量路由、SDK 工具边界或流式错误处理：先看 `docs/SECURITY.md`
- 本地安装、重载、调试与人工验收：见 `docs/DEVELOPMENT.md`
- 多步骤流程：见 `.agents/skills/` 下的 `simple-cursor-change`、`simple-cursor-verify` 与 `simple-cursor-release`（DSH 以当前工作目录最近的 `.git` 目录作为项目根，需在 `simple-cursor/` 目录内工作才能自动发现这些 skill）

## 常用命令

```sh
npm install          # 首次拉取 @cursor/sdk、schemastery 与宿主 peer @deepseek-ai/dsh-llm
npm run check        # 语法检查 + 单元测试 + 打包清单校验（提交前必跑）
npm test             # 仅运行单元测试
npm run check:syntax # 仅运行 node --check 语法检查
npm run check:pack   # 运行 npm pack --dry-run，核对发布文件列表
node --test tests/bridge.test.mjs
node --test --test-name-pattern 'tool' tests/bridge.test.mjs
```

所有测试均为离线测试，不请求 Cursor 服务、不联网，也不依赖运行中的 DSH。CI 与本地提交共用 `npm run check`。

## 核心约束

- **插件标识一致**：包名 `dsh-simple-cursor`、patch 行 ID `simple-cursor`、模块加载器 ID `dsh-simple-cursor`、提供方路由 `cursor`、locale 命名空间 `simpleCursor`、设置页分区 ID `simple-cursor`、凭证引用名 `CURSOR_API_KEY`、用量路由 `/api/dsh-simple-cursor/usage`。改动其中任意一项都必须同步其余各处并重新安装。
- **凭证单一来源**：插件代码只从 `ctx.credentials.resolve('CURSOR_API_KEY')` 读取密钥，不直接读取环境变量、profile 配置或 `~/.cursor/sdk/auth.json`。DSH `credentials` 服务自身的来源优先级（托管文件、环境变量、`.env`）由宿主决定，设置页状态栏通过 `source` 展示当前来源。浏览器端只写不读，`describe` 仅返回 `configured`、`source`、`writable` 与 `masked`；更新密钥后在下一次模型请求时立即生效。
- **工具执行与状态边界**：只将 DSH 传入的自定义工具注册到 SDK 的 `mcp` 组，固定配置 `tools: ['mcp']`、`settingSources: []`、`fs: emptyFs()` 与内存 `LocalAgentStore`，不得放宽。工具统一交由 DSH 执行，插件自身不启用也不执行文件、终端或网页工具，并在释放 agent 时清理对应 `agent-transcripts`。
- **会话级 Agent 隔离**：每个 `sessionKey`（对 `sessionId` 与 `purpose` 进行 `encodeURIComponent` 转义）同时最多运行一个请求；主对话 `session:<id>` 与后台辅助请求 `purpose:<id>:<purpose>` 严格隔离，绝不共用 agent。槽位仅保存密钥 `sha256` 指纹，遇到历史前缀不一致、切换模型或密钥、空闲/挂起超时或中止时，一律销毁旧实例。
- **流式输出契约**：`usage` 分块必须在 `finish` 之前发出，`finish` 之后不得再产生任何分块；工具调用的 `arguments` 必须为原始 JSON 字符串；全程响应 `options.signal` 取消信号；队列与挂起工具均有界限与超时限制；异常经脱敏后统一映射为稳定的 `LlmError` 错误码。
- **调用参数校验**：普通对话若传入 `temperature`、`maxTokens` 或非空 `stop`，直接抛出 `UNSUPPORTED_OPTION`；带非空 `purpose` 的辅助请求（如生成会话标题、上下文压缩）按 Cursor 默认参数放行，忽略这些字段。
- **上下文容量优先取真实档位**：模型目录提供 `context` 参数时，按所选变体的真实容量上报给 DSH；仅当目录未提供该参数时，才使用 `contextWindow` 兜底值（默认 `128000`）。`::context=` 仅作 DSH 模型选择器的内部拼接标识，发往 Cursor SDK 前必须还原为真实模型 ID 与变体参数。
- **订阅用量脱敏**：由服务端使用已存密钥换取短期令牌并请求用量接口，按密钥 SHA-256 哈希缓存 30 秒（`refresh=1` 跳过缓存）；返回给浏览器的响应仅包含归一化后的百分比与额度字段，绝不回传 API Key、短期令牌或上游原始报文。
- **路由鉴权委托宿主**：用量路由必须通过 `connection.fetch.register` 注册在 `/api/...` 精确路径下，复用 DSH `connection` 的 Host/Origin 校验、Cookie 鉴权与 Peer 授权；插件不自建鉴权拦截，也不直接注册裸 `webServer` 路由。
- **双语文案同步**：设置页文案通过 `client.js` 内的中英字典与 `t()` 管理，插件详情页元数据存放在 `locale/{zh,en}.json`；修改用户可见文案时需在同一次改动中同步更新中英文，同时保持 `README.md` / `README.en.md` 与 `CHANGELOG.md` / `CHANGELOG.en.md` 一致。
- **无构建步骤**：源码以标准 ESM 直接加载，不引入 TypeScript、打包器、第三方测试框架或额外运行时依赖；若确需新增依赖，须先在改动说明中列出当前方案无法解决的具体问题。
- **版本号单一来源**：版本号只在 `package.json` 中维护，`usage.js` 的 `user-agent` 动态读取该字段，禁止硬编码版本号；发版时同步更新 `package-lock.json` 根版本。
- **打包清单同步**：新增根目录运行时模块时，必须同步加入 `package.json` 的 `files` 数组与 `check:syntax` 脚本，并通过 `npm run check:pack` 核对打包输出（`check:pack` 只能展示已列入的文件，无法自动发现漏加的新模块）。

## 模块分工

| 文件 | 负责 | 不负责 |
|---|---|---|
| `index.js` | 校验配置、注册 `cursor` 适配器、挂载用量路由、读取图片附件、卸载释放资源 | 模型流式协议细节、SDK 事件解析、工具执行 |
| `adapter.js` | `LlmAdapter` 实现：拉取目录与解析模型、校验调用参数、读取密钥、映射 `LlmError` | 直接调用 SDK、维护会话级 agent、解析 Cursor 回调 |
| `catalog.js` | 账号模型目录 60 秒缓存、上下文与推理强度变体展开、模型参数组装、离线兜底列表 | HTTP 请求、`ctx`、凭证读取、SDK 调用 |
| `bridge.js` | 会话级 agent 生命周期、`fresh`/`follow-up`/`tools` 路径判定、工具调用挂起与恢复、取消与释放 | 凭证读取、模型目录、DSH 路由、DOM |
| `transcript.js` | 消息历史指纹计算、续接分类、单条用户消息文本拼装、工具结果载荷转换 | 网络请求、SDK 实例、`ctx` |
| `chunks.js` | DSH `StreamChunk` 分块组装、`usage` 字段归一化、`finish` 分块生成 | 会话状态维护、SDK 调用 |
| `queue.js` | Cursor 运行回调与 DSH 异步流之间的有序事件队列 | SDK 调用、模型业务语义 |
| `sdk.js` | 首次使用时动态导入 `@cursor/sdk`、组装 `Agent.create` 选项、映射自定义工具、拉取模型列表 | 会话续接决策、凭证来源管理 |
| `errors.js` | `BridgeFailure` 定义、将 SDK 与网络异常映射为稳定错误码 | 日志打印、前端提示渲染 |
| `config.js` | 提供方与凭证常量、配置项校验、调用控制参数策略、兜底上下文容量、默认临时目录 | SDK 调用、`ctx` |
| `schema.js` | Cordis `Config` Schema 定义（`cwd`、`contextWindow`） | 运行时细粒度校验（由 `config.js` 负责） |
| `usage.js` | 短期令牌兑换、DashboardService 查询、用量字段归一化、30 秒缓存、`UsageFailure` | DSH 路由鉴权、前端 UI 渲染 |
| `client.js` | 「更多 → 设置 → Cursor」面板、密钥保存/清除、订阅用量展示、中英文案字典、`--dsw-alias-*` 样式 | 读取密钥明文、服务端鉴权、发起模型请求 |
| `tests/*.test.mjs` | 基于 `node:test` 的离线行为单测 | 连接真实 Cursor、联网、操作真实浏览器或启动 DSH |
| `locale/*.json` | 插件详情页标题与简介 | 设置页运行时交互文案 |
| `cordis.patch.yml` | Bundle 插件注入声明（`id: simple-cursor`） | 配置项默认值 |
| `package.json` | 包清单、检查脚本、`files` 白名单、`dsh` 声明、引擎版本约束与依赖 | 业务逻辑 |

## 改动对照表

| 改动内容 | 先读文档 | 运行检查 | 生效与验收方式 |
|---|---|---|---|
| 适配器、模型目录、上下文/推理变体、参数校验 | `docs/ARCHITECTURE.md` | `tests/adapter.test.mjs`、`tests/catalog.test.mjs`、`tests/support.test.mjs` | 移除并重装同一目录（`remove_bundle` → `install_bundle`）或重启 DSH；确认选择器出现 Cursor 及各变体，并发起真实请求验证容量与推理档位 |
| `bridge`、`transcript`、`chunks`、`queue`、工具往返、取消 | `docs/ARCHITECTURE.md`、`docs/SECURITY.md` | `tests/bridge.test.mjs`、`tests/transcript.test.mjs`、`tests/support.test.mjs` | 重装触发重载或重启 DSH；实测带 DSH 工具调用的多轮对话、中途取消与空响应提示 |
| 凭证读取、设置页保存与清除 | `docs/SECURITY.md` | `tests/adapter.test.mjs`、`tests/client.test.mjs`、`tests/index.test.mjs` | 刷新页面；验证保存/清除在下一次模型请求生效，且响应中不含密钥明文 |
| 用量路由、`usage.js`、用量面板 UI | `docs/SECURITY.md` | `tests/usage.test.mjs`、`tests/index.test.mjs`、`tests/client.test.mjs` | 重装触发重载或重启 DSH；验证设置页用量展示、手动刷新及脱敏响应 |
| `sdk.js`、SDK 升级、本地 agent 参数 | `docs/SECURITY.md` | `tests/support.test.mjs`、`tests/bridge.test.mjs` | 升级前核对 `StatsigClient` 禁用遥测/外连、`local.store` / `local.fs` / `agent-transcripts` 行为与原生二进制包变更；重装触发重载或重启 DSH；验证新建 agent 正常且工具仍完全由 DSH 执行 |
| `package.json`、`cordis.patch.yml`、`dsh.client.inject`、`files` | `docs/DEVELOPMENT.md` | `npm run check:pack` | `remove_bundle` → `install_bundle` 并刷新页面（`files` 仅影响打包产物，`link:` 安装不会自动过滤目录）；确认 `applied` 且 `warnings=[]` |
| `locale/*.json`、`icon.svg` | `docs/DEVELOPMENT.md` | `npm run check:pack` | `link:` 安装直接刷新页面（必要时强制刷新），打包安装需重装；核对中英文插件详情页标题、简介与图标 |
| 仅文档 / 测试 | 对应文档 | 受影响的检查命令 | 无需重载运行环境 |

## 验收标准

- `npm run check` 全部通过；新增行为需补充对应测试，并在修复前确认该测试能够触发失败。
- 安装类改动必须以 `install_bundle` 返回 `application=applied` 且 `warnings=[]` 为准，否则如实说明原因。
- 涉及真实 Cursor 请求、浏览器交互、视觉样式或订阅用量展示，在未由用户亲自确认前一律标注为「待验证」，不得写成「已通过」。
- 不把无关重构混入功能改动；不得删除或放宽与凭证来源、工具边界、流式契约、会话隔离、超时与取消相关的测试。
- 新增测试必须离线独立运行，不访问真实网络或 Cursor 接口，不引入 jsdom、Playwright 或第三方断言库。

## 代码与文档风格

- 纯 ESM；2 空格缩进；单引号；JS 行尾不加分号（沿用现有代码风格）。
- 源码标识符、JSDoc 与内部错误文本使用英文；项目文档默认以中文为主，`README.md` 与 `CHANGELOG.md` 对应英文版 `README.en.md` 与 `CHANGELOG.en.md`，同一改动需同步更新双语版本。
- 非显而易见的接口契约用 JSDoc 注明；注释解释「为什么这样做」，不记录修改历史。
- 保持纯函数模块边界：`catalog.js`、`transcript.js`、`chunks.js`、`queue.js`、`errors.js` 不引入 `ctx`、HTTP、SDK 或浏览器 API。
- `sdk.js` 保持在首次调用时动态 `import('@cursor/sdk')`，避免单元测试加载原生二进制依赖，禁止改为顶层静态导入。
- `client.js` 不读取密钥明文、不访问文件系统、不自行实现服务端鉴权；不引入额外 DSH 前端组件包，样式统一使用 `--dsw-alias-*` 主题变量。
- 需要用户介入处理的报错应指明具体操作入口（如 `More → Settings → Cursor`），严禁在错误信息中回显密钥内容。
- 新增测试遵循 `tests/AGENTS.md`。

## 设计决策与计划

- 架构、安全、凭证管理、工具边界与测试策略背后的权衡记录在 `docs/decisions/`，阶段性背景记录放在 `docs/plans/`，不要只留在 commit message 里。
- 当前架构与操作方式以本文件及 `docs/` 根目录文档为准；`docs/plans/` 仅作历史背景参考。
