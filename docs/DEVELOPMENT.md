# 开发与调试指南

本文档涵盖本地安装、模块重载、测试编写与人工验收流程；修改代码前请先阅读 `ARCHITECTURE.md` 与 `SECURITY.md`。

## 环境要求

- **Node.js**：`>=22.13`（见 `package.json` 的 `engines.node`，CI 使用 24.x）。
- **DSH 版本**：`>=0.2.2-rc.4 <0.3.0`（见 `engines.dsh`）。若宿主升级超出此范围，需先评估兼容性并记录决策，不要直接放宽版本号。
- **安装依赖**：本插件依赖 `@cursor/sdk`、`@deepseek-ai/schemastery` 以及 peer 依赖 `@deepseek-ai/dsh-llm`，首次拉取仓库后必须先执行 `npm install`。
- **修改位置**：Profile 通过 `link:` 指向本地插件目录，日常开发请直接在源码仓库内修改，不要直接编辑 `~/.dsh/profiles/web` 下的文件。

## Skill 自动发现说明

DSH 会以当前会话工作目录最近的 `.git` 祖先目录作为项目根目录。若本插件作为独立 Git 仓库维护，只有在 `simple-cursor/` 目录内工作时，`.agents/skills/` 下的工作流才会被自动扫描加载；若会话停留在外层工作区目录，请先将工作目录切入 `simple-cursor/`，或让子代理以该目录为 `cwd` 启动（`AGENTS.md` 不受影响，读写该目录下文件时会自动注入）。

## 常用命令

```sh
npm install          # 首次安装 @cursor/sdk、schemastery 与 peer 依赖
npm run check        # 语法检查 + 全部单测 + 打包清单校验（提交前统一入口）
npm test             # 仅运行单元测试
npm run check:syntax # 仅运行 node --check 语法检查
npm run check:pack   # 仅运行 npm pack --dry-run 检查发布文件清单
```

运行单个测试文件或指定用例：

```sh
node --test tests/bridge.test.mjs
node --test --test-name-pattern 'tool' tests/bridge.test.mjs
node --test tests/adapter.test.mjs tests/catalog.test.mjs
```

CI 与本地提交执行同一条 `npm run check`。所有单元测试完全离线运行，不访问 Cursor 服务，也不依赖运行中的 DSH。

## 本地安装与模块重载

在 DSH 中挂载本地目录有两种常用方式：

- **Web 界面或 `plugin_manager` 工具**：在 **插件 → 添加插件** 中选择本地 `simple-cursor` 目录，或调用 `plugin_manager` 的 `install_bundle`（`target` 传入本地目录绝对路径）。必须以返回 `application=applied` 且 `warnings=[]` 作为安装成功标准。
- **命令行安装**：执行 `dsh plugin --profile web add /path/to/simple-cursor`。命令会自动安装依赖并将声明了 `dsh.bundle.patch` 的包写入 `dsh.profile.bundles`；由于命令行不会热更新正在运行的进程，执行完毕后需重启一次 DSH。

当同名包已安装在启用了 HMR 的 Web profile 中时，直接调用 `install_bundle` 会返回 `already-installed`；需先调用 `remove_bundle` 移除，再调用 `install_bundle` 重新安装同一路径。

| 改动内容 | 生效方式 | 验证方式 |
|---|---|---|
| 服务端模块（`index.js`、`adapter.js`、`bridge.js`、`catalog.js`、`chunks.js`、`config.js`、`errors.js`、`queue.js`、`schema.js`、`sdk.js`、`transcript.js`、`usage.js`） | 默认 Web profile 的 HMR 以 `root: []` 启动，直接保存外部源码不会触发自动重载。已安装时执行 `remove_bundle` → `install_bundle`（同一目录即可，无需改目录名）触发重组替换；若未启用 HMR 或返回 `restart-required`，则重启 DSH | 发起一次真实模型请求、查看设置页订阅用量，并确认插件项 `include:simple-cursor` 处于激活状态 |
| `client.js` | 刷新浏览器页面即可（`pnpm run dev:web` 仅构建 DSH 自身前端包，不处理本插件单文件模块） | 打开「更多 → 设置 → Cursor」，验证保存/清除密钥与用量刷新 |
| `package.json`、`cordis.patch.yml`、`dsh.client.inject` | 执行 `remove_bundle` → `install_bundle` 后刷新浏览器页面，或重启 DSH | `install_bundle` 返回 `applied` 且 `warnings=[]`；检查插件列表与设置导航 |
| `locale/*.json`、`icon.svg` | `link:` 安装下刷新浏览器页面即可（命中缓存时强制刷新）；若为打包副本安装则需重装 | 切换中英文界面，检查插件详情页标题、简介与图标 |
| `package.json` 依赖或 `@cursor/sdk` 版本 | 先在插件目录执行 `npm install`，再按上法重装或重启 DSH | 确认启动无模块解析报错，并跑通一次真实模型请求 |
| `tests/`、`docs/`、`.agents/` | 不参与运行时，无需重载 | 运行对应的测试或检查命令 |

