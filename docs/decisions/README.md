# 架构决策记录（ADR）

本目录记录影响插件架构、安全边界、凭证管理、工具执行策略、测试方式或分发形态的关键决定。每条决定单独成文、按编号递增；若后续状态发生变化，只更新 `Status` 字段，不改写当时的历史背景与理由。

## 模板

```markdown
# NNNN 标题

Status: proposed | accepted | superseded
Date: YYYY-MM-DD

## 背景
需要做决定的背景、约束条件与触发原因。

## 决策
最终采用的方案（用现在时描述）。

## 影响
带来的收益、代价，以及后续必须遵守的约束。

## 备选方案
认真评估过但未采用的方案及其放弃原因。
```

## 决策索引

- [0001 密钥统一从 DSH credentials 服务读取](0001-credential-source.md)
- [0002 按会话隔离本地 agent，用历史指纹判定续接](0002-agent-per-session.md)
- [0003 工具统一由 DSH 执行，仅向 Cursor 开放自定义工具](0003-dsh-executes-tools.md)
- [0004 将上下文窗口变体展开为独立模型条目](0004-context-variants.md)
- [0005 在服务端查询订阅用量并仅返回脱敏归一化字段](0005-usage-on-host.md)
- [0006 保持纯 ESM JavaScript、node:test 与边界注入](0006-plain-js-node-test.md)
- [0007 普通对话拒绝不支持的调用参数，辅助请求使用默认值](0007-unsupported-call-controls.md)

新增决定时请同步更新此索引，不要把重要权衡只留在 commit message 或聊天记录里。
