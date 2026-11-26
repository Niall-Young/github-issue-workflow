# Issue 看板（纯终端 TUI + 极简 Orca 状态栏启动器）

完全在终端中绘制的 Claude Code 风格轻量 Issue 看板（无 Webview / 无 Electron iframe 开销），同时支持**鼠标点击、滚轮滚动、拖拽文件、剪贴板粘贴截图**与键盘快捷键。

## 核心体验

- **纯终端绘制 + 鼠标可点击**：基于零依赖原生 ANSI 终端画布 + SGR 1006 鼠标协议，支持点击顶栏按钮、点击切换 Issues / PRs 标签页、点击列表项与右侧「需要你处理」操作按钮、滚轮滚动列表，响应极快。
- **任意终端即开即用**：在任意项目目录直接运行 `orca-board`（或 `issue-board`），无需打开任何 GUI 窗口，直接在当前终端全屏渲染。
- **极简 Orca 插件（可选）**：仅保留后台状态栏待处理红点徽标、桌面通知与快捷键（`Cmd+Shift+I`），点击状态栏或按快捷键会在当前工作区直接打开一个运行纯终端 TUI 的终端标签页。
- **全功能覆盖**：
  - 顶栏点击 `⚙ Agent`（或按 `,`）配置工作树默认执行 Agent 与允许 `agent:<id>` 标签覆盖的列表；
  - 点击 `+ 提需求`（或按 `n`）默认走 `github-issue-handoff` Skill 唤起 Agent 查重并按模板提单（也支持切换「快速直提」），支持 `Ctrl+V` 粘贴 macOS 剪贴板截图与直接拖入文件路径；
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
