---
name: simple-cursor-verify
description: "Use before claiming dsh-simple-cursor work is done, committing, or reviewing a change; selects the smallest evidence for the touched surface and reports verified, unverified, and blocked items separately."
---

# Simple Cursor 验收流程

在宣布改动完成、提交代码或做代码评审前使用。核心原则是让每一条结论都有明确证据，不把推测当成验证结果。

## 1. 按改动范围选择检查项

| 改动范围 | 必跑项 | 补充项 |
|---|---|---|
| 适配器、模型目录、变体选择 | `node --test tests/adapter.test.mjs tests/catalog.test.mjs` | 在真实模型选择器中人工确认 |
| 会话桥接、工具往返、中途取消 | `node --test tests/bridge.test.mjs tests/transcript.test.mjs` | 发起一次带 DSH 工具调用的真实对话 |
| 凭证解析、设置面板 | `node --test tests/adapter.test.mjs tests/client.test.mjs tests/index.test.mjs` | 保存/清除密钥后刷新页面并发起真实请求 |
| 订阅用量 | `node --test tests/usage.test.mjs tests/index.test.mjs` | 检查设置页用量卡片、手动刷新与响应脱敏 |
| 清单、locale、图标 | `npm run check:pack` | `link:` 安装刷新页面（打包安装需重装），检查中英文插件详情页 |
| SDK 参数或版本升级 | `node --test tests/support.test.mjs tests/bridge.test.mjs` | 重装或重启后验证新建 agent 及工具边界 |
| 文档 / Skill | 受影响的检查命令 | 确认相对链接有效、命令可直接复制执行 |

不确定影响面时直接运行 `npm run check`，它涵盖语法检查、全部单元测试和打包清单校验，是提交前的统一入口。

## 2. 必跑检查

```sh
npm run check
```

预期结果：

- `node --check` 覆盖全部运行时模块，无语法错误。
- 单元测试全部通过（具体用例数以实际输出为准）。
- `npm pack --dry-run` 只包含预期发布文件，不夹带 `tests/`、`docs/`、`.agents/`、`node_modules/` 或 `*.tgz`。
- 终端输出中不包含真实 API Key 或短期访问令牌。

必要时可单独核对：

```sh
npm pack --dry-run
git diff --stat
```

确认打包文件列表与 `package.json` 的 `files` 一致；若新增了运行时模块但漏加进 `files`，打包安装后会出现模块缺失。

## 3. 人工检查清单

以下项目依赖运行中的 DSH 与真实 Cursor 账号，只能由用户亲自确认，不要代为宣布通过：

1. **更多 → 设置 → Cursor**：确认导航位置（位于 Models 与 Plugins 之间）、标题、说明文案与未配置/已配置状态指示点正常。
2. **保存与清除密钥**：粘贴有效密钥点击保存后状态变为「已配置」，刷新页面仍保持不变；点击清除后回到「未配置」。
3. **订阅用量**：保存密钥后自动展示套餐与百分比；点击「刷新」发起 `?refresh=1` 请求；保存无效密钥时展示可读报错；浏览器开发者工具网络面板中的响应不含原始密钥或短期令牌。
4. **模型选择器**：出现 `Cursor` 提供方、账号可用模型、各上下文窗口变体（如 `300K`、`1M`）及推理强度选项。
5. **真实对话**：流式输出正常，中途取消不会残留卡死状态，下一轮可继续发送；触发上下文压缩后能平滑重建新 agent。
6. **工具往返**：模型发起的工具调用由 DSH 执行，执行结果送回同一次运行继续生成回复，期间不出现 Cursor 内置工具。
7. **辅助请求**：新建会话自动生成标题时使用独立 agent，不影响当前主对话。
8. **图片输入**：启用 `attachments` 服务时可正常发送图片；缺失该服务时明确报 `UNSUPPORTED_CONTENT`。
9. **插件详情页**：在中文与英文界面下，标题、简介与图标均正常显示。
10. **重载或重启恢复**：重装触发重载或重启 DSH 后，已保存密钥依然有效，新消息按 `fresh` 重建本地 agent，无残留状态冲突。

未执行的项目一律归入「待验证」，并说明用户应如何确认。

## 4. 安全与边界复核

只要改动触及凭证读取、用量路由、SDK 参数、工具边界或流式输出契约，必须逐项核对 `references/provider-checklist.md`，不要用「现有单测全绿」替代逐项检查。

## 5. 验收报告格式

```text
已验证：
- npm run check — 语法检查通过，单测全绿（以实际输出条数为准），pack 共 N 个文件
- 用量路由单测确认响应体不含 cursor_test / access_test

待验证：
- 设置页保存真实密钥后的订阅用量展示（需用户使用 Cursor 账号确认）
- 模型选择器中的真实模型目录与上下文变体（需用户确认）

受阻项：
- 无 / 具体阻塞原因
```

汇报原则：

- 不要把「单测通过」写成「真实 Cursor 请求已通过」。
- 不要把「`install_bundle` 返回 applied」写成「设置页或模型选择器已验证通过」。
- 未携带登录态直接 `curl /api/...` 返回 `401` 只说明宿主 `/api` 通道存在，不能证明本插件用量路由已挂载，不要据此写成「路由已生效」。
- 不隐瞒失败命令或跳过的检查项；每一条「已验证」都必须有命令输出或可复现依据。

## 验收标准

- 每一条「已验证」都有对应的命令输出或可复现依据。
- 未验证项单独列出，并附带具体确认方式。
- 凭证、工具边界、流式契约与会话隔离逐项有明确结论，不写「应该没问题」。
- 不通过放宽断言或跳过测试来换取绿灯。

## 参考文档

- `references/provider-checklist.md`
- `../../../docs/SECURITY.md`
- `../../../docs/DEVELOPMENT.md`
- `../../../AGENTS.md`
