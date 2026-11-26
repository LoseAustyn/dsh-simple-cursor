# 0006 保持纯 ESM JavaScript、node:test 与边界注入

Status: accepted
Date: 2026-11-25

## 背景

本插件以本地 bundle 形式由 DSH profile 直接挂载运行：服务端直接加载标准 ESM 模块，浏览器端由宿主的页面模块加载器动态求值。核心依赖 `@cursor/sdk` 包含平台相关的原生二进制包，真实调用需要联网并消耗个人 Cursor 订阅额度；同时单元测试也不应强依赖运行中的完整 DSH 进程。

若引入 TypeScript 与打包构建步骤，会增加编译产物同步、Source Map 调试以及版本升级维护成本；若引入 Vitest、jsdom 或 Playwright 作为日常提交门禁，则会显著拉长安装与运行耗时，且依然无法替代真实 Cursor 账号联调。

## 决策

- 运行时保持纯 ESM JavaScript，无编译与打包步骤。
- 单元测试统一使用 Node.js 内置的 `node:test` 与 `node:assert/strict`。
- 通过参数注入隔离外部边界（SDK 客户端、`fetch`、Cordis `ctx`、精简版 React、`now` 与 `defer` 调度器），不对内部业务模块做整体 mock。
- `sdk.js` 在首次实际调用时动态 `import('@cursor/sdk')`，使离线单测无需加载原生二进制模块。
- 前端设置面板使用精简版模拟 React 检查生成的元素树，不引入 jsdom。
- 真实模型对话、设置页视觉与浏览器交互留给人工验收清单覆盖。

## 影响

- 开发环境执行一次 `npm install` 后即可秒级跑完 `npm run check`，全程离线、零额度消耗。
- 缺少编译期类型检查，模块间接口契约依靠 JSDoc 注释、单测覆盖与代码评审把关。
- 模拟替身可能无法第一时间感知上游 SDK 或宿主插槽协议的破坏性变更，涉及升级时必须配合人工实机验收。
- 由于 Node.js 会缓存首次导入的 `client.js`，所有前端组件测试统一维护在单个 `tests/client.test.mjs` 文件中。
- 后续若提议新增开发或运行时依赖，须先明确指出当前方案无法解决的具体问题。

## 备选方案

- **引入 TypeScript 与构建工具链**：虽然静态类型更强，但对当前千行级插件而言，构建产物管理与调试链路拉长的代价大于收益，放弃。
- **引入 Vitest + jsdom**：增加依赖体积与 DOM 模拟复杂度，现有元素树检查已足以覆盖表单属性、状态切换与双语文案，暂不引入。
- **将 Playwright 或真实 Cursor 请求纳入 CI 门禁**：依赖真实浏览器、运行中的 DSH 及付费账号密钥，外部波动大，仅保留在人工验收环节。
