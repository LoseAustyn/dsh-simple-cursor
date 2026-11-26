# simple-cursor 工程化收尾记录

状态：已完成落地（2026-11-25）  
范围：独立插件仓库 `dsh-simple-cursor`（`simple-cursor/`）

> 当前架构、开发命令与安全约束均以 `AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/SECURITY.md` 与 `docs/decisions/` 为准，本文仅归纳已落地事项与后续按需评估项。

## 已落地事项

| 事项 | 落地位置 |
|---|---|
| Agent 开发入口指引 | `AGENTS.md`、`tests/AGENTS.md` |
| 统一检查入口 | `npm run check`（语法检查 + 单元测试 + 打包清单校验），本地与 CI 共用 |
| 版本号单一来源 | `usage.js` 的 `user-agent` 读取 `package.json`，由 `usage.test.mjs` 防止版本漂移 |
| 高频工作流 Skill | `.agents/skills/simple-cursor-{change,verify,release}` |
| 核心工程文档 | `docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`、`docs/SECURITY.md` |
| 架构决策记录 | `docs/decisions/`（7 篇 ADR） |
| 双语用户文档与变更日志 | `README.md` / `README.en.md`、`CHANGELOG.md` / `CHANGELOG.en.md` |
| 持续集成与格式规范 | `.github/workflows/ci.yml`、`.editorconfig` |

## 暂缓的可选项

以下事项在当前单人维护与代码体量下暂不构成阻塞，待触发条件出现后再按需补充：

| 可选项 | 触发条件 | 暂缓原因 |
|---|---|---|
| `scripts/verify-identity.mjs` 自动核对多处插件标识 | 插件标识再次发生不一致或挂载错位 | 解析 YAML 与 JS 有额外脚本维护成本，目前靠文档约束即可 |
| `scripts/verify-manifest.mjs` 自动校验根目录模块均列入 `files` | 出现新增模块漏加进 `files` 导致打包缺文件 | 当前模块结构稳定，提交前核对 `check:pack` 已够用 |
| `scripts/verify-docs.mjs` 校验 Markdown 相对链接与 Skill 头信息 | 文档规模继续扩大，人工难以保证链接不失效 | 现阶段文件数量有限，改动文档时直接检查即可 |
| 用量路由与宿主 `connection` 的真实集成脚本 | 宿主路由授权接口调整 | 目前通过 `tests/index.test.mjs` 的模拟上下文覆盖 |
| 模型目录缓存按 API Key 哈希分桶 | 出现多账号高频切换需求 | 单用户场景下 60 秒单槽缓存影响极小，调整前需先补充 ADR |
| 将 `UNSUPPORTED_CONTEXT` 对齐宿主标准错误码 | DSH 重试策略需要专门识别该错误类型 | 目前仅用于向用户提示所选上下文变体不可用，不影响主流程 |
| 测试覆盖率门槛或 Issue / PR 模板 | 测试规模大幅膨胀或开放外部协作贡献 | 现阶段按模块划分的离线行为单测已足够清晰 |

## 已放弃的方案

- **引入 TypeScript、构建工具链、Vitest 或 jsdom**：见 [ADR 0006](../decisions/0006-plain-js-node-test.md)。
- **开启 Cursor 内置工具或加载本地项目/用户 MCP**：见 [ADR 0003](../decisions/0003-dsh-executes-tools.md)。
- **由浏览器直接请求 Cursor 用量接口**：见 [ADR 0005](../decisions/0005-usage-on-host.md)。
- **读取环境变量、插件配置密钥字段或 SDK 本地登录文件**：见 [ADR 0001](../decisions/0001-credential-source.md)。
- **`CLAUDE.md` 与 `.claude/skills` 兼容层**：本仓库仅面向 DSH 环境，统一只维护 `AGENTS.md` 与 `.agents/skills/`。
- **发布至公共 npm 仓库**：当前保持 `private: true` 并通过本地目录挂载，后续若改变分发渠道再单独决策。
