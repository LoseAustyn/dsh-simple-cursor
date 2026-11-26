---
name: simple-cursor-change
description: "Use when changing dsh-simple-cursor source, tests, the Cursor settings page, the usage route, the model catalog or bridge, or the manifest; selects the owning surface, applies the smallest change, runs the right checks, and verifies the installed bundle."
---

# Simple Cursor 改动流程

适用于本仓库的各类代码修改。项目级规范见根目录 `AGENTS.md`，这里只列出具体执行步骤。

## 1. 改动前检查

```sh
git status --short --branch
npm run check
```

- 如果 `npm run check` 已经失败，先记录失败命令与首个报错并停止，不要在坏基线上继续修改代码。
- 动手前先明确本次改动的影响面与预期效果（模型请求可见 / 设置页可见 / 订阅用量可见 / 仅内部实现）。
- 涉及凭证解析、用量路由、SDK 工具边界或流式错误处理时，先阅读 `../../../docs/SECURITY.md`；其他模块改动先阅读 `../../../docs/ARCHITECTURE.md`。

## 2. 确定归属模块

| 改动内容 | 主要文件 | 对应测试 |
|---|---|---|
| 提供方路由、适配器、模型目录、上下文/推理档位选择、调用参数校验 | `adapter.js`、`catalog.js`、`config.js`、`schema.js` | `tests/adapter.test.mjs`、`tests/catalog.test.mjs`、`tests/support.test.mjs` |
| 流式输出、工具往返、会话级 agent 生命周期、中途取消、对话指纹分类 | `bridge.js`、`transcript.js`、`chunks.js`、`queue.js` | `tests/bridge.test.mjs`、`tests/transcript.test.mjs`、`tests/support.test.mjs` |
| 凭证解析、设置页保存与清除 | `adapter.js`（`resolveApiKey`）、`client.js`、`config.js` | `tests/adapter.test.mjs`、`tests/client.test.mjs`、`tests/index.test.mjs` |
| 订阅用量查询、用量路由、用量面板 UI | `usage.js`、`index.js`、`client.js` | `tests/usage.test.mjs`、`tests/index.test.mjs`、`tests/client.test.mjs` |
| SDK 调用选项、SDK 版本升级、原生依赖行为 | `sdk.js`、`package.json` | `tests/support.test.mjs`、`tests/bridge.test.mjs` |
| 插件清单、patch、locale、图标、打包白名单 | `package.json`、`cordis.patch.yml`、`locale/`、`icon.svg` | `npm run check:pack` |
| 测试、文档、Skill | `tests/`、`docs/`、`.agents/` | 受影响的检查命令 |

如果改动跨多个模块，先对齐契约（JSDoc 与 `docs/ARCHITECTURE.md` 中的流程与错误码表），再修改具体实现与调用方。

## 3. 编码要求

- 只改归属模块，不要顺手重构无关代码。
- **凭证读取**：只通过 `ctx.credentials.resolve('CURSOR_API_KEY')` 读取，不增加环境变量、配置字段或 SDK 登录文件回退，不在日志与报错中回显密钥。
- **用量路由**：只通过 `connection.fetch.register` 注册 `/api/...` 精确路径，查询参数只读 `refresh=1`，响应携带 `cache-control: no-store`，失败统一返回 `{ code, message }`；不注册裸 `webServer` 路由，也不自建鉴权拦截。
- **工具边界**：保持 `tools: ['mcp']` 与 `settingSources: []` 不变；工具统一交由 DSH 执行，结果严格按 `toolCallId` 匹配。
- **会话桥接**：维持 `sessionKey` 隔离、`classify` 的 `fresh`/`follow-up`/`tools` 三路决策、工具调用挂起与 `drop` 清理逻辑；同一 `sessionKey` 禁止并发运行，全程响应 `options.signal`。
- **流式分块**：`usage` 必须在 `finish` 之前发出，`finish` 之后不再产出分块；工具参数保持原始 JSON 字符串；每个内容块分配独立递增 `index`；空回复返回 `EMPTY_RESPONSE`。
- **模型目录**：有 `context` 参数时优先上报变体真实容量，无该参数时才回退到 `contextWindow`；发往 SDK 前将 `::context=` 内部标识还原为真实模型 ID，并保留变体自带的其他参数与 `maxMode`。
- **浏览器端**：不读取密钥明文、不自行做服务端鉴权、不直接操作全局 DOM；样式只使用 `--dsw-alias-*` 主题变量；用户可见文案在同一次改动中补齐中英文（含 `README.md` / `README.en.md` 与 `CHANGELOG.md` / `CHANGELOG.en.md`）。
- **SDK 加载**：保持首次调用时动态导入 `@cursor/sdk`；升级 SDK 版本时需核对回调结构、`run.wait()` 返回值、`local.customTools` 与 `Cursor.models.list`。
- **依赖与打包清单**：无明确失败场景不引入新依赖；新增根目录运行时文件时，同步写入 `package.json` 的 `files` 与 `check:syntax`，并用 `npm run check:pack` 核对文件列表。

