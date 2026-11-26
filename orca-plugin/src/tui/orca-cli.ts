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
  hasHandoffCreatedIssue,
  isHandoffSessionTitle,
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
const DISCOVERED_HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type PendingHandoff = {
  terminalId: string
  paneKey?: string
  orcaSessionId?: string
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

type OrcaTerminalEntry = {
  handle?: string
  worktreeId?: string
  worktreePath?: string
  tabId?: string
  leafId?: string
  title?: string
  connected?: boolean
  writable?: boolean
  lastOutputAt?: number
  preview?: string
  agentIdentity?: string
}

export type ResolvedOrcaAgent = {
  handle: string
  paneKey?: string
  orcaSessionId?: string
  agent: string
  state: string
  title: string
  worktreeId: string
  workspace: string
  lastAssistantMessage: string
  preview: string
  updatedAt: number
  terminalConnected: boolean
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

function matchesProject(
  entry: { worktreeId?: string; worktreePath?: string; repo?: string },
  repoPath: string
): boolean {
  const normalized = resolve(repoPath)
  if (entry.worktreePath && resolve(entry.worktreePath) === normalized) return true
  if (entry.worktreeId && entry.worktreeId.includes(normalized)) return true
  const projectName = basename(normalized)
  if (entry.repo && entry.repo === projectName) return true
  return false
}

async function readTerminalText(
  handle: string,
  runner: CommandRunner
): Promise<string> {
  if (!handle) return ''
  for (const extraArgs of [
    ['--screen', '--limit', '40'],
    ['--limit', '40']
  ]) {
    const readRes = await runner(
      'orca',
      ['terminal', 'read', '--terminal', handle, ...extraArgs, '--json'],
      { timeoutMs: 4_000 }
    )
    if (readRes.exitCode === 0 && readRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(readRes.stdout) as {
          result?: { terminal?: { tail?: string[] } }
        }
        const tail = parsed.result?.terminal?.tail || []
        const joined = tail.join('\n').trim()
        if (joined) return joined
      } catch {
        // ignore
      }
    }
  }
  return ''
}

export async function collectOrcaAgentState(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<{
  questions: NeedsYouItem[]
  sessionStates: Map<string, string>
  agentsByKey: Map<string, ResolvedOrcaAgent>
  terminalByHandle: Map<string, OrcaTerminalEntry>
  handoffAgents: ResolvedOrcaAgent[]
}> {
  const questions: NeedsYouItem[] = []
  const sessionStates = new Map<string, string>()
  const agentsByKey = new Map<string, ResolvedOrcaAgent>()
  const terminalByHandle = new Map<string, OrcaTerminalEntry>()
  const terminalByPaneKey = new Map<string, OrcaTerminalEntry>()
  const handoffAgents: ResolvedOrcaAgent[] = []

  const [agentRes, termRes] = await Promise.all([
    runner('orca', ['agent', 'list', '--json'], { timeoutMs: 6_000 }),
    runner('orca', ['terminal', 'list', '--json'], { timeoutMs: 6_000 })
  ])

  if (termRes.exitCode === 0 && termRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(termRes.stdout) as {
        result?: { terminals?: OrcaTerminalEntry[] }
        terminals?: OrcaTerminalEntry[]
      }
      const terminals = parsed.result?.terminals || parsed.terminals || []
      for (const term of terminals) {
        if (term.handle) {
          terminalByHandle.set(term.handle, term)
        }
        if (term.tabId && term.leafId) {
          terminalByPaneKey.set(`${term.tabId}:${term.leafId}`, term)
        }
      }
    } catch {
      // ignore terminal list parse failure
    }
  }

  if (agentRes.exitCode !== 0 || !agentRes.stdout.trim()) {
    return { questions, sessionStates, agentsByKey, terminalByHandle, handoffAgents }
  }

  let agents: OrcaAgentEntry[] = []
  try {
    const parsed = JSON.parse(agentRes.stdout) as {
      result?: { agents?: OrcaAgentEntry[] }
      agents?: OrcaAgentEntry[]
    }
    agents = parsed.result?.agents || parsed.agents || []
  } catch {
    return { questions, sessionStates, agentsByKey, terminalByHandle, handoffAgents }
  }

  for (const agent of agents) {
    const matchedTerminal =
      (agent.terminalId ? terminalByHandle.get(agent.terminalId) : undefined) ||
      (agent.paneKey ? terminalByPaneKey.get(agent.paneKey) : undefined)
    if (!matchesProject(agent, repoPath) && !(matchedTerminal && matchesProject(matchedTerminal, repoPath))) {
      continue
    }

    const handle =
      matchedTerminal?.handle || agent.terminalId || agent.paneKey || agent.orcaSessionId || ''
    const resolved: ResolvedOrcaAgent = {
      handle,
      paneKey: agent.paneKey,
      orcaSessionId: agent.orcaSessionId,
      agent: agent.agent || matchedTerminal?.agentIdentity || 'Agent',
      state: agent.state || '',
      title: agent.title || matchedTerminal?.title || '',
      worktreeId: agent.worktreeId || matchedTerminal?.worktreeId || '',
      workspace: agent.workspace || basename(repoPath),
      lastAssistantMessage: (agent.lastAssistantMessage || '').trim(),
      preview: (matchedTerminal?.preview || '').trim(),
      updatedAt: agent.updatedAt || matchedTerminal?.lastOutputAt || Date.now(),
      terminalConnected: matchedTerminal ? matchedTerminal.connected !== false : true
    }

    for (const key of [handle, agent.terminalId, agent.paneKey, agent.orcaSessionId]) {
      if (key) {
        if (resolved.state) sessionStates.set(key, resolved.state)
        agentsByKey.set(key, resolved)
      }
    }

    if (isHandoffSessionTitle(resolved.title)) {
      handoffAgents.push(resolved)
    }

    if (
      resolved.state === 'blocked' ||
      resolved.state === 'waiting' ||
      resolved.state === 'permission'
    ) {
      let question = resolved.lastAssistantMessage
      if (!question && resolved.preview) {
        question = extractTerminalQuestion(resolved.preview)
      }
      if (!question && handle) {
        const terminalText = await readTerminalText(handle, runner)
        if (terminalText) {
          question = extractTerminalQuestion(terminalText)
        }
      }
      if (!question) {
        question = '后台助手正在等待你的确认或输入，可以直接回复指示，或点击「同意继续」。'
      }
      questions.push({
        id: `agent-${handle || agent.orcaSessionId || Math.random().toString(36).slice(2)}`,
        kind: 'agent-question',
        title: resolved.title || `${resolved.workspace} 中的助手需要你确认`,
        question,
        terminalId: handle,
        workspaceId: resolved.worktreeId,
        agentName: resolved.agent,
        state:
          resolved.state === 'blocked'
            ? 'blocked'
            : resolved.state === 'permission'
              ? 'permission'
              : 'waiting',
        updatedAt: new Date(resolved.updatedAt).toISOString()
      })
    }
  }

  return { questions, sessionStates, agentsByKey, terminalByHandle, handoffAgents }
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

  const questionsByHandle = new Map<string, Extract<NeedsYouItem, { kind: 'agent-question' }>>()
  const allQuestions: NeedsYouItem[] = []
  for (const q of agentState.questions) {
    allQuestions.push(q)
    if (q.kind === 'agent-question' && q.terminalId) {
      questionsByHandle.set(q.terminalId, q)
    }
  }

  const now = Date.now()
  const activeHandoffs: InProgressItem[] = []
  const handledHandoffKeys = new Set<string>()

  for (const [terminalId, entry] of pendingHandoffs.entries()) {
    if (entry.repoPath !== repoPath) continue
    const resolved =
      agentState.agentsByKey.get(entry.terminalId) ||
      (entry.paneKey ? agentState.agentsByKey.get(entry.paneKey) : undefined) ||
      (entry.orcaSessionId ? agentState.agentsByKey.get(entry.orcaSessionId) : undefined)
    const effectiveHandle = resolved?.handle || entry.terminalId
    const termEntry = agentState.terminalByHandle.get(effectiveHandle)
    const state = resolved?.state
    const terminalStillOpen = Boolean(
      (termEntry && termEntry.connected !== false) ||
        (resolved && resolved.terminalConnected)
    )

    for (const k of [
      entry.terminalId,
      entry.paneKey,
      entry.orcaSessionId,
      effectiveHandle,
      resolved?.paneKey,
      resolved?.orcaSessionId
    ]) {
      if (k) handledHandoffKeys.add(k)
    }

    if (!state && !terminalStillOpen) {
      if (now - entry.startedMs > HANDOFF_BOOT_GRACE_MS) {
        pendingHandoffs.delete(terminalId)
        continue
      }
      activeHandoffs.push({
        id: `handoff-${effectiveHandle}`,
        issueNumber: null,
        title: entry.title,
        url: '',
        statusLabel: `Skill 整理提单中 (${entry.agent})`,
        updatedAt: entry.startedAt
      })
      continue
    }

    if (state === 'done' || state === 'idle') {
      let output = [resolved?.lastAssistantMessage, resolved?.preview, termEntry?.preview]
        .filter(Boolean)
        .join('\n')
      let created = hasHandoffCreatedIssue({
        output,
        repository: autopilot?.repository || repository,
        githubIssues,
        startedMs: entry.startedMs
      })
      if (!created && effectiveHandle) {
        const screenText = await readTerminalText(effectiveHandle, runner)
        if (screenText) {
          output = output ? `${output}\n${screenText}` : screenText
          created = hasHandoffCreatedIssue({
            output,
            repository: autopilot?.repository || repository,
            githubIssues,
            startedMs: entry.startedMs
          })
        }
      }
      if (created || !terminalStillOpen) {
        pendingHandoffs.delete(terminalId)
        continue
      }

      // Agent finished its turn without creating an Issue -> waiting for user confirmation!
      const existingQuestion = questionsByHandle.get(effectiveHandle)
      if (existingQuestion) {
        existingQuestion.title = entry.title
      } else {
        const questionItem: Extract<NeedsYouItem, { kind: 'agent-question' }> = {
          id: `agent-${effectiveHandle}`,
          kind: 'agent-question',
          title: entry.title,
          question: extractTerminalQuestion(output),
          terminalId: effectiveHandle,
          workspaceId: resolved?.worktreeId || '',
          agentName: entry.agent,
          state: 'waiting',
          updatedAt: new Date(resolved?.updatedAt || now).toISOString()
        }
        allQuestions.push(questionItem)
        questionsByHandle.set(effectiveHandle, questionItem)
      }

      activeHandoffs.push({
        id: `handoff-${effectiveHandle}`,
        issueNumber: null,
        title: entry.title,
        url: '',
        statusLabel: `Skill 等待确认 (${entry.agent})`,
        updatedAt: new Date(resolved?.updatedAt || entry.startedMs).toISOString()
      })
      continue
    }

    const waitingConfirmation =
      state === 'waiting' || state === 'blocked' || state === 'permission'
    if (waitingConfirmation) {
      const existingQuestion = questionsByHandle.get(effectiveHandle)
      if (existingQuestion) {
        existingQuestion.title = entry.title
      }
    }

    activeHandoffs.push({
      id: `handoff-${effectiveHandle}`,
      issueNumber: null,
      title: entry.title,
      url: '',
      statusLabel: waitingConfirmation
        ? `Skill 等待确认 (${entry.agent})`
        : `Skill 整理提单中 (${entry.agent})`,
      updatedAt: entry.startedAt
    })
  }

  // Also discover active/waiting handoff terminals not in in-memory pendingHandoffs (e.g. after TUI restart)
  for (const agent of agentState.handoffAgents) {
    if (!agent.terminalConnected) continue
    if (
      handledHandoffKeys.has(agent.handle) ||
      (agent.paneKey && handledHandoffKeys.has(agent.paneKey)) ||
      (agent.orcaSessionId && handledHandoffKeys.has(agent.orcaSessionId))
    ) {
      continue
    }
    if (now - agent.updatedAt > DISCOVERED_HANDOFF_MAX_AGE_MS) continue

    const effectiveHandle = agent.handle
    const displayTitle = agent.title || 'Skill 规范提单任务'

    if (agent.state === 'done' || agent.state === 'idle') {
      let output = [agent.lastAssistantMessage, agent.preview].filter(Boolean).join('\n')
      let created = hasHandoffCreatedIssue({
        output,
        repository: autopilot?.repository || repository,
        githubIssues,
        agentUpdatedMs: agent.updatedAt
      })
      if (!created && effectiveHandle) {
        const screenText = await readTerminalText(effectiveHandle, runner)
        if (screenText) {
          output = output ? `${output}\n${screenText}` : screenText
          created = hasHandoffCreatedIssue({
            output,
            repository: autopilot?.repository || repository,
            githubIssues,
            agentUpdatedMs: agent.updatedAt
          })
        }
      }
      if (created) continue

      if (!questionsByHandle.has(effectiveHandle)) {
        const questionItem: Extract<NeedsYouItem, { kind: 'agent-question' }> = {
          id: `agent-${effectiveHandle}`,
          kind: 'agent-question',
          title: displayTitle,
          question: extractTerminalQuestion(output),
          terminalId: effectiveHandle,
          workspaceId: agent.worktreeId,
          agentName: agent.agent,
          state: 'waiting',
          updatedAt: new Date(agent.updatedAt).toISOString()
        }
        allQuestions.push(questionItem)
        questionsByHandle.set(effectiveHandle, questionItem)
      }

      activeHandoffs.push({
        id: `handoff-${effectiveHandle}`,
        issueNumber: null,
        title: displayTitle,
        url: '',
        statusLabel: `Skill 等待确认 (${agent.agent})`,
        updatedAt: new Date(agent.updatedAt).toISOString()
      })
      continue
    }

    const waitingConfirmation =
      agent.state === 'waiting' || agent.state === 'blocked' || agent.state === 'permission'
    activeHandoffs.push({
      id: `handoff-${effectiveHandle}`,
      issueNumber: null,
      title: displayTitle,
      url: '',
      statusLabel: waitingConfirmation
        ? `Skill 等待确认 (${agent.agent})`
        : `Skill 整理提单中 (${agent.agent})`,
      updatedAt: new Date(agent.updatedAt).toISOString()
    })
  }

  const merged = mergeBoardItems({
    ledgerRows,
    githubIssues,
    agentQuestions: allQuestions
  })

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
  let paneKey: string | undefined
  let orcaSessionId: string | undefined
  try {
    const parsed = JSON.parse(launchRes.stdout) as {
      result?: {
        terminalId?: string
        paneKey?: string
        terminal?: { handle?: string; tabId?: string; leafId?: string }
        orcaSessionId?: string
      }
    }
    terminalId =
      parsed.result?.terminalId ||
      parsed.result?.terminal?.handle ||
      parsed.result?.orcaSessionId ||
      terminalId
    orcaSessionId = parsed.result?.orcaSessionId
    paneKey =
      parsed.result?.paneKey ||
      (parsed.result?.terminal?.tabId && parsed.result?.terminal?.leafId
        ? `${parsed.result.terminal.tabId}:${parsed.result.terminal.leafId}`
        : undefined)
  } catch {
    // keep synthetic id
  }

  const nowMs = Date.now()
  params.pendingHandoffs.set(terminalId, {
    terminalId,
    paneKey,
    orcaSessionId,
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
