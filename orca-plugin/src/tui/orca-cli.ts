// Standalone data & action bridge for the terminal TUI.
// Reuses board-data.ts directly and communicates with Orca via the `orca` CLI.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import {
  buildAutopilotInstallArgs,
  buildHandoffPrompt,
  createAgentReadyIssue,
  defaultRunner,
  extractTerminalQuestion,
  fetchGithubIssues,
  fetchGithubPullRequests,
  findAutopilotConfigForRepo,
  findBundledAutopilotAdmin,
  findBundledHandoffSkill,
  getAutopilotStateRoot,
  listInstalledAgents,
  mergeBoardItems,
  readLedgerIssues,
  resolveGitRepository,
  resolvePreferredAgent,
  type CommandRunner
} from '../board-data'
import type {
  BoardSnapshot,
  CreateIssueResult,
  InProgressItem,
  IssueKind,
  NeedsYouItem,
  SavedAttachment,
  SubmitMode
} from '../protocol'

const HANDOFF_BOOT_GRACE_MS = 25_000
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type PendingHandoff = {
  terminalId: string
  repoPath: string
  title: string
  agent: string
  startedAt: string
  startedMs: number
}

type OrcaAgentEntry = {
  orcaSessionId?: string
  kind?: string
  agent?: string
  state?: string
  worktreeId?: string
  workspace?: string
  repo?: string
  paneKey?: string
  terminalId?: string
  title?: string
  lastAssistantMessage?: string | null
  updatedAt?: number
}

function resolvePluginRootFromTui(): string {
  try {
    const fileUrl = import.meta.url
    if (fileUrl.startsWith('file://')) {
      // orca-plugin/src/tui/orca-cli.ts -> orca-plugin
      return resolve(new URL(fileUrl).pathname, '..', '..', '..')
    }
  } catch {
    // ignore
  }
  return process.cwd()
}

function matchesProject(entry: OrcaAgentEntry, repoPath: string): boolean {
  const normalized = resolve(repoPath)
  if (entry.worktreeId && entry.worktreeId.includes(normalized)) return true
  const projectName = basename(normalized)
  if (entry.repo && entry.repo === projectName) return true
  return false
}

