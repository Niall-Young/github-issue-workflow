# Orca Autopilot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

面向 Orca 的 GitHub Issue 自动驾驶插件与纯终端控制台：一句话提单，Agent 在隔离 worktree 中自动修复、独立 Review、开 PR、解冲突并自动合并，仅把需要你拍板的事项送到「待处理」队列。

An Orca plugin and pure-terminal console for unattended GitHub Issue autopilot: file an Issue in plain language, let Agents fix it in isolated worktrees with independent review, PR creation, conflict resolution, and auto-merge, while surfacing only human decisions in a Needs You queue.

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 中文

### 项目简介

**Orca Autopilot** 将 GitHub Issue 从「提出需求」到「代码合入主干」的全流程接入 Orca 工作区，由三层组件协同构成：

```text
一句话提单 (TUI / Skill)
  → 自动认领带 agent-ready 的 Issue（最多 3 并发隔离 worktree）
  → Agent 实现 + 自测 + 独立 Reviewer 复核
  → 自动 pre-merge 检查、push、建 PR、轮询 CI、自动解冲突、squash 合并、同步本地分支
  → 仅将提问、权限审批、冲突熔断或待验收项推送到「待处理」队列与 Orca 状态栏
```

- **极简 Orca 插件**（`orca-plugin/`）：在 Orca 状态栏实时展示 `Autopilot · N 待处理` 徽标与桌面通知，点击状态栏或按 `Cmd+Shift+I` 一键在终端标签页打开控制台。
- **纯终端 TUI 控制台**（`orca-autopilot`）：零外部依赖的原生全屏终端界面（无 Webview 开销），支持鼠标点击、滚轮、拖拽文件与粘贴截图，在任意项目目录秒开。
- **四个可独立组合的底层 Skill**：`github-issue-handoff`（规范提单）、`github-issue-repair`（受控修复）、`github-issue-autopilot`（本地自动调度器）与 `github-issue-workflow-update`（稳定 Release 更新器），既驱动插件闭环，也可在 Agent 会话中单独调用。

### 核心能力

#### 1. 纯终端控制台 TUI（`orca-autopilot`）
- **对话式底部输入框**：固定单行输入，长文本横向滚动，`Shift+Enter` 换行；支持 `Ctrl+V` 粘贴 macOS 剪贴板截图与拖入文件路径，附件以内联 `[Image #1]` / `[File #1]` 标识符展示，按 `Backspace` 可整块删除。
- **双模式提单与类型切换**：默认以 `✓ handoff 规范提单` 唤起 `github-issue-handoff` 查重并套用模板，也可点击底部状态栏或执行 `/direct` 切换为 `○ direct 快速直提`；按 `Shift+Tab` 或点击可在「新功能 / 修 Bug / 体验优化」间切换。
- **内联斜杠命令**：输入 `/` 展开 Claude Code 风格命令菜单（`/bug`、`/feature`、`/polish`、`/handoff`、`/direct`、`/agent`、`/refresh`、`/issues`、`/prs`、`/autopilot`、`/stop`、`/paste`、`/clear`、`/quit`），顶部状态徽标支持一键暂停/恢复自动处理循环。
- **双视图与「待处理」介入队列**：支持 Issues（进行中 / 已完成）与 PRs（打开中 / 历史、CI 与冲突状态）切换；右侧「待处理」集中汇总 Agent 提问/权限审批、纯文字停顿追问、提单卡死告警、待验收任务、本地分支分叉冲突（「一键自动合并」）以及 `gh` 鉴权/Autopilot 停摆告警，支持一键同意、回复（可附截图/文件）、重试/放弃、重新提单与忽略。

