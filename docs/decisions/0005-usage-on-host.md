# 0005 在服务端查询订阅用量并仅返回脱敏归一化字段

Status: accepted
Date: 2026-11-25

## 背景

在「更多 → 设置 → Cursor」面板中展示套餐、计费周期、额度百分比与重置时间，能够帮助用户随时确认密钥可用性与剩余额度。Cursor 的 `DashboardService` 接口需要先用用户的长期 API Key 兑换短期访问令牌（Access Token），再发起查询。

如果让浏览器直接请求 Cursor 接口：

- 必须将 API Key 或短期访问令牌暴露给前端上下文，大幅增加 XSS、浏览器扩展或抓包泄露的风险。
- 受限于跨域（CORS）策略与上游 protobuf-JSON 结构，前端难以直接稳定调用。

如果不提供用量面板，用户每次确认密钥状态和剩余额度都只能跳转外部网页查看。

## 决策

在 Node 服务端通过 `connection.fetch.register` 注册受宿主认证保护的精确路由：

```text
GET /api/dsh-simple-cursor/usage
GET /api/dsh-simple-cursor/usage?refresh=1
```

处理流程：

1. 调用 `ctx.credentials.resolve('CURSOR_API_KEY')` 在服务端读取密钥。
2. 请求 `POST /auth/exchange_user_api_key` 换取短期访问令牌。
3. 并行请求 `GetCurrentPeriodUsage` 与 `GetPlanInfo`（单次超时上限 15 秒）。
4. 通过 `normalizeUsage()` 仅提取套餐信息、计费周期、用量百分比、额度池、按量消费与查询时间，丢弃上游原始响应中的其余字段。
5. 在进程内存内按 `sha256(apiKey)` 缓存快照 30 秒，传入 `refresh=1` 时跳过缓存强制更新。
6. 所有响应附带 `cache-control: no-store`；异常统一收敛为安全的 `{ code, message }`（凭证无效返回 `400`，其余上游异常返回 `502`）。

路由直接复用 DSH `connection` 的 `/api` 认证通道（含同源检查、登录 Cookie 校验与 owner Peer 授权），插件不再重复编写自定义鉴权中间件。

## 影响

- API Key 与短期访问令牌全程留在服务端进程内，浏览器仅接触脱敏后的百分比与数值字段。
- 在未启用 `connection` 服务的运行环境中，用量路由不会挂载，设置页会提示无法读取用量，但模型推理功能不受影响。
- 默认最多存在 30 秒缓存延迟，用户可通过「刷新」按钮随时拉取最新数据。
- 用量查询与模型推理相互独立：即便上游统计接口短暂故障，也不会阻塞正常对话。

## 备选方案

- **前端直连 Cursor 接口**：存在密钥暴露至浏览器的安全隐患及跨域限制，放弃。
- **服务端原样透传 `DashboardService` 原始 JSON**：容易夹带多余账号元数据，且会使前端渲染强耦合上游内部字段名，放弃。
- **完全省略用量展示**：降低设置页确认密钥有效性及关注额度的便利性，放弃。