export async function collectOrcaAgentState(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<{ questions: NeedsYouItem[]; sessionStates: Map<string, string> }> {
  const questions: NeedsYouItem[] = []
  const sessionStates = new Map<string, string>()

  const res = await runner('orca', ['agent', 'list', '--json'], { timeoutMs: 6_000 })
  if (res.exitCode !== 0 || !res.stdout.trim()) {
    return { questions, sessionStates }
  }

  let agents: OrcaAgentEntry[] = []
  try {
    const parsed = JSON.parse(res.stdout) as {
      result?: { agents?: OrcaAgentEntry[] }
      agents?: OrcaAgentEntry[]
    }
    agents = parsed.result?.agents || parsed.agents || []
  } catch {
    return { questions, sessionStates }
  }

  for (const agent of agents) {
    if (!matchesProject(agent, repoPath)) continue
    const handle = agent.terminalId || agent.paneKey || agent.orcaSessionId || ''
    if (handle && agent.state) {
      sessionStates.set(handle, agent.state)
    }
    if (agent.orcaSessionId && agent.state) {
      sessionStates.set(agent.orcaSessionId, agent.state)
    }

    if (agent.state === 'blocked' || agent.state === 'waiting') {
      let question = (agent.lastAssistantMessage || '').trim()
      if (!question && handle) {
        const readRes = await runner(
          'orca',
          ['terminal', 'read', '--terminal', handle, '--limit', '30', '--json'],
          { timeoutMs: 4_000 }
        )
        if (readRes.exitCode === 0 && readRes.stdout.trim()) {
          try {
            const parsed = JSON.parse(readRes.stdout) as {
              result?: { terminal?: { tail?: string[] } }
            }
            const tail = parsed.result?.terminal?.tail || []
            question = extractTerminalQuestion(tail.join('\n'))
          } catch {
            // ignore
          }
        }
      }
      if (!question) {
        question = '后台助手正在等待你的确认或输入，可以直接回复指示，或点击「同意继续」。'
      }
      questions.push({
        id: `agent-${handle || agent.orcaSessionId || Math.random().toString(36).slice(2)}`,
        kind: 'agent-question',
        title: agent.title || `${agent.workspace || basename(repoPath)} 中的助手需要你确认`,
        question,
        terminalId: handle,
        workspaceId: agent.worktreeId || '',
        agentName: agent.agent || 'Agent',
        state: agent.state === 'blocked' ? 'blocked' : 'waiting',
        updatedAt: new Date(agent.updatedAt || Date.now()).toISOString()
      })
    }
  }

  return { questions, sessionStates }
}

export async function loadBoardSnapshot(
  targetPath: string,
  pendingHandoffs: Map<string, PendingHandoff>,
  runner: CommandRunner = defaultRunner
): Promise<BoardSnapshot> {
  const syncedAt = new Date().toISOString()
  const gitInfo = await resolveGitRepository(targetPath, runner)
  const repoPath = gitInfo.rootPath
  const repository = gitInfo.repository
  const autopilot = findAutopilotConfigForRepo(repoPath, repository)

  const [ledgerRows, githubIssues, pullRequests, agentState, installedAgents] = await Promise.all([
    autopilot ? readLedgerIssues(autopilot.dbPath, runner) : Promise.resolve([]),
    fetchGithubIssues(repoPath, runner),
    fetchGithubPullRequests(repoPath, runner),
    collectOrcaAgentState(repoPath, runner),
    listInstalledAgents(runner)
  ])

  const preferredAgent = await resolvePreferredAgent(
    autopilot?.defaultAgent ?? null,
    runner,
    installedAgents
  )

  const merged = mergeBoardItems({
    ledgerRows,
    githubIssues,
    agentQuestions: agentState.questions
  })

  const now = Date.now()
  const activeHandoffs: InProgressItem[] = []
  for (const [terminalId, entry] of pendingHandoffs.entries()) {
    if (entry.repoPath !== repoPath) continue
    const state = agentState.sessionStates.get(terminalId)
    if (state === 'done') {
      pendingHandoffs.delete(terminalId)
      continue
    }
    if (!state && now - entry.startedMs > HANDOFF_BOOT_GRACE_MS) {
      pendingHandoffs.delete(terminalId)
      continue
    }
    activeHandoffs.push({
      id: `handoff-${terminalId}`,
      issueNumber: null,
      title: entry.title,
      url: '',
      statusLabel:
        state === 'waiting' || state === 'blocked'
          ? `Skill 等待确认 (${entry.agent})`
          : `Skill 整理提单中 (${entry.agent})`,
      updatedAt: entry.startedAt
    })
  }

  return {
    projectName: basename(repoPath),
    repository: autopilot?.repository || repository,
    repoPath,
    autopilotInstalled: Boolean(autopilot),
    autopilotRunning: Boolean(autopilot),
    defaultAgent: autopilot?.defaultAgent ?? null,
    allowedAgents: autopilot?.allowedAgents ?? [],
    installedAgents,
    preferredAgent,
    syncedAt,
    error: null,
    needsYou: merged.needsYou,
    inProgress: [...activeHandoffs, ...merged.inProgress],
    completed: merged.completed,
    pullRequests
  }
}

export async function submitIssueFromTui(params: {
  repoPath: string
  repository: string | null
  autopilotInstalled: boolean
  defaultAgent: string | null
  mode: SubmitMode
  kind: IssueKind
  title: string
  details?: string
  followUpOf?: number | null
  savedAttachments?: SavedAttachment[]
  pendingHandoffs: Map<string, PendingHandoff>
  runner?: CommandRunner
}): Promise<CreateIssueResult> {
  const runner = params.runner ?? defaultRunner
  const title = params.title.trim()
  if (!title) {
    throw new Error('请输入任务标题或问题描述')
  }

  const savedAttachments = params.savedAttachments ?? []

  if (params.mode === 'direct') {
    // Reuse direct creator; attachments are already saved on disk so embed their paths in details
    const extraLines =
      savedAttachments.length > 0
        ? [
            params.details?.trim() || '',
            '',
            '本地附件路径：',
            ...savedAttachments.map((a) => `- ${a.path} (${a.name})`)
          ]
            .filter(Boolean)
            .join('\n')
        : params.details
    const res = await createAgentReadyIssue(
      {
        repoPath: params.repoPath,
        mode: 'direct',
        kind: params.kind,
        title,
        details: extraLines,
        followUpOf: params.followUpOf
      },
      runner
    )
    return { ...res, savedAttachments }
  }

  const pluginRoot = resolvePluginRootFromTui()
  const skillPaths = findBundledHandoffSkill(pluginRoot)
  const agent = await resolvePreferredAgent(params.defaultAgent, runner)
  const prompt = buildHandoffPrompt({
    repoPath: params.repoPath,
    repository: params.repository,
    kind: params.kind,
    title,
    details: params.details,
    followUpOf: params.followUpOf,
    savedAttachments,
    autopilotInstalled: params.autopilotInstalled,
    skillPaths
  })

  const launchRes = await runner(
    'orca',
    [
      'agent',
      'launch',
      '--agent',
      agent,
      '--worktree',
      `path:${params.repoPath}`,
      '--surface',
      'terminal',
      '--prompt',
      prompt,
      '--json'
    ],
    { cwd: params.repoPath, timeoutMs: 25_000 }
  )

  if (launchRes.exitCode !== 0) {
    throw new Error(
      launchRes.stderr.trim() ||
        launchRes.stdout.trim() ||
        '无法通过 Orca 启动 Skill 提单 Agent，请确认 Orca 正在运行，或切换为「快速直提」模式'
    )
  }

  let terminalId = `handoff-${Date.now()}`
  try {
    const parsed = JSON.parse(launchRes.stdout) as {
      result?: {
        terminalId?: string
        terminal?: { handle?: string }
        orcaSessionId?: string
      }
    }
    terminalId =
      parsed.result?.terminalId ||
      parsed.result?.terminal?.handle ||
      parsed.result?.orcaSessionId ||
      terminalId
  } catch {
    // keep synthetic id
  }

  const nowMs = Date.now()
  params.pendingHandoffs.set(terminalId, {
    terminalId,
    repoPath: params.repoPath,
    title,
    agent,
    startedAt: new Date(nowMs).toISOString(),
    startedMs: nowMs
  })

  return {
    ok: true,
    mode: 'handoff',
    issueNumber: null,
    url: '',
    title,
    savedAttachments,
    terminalId,
    agent
  }
}

export async function replyToAgentTerminal(
  terminalId: string,
  message: string,
  attachments: SavedAttachment[] = [],
  runner: CommandRunner = defaultRunner
): Promise<void> {
  const baseText = message.trim()
  if (!baseText && attachments.length === 0) {
    throw new Error('回复内容或附件不能为空')
  }
  const attachmentNote =
    attachments.length > 0
      ? `\n附件路径：\n${attachments.map((a) => `- ${a.path}`).join('\n')}`
      : ''
  const payload = `${baseText}${attachmentNote}`.trim()
  const res = await runner(
    'orca',
    ['terminal', 'send', '--terminal', terminalId, '--text', payload, '--enter', '--json'],
    { timeoutMs: 10_000 }
  )
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || '发送回复失败')
  }
}

