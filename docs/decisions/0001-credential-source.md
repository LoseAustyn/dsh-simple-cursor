# 0001 密钥统一从 DSH credentials 服务读取

Status: accepted
Date: 2026-11-25

## 背景

插件发起模型推理和查询订阅用量都需要 Cursor API Key。候选配置途径包括插件 `Config` 配置项、进程环境变量、`.env` 文件、`~/.cursor/sdk/auth.json` 登录文件以及 DSH 的 `credentials` 凭证服务。如果同时支持多处读取，会带来三个现实问题：

- 用户难以判断当前请求实际命中的是哪一把密钥。
- 一旦允许写进 `cordis.patch.yml` 或日志，密钥极易随配置备份、截图或仓库同步泄露。
- 在设置页面更新密钥后，若被环境变量或本地登录文件覆盖，会出现「界面提示保存成功但实际未生效」的困惑。

DSH 已内置了「配置层只存引用名、密文值由凭证提供方托管」的 `credentials` 服务，前端可通过 Remote 安全写入，服务端适配器可在每次请求时动态解析。

## 决策

插件代码统一只通过 `ctx.credentials.resolve('CURSOR_API_KEY')` 获取密钥：

- 设置页的「保存 / 清除」操作通过 `ctx.remote.credentials` 写入托管存储。
- `Config` Schema 仅保留 `cwd` 与 `contextWindow`，明确拒绝 `apiKey`、`apiKeyEnv` 等字段。
- 插件自身不读取 `process.env`、`.env` 或 `~/.cursor/sdk/auth.json`。

DSH `credentials` 服务自身的底层来源优先级（托管存储文件 > 启动环境变量 > 项目/用户 `.env`）仍由宿主统一管理；设置页通过 `describe` 返回的 `source` 向用户展示当前生效来源。

## 影响

- 用户统一在「更多 → 设置 → Cursor」（或宿主凭证服务的其他标准入口）配置密钥，不存在绕过凭证服务的配置文件写法。
- 每次请求实时调用 `resolve`，更换密钥后在下一次模型请求时立即生效；`bridge` 检测到密钥变化会自动销毁旧的本地 agent。
- 凭证服务缺失、未配置或读取失败时统一返回 `MISSING_CREDENTIAL` 并引导前往设置页，绝不静默回退到其他来源。
- 单元测试必须保留「即便 `process.env.CURSOR_API_KEY` 存在，凭证服务无值时依然报错」的用例，防止后续误加环境变量兜底。
- 若部署环境通过进程环境变量向宿主 `credentials` 服务注入了同名键，需在宿主的凭证提供方层控制开关，不在插件内重复做第二套策略。

## 备选方案

- **在插件 `Config` 中配置 `apiKey`**：实现简单，但密钥会明文落入 `cordis.patch.yml` 与配置备份，放弃。
- **直接读取 `process.env.CURSOR_API_KEY`**：便于无界面环境使用，但会绕过宿主凭证服务的优先级与状态查询，用户无法在界面获知来源，放弃。
- **自动回退读取 `~/.cursor/sdk/auth.json`**：虽然免去了手动配置，但会隐式混用本机 Cursor 客户端的登录态，导致两边登出与切换账号行为互相干扰，放弃。
- **插件内自行合并多种来源并维护优先级**：维护与排查成本高，仍容易引发保存后被其他来源覆盖的困惑，放弃。
