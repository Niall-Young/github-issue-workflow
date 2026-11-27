// Standalone data & action bridge for the terminal TUI.
// Reuses board-data.ts directly and communicates with Orca via the `orca` CLI.

import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAutopilotInstallArgs,
  buildHandoffPrompt,
  buildLocalDevPrompt,
  buildSystemHealthAlerts,
  createAgentReadyIssue,
  defaultRunner,
  extractTerminalQuestion,
  fetchGithubIssuesWithStatus,
  fetchGithubPullRequests,
  findAutopilotConfigForRepo,
  findBundledAutopilotAdmin,
  findBundledHandoffSkill,
  getAutopilotStateRoot,
  hasAutopilotReceipt,
  hasHandoffCreatedIssue,
  inspectLocalBranchSync,
  isHandoffSessionTitle,
  listInstalledAgents,
  LOCAL_DEV_LOCK_FILENAME,
  mergeBoardItems,
  readLedgerIssues,
  resolveGitRepository,
  resolvePreferredAgent,
  type AutopilotConfigInfo,
  type CommandRunner
} from '../board-data'
import type {
  BoardSnapshot,
  BranchSyncStatus,
  CreateIssueResult,
  InProgressItem,
  IssueKind,
  NeedsYouItem,
  SavedAttachment,
  SubmitMode,
  WorkerMode
} from '../protocol'

const HANDOFF_BOOT_GRACE_MS = 25_000
const HANDOFF_STALL_TIMEOUT_MS = 10 * 60 * 1000
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
  sessionKind?: 'handoff' | 'local'
  lockPath?: string
  existingIssueNumbers?: number[]
  lastActivityMs?: number
  lastPreview?: string
  exitedWithoutIssue?: boolean
  exitedAt?: string
}

function tryRemoveLocalDevLock(lockPath?: string) {
  if (!lockPath) return
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath)
  } catch {
    // ignore cleanup failures
  }
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
  worktreePath?: string
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

export type ParsedAgentLaunch = {
  terminalId?: string
  paneKey?: string
  orcaSessionId?: string
}

type LaunchOutcomeLike = {
  kind?: string
  handle?: string
  terminalId?: string
  paneKey?: string
  tabId?: string
  leafId?: string
  sessionId?: string
  orcaSessionId?: string
}

type LaunchContainerLike = {
  handle?: string
  terminalId?: string
  agentTerminalHandle?: string
  paneKey?: string
  tabId?: string
  leafId?: string
  sessionId?: string
  orcaSessionId?: string
  terminal?: { handle?: string; tabId?: string; leafId?: string }
  outcome?: LaunchOutcomeLike
}

export function parseAgentLaunchResult(stdout: string): ParsedAgentLaunch {
  if (!stdout.trim()) return {}
  try {
    const parsed = JSON.parse(stdout) as {
      result?: LaunchContainerLike & { launch?: LaunchContainerLike }
    }
    const r = parsed.result
    if (!r) return {}
    const launch = r.launch
    const outcome = r.outcome || launch?.outcome
    const terminalObj = r.terminal || launch?.terminal

    const orcaSessionId =
      r.orcaSessionId ||
      outcome?.orcaSessionId ||
      outcome?.sessionId ||
      r.sessionId ||
      launch?.orcaSessionId ||
      launch?.sessionId ||
      undefined

    const terminalId =
      outcome?.handle ||
      outcome?.terminalId ||
      r.terminalId ||
      r.terminal?.handle ||
      r.agentTerminalHandle ||
      r.handle ||
      launch?.terminalId ||
      launch?.terminal?.handle ||
      launch?.agentTerminalHandle ||
      launch?.handle ||
      orcaSessionId ||
      undefined

    const paneKey =
      r.paneKey ||
      outcome?.paneKey ||
      launch?.paneKey ||
      (terminalObj?.tabId && terminalObj?.leafId
        ? `${terminalObj.tabId}:${terminalObj.leafId}`
        : undefined) ||
      (outcome?.tabId && outcome?.leafId ? `${outcome.tabId}:${outcome.leafId}` : undefined) ||
      (r.tabId && r.leafId ? `${r.tabId}:${r.leafId}` : undefined) ||
      (launch?.tabId && launch?.leafId ? `${launch.tabId}:${launch.leafId}` : undefined)

    return { terminalId, paneKey, orcaSessionId }
  } catch {
    return {}
  }
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
  allAgents: ResolvedOrcaAgent[]
  orcaReachable: boolean
}> {
  const questions: NeedsYouItem[] = []
  const sessionStates = new Map<string, string>()
  const agentsByKey = new Map<string, ResolvedOrcaAgent>()
  const terminalByHandle = new Map<string, OrcaTerminalEntry>()
  const terminalByPaneKey = new Map<string, OrcaTerminalEntry>()
  const handoffAgents: ResolvedOrcaAgent[] = []
  const allAgents: ResolvedOrcaAgent[] = []

  const [agentRes, termRes] = await Promise.all([
    runner('orca', ['agent', 'list', '--json'], { timeoutMs: 6_000 }),
    runner('orca', ['terminal', 'list', '--json'], { timeoutMs: 6_000 })
  ])
  const orcaReachable = agentRes.exitCode === 0 && termRes.exitCode === 0

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
    return {
      questions,
      sessionStates,
      agentsByKey,
      terminalByHandle,
      handoffAgents,
      allAgents,
      orcaReachable
    }
  }

  let agents: OrcaAgentEntry[] = []
  try {
    const parsed = JSON.parse(agentRes.stdout) as {
      result?: { agents?: OrcaAgentEntry[] }
      agents?: OrcaAgentEntry[]
    }
    agents = parsed.result?.agents || parsed.agents || []
  } catch {
    return {
      questions,
      sessionStates,
      agentsByKey,
      terminalByHandle,
      handoffAgents,
      allAgents,
      orcaReachable
    }
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
      worktreePath: matchedTerminal?.worktreePath,
      workspace: agent.workspace || basename(repoPath),
      lastAssistantMessage: (agent.lastAssistantMessage || '').trim(),
      preview: (matchedTerminal?.preview || '').trim(),
      updatedAt: agent.updatedAt || matchedTerminal?.lastOutputAt || Date.now(),
      terminalConnected: matchedTerminal ? matchedTerminal.connected !== false : true
    }
    allAgents.push(resolved)

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

  return {
    questions,
    sessionStates,
    agentsByKey,
    terminalByHandle,
    handoffAgents,
    allAgents,
    orcaReachable
  }
}