export async function runIssueAdminAction(
  repoPath: string,
  issueUrl: string,
  action: 'retry' | 'discard',
  runner: CommandRunner = defaultRunner
): Promise<void> {
  const autopilot = findAutopilotConfigForRepo(repoPath, null)
  const adminScript =
    (autopilot && autopilot.runtimeAdminPath) ||
    findBundledAutopilotAdmin(resolvePluginRootFromTui())
  if (!adminScript) {
    throw new Error('未找到 autopilot_admin.py，请先安装 github-issue-autopilot')
  }
  const res = await runner('python3', [
    adminScript,
    action,
    '--repo-path',
    repoPath,
    '--issue-url',
    issueUrl
  ])
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `执行 ${action} 失败`)
  }
}

export async function saveAgentConfig(params: {
  repoPath: string
  defaultAgent: string
  allowedAgents: string[]
  runner?: CommandRunner
}): Promise<string> {
  const runner = params.runner ?? defaultRunner
  const existing = findAutopilotConfigForRepo(params.repoPath, null)
  const adminScript =
    findBundledAutopilotAdmin(resolvePluginRootFromTui()) ||
    (existing && existing.runtimeAdminPath)
  if (!adminScript) {
    throw new Error('未找到 autopilot_admin.py，请先确认已安装 github-issue-autopilot')
  }
  const normalizedAllowed = Array.from(
    new Set([
      params.defaultAgent.trim(),
      ...params.allowedAgents.map((a) => a.trim()).filter(Boolean)
    ])
  )
  const args = buildAutopilotInstallArgs({
    adminScript,
    repoPath: params.repoPath,
    defaultAgent: params.defaultAgent.trim(),
    allowedAgents: normalizedAllowed,
    existing
  })
  const res = await runner('python3', args, { timeoutMs: 45_000 })
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || '保存 Agent 配置失败')
  }
  return `已更新执行 Agent 为 ${params.defaultAgent.trim()}（允许：${normalizedAllowed.join(', ')}）`
}