#### 2. 无人值守 Autopilot 闭环
- **隔离并发调度**：通过 Orca 原生 Automation 每 3 分钟无模型预检一次（仅协调器缺失时恢复），一次入账全部符合策略的 open Issue（含启用前积压），最多 3 个任务在 Orca 子 worktree 中并发执行，不修改用户当前工作树；本地分支领先远端或无上游时自动传入 `--base-branch`。
- **依赖图与超时保护**：识别正文中的同仓前置依赖（`Blocked by: #1`、`Depends on: #1`、`前置依赖: #1`），前置未完成前自动等待并检测依赖环标记为 `blocked`；运行中持续刷新心跳，超过硬超时（默认 45 分钟）或无输出心跳超时（默认 15 分钟）自动回收 Dispatch 并归档 `.patch`。
- **双闭环自动合并**：默认采用 `publication: "auto-merge"`——Worker 完成实现、自测与独立 Reviewer 核对后，协调器确定性执行 `pre_merge_commands`、push 并建 PR、轮询 CI 与合并状态；若出现冲突先尝试无冲突合并最新基线，必要时在 `policy.max_conflict_resolutions`（默认 `2` 次）上限内自动派发解冲突 Worker 原地更新 PR；CI 通过后自动 `squash` 合并、关 Issue、清 worktree，并零 token 同步本地分支（`policy.sync_local_branch`，默认 `true`），失败则熔断为 `needs-human` 并保留 `.patch`。也可切换为 `pr-only` 或 `never`。
- **双层防重账本**：SQLite schema v5 以不可变 Issue node ID 防止重复派单，记录前置依赖、所选 Agent、Orca Task/Dispatch/worktree、分支、base/head SHA、PR 链接、合并时间、心跳与失败 `.patch` 路径；未完成的 `failed` attempt 默认最多自动重试至总计 2 次。

#### 3. 四个底层 Agent Skill（可独立使用）
- `github-issue-handoff`：校验仓库、查重、套用 Feature / Bug / Refactor / Research 模板并通过可执行性门禁后创建中文 Issue；安全问题自动走私有上报渠道。
- `github-issue-repair`：将既有 Issue 归一化为工作包，交互模式下先只读分析、获批后再本地修改，用户检查 diff 后才 push / 建 draft PR；仅给仓库 URL 时只做只读分诊。
- `github-issue-autopilot`：一句话为当前仓库安装/管理本地自动循环，支持单 Issue 通过 `agent:<id>` 标签覆盖默认 Agent。
- `github-issue-workflow-update`：按需只读检查版本，或从最新稳定 Release 事务式更新四个官方 Skill 并同步已安装的 Autopilot runtime。

### 快速开始

#### 环境要求

- 正在运行的 Orca（状态栏插件需要 Orca **1.4.259** 或更高版本），以及至少一个可由 Orca 启动的 Agent（如 Codex、Claude、OMP）
- 已登录认证的 GitHub CLI（`gh`）
- Python 3，以及 Bun（推荐）或 Node.js >= 22

#### 一键安装（插件 + 终端命令 + 全部内置 Skill）

**方式一：从 Release 下载完整包（推荐）**