export async function detectAutopilotRunning(
  autopilot: AutopilotConfigInfo | null,
  runner: CommandRunner = defaultRunner
): Promise<boolean> {
  if (!autopilot) return false
  if (!autopilot.automationId) return true
  try {
    const res = await runner(
      'orca',
      ['automations', 'show', autopilot.automationId, '--json'],
      { timeoutMs: 6_000 }
    )
    if (res.exitCode !== 0 || !res.stdout.trim()) return true
    const parsed = JSON.parse(res.stdout) as {
      enabled?: unknown
      isEnabled?: unknown
      automation?: { enabled?: unknown; isEnabled?: unknown }
      result?: {
        enabled?: unknown
        isEnabled?: unknown
        automation?: { enabled?: unknown; isEnabled?: unknown }
      }
    }
    const target = parsed.result?.automation ?? parsed.automation ?? parsed.result ?? parsed
    if (typeof target?.enabled === 'boolean') return target.enabled
    if (typeof target?.isEnabled === 'boolean') return target.isEnabled
    return true
  } catch {
    return true
  }
}

export async function loadBoardSnapshot(
  targetPath: string,
  pendingHandoffs: Map<string, PendingHandoff>,
  runner: CommandRunner = defaultRunner,
  options?: {
    dismissedAlertIds?: ReadonlySet<string>
    nowMs?: number
  }
): Promise<BoardSnapshot> {
  const now = options?.nowMs ?? Date.now()
  const syncedAt = new Date(now).toISOString()
  const gitInfo = await resolveGitRepository(targetPath, runner)
  const repoPath = gitInfo.rootPath
  const repository = gitInfo.repository
  const autopilot = findAutopilotConfigForRepo(repoPath, repository)

  const [ledgerRows, ghResult, pullRequests, agentState, installedAgents, autopilotRunning, branchSync] =
    await Promise.all([
      autopilot ? readLedgerIssues(autopilot.dbPath, runner) : Promise.resolve([]),
      fetchGithubIssuesWithStatus(repoPath, runner),
      fetchGithubPullRequests(repoPath, runner),
      collectOrcaAgentState(repoPath, runner),
      listInstalledAgents(runner),
      detectAutopilotRunning(autopilot, runner),
      inspectLocalBranchSync(repoPath, runner)
    ])
  const githubIssues = ghResult.issues

  const preferredAgent = await resolvePreferredAgent(
    autopilot?.defaultAgent ?? null,
    runner,
    installedAgents
  )

  const questionsByHandle = new Map<string, Extract<NeedsYouItem, { kind: 'agent-question' }>>()
  const allQuestions: NeedsYouItem[] = []
  const handoffAlerts: Array<Extract<NeedsYouItem, { kind: 'system-alert' }>> = []
  for (const q of agentState.questions) {
    allQuestions.push(q)
    if (q.kind === 'agent-question' && q.terminalId) {
      questionsByHandle.set(q.terminalId, q)
    }
  }

  const activeHandoffs: InProgressItem[] = []
  const handledHandoffKeys = new Set<string>()

  const pushHandoffExitAlert = (terminalId: string, entry: PendingHandoff) => {
    entry.exitedWithoutIssue = true
    entry.exitedAt = entry.exitedAt || new Date(now).toISOString()
    handoffAlerts.push({
      id: `handoff-exited-${terminalId}`,
      kind: 'system-alert',
      severity: 'error',
      badge: '提单中断',
      title: entry.title,
      reason: '提单终端已提前关闭且未检测到新 Issue，可能因 CLI 报错、网络中断或误关终端导致。',
      updatedAt: entry.exitedAt,
      canDismiss: true,
      retryTitle: entry.title
    })
  }

  const hasMatchingNewIssueByTitle = (entry: PendingHandoff): boolean => {
    const existingSet = entry.existingIssueNumbers ? new Set(entry.existingIssueNumbers) : null
    const targetTitle = entry.title.trim().toLowerCase()
    if (!targetTitle) return false
    return githubIssues.some((gh) => {
      if (existingSet && existingSet.has(gh.number)) return false
      const createdMs = Date.parse(gh.createdAt)
      if (!Number.isFinite(createdMs) || createdMs < entry.startedMs - 5_000) return false
      return gh.title.trim().toLowerCase() === targetTitle
    })
  }

  for (const [terminalId, entry] of pendingHandoffs.entries()) {
    if (entry.repoPath !== repoPath) continue
    if (entry.exitedWithoutIssue) {
      if (hasMatchingNewIssueByTitle(entry)) {
        pendingHandoffs.delete(terminalId)
        continue
      }
      pushHandoffExitAlert(terminalId, entry)
      continue
    }

    let resolved =
      agentState.agentsByKey.get(entry.terminalId) ||
      (entry.paneKey ? agentState.agentsByKey.get(entry.paneKey) : undefined) ||
      (entry.orcaSessionId ? agentState.agentsByKey.get(entry.orcaSessionId) : undefined)
    let effectiveHandle = resolved?.handle || entry.terminalId
    let termEntry = agentState.terminalByHandle.get(effectiveHandle)

    // Fallback: if launch returned an unrecognized schema and fell back to a synthetic id,
    // adopt an unclaimed live handoff agent started around the same time instead of false-alarming.
    if (!resolved && !termEntry && entry.terminalId.startsWith('handoff-')) {
      const adopted = agentState.handoffAgents.find(
        (a) =>
          a.terminalConnected &&
          a.updatedAt >= entry.startedMs - 5_000 &&
          !handledHandoffKeys.has(a.handle) &&
          !(a.paneKey && handledHandoffKeys.has(a.paneKey)) &&
          !(a.orcaSessionId && handledHandoffKeys.has(a.orcaSessionId))
      )
      if (adopted) {
        resolved = adopted
        effectiveHandle = adopted.handle || entry.terminalId
        termEntry = agentState.terminalByHandle.get(effectiveHandle)
        if (adopted.handle) entry.terminalId = adopted.handle
        if (adopted.paneKey) entry.paneKey = adopted.paneKey
        if (adopted.orcaSessionId) entry.orcaSessionId = adopted.orcaSessionId
      }
    }

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

    if (entry.sessionKind === 'local') {
      if (!state && !terminalStillOpen) {
        if (agentState.orcaReachable && now - entry.startedMs > HANDOFF_BOOT_GRACE_MS) {
          tryRemoveLocalDevLock(entry.lockPath)
          pendingHandoffs.delete(terminalId)
          continue
        }
        activeHandoffs.push({
          id: `local-${effectiveHandle}`,
          issueNumber: null,
          title: entry.title,
          url: '',
          statusLabel: `本地直改中 (${entry.agent})`,
          updatedAt: entry.startedAt
        })
        continue
      }
      if (state === 'done' || state === 'idle') {
        tryRemoveLocalDevLock(entry.lockPath)
        pendingHandoffs.delete(terminalId)
        continue
      }
      const waitingLocal = state === 'waiting' || state === 'blocked' || state === 'permission'
      activeHandoffs.push({
        id: `local-${effectiveHandle}`,
        issueNumber: null,
        title: entry.title,
        url: '',
        statusLabel: waitingLocal
          ? `本地直改等待确认 (${entry.agent})`
          : `本地直改中 (${entry.agent})`,
        updatedAt: new Date(resolved?.updatedAt || entry.startedMs).toISOString()
      })
      continue
    }

    if (!state && !terminalStillOpen) {
      if (agentState.orcaReachable && now - entry.startedMs > HANDOFF_BOOT_GRACE_MS) {
        if (hasMatchingNewIssueByTitle(entry)) {
          pendingHandoffs.delete(terminalId)
        } else {
          pushHandoffExitAlert(terminalId, entry)
        }
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
        startedMs: entry.startedMs,
        existingIssueNumbers: entry.existingIssueNumbers
      })
      if (!created && effectiveHandle && terminalStillOpen) {
        const screenText = await readTerminalText(effectiveHandle, runner)
        if (screenText) {
          output = output ? `${output}\n${screenText}` : screenText
          created = hasHandoffCreatedIssue({
            output,
            repository: autopilot?.repository || repository,
            githubIssues,
            startedMs: entry.startedMs,
            existingIssueNumbers: entry.existingIssueNumbers
          })
        }
      }
      if (created) {
        pendingHandoffs.delete(terminalId)
        continue
      }
      if (!terminalStillOpen) {
        if (hasMatchingNewIssueByTitle(entry)) {
          pendingHandoffs.delete(terminalId)
        } else {
          pushHandoffExitAlert(terminalId, entry)
        }
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

    // Track output activity to detect stalled handoff sessions
    const latestPreview = [resolved?.lastAssistantMessage, resolved?.preview, termEntry?.preview]
      .filter(Boolean)
      .join('\n')
    const reportedActivityMs = Math.max(
      entry.lastActivityMs ?? entry.startedMs,
      resolved?.updatedAt ?? 0,
      termEntry?.lastOutputAt ?? 0
    )
    if (latestPreview) {
      if (entry.lastPreview !== undefined && latestPreview !== entry.lastPreview) {
        entry.lastActivityMs = Math.max(reportedActivityMs, now)
      } else {
        entry.lastActivityMs = reportedActivityMs
      }
      entry.lastPreview = latestPreview
    } else {
      entry.lastActivityMs = reportedActivityMs
    }

    const isStalled =
      !waitingConfirmation &&
      terminalStillOpen &&
      now - (entry.lastActivityMs ?? entry.startedMs) >= HANDOFF_STALL_TIMEOUT_MS

    if (isStalled && !questionsByHandle.has(effectiveHandle)) {
      const stallMinutes = Math.floor((now - (entry.lastActivityMs ?? entry.startedMs)) / 60_000)
      const tail = latestPreview
        ? extractTerminalQuestion(latestPreview)
        : '终端长时间无新输出，可以直接回复催促或检查终端状态。'
      const questionItem: Extract<NeedsYouItem, { kind: 'agent-question' }> = {
        id: `agent-${effectiveHandle}`,
        kind: 'agent-question',
        title: entry.title,
        question: `提单任务已超过 ${stallMinutes} 分钟无新输出，可能已卡住：\n${tail}`,
        terminalId: effectiveHandle,
        workspaceId: resolved?.worktreeId || '',
        agentName: entry.agent,
        state: 'waiting',
        updatedAt: new Date(entry.lastActivityMs ?? now).toISOString()
      }
      allQuestions.push(questionItem)
      questionsByHandle.set(effectiveHandle, questionItem)
    }

    activeHandoffs.push({
      id: `handoff-${effectiveHandle}`,
      issueNumber: null,
      title: entry.title,
      url: '',
      statusLabel: waitingConfirmation
        ? `Skill 等待确认 (${entry.agent})`
        : isStalled
          ? `Skill 可能卡住 (${entry.agent})`
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
    const isStalled =
      !waitingConfirmation && now - agent.updatedAt >= HANDOFF_STALL_TIMEOUT_MS
    if (isStalled && !questionsByHandle.has(effectiveHandle)) {
      const stallMinutes = Math.floor((now - agent.updatedAt) / 60_000)
      const tail = extractTerminalQuestion(
        [agent.lastAssistantMessage, agent.preview].filter(Boolean).join('\n')
      )
      const questionItem: Extract<NeedsYouItem, { kind: 'agent-question' }> = {
        id: `agent-${effectiveHandle}`,
        kind: 'agent-question',
        title: displayTitle,
        question: `提单任务已超过 ${stallMinutes} 分钟无新输出，可能已卡住：\n${tail}`,
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
      statusLabel: waitingConfirmation
        ? `Skill 等待确认 (${agent.agent})`
        : isStalled
          ? `Skill 可能卡住 (${agent.agent})`
          : `Skill 整理提单中 (${agent.agent})`,
      updatedAt: new Date(agent.updatedAt).toISOString()
    })
  }

  // Detect Autopilot repair workers that stopped in done/idle asking plain-text questions without a receipt
  const activeRepairRows = ledgerRows.filter(
    (r) => r.status === 'running' || r.status === 'claimed' || r.attempt_status === 'running'
  )
  if (activeRepairRows.length > 0) {
    for (const agent of agentState.allAgents) {
      if (!agent.terminalConnected) continue
      if (agent.state !== 'done' && agent.state !== 'idle') continue
      if (isHandoffSessionTitle(agent.title)) continue
      if (questionsByHandle.has(agent.handle) || handledHandoffKeys.has(agent.handle)) continue

      const matchedRow = activeRepairRows.find(
        (r) =>
          (r.orca_worktree_id && agent.worktreeId && r.orca_worktree_id === agent.worktreeId) ||
          (r.worktree_path &&
            agent.worktreePath &&
            resolve(r.worktree_path) === resolve(agent.worktreePath)) ||
          agent.title.includes(`#${r.issue_number}`)
      )
      if (!matchedRow) continue

      let output = [agent.lastAssistantMessage, agent.preview].filter(Boolean).join('\n')
      if (!hasAutopilotReceipt(output) && agent.handle) {
        const screenText = await readTerminalText(agent.handle, runner)
        if (screenText) {
          output = output ? `${output}\n${screenText}` : screenText
        }
      }
      if (hasAutopilotReceipt(output)) continue

      const questionItem: Extract<NeedsYouItem, { kind: 'agent-question' }> = {
        id: `agent-${agent.handle}`,
        kind: 'agent-question',
        title: `#${matchedRow.issue_number} ${matchedRow.title}`,
        question: extractTerminalQuestion(output),
        terminalId: agent.handle,
        workspaceId: agent.worktreeId,
        agentName: agent.agent,
        state: 'waiting',
        updatedAt: new Date(agent.updatedAt).toISOString()
      }
      allQuestions.push(questionItem)
      questionsByHandle.set(agent.handle, questionItem)
    }
  }

  const healthAlerts = buildSystemHealthAlerts({
    repository: autopilot?.repository || repository,
    autopilotInstalled: Boolean(autopilot),
    autopilotLabel: autopilot?.label,
    pollIntervalSeconds: autopilot?.pollIntervalSeconds,
    maxConcurrentWorkers: autopilot?.maxConcurrentWorkers,
    githubError: ghResult.error,
    branchSync,
    ledgerRows,
    githubIssues,
    nowMs: now
  })
  const dismissed = options?.dismissedAlertIds
  const systemAlerts = [...handoffAlerts, ...healthAlerts].filter(
    (a) => !dismissed || !dismissed.has(a.id)
  )

  const merged = mergeBoardItems({
    ledgerRows,
    githubIssues,
    agentQuestions: allQuestions,
    systemAlerts,
    publication: autopilot?.publication ?? null
  })

  return {
    projectName: basename(repoPath),
    repository: autopilot?.repository || repository,
    repoPath,
    autopilotInstalled: Boolean(autopilot),
    autopilotRunning,
    workerMode: autopilot?.workerMode ?? null,
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
  existingIssueNumbers?: number[]
  pendingHandoffs: Map<string, PendingHandoff>
  runner?: CommandRunner
}): Promise<CreateIssueResult> {
  const runner = params.runner ?? defaultRunner
  const title = params.title.trim()
  if (!title) {
    throw new Error('请输入任务标题或问题描述')
  }

  const savedAttachments = params.savedAttachments ?? []

  if (params.mode === 'local') {
    const agent = await resolvePreferredAgent(params.defaultAgent, runner)
    const branchRes = await runner('git', ['-C', params.repoPath, 'branch', '--show-current'], {
      timeoutMs: 5_000
    })
    const branch = (branchRes.exitCode === 0 ? branchRes.stdout.trim() : '') || 'main'
    const commonDirRes = await runner(
      'git',
      ['-C', params.repoPath, 'rev-parse', '--git-common-dir'],
      { timeoutMs: 5_000 }
    )
    const commonDirRaw = commonDirRes.exitCode === 0 ? commonDirRes.stdout.trim() : ''
    const commonDir = commonDirRaw ? resolve(params.repoPath, commonDirRaw) : join(params.repoPath, '.git')
    const lockPath = join(commonDir, LOCAL_DEV_LOCK_FILENAME)
    const nowMs = Date.now()
    const startedAt = new Date(nowMs).toISOString()
    try {
      mkdirSync(commonDir, { recursive: true })
      writeFileSync(
        lockPath,
        JSON.stringify(
          {
            title,
            branch,
            repo_path: params.repoPath,
            agent,
            started_at: startedAt
          },
          null,
          2
        ) + '\n',
        'utf8'
      )
    } catch {
      // Best-effort lock write; coordinator still guards dirty/ahead local branch.
    }

    const prompt = buildLocalDevPrompt({
      repoPath: params.repoPath,
      branch,
      title,
      details: params.details,
      savedAttachments,
      lockPath
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
      tryRemoveLocalDevLock(lockPath)
      throw new Error(
        launchRes.stderr.trim() ||
          launchRes.stdout.trim() ||
          '无法通过 Orca 启动本地直改 Agent，请确认 Orca 正在运行'
      )
    }

    const parsedLaunch = parseAgentLaunchResult(launchRes.stdout)
    const terminalId = parsedLaunch.terminalId || `local-${Date.now()}`
    params.pendingHandoffs.set(terminalId, {
      terminalId,
      paneKey: parsedLaunch.paneKey,
      orcaSessionId: parsedLaunch.orcaSessionId,
      repoPath: params.repoPath,
      title,
      agent,
      startedAt,
      startedMs: nowMs,
      sessionKind: 'local',
      lockPath,
      lastActivityMs: nowMs
    })

    return {
      ok: true,
      mode: 'local',
      issueNumber: null,
      url: '',
      title,
      savedAttachments,
      terminalId,
      agent
    }
  }

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

  const parsedLaunch = parseAgentLaunchResult(launchRes.stdout)
  const terminalId = parsedLaunch.terminalId || `handoff-${Date.now()}`
  const paneKey = parsedLaunch.paneKey
  const orcaSessionId = parsedLaunch.orcaSessionId

  const nowMs = Date.now()
  params.pendingHandoffs.set(terminalId, {
    terminalId,
    paneKey,
    orcaSessionId,
    repoPath: params.repoPath,
    title,
    agent,
    startedAt: new Date(nowMs).toISOString(),
    startedMs: nowMs,
    existingIssueNumbers: params.existingIssueNumbers,
    lastActivityMs: nowMs
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
  workerMode?: WorkerMode | null
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
    workerMode: params.workerMode,
    existing
  })
  const res = await runner('python3', args, { timeoutMs: 45_000 })
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || '保存 Agent 配置失败')
  }
  return `已更新执行 Agent 为 ${params.defaultAgent.trim()}（允许：${normalizedAllowed.join(', ')}）`
}

export async function stopAutopilot(params: {
  repoPath: string
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
  const res = await runner(
    'python3',
    [adminScript, 'stop', '--repo-path', params.repoPath],
    { timeoutMs: 30_000 }
  )
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || '暂停自动处理循环失败')
  }
  return '已暂停自动处理循环（保留状态，可随时重新开启）'
}

export async function syncDivergedBranchFromTui(params: {
  repoPath: string
  syncBranch: BranchSyncStatus
  defaultAgent: string | null
  runner?: CommandRunner
}): Promise<{ mode: 'auto-rebase' | 'agent-launched'; message: string }> {
  const runner = params.runner ?? defaultRunner
  const { branch, hasConflict, dirty } = params.syncBranch
  const remoteRef = `origin/${branch}`

  if (!hasConflict && !dirty) {
    const fetchRes = await runner('git', ['-C', params.repoPath, 'fetch', 'origin'], {
      timeoutMs: 15_000
    })
    if (fetchRes.exitCode === 0) {
      const rebaseRes = await runner('git', ['-C', params.repoPath, 'rebase', remoteRef], {
        timeoutMs: 20_000
      })
      if (rebaseRes.exitCode === 0) {
        return {
          mode: 'auto-rebase',
          message: `已自动将本地 ${branch} 变基同步到 ${remoteRef}`
        }
      }
      await runner('git', ['-C', params.repoPath, 'rebase', '--abort'], { timeoutMs: 5_000 })
    }
  }

  const agent = await resolvePreferredAgent(params.defaultAgent, runner)
  const prompt = [
    `当前仓库（${params.repoPath}）的本地分支 \`${branch}\` 与远端 \`${remoteRef}\` 分叉（本地领先 ${params.syncBranch.ahead} 个提交、落后 ${params.syncBranch.behind} 个提交）。`,
    '请帮用户全自动安全同步，不要丢弃用户的任何未提交改动或本地提交：',
    '1. 先检查 `git status` 与 `git log --left-right --oneline HEAD...origin/' + branch + '`。',
    '2. 若有未提交改动先妥善保存（如 `git stash push -u`），再执行 `git fetch origin` 与 `git rebase origin/' + branch + '`（若不适合 rebase 可改用 `git merge origin/' + branch + '`）。',
    '3. 逐一解决所有冲突，同时保留本地与远端的有效改动。',
    '4. 冲突解完后恢复之前的暂存改动（如有），并运行仓库测试验证通过。',
    '5. 若工作区干净且测试全部通过，把同步后的 `' + branch + '` 推送到 `origin`，让后续自动同步恢复正常；若遇到需要人工拍板的语义冲突，向用户简明说明。'
  ].join('\n')

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
        '无法启动 Agent 自动解冲突，请确认 Orca 正在运行'
    )
  }

  return {
    mode: 'agent-launched',
    message: `已启动 ${agent} 自动合并 ${branch} 并解决冲突`
  }
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

