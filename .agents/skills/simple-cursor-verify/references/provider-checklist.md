# 安全与契约核对清单

修改凭证解析、用量路由、SDK 调用选项、工具边界或流式输出契约时，请逐项核对以下条目。完整威胁模型见 `../../../../docs/SECURITY.md`。

## 凭证管理

- [ ] 唯一密钥读取入口为 `ctx.credentials.resolve('CURSOR_API_KEY')`，未新增 `process.env`、配置字段、`.env` 或 SDK 登录文件回退。
- [ ] `Config` Schema 仅包含 `cwd` 与 `contextWindow`；`resolveConfig` 仍明确拒绝 `apiKey`、`apiKeyEnv` 等未知字段。
- [ ] 每次模型请求动态重新解析密钥，不在适配器内缓存明文；检测到密钥变更时自动销毁旧 agent。
- [ ] 浏览器端只调用 `credentials.describe` / `set` / `unset`；`describe` 不返回密钥明文；保存成功后立即清空输入框草稿。
- [ ] 错误信息、终端日志与 HTTP 响应中均不出现完整密钥或短期访问令牌。
- [ ] `credentials` 服务缺失或未配置密钥时统一抛出 `MISSING_CREDENTIAL`，绝不降级读取其他来源。

## 订阅用量路由

- [ ] 通过 `connection.fetch.register` 注册精确路径 `/api/dsh-simple-cursor/usage`。
- [ ] 未注册裸 `webServer` 路由，未自建鉴权拦截或本机回环免鉴权放行逻辑。
- [ ] 宿主缺少 `connection` 服务时不挂载该路由；设置页用量区给出明确不可用提示，但模型提供方本身仍可正常工作。
- [ ] 仅接受 `GET` 请求，`requestBody: 'buffered'`，查询参数仅读取 `refresh=1`。
- [ ] 所有响应携带 `cache-control: no-store`，仅返回归一化后的安全字段，不透传上游原始 JSON。
- [ ] 失败响应只返回 `{ code, message }`：`resolveApiKey` 失败返回 `400`；上游 `401`/`403` 映射为 `INVALID_CREDENTIAL`（`400`），其余上游异常返回 `502`。
- [ ] 内存缓存以 `sha256(apiKey)` 为键，不保存密钥原文、不落盘；`force=true` 可跳过缓存。
- [ ] 单次上游请求设 15 秒超时，网络或超时错误统一归类为 `USAGE_TIMEOUT` 或 `USAGE_UNAVAILABLE`。

## 工具执行边界

- [ ] `localAgentOptions()` 固定保持 `tools: ['mcp']` 与 `settingSources: []`。
- [ ] 自定义工具仅由当次 DSH 请求的 `name`、`description`、`parameters` 映射生成，无本地隐式注入。
- [ ] 自定义工具的 `execute` 仅将调用挂起交给 `bridge`，插件自身不执行文件读写、终端命令或网页抓取。
- [ ] 工具执行结果严格按 `toolCallId` 匹配；若待决集合不一致，`classify` 自动回退为 `fresh` 重建实例；并发请求或非法工具名直接报 `INVALID_REQUEST`。
- [ ] 未启用任何 Cursor 内置工具，也未加载项目级或用户级 MCP 配置。

## 流式输出契约

- [ ] `usage` 分块位于 `finish` 之前，`finish` 发出后不再产出任何分块。
- [ ] 每个 `block-start` 均有配对的 `block-end`，同一内容块的增量分块复用同一个 `index`。
- [ ] 工具调用的 `arguments` 与 `argumentsDelta` 均为原始 JSON 字符串。
- [ ] 工具轮次结束时仅发出 `finish { kind: 'tool-calls' }`，整次 Cursor 运行真正结束时再上报 `usage`。
- [ ] 空回复映射为 `EMPTY_RESPONSE`，取消映射为 `ABORTED`，未归类传输失败映射为 `TRANSPORT`。
- [ ] `options.signal` 全链路透传至队列与附件读取；触发取消时立即终止当前运行并释放会话槽位。

## 会话与本地 Agent

- [ ] `sessionKey` 将普通主对话与带 `purpose` 的辅助请求严格隔离，不同会话之间不共用实例。
- [ ] 同一 `sessionKey` 同时最多存在一个运行中请求，并发调用直接返回 `INVALID_REQUEST`。
- [ ] 历史前缀不一致走 `fresh` 重建，匹配待决工具结果走 `tools` 恢复，纯新增用户侧消息走 `follow-up` 增量发送。
- [ ] `fresh` 将完整对话渲染为单条用户消息发送，`follow-up` 仅发送新增后缀。
- [ ] `drop()` 确保取消运行、销毁 agent、拒绝所有挂起的工具回调并从会话表中移除。
- [ ] 插件卸载清理回调会调用 `bridge.dispose()` 释放全部存活实例。

## 模型目录与上下文容量

- [ ] 目录暴露 `context` 参数时上报所选变体的真实容量，仅在缺少该参数时回退到 `contextWindow`。
- [ ] `::context=` 仅用作 DSH 选择器内部标识，发往 SDK 前正确还原为真实模型 ID 与 `context` 参数。
- [ ] 保留所选变体携带的其他参数及 `maxMode` 标记，不丢失变体配置。
- [ ] 请求了模型不支持的 `context` 或 `reasoningEffort` 时明确报错，不静默降级。
- [ ] 目录拉取失败时仅打印一次警告并返回静态兜底模型列表；此时若显式指定了 `reasoningEffort` 则直接报错中止。

## 浏览器端设置页

- [ ] 模块加载器 ID、前端 `inject` 列表、设置页分区 `id` / `order` / `locale` 未被意外改动。
- [ ] 中英文文案同步补齐，未将单一语言硬编码在组件渲染分支中。
- [ ] 样式仅使用 `--dsw-alias-*` 主题变量，未引入额外 DSH 前端组件包，也未直接修改全局 DOM。
- [ ] 密钥输入框保持 `type="password"`、`autoComplete="off"`、`spellCheck={false}`，保存后自动清空。
- [ ] 错误与状态提示分别设置 `role="alert"` 与 `role="status"`。

## 测试覆盖核对

- [ ] `tests/adapter.test.mjs` 覆盖单一凭证来源、目录变体展开、上下文容量、推理档位与离线兜底。
- [ ] `tests/index.test.mjs` 覆盖用量路由挂载、凭证缺失与响应脱敏。
- [ ] `tests/usage.test.mjs` 覆盖 401/403 映射、TTL 缓存、`force` 刷新及无密钥/令牌泄露。
- [ ] `tests/support.test.mjs` 覆盖 `tools: ['mcp']` 与 `settingSources: []`。
- [ ] `tests/bridge.test.mjs` 覆盖 `tools`/`follow-up`/`fresh` 切换、中途取消、空响应与 `dispose`。
- [ ] `tests/client.test.mjs` 覆盖模块注册、密码框属性、用量卡片状态及中文文案渲染。

只要有任意一项无法确认勾选，立即停止推进，不要以「其他测试都过了」为由跳过。
