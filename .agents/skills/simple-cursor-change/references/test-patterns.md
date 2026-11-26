# 测试编写模式

本仓库只使用 Node.js 内置的 `node:test`。写测试前先阅读 `../../../../tests/AGENTS.md`；以下列出六类模块的测试组织方式，供参考落点，无需整段照搬。

## 1. 纯逻辑模块（`catalog.test.mjs`、`transcript.test.mjs`、`support.test.mjs`）

直接导入被测函数，无需构造外部替身：

```js
import { contextModelId, modelSelection } from '../catalog.js'

const opus = {
  id: 'claude-opus-5-5',
  displayName: 'Claude Opus 5.5',
  parameters: [{ id: 'context', values: [{ value: '300k', displayName: '300K' }] }],
  variants: [{ params: [{ id: 'context', value: '300k' }], isDefault: true }],
}

assert.deepEqual(modelSelection(contextModelId('claude-opus-5-5', '300k'), undefined, [opus]), {
  id: 'claude-opus-5-5',
  params: [{ id: 'context', value: '300k' }],
})
```

适用场景：模型目录转换、上下文与推理强度参数选择、对话指纹与分类、流式分块顺序、`usage` 字段映射及配置校验。

## 2. 模型适配器（`adapter.test.mjs`）

注入最小化的模拟 `bridge`（仅实现 `stream`）、`listModels` 与 `resolveApiKey`：

```js
const selections = []
const adapter = new CursorAdapter({
  bridge: {
    async *stream(_request, extras) { selections.push(extras.model) },
  },
  contextWindow: () => 128_000,
  resolveApiKey: async () => 'cursor_test',
  loadImage: async () => { throw new Error('no image') },
  listModels: async () => [opus, composer],
})

await adapter.listModels('cursor')
await adapter.resolveModel('cursor', 'claude-opus-5-5')
```

适用场景：模型变体展开、上下文容量计算、推理档位透传、目录加载失败回退，以及 `resolveApiKey` 单一凭证来源校验。不要在适配器测试中加载真实 SDK。

## 3. 会话桥接（`bridge.test.mjs`）

注入模拟 SDK 客户端与可控的 `defer` 批处理调度器：

```js
const scheduled = []
const client = {
  agents: [],
  async createAgent() {
    const agent = {
      sends: [],
      async send(message, listeners) {
        let resolveWait
        const run = {
          wait: () => new Promise((resolve) => { resolveWait = resolve }),
          async cancel() { resolveWait?.({ status: 'cancelled' }) },
          finish: (result) => resolveWait(result),
        }
        agent.sends.push({ message, listeners, run })
        return run
      },
      async dispose() {},
    }
    client.agents.push(agent)
    return agent
  },
}
const bridge = createBridge({
  client,
  cwd: '/tmp/dsh-simple-cursor-test',
  defer(fn) { scheduled.push(fn); return () => {} },
})
```

`collect(iter)` 设置 1 秒超时用于防止死锁；`waitFor(predicate)` 通过 0 ms 定时器让出事件循环。并行工具批次通过 `scheduled.splice(0)` 手动触发，不要使用真实 `setTimeout` 等待 30 ms。

适用场景：首轮会话、`follow-up` 续接、工具调用挂起与恢复、历史改写重建、辅助请求隔离、中途取消、空响应及卸载清理。

## 4. 服务端入口（`index.test.mjs`）

使用模拟 `ctx` 捕获注册的路由对象，配合临时替换的 `globalThis.fetch` 模拟 Cursor 上游接口：

```js
let route
const ctx = {
  get: (name) => name === 'credentials' ? credentials : undefined,
  effect: (fn) => { fn() },
  llm: { registerAdapter: () => () => {} },
  inject(names, callback) {
    callback({ ...ctx, connection: { fetch: { register(value) { route = value; return () => {} } } } })
  },
}
apply(ctx, {})
```

重点断言路由的 `path`、`methods`、`requestBody`、HTTP 状态码、`cache-control` 响应头，以及序列化后的响应体不包含 `cursor_test` 或 `access_test`。不要在测试中监听真实端口。

## 5. 浏览器端设置页（`client.test.mjs`）

在动态导入 `client.js` 前挂载 `globalThis.window.__ModuleLoader__.load`，并传入仅实现所需 Hook 的精简版 React：

```js
let captured
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
await import('../client.js')

const module = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
```

通过 `walk`、`collect`、`textOf` 检查返回的虚拟节点树，通过 `applyWith` 配合模拟 `ctx.slots` 与 `ctx.locale` 验证注册参数。由于 Node.js 会缓存首次导入的 `client.js`，前端用例必须集中在这一个文件中。

适用场景：模块 ID、前端 `inject` 列表、设置页分区参数、密码输入框属性、按钮禁用态、用量卡片各状态与中英文文案渲染。不要引入 jsdom。

## 6. 订阅用量（`usage.test.mjs`）

通过参数注入自定义 `fetch`、`now` 与 `ttlMs`：

```js
const usage = await fetchCursorUsage('cursor_test', {
  fetch: async (url, init) => json({ accessToken: 'access_test' }),
  now: () => Date.parse('2026-11-25T00:00:00.000Z'),
})
```

重点断言短期令牌兑换请求头、两条 `DashboardService` RPC 路径、字段归一化结果、401/403 映射为 `INVALID_CREDENTIAL`、缓存命中与 `force` 强制刷新，以及序列化结果不含密钥和令牌。不要请求真实的 `api2.cursor.sh`。

## 基本要求

- 写完新测试后，先确认它在代码修复前会失败（修之前跑一次，或临时改坏断言验证）。
- 新增测试文件必须命名为 `tests/*.test.mjs`，由 `npm test` 自动扫描。
- 断言对外行为与响应结果，不要绑定内部辅助函数的调用顺序。
- 覆盖全局变量（`globalThis.fetch`、`globalThis.window`、`process.env.CURSOR_API_KEY`）后务必在 `finally` 或 `after` 中恢复。
- 测试名称直接描述预期行为，如 `reports the selected variant context window to DSH`。
- 涉及凭证来源、工具执行边界、流式分块契约、会话隔离与取消清理的断言属于安全与核心契约底线，不得为跑通测试而放宽。
- 全程离线运行，不加载原生 SDK 真实会话，也不使用真实密钥。