function normalizePathCandidate(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s)
    } catch {
      return null
    }
  }
  if (s === '~') {
    s = homedir()
  } else if (s.startsWith('~/')) {
    s = join(homedir(), s.slice(2))
  }
  return s || null
}

function isExistingRegularFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}

function tokenizeShellPaths(input: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let hasToken = false

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next
          i += 1
        } else {
          current += ch
        }
      } else {
        current += ch
      }
      continue
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasToken = true
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 1
      hasToken = true
      continue
    }
    current += ch
    hasToken = true
  }

  if (quote !== null) return null
  if (hasToken) tokens.push(current)
  return tokens
}

function parseSingleFilePath(candidate: string): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return null
  const unquoted =
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
      ? trimmed.slice(1, -1)
      : trimmed.replace(/\\(.)/g, '$1')
  const normalized = normalizePathCandidate(unquoted)
  if (normalized && isExistingRegularFile(normalized)) {
    return normalized
  }
  return null
}

export function parseLocalFilePaths(rawInput: string): string[] {
  const trimmed = rawInput.trim()
  if (!trimmed) return []

  // 1. Try treating the whole input as a single path (supports unquoted paths with literal spaces)
  const single = parseSingleFilePath(trimmed)
  if (single) {
    return [single]
  }

  // 2. Try newline-separated paths (e.g. Finder "Copy as Pathname" for multiple files with literal spaces)
  if (/[\r\n]/.test(trimmed)) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length > 1) {
      const linePaths: string[] = []
      let allValid = true
      for (const line of lines) {
        const parsed = parseSingleFilePath(line)
        if (!parsed) {
          allValid = false
          break
        }
        linePaths.push(parsed)
      }
      if (allValid) return linePaths
    }
  }

  // 3. Otherwise split into shell-quoted / escaped / whitespace-separated tokens and require every token to be a real file
  const tokens = tokenizeShellPaths(trimmed)
  if (!tokens || tokens.length === 0) return []

  const resolvedPaths: string[] = []
  for (const token of tokens) {
    const normalized = normalizePathCandidate(token)
    if (!normalized || !isExistingRegularFile(normalized)) {
      return []
    }
    resolvedPaths.push(normalized)
  }
  return resolvedPaths
}

