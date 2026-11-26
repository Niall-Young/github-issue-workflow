# Issue 看板（Orca Plugin）

面向非开发者的项目级 Issue 仪表盘插件，直接打开在 Orca 主区域标签页中（每个项目独立一个看板）。

## 核心体验

- **快速提需求 / 报问题**：用大白话输入即可自动创建带 `agent-ready` 标签的 GitHub Issue，交给后台 `github-issue-autopilot` 自动处理与合并。
- **只看结果，不看开发细节**：左侧展示「进行中」与「已完成（可直接验收）」，隐藏分支、worktree、重试与日志噪声。
- **只在需要时打扰**：右侧「需要你处理」与底部状态栏红点提醒，仅在助手向你提问或任务需要人工拍板时亮起，可直接回复或点「同意继续」「重试」「放弃」。

## 在 Orca 中加载（开发 / 本地使用）

```bash
orca plugin dev load /path/to/github-issue-workflow/orca-plugin
```

首次加载会提示授权插件所需权限；按提示执行带 `--approve <fingerprint>` 的命令完成授权后：

- 点击 Orca 底部状态栏的 **Issue 看板**，或按 `Cmd+Shift+I`（命令面板搜索「打开当前项目的 Issue 看板」），即可在当前项目主区域打开专属看板标签页。

## 验证命令

```bash
orca plugin validate ./orca-plugin --json
orca plugin test ./orca-plugin --json
orca plugin check ./orca-plugin --json
```
