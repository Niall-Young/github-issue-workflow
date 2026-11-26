import { basename, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  createAgentReadyIssue,
  defaultRunner,
  ensureBoardAnchorFile,
  extractTerminalQuestion,
  fetchGithubIssues,
  findAutopilotConfigForRepo,
  findBundledAutopilotAdmin,
  mergeBoardItems,
  readLedgerIssues,
  resolveGitRepository,
  resolvePluginRootDir,
  saveAttachmentsLocally
} from './board-data'
import type { BoardSnapshot, NeedsYouItem } from './protocol'

const POLL_INTERVAL_MS = 12_000

export default function activate(orca: OrcaWorkerApi) {
  const pluginRoot = resolvePluginRootDir()
  const notifiedIds = new Set<string>()
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function resolveWorkspaceInfo(requestedRepoPath?: string, requestedWorkspaceId?: string) {
    let repoPath = requestedRepoPath ? resolve(requestedRepoPath) : null
    let workspaceId = requestedWorkspaceId
    let projectId: string | null = null

    try {
      const ctx = await orca.host.call('workspace.readContext')
      if (!workspaceId && ctx?.workspaceId) {
        workspaceId = ctx.workspaceId
      }
    } catch {
      // ignore
    }

    try {
      const wsList = await orca.host.call('workspace.list', { includeStatus: true })
      const workspaces = wsList.workspaces || []
      const match =
        (workspaceId ? workspaces.find((w) => w.id === workspaceId) : null) ||
        (repoPath ? workspaces.find((w) => resolve(w.path) === repoPath) : null) ||
        workspaces[0]

      if (match) {
        workspaceId = match.id
        projectId = match.projectId ?? null
        if (!repoPath) repoPath = resolve(match.path)
      }
      return { repoPath, workspaceId, projectId, workspaces }
    } catch {
      return { repoPath, workspaceId, projectId, workspaces: [] }
    }
  }

  async function collectAgentQuestions(
    projectId: string | null,
    repoPath: string | null,
    workspaces: Array<{
      id: string
      name: string
      path: string
      projectId?: string | null
      status?: { state: string }
    }>
  ): Promise<NeedsYouItem[]> {
    const related = workspaces.filter((w) => {
      if (projectId && w.projectId === projectId) return true
      if (repoPath && resolve(w.path) === repoPath) return true
      return false
    })

    const questions: NeedsYouItem[] = []
    for (const ws of related) {
      try {
        const res = await orca.host.call('agents.list', { workspaceId: ws.id })
        for (const agent of res.agents || []) {
          if (
            agent.terminalId &&
            (agent.state === 'blocked' || agent.state === 'waiting')
          ) {
            let output = ''
            try {
              const readRes = await orca.host.call('terminal.read', {
                terminalId: agent.terminalId,
                lines: 30
              })
              output = readRes.text || ''
            } catch {
              output = ''
            }
            const question = extractTerminalQuestion(output)
            questions.push({
              id: `agent-${agent.terminalId}`,
              kind: 'agent-question',
              title: agent.task?.title || agent.title || `${ws.name} 中的助手需要你确认`,
              question,
              terminalId: agent.terminalId,
              workspaceId: ws.id,
              agentName: agent.agent || 'Agent',
              state: agent.state === 'blocked' ? 'blocked' : 'waiting',
              updatedAt: new Date(agent.stateStartedAt || Date.now()).toISOString()
            })
          }
        }
      } catch {
        continue
      }
    }
    return questions
  }

  async function buildSnapshot(input?: {
    repoPath?: string
    repository?: string
    workspaceId?: string
  }): Promise<BoardSnapshot> {
    const { repoPath: resolvedPath, projectId, workspaces } = await resolveWorkspaceInfo(
      input?.repoPath,
      input?.workspaceId
    )
    const syncedAt = new Date().toISOString()

    if (!resolvedPath) {
      return {
        projectName: '未选择项目',
        repository: null,
        repoPath: null,
        autopilotInstalled: false,
        autopilotRunning: false,
        syncedAt,
        error: '请先在 Orca 左侧选择一个 Git 项目工作区。',
        needsYou: [],
        inProgress: [],
        completed: []
      }
    }

    const gitInfo = await resolveGitRepository(resolvedPath)
    const repoPath = gitInfo.rootPath
    const repository = input?.repository || gitInfo.repository
    const autopilot = findAutopilotConfigForRepo(repoPath, repository)

    const [ledgerRows, githubIssues, agentQuestions] = await Promise.all([
      autopilot ? readLedgerIssues(autopilot.dbPath) : Promise.resolve([]),
      fetchGithubIssues(repoPath),
      collectAgentQuestions(projectId, repoPath, workspaces)
    ])

    const merged = mergeBoardItems({ ledgerRows, githubIssues, agentQuestions })

    return {
      projectName: basename(repoPath),
      repository: autopilot?.repository || repository,
      repoPath,
      autopilotInstalled: Boolean(autopilot),
      autopilotRunning: Boolean(autopilot),
      syncedAt,
      error: null,
      needsYou: merged.needsYou,
      inProgress: merged.inProgress,
      completed: merged.completed
    }
  }

  async function refreshStatusBarAndNotify() {
    try {
      const snap = await buildSnapshot()
      const count = snap.needsYou.length
      await orca.host.call('statusBar.update', {
        id: 'board-status',
        text: count > 0 ? `Issue 看板 · ${count} 待处理` : 'Issue 看板',
        tone: count > 0 ? 'warning' : 'neutral',
        tooltip:
          count > 0
            ? `${snap.projectName} 有 ${count} 件事需要你回复或确认`
            : `打开 ${snap.projectName} 的 Issue 看板`
      })

      for (const item of snap.needsYou) {
        if (!notifiedIds.has(item.id)) {
          notifiedIds.add(item.id)
          void orca.host.call('notifications.show', {
            title: `${snap.projectName} 需要你确认`,
            body: item.title
          })
        }
      }

      orca.panels.post('board.updated', {
        repoPath: snap.repoPath,
        needsYouCount: count
      })
    } catch (err) {
      orca.log(`refresh failed: ${String(err)}`)
    }
  }

  async function openBoardForCurrentWorkspace() {
    const { repoPath, workspaceId } = await resolveWorkspaceInfo()
    if (!repoPath || !workspaceId) {
      void orca.host.call('notifications.show', {
        title: '无法打开 Issue 看板',
        body: '请先在 Orca 左侧选择一个项目工作区。'
      })
      return '未检测到当前项目工作区'
    }
    const gitInfo = await resolveGitRepository(repoPath)
    const relPath = await ensureBoardAnchorFile(gitInfo.rootPath, gitInfo.repository, workspaceId)
    await orca.host.call('editor.open', {
      workspaceId,
      path: relPath
    })
    return `已打开 ${basename(gitInfo.rootPath)} 的 Issue 看板`
  }

  orca.commands.register('open-board', async () => {
    return await openBoardForCurrentWorkspace()
  })

  orca.panels.handle('board.snapshot', async (input) => {
    return await buildSnapshot(input)
  })

  orca.panels.handle('board.createIssue', async (input) => {
    const result = await createAgentReadyIssue(input)
    void refreshStatusBarAndNotify()
    return result
  })

  orca.panels.handle('board.replyAgent', async (input) => {
    const baseText = input.message.trim()
    const savedAttachments =
      input.attachments && input.attachments.length > 0
        ? saveAttachmentsLocally(input.repoPath || 'reply', input.attachments)
        : []

    if (!baseText && savedAttachments.length === 0) {
      throw Object.assign(new Error('回复内容或附件不能为空'), { code: 'invalid_params' })
    }

    const attachmentNote =
      savedAttachments.length > 0
        ? `\n附件路径：\n${savedAttachments.map((a) => `- ${a.path}`).join('\n')}`
        : ''

    await orca.host.call('terminal.sendText', {
      terminalId: input.terminalId,
      text: `${baseText}${attachmentNote}`.trim(),
      enter: true
    })
    void refreshStatusBarAndNotify()
    return { ok: true, savedAttachments }
  })

  orca.panels.handle('board.issueAction', async (input) => {
    const autopilot = findAutopilotConfigForRepo(input.repoPath, null)
    const adminScript =
      (autopilot && autopilot.runtimeAdminPath) || findBundledAutopilotAdmin(pluginRoot)
    if (!adminScript) {
      throw new Error('未找到 autopilot_admin.py，请先安装 github-issue-autopilot')
    }
    const res = await defaultRunner('python3', [
      adminScript,
      input.action,
      '--repo-path',
      input.repoPath,
      '--issue-url',
      input.issueUrl
    ])
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || `执行 ${input.action} 失败`)
    }
    void refreshStatusBarAndNotify()
    return { ok: true }
  })

  orca.panels.handle('board.enableAutopilot', async (input) => {
    const adminScript = findBundledAutopilotAdmin(pluginRoot)
    if (!adminScript) {
      throw new Error('未找到 autopilot_admin.py，请先确认已安装 github-issue-autopilot')
    }
    const res = await defaultRunner(
      'python3',
      [adminScript, 'install', '--repo-path', input.repoPath],
      { timeoutMs: 45_000 }
    )
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || '开启自动处理失败')
    }
    void refreshStatusBarAndNotify()
    return { ok: true, message: '已为当前项目开启自动处理循环' }
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