function copyFilesToAttachmentDir(
  repoPath: string,
  filePaths: readonly string[],
  stateRoot = getAutopilotStateRoot()
): SavedAttachment[] {
  if (filePaths.length === 0) return []
  for (const filePath of filePaths) {
    const st = statSync(filePath)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`文件 ${basename(filePath)} 超过 10MB 限制`)
    }
  }
  const repoSlug = basename(resolve(repoPath)).replace(/[^\w.-]+/g, '_') || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetDir = join(stateRoot, 'attachments', repoSlug, stamp)
  mkdirSync(targetDir, { recursive: true })

  const usedNames = new Set<string>()
  const saved: SavedAttachment[] = []
  for (const filePath of filePaths) {
    const origName = basename(filePath)
    const ext = extname(origName)
    const stem = ext ? origName.slice(0, -ext.length) : origName
    let destName = origName
    let seq = 2
    while (usedNames.has(destName.toLowerCase()) || existsSync(join(targetDir, destName))) {
      destName = `${stem}-${seq}${ext}`
      seq += 1
    }
    usedNames.add(destName.toLowerCase())
    const dest = join(targetDir, destName)
    copyFileSync(filePath, dest)
    const st = statSync(dest)
    saved.push({
      name: origName,
      mimeType: guessMimeType(dest),
      size: st.size,
      path: dest
    })
  }
}

