# Orca Autopilot（纯终端 TUI 控制台 + Orca 状态栏插件）

完全在终端中绘制的 Claude Code 风格 GitHub Issue 自动驾驶控制台（零外部依赖、无 Webview 开销），支持**鼠标点击、滚轮滚动、拖拽文件、剪贴板粘贴截图**与键盘快捷键，配合极简 Orca 状态栏插件实现红点提醒与一键唤起。

## 核心体验

- **纯终端绘制 + 鼠标可点击**：基于零依赖原生 ANSI 终端画布 + SGR 1006 鼠标协议，支持点击切换 Issues / PRs 标签页、点击列表项与右侧「待处理」操作按钮、点击斜杠命令与滚轮滚动列表。
- **任意终端即开即用**：在任意项目目录直接运行 `orca-autopilot`（兼容别名 `orca-board`），无需打开 GUI 窗口，直接在当前终端全屏渲染。
- **类 AI 对话式底部输入 + 斜杠命令**：
  - 底部常驻单行分割线式输入框，输入大白话按 `Enter` 即可提单（默认启用 `github-issue-handoff` Skill 规范提单 `handoff`；如需跳过整理直接建单，可点击底部状态栏模式项或执行 `/direct` 切换为快速直提），支持 `Shift+Enter` 换行、`Ctrl+V` 粘贴 macOS 剪贴板截图与拖入文件路径；附件以 `[Image #1]` / `[File #1]` 内联展示并支持 `Backspace` 整块删除；
  - 输入框下方状态栏直接展示当前 Issue 类型（默认「新功能」，支持 `Shift+Tab` 或点击轮询切换「新功能 / 修 Bug / 体验优化」）与提单模式（`✓ handoff 规范提单` / `○ direct 快速直提`）；
  - 输入 `/` 在输入框正上方展开内联斜杠命令列表（`↑↓`/滚轮选择、`Tab` 补全、`Enter` 或点击执行）：
    - `/bug [描述]`、`/feature [描述]`、`/polish [描述]`：切换需求类型或直接带描述提单；
    - `/handoff [描述]`、`/direct [描述]`：切换「Skill 规范提单」或「快速直提」；
    - `/agent`：配置工作树默认执行 Agent 与允许 `agent:<id>` 标签覆盖的列表；
    - `/refresh`、`/issues`、`/prs`、`/autopilot`、`/stop`、`/paste`、`/clear`、`/quit`：刷新、切视图、开启/暂停自动处理循环（也可直接点击顶部状态徽标切换）、贴图、清空与退出。
- **极简 Orca 状态栏插件（可选）**：仅保留后台状态栏待处理徽标（`Autopilot · N 待处理`）、桌面通知与快捷键（`Cmd+Shift+I`），点击状态栏或按快捷键会在当前工作区打开运行纯终端 TUI 的终端标签页。
- **双视图与人工介入队列**：
  - Issues（进行中 / 已完成）与 PRs（打开中 / 历史、CI 与冲突状态）双视图切换；
  - 右侧「待处理」集中展示 Agent 提问/权限审批、提单或自动修复纯文字停顿追问、提单中断/卡死告警、`ready-for-review` / `pr-only` 待验收任务、本地分支与远端分叉/冲突告警（「一键自动合并」），以及 `gh` 鉴权失效或 Autopilot 停摆告警；支持一键同意、回复（支持附截图/文件）、重试/放弃、重新提单与忽略。

## 一键安装与使用

直接使用 Orca 原生命令安装（首次激活会自动同步 4 个内置 Skill 与终端命令）：

```bash
orca plugin install Niall-Young/orca-autopilot
```

或从本地仓库 / Release 完整包离线独立安装（本地开发可加 `--dev`）：

```bash
./scripts/orca-autopilot --install
```

之后在**任意项目目录的终端**直接运行：

```bash
orca-autopilot
```

也可在 Orca 底部状态栏点击 **Autopilot** 或按 `Cmd+Shift+I` 在终端标签页中打开。

## 验证命令

```bash
bun test ./orca-plugin/src
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
```