注意：服务端代码修改后，单元测试通过仅代表磁盘源码逻辑正确，运行中的 DSH 进程仍持有旧模块，务必执行重装重载或重启后再做页面验证。

## 编写测试

动手前先阅读 `tests/AGENTS.md`。仓库测试按五类边界组织：

1. **纯逻辑模块**（`catalog.test.mjs`、`transcript.test.mjs`、`support.test.mjs`）：直接导入纯函数验证输入输出，无需构造外部替身。
2. **模型适配器**（`adapter.test.mjs`）：注入模拟 `bridge`、`listModels` 与 `resolveApiKey`，验证目录展开、`resolveModel` 容量上报与凭证读取。
3. **会话桥接**（`bridge.test.mjs`）：注入模拟 SDK 客户端与 `defer` 调度器，使用 0 ms 定时器的 `waitFor` 推进异步事件，不等待真实时钟。
4. **服务端与用量**（`index.test.mjs`、`usage.test.mjs`）：通过模拟 `ctx` 捕获注册路由，注入模拟 `fetch`、`now` 与 `ttlMs`，验证状态码、缓存控制及响应脱敏。
5. **浏览器端面板**（`client.test.mjs`）：在导入 `client.js` 前挂载 `globalThis.window.__ModuleLoader__.load`，配合精简版模拟 React 检查虚拟节点树。因 Node.js 会缓存已导入模块，所有前端用例统一集中在该文件内。

新增测试须在代码修复前先行验证能够失败（红灯验证），文件统一命名为 `tests/*.test.mjs`。

## 人工验收清单

离线单测无法替代真实 DSH 与 Cursor 账号联调。在未由用户亲自确认前，以下项目一律标注为「待验证」，不得写成「已通过」。

### 1. 设置页与密钥管理

1. 打开 **更多 → 设置 → Cursor**，确认导航项位于 Models 之后、Plugins 之前，标题、简介与状态圆点显示正常。
2. 未配置时状态显示「未配置」，保存按钮在输入框为空时处于禁用态，用量区域提示先保存密钥。
3. 粘贴有效的 Cursor API Key 点击 **保存**：出现保存成功提示，状态变为「已配置」，密码框自动清空。
4. 点击 **清除**：状态回到「未配置」；再次保存可正常恢复。
5. 刷新浏览器页面：已配置状态保持不变（密钥保存在服务端凭证存储中，而非浏览器 `localStorage`）。
6. 打开浏览器开发者工具查看网络面板，确认 `describe` 与 `usage` 响应中均不包含 `cursor_...` 明文密钥或短期令牌。

### 2. 订阅用量展示

1. 配置有效密钥后，用量卡片自动展示套餐名称、计费周期、总用量 / Auto + Composer / API 模型百分比、额度池、按量消费及下次重置时间（以账号实际返回的非空字段为准）。
2. 点击 **刷新**，确认发出 `?refresh=1` 请求并更新数据。
3. 保存一段无效密钥，确认用量区域展示可读错误提示（`INVALID_CREDENTIAL`），不暴露上游原始报文。
4. 在未挂载 `connection` 服务的精简环境中，确认设置页提示无法读取用量，但模型对话本身仍可正常使用。

> 提示：用量路由挂载在 `/api/dsh-simple-cursor/usage`。未携带页面 Cookie 直接用 `curl` 访问返回 `401` 只能说明宿主 `/api` 网关在线，**不能**证明本插件路由已注册，请以设置页面内的实际请求为准。

### 3. 模型选择器与变体

1. 打开模型选择器，确认出现 **Cursor** 提供方并列出当前账号可用模型。
2. 支持多上下文窗口的模型应拆分为多个带容量后缀的条目（如 `… · 300K`、`… · 1M`），默认档位同样带有容量后缀。
3. 支持推理强度的模型应显示推理档位选项；切换非默认档位发起对话应正常生效。
4. 当密钥未配置或网络断开导致目录拉取失败时，选择器应回退显示 `Composer 2.5` 与 `Auto`，且服务端控制台仅输出一次 `[dsh-simple-cursor] model list unavailable: …` 警告。