export function attachLocalFilePaths(
  repoPath: string,
  rawInput: string,
  stateRoot = getAutopilotStateRoot()
): SavedAttachment[] {
  const filePaths = parseLocalFilePaths(rawInput)
  if (filePaths.length === 0) return []
  return copyFilesToAttachmentDir(repoPath, filePaths, stateRoot)
}

export function attachLocalFilePath(
  repoPath: string,
  rawPath: string,
  stateRoot = getAutopilotStateRoot()
): SavedAttachment | null {
  const saved = attachLocalFilePaths(repoPath, rawPath, stateRoot)
  return saved[0] ?? null
}

export async function captureClipboardAttachments(
  repoPath: string,
  stateRoot = getAutopilotStateRoot(),
  runner: CommandRunner = defaultRunner
): Promise<SavedAttachment[]> {
  if (process.platform !== 'darwin') return []
  const repoSlug = basename(resolve(repoPath)).replace(/[^\w.-]+/g, '_') || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetDir = join(stateRoot, 'attachments', repoSlug, stamp)
  mkdirSync(targetDir, { recursive: true })
  const outPath = join(targetDir, `clipboard-${Date.now()}.png`)

  // Use macOS JXA + AppKit NSPasteboard to inspect copied Finder files, images (PNG/TIFF/JPEG),
  // or local file path text in priority order without external dependencies.
  const jxaScript = `
    ObjC.import("AppKit");
    function run() {
      const pb = $.NSPasteboard.generalPasteboard;
      const paths = [];
      try {
        const fileList = pb.propertyListForType("NSFilenamesPboardType");
        if (fileList && !fileList.isNil()) {
          const arr = ObjC.unwrap(fileList);
          if (Array.isArray(arr)) {
            for (const item of arr) {
              const p = ObjC.unwrap(item);
              if (typeof p === "string" && p.length > 0) paths.push(p);
            }
          }
        }
      } catch (e) {}
      if (paths.length === 0) {
        try {
          const urlStr = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeFileURL));
          if (typeof urlStr === "string" && urlStr.length > 0) {
            const nsUrl = $.NSURL.URLWithString($(urlStr));
            const p = nsUrl && !nsUrl.isNil() ? ObjC.unwrap(nsUrl.path) : "";
            if (typeof p === "string" && p.length > 0) paths.push(p);
          }
        } catch (e) {}
      }
      if (paths.length > 0) {
        return JSON.stringify({ kind: "files", paths });
      }
      try {
        const img = $.NSImage.alloc.initWithPasteboard(pb);
        if (img && !img.isNil()) {
          const tiff = img.TIFFRepresentation;
          if (tiff && !tiff.isNil()) {
            const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
            if (rep && !rep.isNil()) {
              const pngType = typeof $.NSBitmapImageFileTypePNG === "number" ? $.NSBitmapImageFileTypePNG : 4;
              const png = rep.representationUsingTypeProperties(pngType, $({}));
              if (png && !png.isNil() && png.writeToFileAtomically($(${JSON.stringify(outPath)}), true)) {
                return JSON.stringify({ kind: "image", path: ${JSON.stringify(outPath)} });
              }
            }
          }
        }
      } catch (e) {}
      try {
        const text = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
        if (typeof text === "string" && text.trim().length > 0) {
          return JSON.stringify({ kind: "text", text });
        }
      } catch (e) {}
      return JSON.stringify({ kind: "empty" });
    }
  `

  const res = await runner('osascript', ['-l', 'JavaScript', '-e', jxaScript], { timeoutMs: 5_000 })
  if (res.exitCode !== 0) return []

  const stdout = res.stdout.trim()
  if (!stdout) return []

  try {
    const parsed = JSON.parse(stdout) as {
      kind?: string
      paths?: unknown
      path?: unknown
      text?: unknown
    }
    if (parsed.kind === 'files' && Array.isArray(parsed.paths)) {
      const validFiles = parsed.paths
        .filter((p): p is string => typeof p === 'string' && isExistingRegularFile(p))
      return copyFilesToAttachmentDir(repoPath, validFiles, stateRoot)
    }
    if (parsed.kind === 'image' && typeof parsed.path === 'string' && existsSync(parsed.path)) {
      const st = statSync(parsed.path)
      if (st.size === 0) return []
      return [
        {
          name: basename(parsed.path),
          mimeType: 'image/png',
          size: st.size,
          path: parsed.path
        }
      ]
    }
    if (parsed.kind === 'text' && typeof parsed.text === 'string') {
      return attachLocalFilePaths(repoPath, parsed.text, stateRoot)
    }
  } catch {
    // Fallback for legacy/mocked runners returning plain "ok"
    if (stdout === 'ok' && existsSync(outPath)) {
      const st = statSync(outPath)
      if (st.size > 0) {
        return [
          {
            name: basename(outPath),
            mimeType: 'image/png',
            size: st.size,
            path: outPath
          }
        ]
      }
    }
  }
}

