# Issue 看板（Orca Plugin）

面向非开发者的项目级 Issue 仪表盘插件，直接打开在 Orca 主区域标签页中（每个项目独立一个看板）。

## 核心体验

- **TUI 风格主区域看板**：等宽终端美学、清晰框线与键盘快捷键（`n` 提需求、`r` 刷新、`1/2/3` 切换类型、`⌘V` 贴截图、`⌘↵` 提交），每个项目独立一个标签页。
- **默认走 `github-issue-handoff` Skill 提单 + 附截图/文件**：用大白话输入，支持直接 **`Cmd+V` 粘贴截图**、**拖拽文件**或点击选文件；附件自动保存到 `~/.local/state/github-issue-autopilot/attachments/<project>/`（不污染 Git 仓库）。默认模式会通过 Orca `agent.launch` 启动项目默认 Agent，按 `github-issue-handoff` 规范读取代码上下文、查重并套用标准模板提单（如需补充信息会自动出现在右侧「需要你处理」等待回复）；也可一键切换为「直提」模式直接调用 `gh issue create`。
- **只看结果，不看开发细节**：左侧展示「进行中」与「已完成（可直接验收）」，隐藏分支、worktree、重试与日志噪声。
- **只在需要时打扰**：右侧「需要你处理」与底部状态栏红点提醒，仅在助手向你提问或任务需要人工拍板时亮起；回复助手时同样支持粘贴截图或附带文件。

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
