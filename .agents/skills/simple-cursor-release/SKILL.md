---
name: simple-cursor-release
description: "Use when bumping the dsh-simple-cursor version, updating the changelog or package-lock, packing, tagging, or installing a release; keeps version, package contents, install state, and remote state consistent."
---

# Simple Cursor 发布流程

适用于升版、同步锁文件、打包校验、打 Git tag 及本地安装验收。所有对外推送或发布动作都需先获得用户明确授权，本流程不替代授权。

## 1. 发布前检查

```sh
git status --short --branch
npm run check
node -p "require('./package.json').version"
git remote -v
git log --oneline -5
```

- 工作区必须干净，且 `npm run check` 全部通过。
- 先确认分发方式：当前包为 `private: true`，通过 profile 的 `link:` 本地安装；如需发布到 npm，需另行决策并调整 `private` 与 `publishConfig`，不要在常规发版中顺手改动。
- 若仓库未配置远端 `origin`，可在本地完成提交与打标签，并在报告中注明「未配置远端，未推送」。
- 若配置了远端且远端 `main` 已有本地未同步的新提交，立即停止，避免覆盖远端历史。

## 2. 更新版本号与变更日志

只需修改 `package.json` 中的 `version` 字段（`usage.js` 的 `user-agent` 会自动读取该值，不要在代码里硬编码版本号），随后同步 `package-lock.json` 根版本：

```sh
node -p "require('./package.json').version"
npm install --package-lock-only
node -p "require('./package-lock.json').packages[''].version"
```

同步更新 `CHANGELOG.md`（中文）与 `CHANGELOG.en.md`（英文）：将 `Unreleased` 下的条目归入 `## [x.y.z] - YYYY-MM-DD`，聚焦用户可见的变化、兼容性与迁移说明；两版内容保持对齐，不要直接粘贴 commit 列表。

## 3. 打包与安装核验

```sh
npm run check
npm pack --dry-run
```

逐项确认：

- 语法检查与全部单元测试通过。
- 打包清单包含 `index.js`、`client.js`、`adapter.js`、`bridge.js`、`catalog.js`、`chunks.js`、`config.js`、`errors.js`、`queue.js`、`sdk.js`、`schema.js`、`transcript.js`、`usage.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`README.en.md`、`package.json`。
- 不包含 `tests/`、`docs/`、`.agents/`、`node_modules/`、`.github/` 或 `*.tgz`。

若当前环境支持安装验证：

```sh
# 已安装同名包时先 remove_bundle，再通过 plugin_manager 的 install_bundle 安装本目录绝对路径
# 期望返回 application=applied、warnings=[]
```

- 服务端模块更新需通过同一目录的 `remove_bundle` → `install_bundle` 触发 HMR 重载；若未启用 HMR 或返回 `restart-required`，则重启 DSH。
- 本插件未提供 `/version` 路由，不要用 `curl` 状态码推断升级结果；应以插件处于激活状态、「更多 → 设置 → Cursor」页面、模型选择器及一次真实模型请求为准。
- 若无安装验证条件，在报告中如实标为「待验证」。

## 4. 提交、打标签与推送

```sh
git add package.json package-lock.json CHANGELOG.md CHANGELOG.en.md
git commit -m "Release x.y.z"
git tag vx.y.z
```

当存在远端仓库且用户已明确授权推送时执行：

```sh
git push origin main --tags
git ls-remote --heads origin main
git ls-remote --tags origin "vx.y.z"
```

- 推送前再次确认远端 `main` 仍指向预期 commit，若有变动则停止。
- 禁止使用 `--force`；确需改写历史时先询问用户。
- 推送完成后用 `git ls-remote` 实测远端状态，不要凭本地记录推断。

## 5. 发布报告

```text
版本号：   x.y.z
提交：     <sha>
标签：     vx.y.z
远端核对： main=<sha>, tag=<sha> / 未配置远端，未推送
打包清单： dsh-simple-cursor-x.y.z.tgz (dry-run: N 个文件)
已验证：   npm run check、打包清单、安装状态与基础检查
待验证：   真实 Cursor 请求、真实订阅用量展示、浏览器视觉效果（如未执行）
```

## 完成标准

- 版本号只维护在 `package.json` 中，`package-lock.json` 根版本与其一致，代码中无手写版本常量。
- `CHANGELOG.md` 与 `CHANGELOG.en.md` 均已更新且内容对齐。
- 打包清单干净，无测试、文档或开发辅助文件混入。
- 若执行了推送，远端 `main` 与 tag 的 SHA 已通过 `git ls-remote` 复核。
- 未执行的发布或人工验收步骤如实标注，不写成已完成。

## 何时停下

- 工作区有未提交改动，或 `npm run check` 未通过。
- 远端 `main` 已前移，或目标 tag 已存在且指向不同提交。
- 需要调整分发方式、执行 `npm publish` 或强制推送，但尚未获得用户明确授权。
- 需要放宽 `engines.dsh` 或 peer 依赖版本范围才能安装，但尚未记录架构决策。
