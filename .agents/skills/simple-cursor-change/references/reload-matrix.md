# 重载对照表

修改完成后，按改动类型选择对应的生效与验证方式；完整说明见 `../../../../docs/DEVELOPMENT.md`。

| 改动文件 | 原因 | 生效方式 | 验证方式 |
|---|---|---|---|
| `index.js`、`adapter.js`、`bridge.js`、`catalog.js`、`chunks.js`、`config.js`、`errors.js`、`queue.js`、`schema.js`、`sdk.js`、`transcript.js`、`usage.js` | 默认 Web profile 的 HMR 以 `root: []` 启动，保存外部链接目录中的文件不会自动触发重载；通过插件管理器重新挂载会替换已改动的 `link:` 模块 | 已安装时先 `remove_bundle`，再对同一目录执行 `install_bundle`（无需改目录名）；若未启用 HMR 或返回 `restart-required`，则重启 DSH | 发起一次真实模型请求、查看设置页用量，并确认插件项 `include:simple-cursor` 为激活状态 |
| `client.js` | 浏览器端模块在页面加载时求值；`pnpm run dev:web` 只重新构建 DSH 自身前端包 | 刷新浏览器页面 | 检查「更多 → 设置 → Cursor」页面、保存/清除密钥与用量刷新 |
| `package.json`、`cordis.patch.yml`、`dsh.client.inject` | 包清单与客户端注入声明在重装及页面加载时读取 | `remove_bundle` → `install_bundle` 并刷新页面，或重启 DSH | `install_bundle` 返回 `applied` 且 `warnings=[]`；检查插件页与设置导航 |
| `locale/*.json`、`icon.svg` | 插件管理器按需读取导出的静态资源，`link:` 安装直接指向源码目录 | 刷新浏览器页面（必要时强制刷新）；打包安装的副本需重新安装 | 检查中英文插件详情页的标题、简介与图标 |
| `package.json` 依赖项、SDK 版本 | 运行时从插件目录 `node_modules` 解析依赖 | 先在插件目录执行 `npm install`，再按上法重装或重启 DSH | 启动无模块解析报错，并完成一次真实模型请求 |
| `tests/`、`docs/`、`.agents/` | 不参与运行时 | 无需重载 | 运行对应的检查命令 |

## 常用操作参考

```sh
# 服务端模块或清单改动：先移除已安装的同名包，再安装同一本地目录
# plugin_manager remove_bundle dsh-simple-cursor
# plugin_manager install_bundle target=/path/to/simple-cursor

# 未启用 HMR 或返回 restart-required 时，由用户重启 DSH

# 浏览器端、locale 或图标改动：刷新 DSH Web 页面（必要时强制刷新）

# 校验发布打包文件列表
npm run check:pack
```

## 判定标准

- `install_bundle` 必须以返回 `application=applied` 且 `warnings=[]` 为成功依据；仅看日志、进程列表或页面初始 payload 不能算安装成功。
- 同一包已存在时调用 `install_bundle` 会返回 `already-installed`，需先执行 `remove_bundle` 再重装。
- 返回 `restart-required` 说明变更已写入配置但尚未激活，请根据 `restartReason`（如 `no-hmr`、`package-moved`）重启 DSH 后再验收。
- 有 `list_plugins` 工具时，确认 `include:simple-cursor` 的 `fiberPhase=active` 才代表插件服务端已挂载；无该工具时以插件页面显示为准。
- 本插件未注册 `/version` 探测路由。未携带登录态直接 `curl /api/dsh-simple-cursor/usage` 返回 `401` 仅说明宿主 `/api` 通道存在，**不能**证明本插件路由已挂载，应以设置页实际用量请求为准。
- 服务端改动不能只看单测通过：单测直接加载磁盘源码，而运行中的宿主仍持有旧模块，必须重装触发重载或重启宿主。
- 没有浏览器自动化控制与真实账号时，设置页交互、模型选择器与真实 Cursor 请求一律标为「待用户确认」。

## 常见误判对照

| 观察到的现象 | 不能直接证明的结论 |
|---|---|
| `npm run check` 全绿 | 运行中的 DSH 已加载最新服务端代码 |
| `install_bundle` 返回 `applied` | 设置页交互、模型选择器或真实请求正常 |
| 保存了本地源码文件 | HMR 已自动重载（`root: []` 下编辑文件不触发重载） |
| `list_plugins` 中存在插件条目 | 浏览器已加载最新 `client.js`（仍需刷新页面） |
| 设置页出现 `Cursor` 分区 | 已保存的 API Key 有效或上游用量接口可用 |
| 模型选择器出现 `Cursor` | 实际对话或工具调用能走通 |
| 单测中模拟 SDK 返回正常文本 | 真实 `@cursor/sdk` 上游行为完全一致 |