### 4. 真实对话与会话续接

1. 选择 Cursor 下的模型发送消息，确认流式回复与最终 Token 用量统计正常。
2. 生成途中点击取消，确认流立即中止且不会残留「运行中」死锁状态，下一条消息可正常发送。
3. 在长对话中触发一次上下文压缩，确认下一轮请求会自动新建本地 agent 并传入压缩后的完整上下文，不会报历史不一致。

### 5. 工具调用往返

1. 让模型执行需要调用 DSH 工具的任务（如读取工作区文件），确认工具由 DSH 执行、结果回填至同一次运行并继续输出最终回答。
2. 确认模型仅能看到 DSH 提供的工具列表，不会调用任何 Cursor 自带的文件、终端或网页工具。
3. 触发单轮并行工具调用，确认多个工具调用合并在同一批次发出并按各自 ID 准确回填结果。

### 6. 辅助请求、图片与插件详情页

1. 新建会话触发自动生成标题，确认标题生成使用独立 agent，不干扰当前主对话上下文。
2. 在启用 `attachments` 服务的环境中附带图片提问，确认模型能正常识别图片；在未启用 `attachments` 的环境中应明确报 `UNSUPPORTED_CONTENT`。
3. 打开 **插件 → 简单 Cursor**（并切换英文界面查看 **Simple Cursor**），确认中英文标题、简介、README 正文与图标均正常渲染。

## 常见问题排查

- **`npm run check` 提示找不到 `@deepseek-ai/dsh-llm` 或 `@cursor/sdk`**：先在插件目录运行 `npm install` 安装依赖及平台对应的原生可选包。
- **模型选择器只剩 `Composer 2.5` 与 `Auto`**：尚未保存密钥、网络无法连接 Cursor 或密钥失效；查看服务端终端输出的一次性警告定位原因。
- **设置页提示「这个部署没有可用的凭证服务」**：当前 profile 未启用 `credentials` 服务或其 Remote 通道不可用；检查宿主 profile 配置，不要通过改代码读环境变量绕过。
- **设置页提示「当前部署无法读取订阅用量」或报 `HTTP 404`**：前者通常因缺少 `connection` 服务；后者说明服务端尚未加载最新代码，按上表执行 `remove_bundle` → `install_bundle` 或重启 DSH。
- **对话报 `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`**：未保存密钥、密钥含非法空白/非 ASCII 字符，或密钥已被 Cursor 吊销；前往「更多 → 设置 → Cursor」重新粘贴保存。
- **对话报 `UNSUPPORTED_OPTION`**：普通对话的 agent 配置传入了 `temperature`、`maxTokens` 或 `stop`，移除这些参数后重试。
- **对话报 `UNSUPPORTED_REASONING_EFFORT`**：所选模型不支持当前推理强度档位，切回默认档位或刷新模型列表。
- **配置的 `contextWindow` 未生效**：模型目录本身带有 `context` 参数时一律以所选变体的真实容量为准，仅当目录不含该参数时才使用 `contextWindow` 兜底值。
- **对话报 `this session already has a Cursor run in progress`**：同一会话发起了并发请求，等待上一轮结束或取消后再试。
- **对话报 `Cursor returned an empty response`**：模型本轮未返回任何有效内容块，重试或切换其他模型。
- **对话报 `Cursor run ended before the tool result was delivered`**：工具执行期间底层运行已提前终止，下一轮发送会自动重建新 agent 恢复。
- **改了服务端代码但没生效**：默认 HMR 不监听外部目录文件保存，使用 `remove_bundle` → `install_bundle` 重装同一目录，或重启 DSH。
- **`install_bundle` 返回 `already-installed`**：同名包已存在，先执行 `remove_bundle` 再安装。
- **`dsh plugin add` 后界面里看不到插件**：CLI 安装不会热更新运行中的进程，重启一次 DSH 即可。
- **设置页出现两个 `Cursor` 分区**：存在改名遗留的旧版 bundle，移除旧 bundle 后刷新页面。

## 发布说明

完整发版流程见 `.agents/skills/simple-cursor-release/SKILL.md`。变更日志同步维护在 `CHANGELOG.md`（中文）与 `CHANGELOG.en.md`（英文），说明文档同步维护在 `README.md` 与 `README.en.md`。当前包保持 `private: true`，通过本地目录安装；升版时修改 `package.json`，同步更新 `package-lock.json` 根版本与双语变更日志，再运行 `npm run check` 验证。