export async function openUrlInBrowser(
  url: string,
  runner: CommandRunner = defaultRunner
): Promise<void> {
  if (!url) return
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  await runner(cmd, [url], { timeoutMs: 5_000 })
}

function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

export function attachLocalFilePath(
  repoPath: string,
  rawPath: string,
  stateRoot = getAutopilotStateRoot()
): SavedAttachment | null {
  const cleaned = rawPath
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\ /g, ' ')
  if (!cleaned || !existsSync(cleaned)) return null
  const st = statSync(cleaned)
  if (!st.isFile()) return null
  if (st.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`文件 ${basename(cleaned)} 超过 10MB 限制`)
  }
  const repoSlug = basename(resolve(repoPath)).replace(/[^\w.-]+/g, '_') || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetDir = join(stateRoot, 'attachments', repoSlug, stamp)
  mkdirSync(targetDir, { recursive: true })
  const dest = join(targetDir, basename(cleaned))
  copyFileSync(cleaned, dest)
  return {
    name: basename(cleaned),
    mimeType: guessMimeType(dest),
    size: st.size,
    path: dest
  }
}

export async function captureClipboardImage(
  repoPath: string,
  stateRoot = getAutopilotStateRoot(),
  runner: CommandRunner = defaultRunner
): Promise<SavedAttachment | null> {
  if (process.platform !== 'darwin') return null
  const repoSlug = basename(resolve(repoPath)).replace(/[^\w.-]+/g, '_') || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetDir = join(stateRoot, 'attachments', repoSlug, stamp)
  mkdirSync(targetDir, { recursive: true })
  const outPath = join(targetDir, `clipboard-${Date.now()}.png`)

  // Use AppleScript to save PNG from macOS clipboard without third-party dependencies
  const script = `
    try
      set imgData to the clipboard as «class PNGf»
      set outFile to open for access POSIX file "${outPath.replace(/"/g, '\\"')}" with write permission
      set eof of outFile to 0
      write imgData to outFile
      close access outFile
      return "ok"
    on error
      return "no-image"
    end try
  `
  const res = await runner('osascript', ['-e', script], { timeoutMs: 5_000 })
  if (res.exitCode !== 0 || res.stdout.trim() !== 'ok' || !existsSync(outPath)) {
    return null
  }
  const st = statSync(outPath)
  if (st.size === 0) return null
  return {
    name: basename(outPath),
    mimeType: 'image/png',
    size: st.size,
    path: outPath
  }
}