export function sanitizeTerminalTitle(raw: string): string {
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const DEFAULT_TERMINAL_TITLE = 'Autopilot'

export function formatDefaultTerminalTitle(_projectName?: string): string {
  return DEFAULT_TERMINAL_TITLE
}

export function formatOscTitleSequence(title: string): string {
  const clean = sanitizeTerminalTitle(title)
  return `\x1b]0;${clean}\x07`
}

export async function setOrcaTerminalTitle(
  title: string,
  options?: {
    terminalHandle?: string
    runner?: CommandRunner
  }
): Promise<boolean> {
  const handle = (options?.terminalHandle ?? process.env.ORCA_TERMINAL_HANDLE ?? '').trim()
  if (!handle) return false
  const runner = options?.runner ?? defaultRunner
  const clean = sanitizeTerminalTitle(title)
  const args = ['terminal', 'rename', '--terminal', handle]
  if (clean) {
    args.push('--title', clean)
  }
  args.push('--json')
  try {
    const res = await runner('orca', args, { timeoutMs: 4_000 })
    return res.exitCode === 0
  } catch {
    return false
  }
}
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    case '.heic':
      return 'image/heic'
    case '.tif':
    case '.tiff':
      return 'image/tiff'
    case '.json':
      return 'application/json'
    case '.txt':
    case '.md':
    case '.log':
      return 'text/plain'
  return saved
  return []
}

export async function captureClipboardImage(
  repoPath: string,
  stateRoot = getAutopilotStateRoot(),
  runner: CommandRunner = defaultRunner
): Promise<SavedAttachment | null> {
  const saved = await captureClipboardAttachments(repoPath, stateRoot, runner)
  return saved[0] ?? null