从 [GitHub Releases](https://github.com/Niall-Young/github-issue-workflow/releases/latest) 下载 `github-issue-workflow-full-vX.Y.Z.tar.gz`，解压后执行：

```sh
./scripts/orca-autopilot --install
```

**方式二：从源码仓库安装**

```sh
git clone https://github.com/Niall-Young/github-issue-workflow.git
cd github-issue-workflow
./scripts/orca-autopilot --install
```

一条命令会自动完成三件事，**安装完成后即可安全删除源码或解压目录**：
1. **独立复制运行文件**到 `~/.local/share/orca-autopilot/`，并将 `orca-autopilot`（含兼容别名 `orca-board`）链接到 `~/.local/bin`（请确保 `~/.local/bin` 在 `PATH` 中）；
2. **自动安装全部 4 个内置 Skill**（`github-issue-handoff`、`github-issue-repair`、`github-issue-autopilot`、`github-issue-workflow-update`）到本机已检测到的 Agent Skill 目录（`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`、`~/.gemini/antigravity-cli/skills`），无需用户手动复制或额外提示 Agent；
3. **正式安装 Orca 状态栏插件**（`orca plugin install` 到 Orca 托管目录，而非临时 dev 模式）。

常用可选参数：
- `--dev`：开发调试模式，直接链接当前源码目录并以 `orca plugin dev load` 加载；
- `--no-plugin` / `--no-skills`：按需跳过 Orca 插件或内置 Skill 安装；
- `--install-dir` / `--bin-dir` / `--skills-dir`：自定义安装目标路径。

> 从旧版本升级时，如运行时残留旧版 `github-issue-creator/` 目录，请手动删除避免与 `github-issue-handoff/` 冲突；安装完成后建议重启 Agent 会话以加载最新 Skill。

#### 打开与运行

安装完成后，任选一种方式即可进入控制台：
- 在 Orca 底部状态栏点击 **Autopilot**，或按快捷键 **`Cmd+Shift+I`**；
- 在**任意项目目录的终端**直接运行：

```sh
orca-autopilot
```

### 使用方法

#### 1. 在终端控制台中日常操作

打开 `orca-autopilot` 后，直接在底部输入框输入需求并回车即可提单；常用快捷键与斜杠命令：

| 操作 / 命令 | 说明 |
| :--- | :--- |
| `Enter` / `Shift+Enter` | 提交需求 / 换行 |
| `Shift+Tab` | 轮询切换 Issue 类型（新功能 / 修 Bug / 体验优化） |
| `Ctrl+V` 或拖入文件 | 粘贴 macOS 剪贴板截图或附加文件（生成 `[Image #1]` / `[File #1]`） |
| `/bug` `/feature` `/polish` | 切换类型或直接附带描述提单 |
| `/handoff` `/direct` | 切换「Skill 规范提单」与「快速直提」 |
| `/agent` | 配置默认执行 Agent 与允许的 `agent:<id>` 覆盖列表 |
| `/autopilot` `/stop` | 开启或暂停当前仓库的自动处理循环 |
| `/issues` `/prs` `/refresh` `/quit` | 切换视图、手动刷新、退出控制台 |

更多 TUI 交互细节见 [`orca-plugin/README.md`](orca-plugin/README.md)。

#### 2. 管理仓库的 Autopilot 循环

可在控制台执行 `/autopilot`，或在项目会话中对 Agent 说「构建 Issue 循环检查机制」，也可直接用命令行管理：

```sh
# 为仓库安装自动循环（支持 --publication auto-merge|pr-only|never 等策略参数）
python3 github-issue-autopilot/scripts/autopilot_admin.py install --repo-path /absolute/repository/root --agent codex

# 查看已安装仓库与只读健康检查
python3 github-issue-autopilot/scripts/autopilot_admin.py list
python3 github-issue-autopilot/scripts/autopilot_admin.py doctor --repo-path /absolute/repository/root

# 清理超过 24 小时的历史失败/废弃 worktree（保留 .patch 归档）
python3 github-issue-autopilot/scripts/autopilot_admin.py prune --repo-path /absolute/repository/root --older-than-hours 24
```

移除 Orca 项目或删除本地仓库前，建议先结算未决任务再卸载：

```sh
python3 github-issue-autopilot/scripts/autopilot_admin.py stop --repository owner/repo
python3 github-issue-autopilot/scripts/autopilot_admin.py discard --repo-path /absolute/repository/root --issue-url URL
python3 github-issue-autopilot/scripts/autopilot_admin.py uninstall --repository-id REPOSITORY_ID
```

`uninstall` 会拒绝未决任务，导出 Automation 历史，并将配置、SQLite 账本、日志与 runtime 副本归档到 `~/.local/state/github-issue-autopilot/archives/`，不会删除本地仓库。完整配置项见 [`github-issue-autopilot/references/configuration.md`](github-issue-autopilot/references/configuration.md)。

#### 3. 单独调用底层 Skill

```sh
$github-issue-handoff https://github.com/owner/repo 帮我排查登录接口偶发超时的问题
$github-issue-repair https://github.com/owner/repo/issues/123
$github-issue-repair https://github.com/owner/repo
```

### 更新机制

更新不会在后台自动运行。安装 `github-issue-workflow-update` 后，按需显式调用：

```sh
$github-issue-workflow-update 检查 issue-workflow 更新
$github-issue-workflow-update 更新 issue-workflow
```

- **检查**为只读操作，仅比较当前版本与最新稳定 Release；
- **更新**从 `Niall-Young/github-issue-workflow` 拉取稳定 Release，校验来源、SHA-256、清单与逐文件哈希后事务式替换四个官方 Skill 并同步已安装的 Autopilot runtime，失败自动回滚（保留配置、SQLite 账本、日志、attempt 历史和 worktree）；
- 插件与终端控制台的升级可通过下载最新 `github-issue-workflow-full-vX.Y.Z.tar.gz`（或 `git pull`）后重新运行 `./scripts/orca-autopilot --install` 完成。

### 项目结构

```text
.
├── orca-plugin/                   # Orca Autopilot 纯终端 TUI 控制台与状态栏插件
│   ├── orca-plugin.json           # Orca 插件清单（id: issue-autopilot）
│   ├── README.md                  # 插件与 TUI 交互详细说明
│   └── src/                       # 终端 TUI 引擎（src/tui/）、状态栏 worker、数据桥接与测试
├── scripts/
│   ├── orca-autopilot             # 一键安装并启动 Orca Autopilot 终端控制台的 CLI
│   └── build_release.py           # 构建带清单与校验和的可复现发布包
├── github-issue-handoff/          # 规范提单与交接 Skill
├── github-issue-repair/           # Issue 分诊与受控修复 Skill（含 run_state.py 账本）
├── github-issue-autopilot/        # 自动发现、依赖调度、并发修复与 PR 自动合并引擎
├── github-issue-workflow-update/  # 稳定 Release 检查与事务式更新 Skill
├── tests/                         # CLI、修复账本、自动调度与更新器单元测试
├── .github/workflows/release.yml  # Tag 触发测试、构建并发布稳定包
├── ROADMAP.md                     # 分阶段演进路线图
└── LICENSE                        # MIT 许可证
```

### 开发与验证

```sh
# 1. 运行 Python 单元测试（CLI、账本、调度器、更新器）
python3 -m unittest discover -s tests -v

# 2. 验证 Orca 插件与 TUI 测试
bun test ./orca-plugin/src
orca plugin validate ./orca-plugin --json
orca plugin test ./orca-plugin --json
orca plugin check ./orca-plugin --json

# 3. 本地构建发布包验证
python3 scripts/build_release.py --tag "v$(cat github-issue-workflow-update/VERSION)" --commit "$(git rev-parse HEAD)" --output /tmp/issue-workflow-dist
```

真实 GitHub 提单与回读需通过 `gh repo view`、`gh issue create`、`gh issue view` 进行端到端验证。

### 成熟度与安全边界

当前已完成单机 Orca 状态栏插件、零依赖终端控制台、SQLite 幂等账本、隔离 worktree 并发调度、自动建 PR / 解冲突 / 自动合并、本地分支同步以及稳定 Release 事务式更新；多机分布式调度尚未启用。普通用户进程属于「降低风险的隔离」，不是保护全部本地机密的强安全沙箱；处理不可信仓库时请使用低权限账户或更强隔离环境。详见 [ROADMAP.md](ROADMAP.md#中文)。

### 许可证

本项目使用 [MIT License](LICENSE)。

[English](#english) · [返回顶部](#orca-autopilot)

---

<a id="english"></a>
## English

### Overview

**Orca Autopilot** brings the full GitHub Issue lifecycle—from plain-language request to merged PR—directly into Orca workspaces through three coordinated layers:

```text
Plain-language request (TUI / Skill)
  → Claim eligible agent-ready Issues (up to 3 concurrent isolated worktrees)
  → Agent implementation + self-testing + independent Reviewer verification
  → Deterministic pre-merge checks, push, PR creation, CI polling, conflict resolution, squash merge & local branch sync
  → Surface only questions, permission prompts, conflict circuit-breaks, or review-ready items in Needs You & Orca status bar
```

- **Minimal Orca Plugin** (`orca-plugin/`): shows a live `Autopilot · N 待处理` status-bar badge and desktop notifications, and opens the terminal console in an Orca tab on click or `Cmd+Shift+I`.
- **Pure-Terminal TUI Console** (`orca-autopilot`): zero-dependency full-screen ANSI terminal UI (zero webview overhead) with SGR 1006 mouse click/scroll, file drag-and-drop, and clipboard screenshot paste, launchable in any project terminal.
- **Four Composable Skills**: `github-issue-handoff`, `github-issue-repair`, `github-issue-autopilot`, and `github-issue-workflow-update` power the automated loop and can also be invoked directly in any Agent session.

### Features

#### 1. Pure-Terminal TUI Console (`orca-autopilot`)
- **Chat-style persistent composer**: single-row input with horizontal scroll and `Shift+Enter` newlines; supports `Ctrl+V` macOS clipboard screenshot paste and dragged file paths as inline `[Image #1]` / `[File #1]` tokens deleted atomically with `Backspace`.
- **Dual submission modes & kind cycling**: defaults to `✓ handoff 规范提单` (deduplication + template enforcement via `github-issue-handoff`), switchable to `○ direct 快速直提` via the footer toggle or `/direct`; press `Shift+Tab` or click to cycle through Feature / Bug / Polish.
- **Inline slash commands**: type `/` for a Claude Code-style menu (`/bug`, `/feature`, `/polish`, `/handoff`, `/direct`, `/agent`, `/refresh`, `/issues`, `/prs`, `/autopilot`, `/stop`, `/paste`, `/clear`, `/quit`), plus clickable header badges to pause or resume the autopilot loop.
- **Dual views & Needs You queue**: switch between Issues (In Progress / Completed) and Pull Requests (Open / Merged & Closed with CI and conflict indicators); the Needs You pane aggregates agent questions/permission prompts, plain-text pauses, stalled handoff alerts, manual-review tasks, diverged/conflicting local-branch alerts (with one-click auto-merge), and `gh` auth or stalled-Autopilot health alerts with one-click approve, reply (with attachments), retry/discard, resubmit, and dismiss actions.

#### 2. Unattended Autopilot Loop
- **Isolated concurrent dispatch**: a native Orca Automation prechecks every 3 minutes with zero model turns when healthy, records all eligible open Issues (including backlog created before activation), and runs up to 3 tasks concurrently in Orca child worktrees without touching your active checkout; passes `--base-branch` automatically when the local branch is ahead of upstream or untracked.
- **Dependency graph & timeout recovery**: parses same-repo prerequisites (`Blocked by: #1`, `Depends on: #1`, `前置依赖: #1`), waits until dependencies are locally `merged`/`accepted` or `CLOSED` on GitHub, and flags cycles as `blocked`; refreshes worker heartbeats continuously and stops/releases timed-out workers (default 45m hard timeout, 15m heartbeat timeout) while archiving diffs to `.patch`.
- **Dual-loop auto-merge**: defaults to `publication: "auto-merge"`—after implementation, self-testing, and independent review, the coordinator deterministically runs `pre_merge_commands`, pushes the branch, opens a PR, monitors CI and mergeability, attempts clean base merges or bounded conflict-resolution workers (up to `policy.max_conflict_resolutions`, default `2`), auto-merges (`squash` by default), closes the Issue, cleans up the worktree, and syncs the local base branch with zero AI tokens (`policy.sync_local_branch`, default `true`). Failures circuit-break visibly to `needs-human` with a `.patch` archive. `pr-only` and `never` remain configurable.
- **Two-level idempotent ledger**: SQLite schema v5 deduplicates immutable Issue node IDs and tracks dependencies, selected Agents, Orca Task/Dispatch/worktree IDs, branches, base/head SHAs, PR URLs, merge timestamps, heartbeats, and `.patch` archives; unfinished `failed` attempts retry automatically up to 2 total attempts by default.

#### 3. Four Composable Agent Skills
- `github-issue-handoff`: validates repos, detects duplicates, applies Feature / Bug / Refactor / Research templates, and creates an Issue only after its executability gate passes (routing security reports privately).
- `github-issue-repair`: normalizes Issues into work packages; interactive mode requires scope approval before local edits and explicit authorization before push/draft PR; repository URLs default to read-only triage.
- `github-issue-autopilot`: installs and manages the per-repository local loop, supporting per-Issue `agent:<id>` label overrides.
- `github-issue-workflow-update`: checks versions read-only or transactionally updates all four official Skills and installed Autopilot runtimes from the latest stable Release.

### Quick Start

#### Prerequisites

- A running Orca instance (**1.4.259+** for the status-bar plugin) and at least one Agent Orca can launch (such as Codex, Claude, or OMP)
- An authenticated GitHub CLI (`gh`)
- Python 3, plus Bun (recommended) or Node.js >= 22

#### One-Command Install (Plugin + CLI + All Bundled Skills)

**Option 1: Download the full Release bundle (recommended)**

Download `github-issue-workflow-full-vX.Y.Z.tar.gz` from [GitHub Releases](https://github.com/Niall-Young/github-issue-workflow/releases/latest), extract it, and run:

```sh
./scripts/orca-autopilot --install
```

**Option 2: Install from a source checkout**

```sh
git clone https://github.com/Niall-Young/github-issue-workflow.git
cd github-issue-workflow
./scripts/orca-autopilot --install
```

One command completes three steps, and **you can safely delete the cloned or extracted directory afterward**:
1. **Standalone runtime install**: copies runtime files to `~/.local/share/orca-autopilot/` and symlinks `orca-autopilot` (plus legacy alias `orca-board`) into `~/.local/bin` (ensure `~/.local/bin` is in `PATH`).
2. **Automatic Skill installation**: installs all four bundled Skills (`github-issue-handoff`, `github-issue-repair`, `github-issue-autopilot`, `github-issue-workflow-update`) into every detected local Agent skill directory (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`)—no manual copying required.
3. **Formal Orca plugin install**: installs the plugin into Orca's managed storage via `orca plugin install` (not temporary dev mode).

Optional flags:
- `--dev`: link directly to the source checkout and load via `orca plugin dev load` for local development;
- `--no-plugin` / `--no-skills`: skip Orca plugin or bundled Skill installation;
- `--install-dir` / `--bin-dir` / `--skills-dir`: customize target directories.

> When upgrading from older versions, remove any legacy `github-issue-creator/` directory to avoid conflicts with `github-issue-handoff/`, and restart Agent sessions to pick up updated Skills.

#### Run

Open the console using either entry point:
- Click **Autopilot** in Orca's status bar or press **`Cmd+Shift+I`**;
- Or run in **any project terminal**:

```sh
orca-autopilot
```

### Usage

#### 1. Daily Workflow in the Terminal Console

Launch `orca-autopilot`, type your request in the bottom composer, and press `Enter`:

| Action / Command | Description |
| :--- | :--- |
| `Enter` / `Shift+Enter` | Submit request / insert newline |
| `Shift+Tab` | Cycle Issue kind (Feature / Bug / Polish) |
| `Ctrl+V` or drag files | Paste macOS clipboard screenshot or attach files as `[Image #1]` / `[File #1]` |
| `/bug` `/feature` `/polish` | Switch kind or submit directly with description |
| `/handoff` `/direct` | Toggle structured Skill handoff vs. fast direct submission |
| `/agent` | Configure default execution Agent and allowed `agent:<id>` overrides |
| `/autopilot` `/stop` | Start or pause the repository's autopilot loop |
| `/issues` `/prs` `/refresh` `/quit` | Switch views, refresh data, or exit the console |

See [`orca-plugin/README.md`](orca-plugin/README.md) for full TUI interaction details.

#### 2. Manage Repository Autopilot Loops

Run `/autopilot` inside the console, ask your Agent to “build an Issue loop,” or manage loops via CLI:

```sh
# Install a repository loop (supports --publication auto-merge|pr-only|never and other policy flags)
python3 github-issue-autopilot/scripts/autopilot_admin.py install --repo-path /absolute/repository/root --agent codex

# List installed repositories and run read-only diagnostics
python3 github-issue-autopilot/scripts/autopilot_admin.py list
python3 github-issue-autopilot/scripts/autopilot_admin.py doctor --repo-path /absolute/repository/root

# Prune stale failed/discarded worktrees older than 24 hours (preserving .patch archives)
python3 github-issue-autopilot/scripts/autopilot_admin.py prune --repo-path /absolute/repository/root --older-than-hours 24
```

Before removing an Orca project or deleting a local checkout, settle pending work and uninstall cleanly:

```sh
python3 github-issue-autopilot/scripts/autopilot_admin.py stop --repository owner/repo
python3 github-issue-autopilot/scripts/autopilot_admin.py discard --repo-path /absolute/repository/root --issue-url URL
python3 github-issue-autopilot/scripts/autopilot_admin.py uninstall --repository-id REPOSITORY_ID
```

`uninstall` refuses unresolved work, exports Automation history, and archives config, SQLite ledgers, logs, and runtime copies under `~/.local/state/github-issue-autopilot/archives/` without deleting your repository. See [`github-issue-autopilot/references/configuration.md`](github-issue-autopilot/references/configuration.md) for all policy options.

#### 3. Invoke Individual Skills

```sh
$github-issue-handoff https://github.com/owner/repo Investigate occasional login API timeouts
$github-issue-repair https://github.com/owner/repo/issues/123
$github-issue-repair https://github.com/owner/repo
```

### Update Mechanism

Updates never run automatically in the background. After installing `github-issue-workflow-update`, invoke it explicitly:

```sh
$github-issue-workflow-update check for issue-workflow updates
$github-issue-workflow-update update issue-workflow
```

- **Check** is read-only and reports installed vs. latest stable Release versions.
- **Update** fetches the latest published stable Release from `Niall-Young/github-issue-workflow`, verifies origin, SHA-256, manifest, and per-file hashes, transactionally replaces the four official Skills, and refreshes installed Autopilot runtimes with automatic rollback on failure (preserving configs, SQLite ledgers, logs, attempt history, and worktrees).
- To upgrade the Orca plugin and terminal CLI, download the latest `github-issue-workflow-full-vX.Y.Z.tar.gz` (or `git pull`) and re-run `./scripts/orca-autopilot --install`.

### Project Structure

```text
.
├── orca-plugin/                   # Orca Autopilot pure-terminal TUI + status-bar plugin
│   ├── orca-plugin.json           # Orca plugin manifest (id: issue-autopilot)
│   ├── README.md                  # Plugin & TUI interaction guide
│   └── src/                       # Terminal TUI engine (src/tui/), worker, data bridge, tests
├── scripts/
│   ├── orca-autopilot             # One-command CLI installer and TUI launcher
│   └── build_release.py           # Deterministic release bundle builder with checksums
├── github-issue-handoff/          # Structured Issue creation & handoff Skill
├── github-issue-repair/           # Issue triage & controlled repair Skill (with run_state.py)
├── github-issue-autopilot/        # Auto-discovery, dependency scheduling & PR auto-merge engine
├── github-issue-workflow-update/  # Stable Release checker & transactional updater Skill
├── tests/                         # Unit tests for CLI, ledgers, scheduler, and updater
├── .github/workflows/release.yml  # Tag-triggered testing and stable Release publishing
├── ROADMAP.md                     # Phased evolution roadmap
└── LICENSE                        # MIT license
```

### Development and Verification

```sh
# 1. Run Python unit tests (CLI, ledger, scheduler, updater)
python3 -m unittest discover -s tests -v

# 2. Validate the Orca plugin and run TUI/data tests
bun test ./orca-plugin/src
orca plugin validate ./orca-plugin --json
orca plugin test ./orca-plugin --json
orca plugin check ./orca-plugin --json

# 3. Verify local release bundle generation
python3 scripts/build_release.py --tag "v$(cat github-issue-workflow-update/VERSION)" --commit "$(git rev-parse HEAD)" --output /tmp/issue-workflow-dist
```

End-to-end GitHub mutations are verified via `gh repo view`, `gh issue create`, and `gh issue view`.

### Maturity and Security Boundary

Single-machine Orca status-bar integration, the zero-dependency terminal TUI, SQLite idempotent claims, isolated child-worktree concurrency, automated PR creation/conflict resolution/auto-merge, local branch sync, and stable-Release transactional updates are implemented; multi-machine scheduling is not enabled. A normal user process provides reduced-risk isolation rather than a hard security sandbox protecting all local secrets; use a low-privilege account or stronger sandbox for untrusted repositories. See [ROADMAP.md](ROADMAP.md#english) for details.

### License

This project is licensed under the [MIT License](LICENSE).

[中文](#中文) · [Back to top](#orca-autopilot)
