import { basename, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildSystemHealthAlerts,
  extractTerminalQuestion,
  fetchGithubIssuesWithStatus,
  findAutopilotConfigForRepo,
  hasAutopilotReceipt,
  hasHandoffCreatedIssue,
  inspectLocalBranchSync,
  isHandoffSessionTitle,
  mergeBoardItems,
  readLedgerIssues,
  resolveGitRepository,
  resolvePluginRootDir,
  syncBundledSkillsAndCli
} from './board-data'
import type { NeedsYouItem } from './protocol'

const POLL_INTERVAL_MS = 15_000

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export default function activate(orca: OrcaWorkerApi) {
  const pluginRoot = resolvePluginRootDir()
  const tuiScriptPath = join(pluginRoot, 'src', 'tui', 'app.ts')
  try {
    syncBundledSkillsAndCli(resolve(pluginRoot, '..'))
  } catch (err) {
    orca.log(`bundled skills/cli sync skipped: ${String(err)}`)
  }
  const notifiedIds = new Set<string>()
  const activeBoardTerminals = new Map<string, string>()
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function resolveActiveWorkspace() {
    let workspaceId: string | undefined
    let repoPath: string | null = null
    let projectId: string | null = null

    try {
      const ctx = await orca.host.call('workspace.readContext')
      if (ctx?.workspaceId) workspaceId = ctx.workspaceId
    } catch {
      // ignore
    }

    try {
      const wsList = await orca.host.call('workspace.list', { includeStatus: true })
      const workspaces = wsList.workspaces || []
      const match =
        (workspaceId ? workspaces.find((w) => w.id === workspaceId) : null) || workspaces[0]
      if (match) {
        workspaceId = match.id
        projectId = match.projectId ?? null
        repoPath = resolve(match.path)
      }
      return { workspaceId, repoPath, projectId, workspaces }
    } catch {
      return { workspaceId, repoPath, projectId, workspaces: [] }
    }
  }

  async function countNeedsYou(): Promise<{
    projectName: string
    needsYou: NeedsYouItem[]
  } | null> {
    const { repoPath, projectId, workspaces } = await resolveActiveWorkspace()
    if (!repoPath) return null

    const gitInfo = await resolveGitRepository(repoPath)
    const rootPath = gitInfo.rootPath
    const autopilot = findAutopilotConfigForRepo(rootPath, gitInfo.repository)

    const related = workspaces.filter((w) => {
      if (projectId && w.projectId === projectId) return true
      if (resolve(w.path) === rootPath) return true
      return false
    })

    const [ledgerRows, ghResult, branchSync] = await Promise.all([
      autopilot ? readLedgerIssues(autopilot.dbPath) : Promise.resolve([]),
      fetchGithubIssuesWithStatus(rootPath),
      inspectLocalBranchSync(rootPath)
    ])
    const githubIssues = ghResult.issues
    const activeRepairRows = ledgerRows.filter(
      (r) => r.status === 'running' || r.status === 'claimed' || r.attempt_status === 'running'
    )

    const agentQuestions: NeedsYouItem[] = []
    for (const ws of related) {
      try {
        const res = await orca.host.call('agents.list', { workspaceId: ws.id })
        for (const agent of res.agents || []) {
          if (!agent.terminalId) continue
          const agentState = String(agent.state || '')
          const isExplicitWait =
            agentState === 'blocked' || agentState === 'waiting' || agentState === 'permission'
          const agentTitle = agent.task?.title || agent.title || ''
          const isDoneOrIdle = agentState === 'done' || agentState === 'idle'
          const isHandoffDone = isDoneOrIdle && isHandoffSessionTitle(agentTitle)

          const matchedRepairRow = isDoneOrIdle
            ? activeRepairRows.find(
                (r) =>
                  (r.orca_worktree_id && r.orca_worktree_id === ws.id) ||
                  (r.worktree_path && resolve(r.worktree_path) === resolve(ws.path)) ||
                  agentTitle.includes(`#${r.issue_number}`)
              )
            : undefined
          const isRepairDone = Boolean(matchedRepairRow)

          if (!isExplicitWait && !isHandoffDone && !isRepairDone) continue

          let output = ''
          try {
            const readRes = await orca.host.call('terminal.read', {
              terminalId: agent.terminalId,
              maxLines: 40
            })
            output = (readRes.lines || []).join('\n')
          } catch {
            output = ''
          }

          if (
            isHandoffDone &&
            hasHandoffCreatedIssue({
              output,
              repository: autopilot?.repository || gitInfo.repository,
              githubIssues,
              agentUpdatedMs: agent.stateStartedAt || Date.now()
            })
          ) {
            continue
          }

          if (isRepairDone && hasAutopilotReceipt(output)) {
            continue
          }

          agentQuestions.push({
            id: `agent-${agent.terminalId}`,
            kind: 'agent-question',
            title: matchedRepairRow
              ? `#${matchedRepairRow.issue_number} ${matchedRepairRow.title}`
              : agentTitle || `${ws.name} 中的助手需要你确认`,
            question: extractTerminalQuestion(output),
            terminalId: agent.terminalId,
            workspaceId: ws.id,
            agentName: agent.agent || 'Agent',
            state:
              agentState === 'blocked'
                ? 'blocked'
                : agentState === 'permission'
                  ? 'permission'
                  : 'waiting',
            updatedAt: new Date(agent.stateStartedAt || Date.now()).toISOString()
          })
        }
      } catch {
        continue
      }
    }

    const systemAlerts = buildSystemHealthAlerts({
      repository: autopilot?.repository || gitInfo.repository,
      autopilotInstalled: Boolean(autopilot),
      autopilotLabel: autopilot?.label,
      pollIntervalSeconds: autopilot?.pollIntervalSeconds,
      maxConcurrentWorkers: autopilot?.maxConcurrentWorkers,
      githubError: ghResult.error,
      branchSync,
      ledgerRows,
      githubIssues
    })

    const merged = mergeBoardItems({
      ledgerRows,
      githubIssues,
      agentQuestions,
      systemAlerts,
      publication: autopilot?.publication ?? null
    })
    return {
      projectName: basename(rootPath),
      needsYou: merged.needsYou
    }
  }

  async function refreshStatusBarAndNotify() {
    try {
      const summary = await countNeedsYou()
      if (!summary) return
      const count = summary.needsYou.length
      await orca.host.call('statusBar.update', {
        id: 'autopilot-status',
        text: count > 0 ? `Autopilot · ${count} 待处理` : 'Autopilot',
        tone: count > 0 ? 'warning' : 'neutral',
        tooltip:
          count > 0
            ? `${summary.projectName} 有 ${count} 件事需要你回复或确认（点击打开 Orca Autopilot）`
            : `在终端打开 ${summary.projectName} 的 Orca Autopilot 控制台 (TUI)`
      })

      for (const item of summary.needsYou) {
        if (!notifiedIds.has(item.id)) {
          notifiedIds.add(item.id)
          void orca.host.call('notifications.show', {
            title: `${summary.projectName} 需要你确认`,
            body: item.title
          })
        }
      }
    } catch (err) {
      orca.log(`status bar refresh failed: ${String(err)}`)
    }
  }

  async function openTerminalBoard() {
    const { workspaceId, repoPath } = await resolveActiveWorkspace()
    if (!workspaceId || !repoPath) {
      void orca.host.call('notifications.show', {
        title: '无法打开 Orca Autopilot',
        body: '请先在 Orca 左侧选择一个项目工作区。'
      })
      return '未检测到当前项目工作区'
    }

    const existingTerminalId = activeBoardTerminals.get(workspaceId)
    if (existingTerminalId) {
      try {
        const focused = await orca.host.call('terminal.focus', { terminalId: existingTerminalId })
        if (focused.focused) {
          return `已切换到 ${basename(repoPath)} 的 Orca Autopilot 终端控制台`
        }
      } catch {
        activeBoardTerminals.delete(workspaceId)
      }
    }

    const command = `if command -v bun >/dev/null 2>&1; then exec bun ${shellQuote(tuiScriptPath)} ${shellQuote(repoPath)}; else exec node ${shellQuote(tuiScriptPath)} ${shellQuote(repoPath)}; fi`
    const created = await orca.host.call('terminal.create', {
      workspaceId,
      title: `Orca Autopilot · ${basename(repoPath)}`,
      command
    })
    activeBoardTerminals.set(workspaceId, created.terminalId)
    try {
      await orca.host.call('terminal.focus', { terminalId: created.terminalId })
    } catch {
      // ignore focus failure on headless host
    }
    return `已在终端打开 ${basename(repoPath)} 的 Orca Autopilot 控制台`
  }

  orca.commands.register('open-autopilot', async () => {
    return await openTerminalBoard()
  })

  orca.events.on('agent.status.changed', () => {
    void refreshStatusBarAndNotify()
  })

  orca.events.on('workspace.changed', () => {
    void refreshStatusBarAndNotify()
  })

  void refreshStatusBarAndNotify()
  pollTimer = setInterval(() => {
    void refreshStatusBarAndNotify()
  }, POLL_INTERVAL_MS)

  return () => {
    if (pollTimer) clearInterval(pollTimer)
  }
}