## 4. 补充测试

- 纯逻辑模块 → 对应模块单测；服务端注册与用量路由 → `tests/index.test.mjs`；会话桥接 → `tests/bridge.test.mjs`；设置页 UI → `tests/client.test.mjs`；用量查询 → `tests/usage.test.mjs`。
- 写完新测试后，先确认它在代码修复前会失败（修之前跑一次，或临时改坏断言验证）。
- 只替换真实的外部边界（SDK 客户端、`fetch`、`ctx`、精简版 React、`now`、`defer`），不对内部模块整体 mock。
- 测试保持离线运行，不访问真实 Cursor 或外网，不引入 jsdom、Playwright 或第三方断言库。
- 新增测试文件命名为 `tests/*.test.mjs`，编写规范见 `../../../tests/AGENTS.md`。

## 5. 重载与生效

| 改动文件 | 生效方式 | 验证手段 |
|---|---|---|
| 服务端模块（`index.js`、`adapter.js`、`bridge.js`、`catalog.js`、`chunks.js`、`config.js`、`errors.js`、`queue.js`、`schema.js`、`sdk.js`、`transcript.js`、`usage.js`） | 默认 Web profile 的 HMR 不会因外部源码保存自动触发重载；已安装时先 `remove_bundle` 再对同一路径 `install_bundle`，或直接重启 DSH | 发起一次真实模型请求、查看设置页用量，并确认插件处于激活状态 |
| `client.js` | 刷新浏览器页面（`dev:web` 仅编译 DSH 自身前端包，不处理本插件单文件模块） | 检查「更多 → 设置 → Cursor」页面、密钥保存/清除与用量刷新 |
| `package.json`、`cordis.patch.yml`、`dsh.client.inject` | `remove_bundle` → `install_bundle` 并刷新页面，或重启 DSH | `install_bundle` 返回 `applied` 且 `warnings=[]`；检查插件页与设置导航 |
| `locale/*.json`、`icon.svg` | `link:` 安装直接刷新页面（必要时强制刷新）；打包安装需重装 | 检查中英文插件详情页标题、简介与图标 |
| 测试 / 文档 | 无需重载 | 运行对应检查命令 |

服务端代码改完后，单测通过不代表运行中的 DSH 已经加载新代码。若包已安装，直接调用 `install_bundle` 会返回 `already-installed`，需先 `remove_bundle`。详细规则见 `references/reload-matrix.md`。

## 6. 最终检查与汇报

```sh
npm run check
```

涉及安装变动时，通过 `plugin_manager` 的 `install_bundle` 确认返回 `application=applied` 且 `warnings=[]`；若当前环境无该工具，明确注明「未做安装验证」。

汇报固定包含三段：

```text
已修改：  改动的文件与行为说明
已验证：  npm run check、单测、打包清单、安装或重载检查结果
待确认：  真实 Cursor 请求、浏览器交互、视觉样式或订阅用量数据（需用户亲自确认）
```

不要把「单测通过」写成「设置页已通过」，也不要把「`install_bundle` 返回 applied」写成「真实模型请求已通过」。

## 完成标准

- `npm run check` 全部通过。
- 新增行为有对应测试，且确认过修复前会失败。
- 服务端或前端的重载状态交代清楚（已验证或明确标注待验证）。
- 没有削弱凭证来源、工具边界、流式契约、会话隔离或取消清理相关的约束。

## 何时停下

- 改动前基线检查已经失败且原因不明。
- 为了让测试通过需要放宽凭证、工具边界或流式契约断言。
- 改动涉及新增运行时依赖、调整分发方式或修改宿主 profile 配置。
- DSH 或 `@cursor/sdk` 的公开接口与当前文档不符，需先记录架构决策。
- 用户可见行为存在歧义（先向用户确认，不要自行猜测）。

## 参考文档

- `references/reload-matrix.md`
- `references/test-patterns.md`
- `../../../docs/ARCHITECTURE.md`
- `../../../docs/SECURITY.md`
- `../../../docs/DEVELOPMENT.md`
- `../../../AGENTS.md`
