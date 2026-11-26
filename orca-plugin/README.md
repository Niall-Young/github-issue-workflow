# Issue 看板（纯终端 TUI + 极简 Orca 状态栏启动器）

完全在终端中绘制的 Claude Code 风格轻量 Issue 看板（无 Webview / 无 Electron iframe 开销），同时支持**鼠标点击、滚轮滚动、拖拽文件、剪贴板粘贴截图**与键盘快捷键。

## 核心体验

- **纯终端绘制 + 鼠标可点击**：基于零依赖原生 ANSI 终端画布 + SGR 1006 鼠标协议，支持点击切换 Issues / PRs 标签页、点击列表项与右侧「需要你处理」操作按钮、点击斜杠命令与滚轮滚动列表，响应极快。
- **任意终端即开即用**：在任意项目目录直接运行 `orca-board`（或 `issue-board`），无需打开任何 GUI 窗口，直接在当前终端全屏渲染。
- **类 AI 对话式底部输入 + 斜杠命令**：
  - 底部常驻极简分割线式输入框，直接输入大白话按 `Enter` 即可提单（默认关闭 `github-issue-handoff` Skill，走快速直提直接创建带 `agent-ready` 标签的 Issue；需要规范整理时可在底部状态栏点击开关或输入 `/handoff` 开启），支持 `Shift+Enter` 换行、`Ctrl+V` 粘贴 macOS 剪贴板截图与直接拖入文件路径；贴入的图片/文件会在输入行内直接生成 `[Image #1]` / `[File #1]` 标识符，不额外占用附件行，支持按 `Backspace` 整块退格删除；
  - 输入框下方以类 Codex 状态栏直接展示当前选中的 Issue 类型（默认选中「新功能」，支持按 `Shift+Tab` 或点击在「新功能 / 修 Bug / 体验优化」间轮询切换）与 Skill 提单开关（默认未选中显示 `○ 快速直提`，点击或输入 `/handoff` 后高亮显示 `● Skill 规范提单`，再次点击或输入 `/direct` 切回关闭），不再弹出底部 Toast 条；
  - 输入 `/` 在输入框正上方直接展开 Claude Code 风格无边框内联斜杠命令列表（`↑↓`/滚轮选择、`Tab` 补全、`Enter` 或鼠标点击执行）：
    - `/bug [描述]`、`/feature [描述]`、`/polish [描述]`：切换需求类型或直接带描述提单；
    - `/handoff [描述]`、`/direct [描述]`：切换「Skill 规范提单」或「快速直提」；
    - `/agent`：配置工作树默认执行 Agent 与允许 `agent:<id>` 标签覆盖的列表；
    - `/refresh`、`/issues`、`/prs`、`/autopilot`、`/paste`、`/clear`、`/quit`：刷新、切视图、开启自动处理、贴图、清空与退出。
- **极简 Orca 插件（可选）**：仅保留后台状态栏待处理红点徽标、桌面通知与快捷键（`Cmd+Shift+I`），点击状态栏或按快捷键会在当前工作区直接打开一个运行纯终端 TUI 的终端标签页。
- **双视图与人工介入队列**：
  - Issues（进行中 / 已完成 · 可验收）与 PRs（打开中 / 历史、CI 与冲突状态）双视图切换；
  - 右侧「需要你处理」直接一键「同意继续」、回复助手提问（支持附截图/文件），或对阻塞/失败 Issue 执行「重试」/「放弃」。

## 一键安装与使用

在仓库根目录执行一次安装：

```bash
./scripts/orca-board --install
```

之后在**任意项目目录的终端**直接运行：

```bash
orca-board
```

（也支持别名 `issue-board`，或在 Orca 底部状态栏点击 **Issue 看板** / 按 `Cmd+Shift+I` 在终端标签页中打开。）

## 验证命令

```bash
bun test ./orca-plugin/src/tui/tui.test.ts
orca plugin validate ./orca-plugin --json
orca plugin test ./orca-plugin --json
orca plugin check ./orca-plugin --json
```
