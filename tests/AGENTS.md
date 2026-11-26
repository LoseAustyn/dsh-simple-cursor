# tests/AGENTS.md

本目录存放基于 `node:test` 的离线行为测试。测试不请求 Cursor 服务、不联网、不启动 DSH、不使用真实密钥，也不引入 jsdom、Playwright 或第三方断言库。

## 文件分工

| 文件 | 覆盖范围 |
|---|---|
| `support.test.mjs` | `chunks.js`、`config.js`、`schema.js`、`sdk.js` 的纯函数逻辑与 `errors.js` 错误映射 |
| `adapter.test.mjs` | `CursorAdapter` 的模型目录展开、模型解析、变体选择、离线兜底，以及 `resolveApiKey` 单一凭证来源 |
| `bridge.test.mjs` | 会话级本地 agent：首轮请求、`follow-up` 续接、工具挂起与恢复、历史改写重建、辅助请求隔离、中途取消、空响应与卸载释放 |
| `transcript.test.mjs` | 历史指纹计算、`classify` 分类、对话文本拼装、系统提示词前置与工具结果载荷组装 |
| `catalog.test.mjs` | 目录条目转换、上下文与推理强度参数解析、模型参数组装、`Max Mode` 推断与 60 秒缓存 |
| `index.test.mjs` | `apply()` 的适配器挂载、用量路由注册、凭证缺失处理与响应脱敏 |
| `client.test.mjs` | 模块加载器与工厂 ID、前端 `inject` 声明、设置页分区注册、密码框与按钮状态、用量卡片状态及中文文案渲染 |
| `usage.test.mjs` | 短期令牌兑换、`DashboardService` 响应归一化、TTL 缓存控制与错误码归类 |

## 编写规范

- 断言对外可观察的行为与返回结果，不要绑定内部辅助函数的调用顺序。
- 测试名称直接描述预期行为（例如 `keeps an auxiliary request off the conversation agent`），不要写含糊的 `should work`。
- 写完新测试后，先确认它在代码修复前会失败（修之前跑一次，或临时改坏断言验证），避免写出永不失败的空断言。
- 新增测试文件统一命名为 `tests/*.test.mjs`，由 `npm test` 自动匹配运行。
- 不对整个模块做 mock，只通过依赖注入替换外部边界：SDK 客户端、`fetch`、Cordis `ctx`、精简版 React、`now` 与 `defer` 调度器。
- 修改全局状态（`globalThis.fetch`、`globalThis.window`、`process.env.CURSOR_API_KEY`）后，必须在 `finally`、`after` 钩子中恢复原值。
- `client.test.mjs` 需在 `await import('../client.js')` 前挂载 `globalThis.window`；由于 Node.js 会缓存已加载的 ESM 模块，所有前端测试用例统一写在这一个文件内，不要新建第二个导入 `client.js` 的测试文件。
- `bridge.test.mjs` 通过注入 `defer` 手动触发工具批次，使用 0 ms 定时器的 `waitFor` 让出事件循环，不要在单测中等待真实时钟；`collect()` 中的 1 秒超时仅用于防止死锁挂起。
- `index.test.mjs` 使用模拟 `ctx` 捕获 `connection.fetch.register` 注册的路由处理函数直接调用，不要监听本地端口或启动 DSH。
- `usage.test.mjs` 通过注入 `fetch`、`now` 与 `ttlMs` 测试缓存和超时逻辑，并断言序列化后的结果不包含 API Key 或短期令牌。
- 测试用例中严禁出现真实密钥，统一使用 `cursor_test`、`access_test` 等占位字符串。
- 涉及凭证来源、工具执行边界、流式输出顺序、会话隔离与取消清理的断言属于安全与核心行为底线，不得为了跑通测试而放宽或删除。
- 如调整测试架构或引入新的模拟方式，请同步更新本文档与 `docs/DEVELOPMENT.md`。
