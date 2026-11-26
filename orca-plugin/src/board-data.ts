import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  AttachmentPayload,
  BoardSnapshot,
  BranchSyncStatus,
  CompletedItem,
  CreateIssueInput,
  CreateIssueResult,
  InProgressItem,
  InstalledAgent,
  IssueKind,
  NeedsYouItem,
  PullRequestCheckState,
  PullRequestItem,
  SavedAttachment
} from './protocol'

const execFileAsync = promisify(execFile)

export const BOARD_FILENAME = '.orca-board.issue-board'

export type CommandRunner = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export const defaultRunner: CommandRunner = async (cmd, args, options = {}) => {
  try {
    const env = { ...process.env }
    if (basename(cmd) === 'gh') {
      env.GODEBUG = env.GODEBUG || 'http2client=0'
    }
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env
    })
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : e.message || String(err),
      exitCode: typeof e.code === 'number' ? e.code : 1
    }
  }
}

export type AutopilotConfigInfo = {
  configPath: string
  dbPath: string
  repository: string
  repoPath: string
  runtimeAdminPath: string
  defaultAgent: string | null
  allowedAgents: string[]
  label: string | null
  maxConcurrentWorkers: number | null
  maxAttempts: number | null
  pollIntervalSeconds: number | null
  workerTimeoutSeconds: number | null
  heartbeatTimeoutSeconds: number | null
  publication: 'auto-merge' | 'pr-only' | 'never' | null
  mergeMethod: 'squash' | 'merge' | 'rebase' | null
  preMergeCommands: string[]
  requireCi: boolean | null
  automationId?: string | null
}

export type HandoffSkillPaths = {
  skillMdPath: string
  templatesPath: string | null
}

export type LedgerIssueRow = {
  node_id: string
  repository: string
  issue_number: number
  url: string
  title: string
  created_at: string
  issue_updated_at: string
  status: string
  attempts: number
  summary: string | null
  pr_url: string | null
  merged_at: string | null
  attempt_status: string | null
  attempt_summary: string | null
  orca_worktree_id?: string | null
  worktree_path?: string | null
  orca_dispatch_id?: string | null
}

export type GithubIssueRow = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  url: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  labels: Array<{ name: string }>
  body?: string
}

export function getAutopilotStateRoot(): string {
  const override = process.env.GITHUB_ISSUE_AUTOPILOT_STATE_ROOT
  if (override && override.trim()) return resolve(override)
  return join(homedir(), '.local', 'state', 'github-issue-autopilot')
}

export function findAutopilotConfigForRepo(
  repoPath: string | null,
  repository: string | null,
  stateRoot = getAutopilotStateRoot()
): AutopilotConfigInfo | null {
  if (!existsSync(stateRoot)) return null
  const normalizedRepoPath = repoPath ? resolve(repoPath) : null
  let entries: string[] = []
  try {
    entries = readdirSync(stateRoot)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name === 'archives') continue
    const dir = join(stateRoot, name)
    const configPath = join(dir, 'autopilot.json')
    if (!existsSync(configPath)) continue
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        state_db?: string
        max_concurrent_workers?: number
        max_attempts?: number
        poll_interval_seconds?: number
        worker_timeout_seconds?: number
        heartbeat_timeout_seconds?: number
        policy?: {
          publication?: string
          merge_method?: string
          pre_merge_commands?: string[]
          require_ci?: boolean
        }
        orca?: { default_agent?: string; allowed_agents?: string[] }
        scheduler?: { backend?: string; automation_id?: string }
        repositories?: Array<{ repository?: string; repo_path?: string; labels?: string[] }>
      }
      const entry = raw.repositories?.[0]
      if (!entry) continue
      const entryRepoPath = entry.repo_path ? resolve(entry.repo_path) : null
      const matchPath = normalizedRepoPath && entryRepoPath && normalizedRepoPath === entryRepoPath
      const matchRepo =
        repository &&
        entry.repository &&
        repository.toLowerCase() === entry.repository.toLowerCase()
      if (matchPath || matchRepo) {
        const dbRel = raw.state_db || 'state.sqlite3'
        const dbPath = resolve(dir, dbRel)
        const defaultAgent = raw.orca?.default_agent?.trim() || null
        const allowedAgents = Array.isArray(raw.orca?.allowed_agents)
          ? raw.orca.allowed_agents.map((a) => String(a).trim()).filter(Boolean)
          : defaultAgent
            ? [defaultAgent]
            : []
        const publication =
          raw.policy?.publication === 'auto-merge' ||
          raw.policy?.publication === 'pr-only' ||
          raw.policy?.publication === 'never'
            ? raw.policy.publication
            : null
        const mergeMethod =
          raw.policy?.merge_method === 'squash' ||
          raw.policy?.merge_method === 'merge' ||
          raw.policy?.merge_method === 'rebase'
            ? raw.policy.merge_method
            : null
        return {
          configPath,
          dbPath,
          repository: entry.repository || repository || '',
          repoPath: entryRepoPath || normalizedRepoPath || '',
          runtimeAdminPath: join(dir, 'runtime', 'autopilot_admin.py'),
          defaultAgent,
          allowedAgents,
          label: entry.labels?.[0]?.trim() || null,
          maxConcurrentWorkers:
            typeof raw.max_concurrent_workers === 'number' ? raw.max_concurrent_workers : null,
          maxAttempts: typeof raw.max_attempts === 'number' ? raw.max_attempts : null,
          pollIntervalSeconds:
            typeof raw.poll_interval_seconds === 'number' ? raw.poll_interval_seconds : null,
          workerTimeoutSeconds:
            typeof raw.worker_timeout_seconds === 'number' ? raw.worker_timeout_seconds : null,
          heartbeatTimeoutSeconds:
            typeof raw.heartbeat_timeout_seconds === 'number'
              ? raw.heartbeat_timeout_seconds
              : null,
          publication,
          mergeMethod,
          preMergeCommands: Array.isArray(raw.policy?.pre_merge_commands)
            ? raw.policy.pre_merge_commands.map((c) => String(c)).filter(Boolean)
            : [],
          requireCi: typeof raw.policy?.require_ci === 'boolean' ? raw.policy.require_ci : null,
          automationId: raw.scheduler?.automation_id?.trim() || null
        }
      }
    } catch {
      continue
    }
  }
  return null
}

export function findBundledAutopilotAdmin(pluginDir: string): string | null {
  const candidates = [
    resolve(pluginDir, '..', 'github-issue-autopilot', 'scripts', 'autopilot_admin.py'),
    join(homedir(), '.claude', 'skills', 'github-issue-autopilot', 'scripts', 'autopilot_admin.py'),
    join(homedir(), '.agents', 'skills', 'github-issue-autopilot', 'scripts', 'autopilot_admin.py')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function isAutopilotRuntimeOutdated(
  bundledAdminPath: string,
  runtimeAdminPath: string
): boolean {
  const bundledWatcherPath = join(dirname(bundledAdminPath), 'issue_watcher.py')
  const runtimeWatcherPath = join(dirname(runtimeAdminPath), 'issue_watcher.py')
  if (!existsSync(bundledAdminPath) || !existsSync(bundledWatcherPath)) return false
  if (!existsSync(runtimeAdminPath) || !existsSync(runtimeWatcherPath)) return true
  try {
    const adminSame = readFileSync(bundledAdminPath).equals(readFileSync(runtimeAdminPath))
    const watcherSame = readFileSync(bundledWatcherPath).equals(readFileSync(runtimeWatcherPath))
    return !adminSame || !watcherSame
  } catch {
    return true
  }
}

export function findBundledHandoffSkill(pluginDir: string): HandoffSkillPaths | null {
  const candidates = [
    resolve(pluginDir, '..', 'github-issue-handoff', 'SKILL.md'),
    join(homedir(), '.claude', 'skills', 'github-issue-handoff', 'SKILL.md'),
    join(homedir(), '.codex', 'skills', 'github-issue-handoff', 'SKILL.md'),
    join(homedir(), '.agents', 'skills', 'github-issue-handoff', 'SKILL.md'),
    join(homedir(), '.gemini', 'antigravity-cli', 'skills', 'github-issue-handoff', 'SKILL.md')
  ]
  for (const skillMdPath of candidates) {
    if (existsSync(skillMdPath)) {
      const templatesCandidate = join(dirname(skillMdPath), 'references', 'issue-templates.md')
      return {
        skillMdPath,
        templatesPath: existsSync(templatesCandidate) ? templatesCandidate : null
      }
    }
  }
  return null
}

export async function listInstalledAgents(
  runner: CommandRunner = defaultRunner
): Promise<InstalledAgent[]> {
  const res = await runner('orca', ['agent', 'installed', '--json'], { timeoutMs: 8_000 })
  if (res.exitCode !== 0 || !res.stdout.trim()) return []
  try {
    const parsed = JSON.parse(res.stdout) as {
      result?: { agents?: Array<{ id?: string; name?: string; default?: boolean }> }
      agents?: Array<{ id?: string; name?: string; default?: boolean }>
    }
    const list = parsed.result?.agents || parsed.agents || []
    const seen = new Set<string>()
    const out: InstalledAgent[] = []
    for (const item of list) {
      const id = item.id?.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: item.name?.trim() || id,
        isDefault: Boolean(item.default)
      })
    }
    return out
  } catch {
    return []
  }
}

export async function resolvePreferredAgent(
  autopilotDefaultAgent: string | null,
  runner: CommandRunner = defaultRunner,
  installedAgents?: InstalledAgent[]
): Promise<string> {
  if (autopilotDefaultAgent && autopilotDefaultAgent.trim()) {
    return autopilotDefaultAgent.trim()
  }
  const list = installedAgents ?? (await listInstalledAgents(runner))
  const def = list.find((a) => a.isDefault)
  if (def?.id) return def.id
  if (list[0]?.id) return list[0].id
  return 'codex'
}

export function buildAutopilotInstallArgs(params: {
  adminScript: string
  repoPath: string
  defaultAgent: string
  allowedAgents?: string[]
  existing?: AutopilotConfigInfo | null
}): string[] {
  const defaultAgent = params.defaultAgent.trim()
  if (!defaultAgent) {
    throw new Error('请选择一个有效的执行 Agent')
  }
  const existing = params.existing ?? null
  const args = [params.adminScript, 'install', '--repo-path', params.repoPath, '--agent', defaultAgent]

  const extraAllowed = Array.from(
    new Set((params.allowedAgents ?? []).map((a) => a.trim()).filter((a) => a && a !== defaultAgent))
  )
  for (const agentId of extraAllowed) {
    args.push('--allow-agent', agentId)
  }

  if (existing) {
    if (existing.label) args.push('--label', existing.label)
    if (existing.maxConcurrentWorkers !== null) {
      args.push('--max-concurrent', String(existing.maxConcurrentWorkers))
    }
    if (existing.maxAttempts !== null) {
      args.push('--max-attempts', String(existing.maxAttempts))
    }
    if (existing.workerTimeoutSeconds !== null) {
      args.push('--worker-timeout', String(existing.workerTimeoutSeconds))
    }
    if (existing.heartbeatTimeoutSeconds !== null) {
      args.push('--heartbeat-timeout', String(existing.heartbeatTimeoutSeconds))
    }
    if (existing.publication) {
      args.push('--publication', existing.publication)
    }
    if (existing.mergeMethod) {
      args.push('--merge-method', existing.mergeMethod)
    }
    for (const cmd of existing.preMergeCommands) {
      args.push('--pre-merge-command', cmd)
    }
    if (existing.requireCi === false) {
      args.push('--no-require-ci')
    }
  }

  return args
}

export function buildHandoffPrompt(params: {
  repoPath: string
  repository: string | null
  kind: IssueKind
  title: string
  details?: string
  followUpOf?: number | null
  savedAttachments?: SavedAttachment[]
  autopilotInstalled?: boolean
  skillPaths?: HandoffSkillPaths | null
}): string {
  const repoUrl = params.repository ? `https://github.com/${params.repository}` : params.repoPath
  const kindHint =
    params.kind === 'bug'
      ? 'Bug（问题修复）'
      : params.kind === 'polish'
        ? 'Feature 或 Refactor（体验优化，请结合仓库代码选择最合适的模板分类）'
        : 'Feature（新功能）'

  const lines: string[] = [
    `请严格按照 \`github-issue-handoff\` Skill 为目标仓库创建一条高质量、Agent 可直接执行的中文 GitHub Issue。`,
    `用户已在 Orca Issue 看板中明确点击提交，本请求已授权直接创建符合门禁的单条 Issue（无需额外预览确认；仅当关键信息缺失无法通过门禁、检测到高置信度重复 Issue、或需要拆分为多条独立任务时，再在当前终端向用户提问确认）。`
  ]

  if (params.skillPaths) {
    lines.push(
      '',
      `## Skill 规范文件（请先完整阅读并严格遵守）`,
      `- Skill 主文档：\`${params.skillPaths.skillMdPath}\``
    )
    if (params.skillPaths.templatesPath) {
      lines.push(`- 模板文件：\`${params.skillPaths.templatesPath}\``)
    }
  } else {
    lines.push('', `请加载并使用 \`$github-issue-handoff\` Skill 及其模板规范。`)
  }

  lines.push(
    '',
    `## 目标仓库`,
    `- GitHub 仓库：${repoUrl}`,
    `- 本地路径：\`${params.repoPath}\``,
    '',
    `## 用户提交的原始需求`,
    `- 倾向类型：${kindHint}`,
    `- 简述/标题：${params.title.trim()}`
  )

  if (params.details && params.details.trim()) {
    lines.push(`- 补充说明：`, params.details.trim())
  }
  if (params.followUpOf && Number.isInteger(params.followUpOf) && params.followUpOf > 0) {
    lines.push(`- 关联历史 Issue：针对 #${params.followUpOf} 的后续调整或补充验收意见`)
  }

  const attachments = params.savedAttachments || []
  if (attachments.length > 0) {
    lines.push(
      '',
      `## 本地附件（请先查看以补充上下文，并将路径写入 Issue 的「参考信息」中供后续修复 Agent 读取）`
    )
    for (const att of attachments) {
      const tag = att.mimeType.startsWith('image/') ? '截图' : '文件'
      lines.push(`- [${tag}] \`${att.path}\` (${att.name}, ${formatBytes(att.size)})`)
    }
  }

  lines.push(
    '',
    `## 执行要求`,
    `1. 检查 \`gh auth status\` 与仓库元信息，阅读相关代码、配置与测试，基于已验证事实补全「仓库上下文」「任务范围」「不在范围内」「验收标准」「验证方式」。`,
    `2. 检索 open 与 closed Issue 避免重复；如发现高置信度重复或安全漏洞，按 Skill 规则停止并说明。`,
    `3. 使用中文标题并带标准前缀（\`[Feature]\` / \`[Bug]\` / \`[Refactor]\` / \`[Research]\`），严格套用对应模板并通过可执行性门禁。`,
    params.autopilotInstalled
      ? `4. 当前仓库已启用 Autopilot：请务必附带 \`agent-ready\` 标签（如标签缺失可先创建），并通过 stdin 或临时文件调用 \`gh issue create\` 提交。`
      : `4. 按 Skill 规则检查本地 \`.git/github-issue-autopilot.json\` 决定是否附带 \`agent-ready\` 标签，并通过 stdin 或临时文件调用 \`gh issue create\` 提交。`,
    `5. 提交后必须用 \`gh issue view\` 回读验证仓库、标题、正文与标签完整，最后输出最终标题与可点击 Issue URL。`
  )

  return lines.join('\n')
}

export async function readLedgerIssues(
  dbPath: string,
  runner: CommandRunner = defaultRunner
): Promise<LedgerIssueRow[]> {
  if (!existsSync(dbPath)) return []
  const query = `
    SELECT
      i.node_id,
      i.repository,
      i.issue_number,
      i.url,
      i.title,
      i.created_at,
      i.issue_updated_at,
      i.status,
      i.attempts,
      i.summary,
      a.pr_url,
      a.merged_at,
      a.status AS attempt_status,
      a.summary AS attempt_summary,
      a.orca_worktree_id,
      a.worktree_path,
      a.orca_dispatch_id
    FROM issues i
    LEFT JOIN attempts a
      ON a.node_id = i.node_id
     AND a.attempt_number = (
       SELECT MAX(a2.attempt_number) FROM attempts a2 WHERE a2.node_id = i.node_id
     )
    ORDER BY i.issue_updated_at DESC
    LIMIT 60;
  `
  const res = await runner('sqlite3', ['-readonly', '-json', dbPath, query])
  if (res.exitCode !== 0 || !res.stdout.trim()) return []
  try {
    const parsed = JSON.parse(res.stdout)
    return Array.isArray(parsed) ? (parsed as LedgerIssueRow[]) : []
  } catch {
    return []
  }
}

export async function resolveGitRepository(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<{ rootPath: string; repository: string | null }> {
  let rootPath = repoPath
  const top = await runner('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'])
  if (top.exitCode === 0 && top.stdout.trim()) {
    rootPath = resolve(top.stdout.trim())
  }
  const remote = await runner('git', ['-C', rootPath, 'remote', 'get-url', 'origin'])
  if (remote.exitCode === 0 && remote.stdout.trim()) {
    const parsed = parseGithubRepoFromRemote(remote.stdout.trim())
    if (parsed) return { rootPath, repository: parsed }
  }
  const gh = await runner('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: rootPath
  })
  if (gh.exitCode === 0 && gh.stdout.trim()) {
    return { rootPath, repository: gh.stdout.trim() }
  }
  return { rootPath, repository: null }
}

export function parseGithubRepoFromRemote(url: string): string | null {
  const sshMatch = url.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]
  return null
}

export async function fetchGithubIssuesWithStatus(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<{ issues: GithubIssueRow[]; error: string | null }> {
  const res = await runner(
    'gh',
    [
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '40',
      '--json',
      'number,title,state,url,createdAt,updatedAt,closedAt,labels'
    ],
    { cwd: repoPath, timeoutMs: 15_000 }
  )
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || '').trim()
    return {
      issues: [],
      error: detail || `gh issue list 执行失败 (exit ${res.exitCode})`
    }
  }
  if (!res.stdout.trim()) return { issues: [], error: null }
  try {
    const parsed = JSON.parse(res.stdout)
    return {
      issues: Array.isArray(parsed) ? (parsed as GithubIssueRow[]) : [],
      error: null
    }
  } catch {
    return { issues: [], error: '无法解析 gh issue list 输出' }
  }
}

export async function fetchGithubIssues(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<GithubIssueRow[]> {
  const { issues } = await fetchGithubIssuesWithStatus(repoPath, runner)
  return issues
}

export type GithubPullRequestRow = {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft?: boolean
  url: string
  headRefName?: string
  baseRefName?: string
  author?: { login?: string } | null
  mergeable?: string | null
  reviewDecision?: string | null
  statusCheckRollup?: Array<{
    status?: string
    conclusion?: string
    state?: string
  }> | null
  updatedAt: string
  mergedAt?: string | null
}

export function summarizePrChecks(
  rollup: GithubPullRequestRow['statusCheckRollup']
): PullRequestCheckState {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  const failureStates = new Set([
    'FAILURE',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
    'ERROR',
    'CANCELLED'
  ])
  const passingStates = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL'])
  let hasPending = false
  let hasAny = false

  for (const check of rollup) {
    if (!check || typeof check !== 'object') continue
    hasAny = true
    const conclusion = (check.conclusion || '').toUpperCase()
    const status = (check.status || '').toUpperCase()
    const state = (check.state || '').toUpperCase()
    const value = conclusion || state || status
    if (failureStates.has(value)) return 'failing'
    if (
      status === 'QUEUED' ||
      status === 'IN_PROGRESS' ||
      status === 'PENDING' ||
      status === 'WAITING' ||
      state === 'PENDING' ||
      state === 'EXPECTED' ||
      !passingStates.has(value)
    ) {
      hasPending = true
    }
  }
  if (!hasAny) return 'none'
  return hasPending ? 'pending' : 'passing'
}

export function normalizePullRequests(rows: GithubPullRequestRow[]): PullRequestItem[] {
  const items: PullRequestItem[] = rows.map((row) => ({
    number: row.number,
    title: row.title,
    state: row.state,
    isDraft: Boolean(row.isDraft),
    url: row.url,
    headRefName: row.headRefName || '',
    baseRefName: row.baseRefName || '',
    author: row.author?.login || null,
    mergeable: row.mergeable || null,
    reviewDecision: row.reviewDecision || null,
    ciStatus: summarizePrChecks(row.statusCheckRollup),
    updatedAt: row.updatedAt,
    mergedAt: row.mergedAt || null
  }))

  return items.sort((a, b) => {
    const aOpen = a.state === 'OPEN' ? 0 : 1
    const bOpen = b.state === 'OPEN' ? 0 : 1
    if (aOpen !== bOpen) return aOpen - bOpen
    const aTime = Date.parse(a.mergedAt || a.updatedAt) || 0
    const bTime = Date.parse(b.mergedAt || b.updatedAt) || 0
    return bTime - aTime
  })
}

export async function fetchGithubPullRequests(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<PullRequestItem[]> {
  const res = await runner(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '40',
      '--json',
      'number,title,state,isDraft,url,headRefName,baseRefName,author,mergeable,reviewDecision,statusCheckRollup,updatedAt,mergedAt'
    ],
    { cwd: repoPath, timeoutMs: 15_000 }
  )
  if (res.exitCode !== 0 || !res.stdout.trim()) return []
  try {
    const parsed = JSON.parse(res.stdout)
    return Array.isArray(parsed) ? normalizePullRequests(parsed as GithubPullRequestRow[]) : []
  } catch {
    return []
  }
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENTS_PER_REQUEST = 8

export function sanitizeAttachmentFilename(name: string, mimeType: string, index: number): string {
  const trimmed = (name || '').trim()
  const base = basename(trimmed).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').replace(/^_+|_+$/g, '')
  if (base && base !== '.' && base !== '..') {
    return base.slice(0, 80)
  }
  const ext =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'image/webp'
          ? '.webp'
          : mimeType === 'image/gif'
            ? '.gif'
            : mimeType === 'application/pdf'
              ? '.pdf'
              : '.bin'
  return `attachment-${index + 1}${ext}`
}

export function saveAttachmentsLocally(
  repoPath: string,
  attachments: AttachmentPayload[] | undefined,
  stateRoot = getAutopilotStateRoot()
): SavedAttachment[] {
  if (!attachments || attachments.length === 0) return []
  if (attachments.length > MAX_ATTACHMENTS_PER_REQUEST) {
    throw new Error(`单次最多附加 ${MAX_ATTACHMENTS_PER_REQUEST} 个文件`)
  }
  const repoSlug = basename(resolve(repoPath)).replace(/[^\w.-]+/g, '_') || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const targetDir = join(stateRoot, 'attachments', repoSlug, stamp)
  mkdirSync(targetDir, { recursive: true })

  const saved: SavedAttachment[] = []
  attachments.forEach((item, index) => {
    const cleanBase64 = (item.base64 || '').replace(/^data:[^;]+;base64,/, '')
    const buf = Buffer.from(cleanBase64, 'base64')
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件 ${item.name || index + 1} 超过 10MB 限制`)
    }
    const safeName = sanitizeAttachmentFilename(item.name, item.mimeType, index)
    const filePath = join(targetDir, `${String(index + 1).padStart(2, '0')}-${safeName}`)
    writeFileSync(filePath, buf)
    saved.push({
      name: safeName,
      mimeType: item.mimeType || 'application/octet-stream',
      size: buf.byteLength,
      path: filePath
    })
  })

  return saved
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function buildIssueBody(
  kind: IssueKind,
  title: string,
  details?: string,
  followUpOf?: number | null,
  savedAttachments: SavedAttachment[] = []
): string {
  const kindLabel = kind === 'bug' ? '问题修复 (Bug)' : kind === 'polish' ? '体验优化' : '新功能需求'
  const lines: string[] = [
    `## 任务类型`,
    kindLabel,
    '',
    `## 期望效果`,
    details && details.trim() ? details.trim() : title.trim()
  ]
  if (followUpOf && Number.isInteger(followUpOf) && followUpOf > 0) {
    lines.push('', `## 关联说明`, `针对 #${followUpOf} 的后续调整/补充验收意见。`)
  }
  if (savedAttachments.length > 0) {
    lines.push('', `## 附件（本地截图与文件）`, `本地 AI 助手可直接读取以下路径查看截图或参考文件：`)
    for (const att of savedAttachments) {
      const tag = att.mimeType.startsWith('image/') ? '截图' : '文件'
      lines.push(`- [${tag}] \`${att.path}\` (${att.name}, ${formatBytes(att.size)})`)
    }
  }
  lines.push(
    '',
    `## 验收标准`,
    `- [ ] 实现上述期望效果，且不破坏现有正常功能`,
    `- [ ] 完成后在总结中用简洁的非技术语言说明改动与验证结果`
  )
  return lines.join('\n')
}

export async function createAgentReadyIssue(
  input: CreateIssueInput,
  runner: CommandRunner = defaultRunner
): Promise<CreateIssueResult> {
  const title = input.title.trim()
  if (!title) {
    throw new Error('请输入任务标题或问题描述')
  }
  const savedAttachments = saveAttachmentsLocally(input.repoPath, input.attachments)

  // Ensure agent-ready label exists (best-effort, ignore if already present)
  await runner(
    'gh',
    ['label', 'create', 'agent-ready', '--color', '0E8A16', '--description', 'Ready for automated agent execution'],
    { cwd: input.repoPath, timeoutMs: 10_000 }
  )

  const body = buildIssueBody(input.kind, title, input.details, input.followUpOf, savedAttachments)
  const res = await runner(
    'gh',
    ['issue', 'create', '--title', title, '--body', body, '--label', 'agent-ready'],
    { cwd: input.repoPath, timeoutMs: 20_000 }
  )
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || '创建 GitHub Issue 失败，请确认 gh 已登录')
  }
  const url = res.stdout.trim().split(/\s+/).pop() || ''
  const numMatch = url.match(/\/issues\/(\d+)$/)
  return {
    ok: true,
    mode: 'direct',
    issueNumber: numMatch ? Number(numMatch[1]) : null,
    url,
    title,
    savedAttachments
  }
}

const TERMINAL_CHROME_PATTERNS: readonly RegExp[] = [
  /^[─━═\-_=│┃┌┐└┘├┤┬┴┼]+$/,
  /^>\s*$/,
  /^>\s*Auto mode:/i,
  /^\?\s*for shortcuts/i,
  /^shift\+tab\b/i,
  /^esc to interrupt\b/i,
  /^剩余\s+\d+%/,
  /^auto\s*·/i
]

export function isHandoffSessionTitle(title: string | undefined | null): boolean {
  if (!title) return false
  const normalized = title.toLowerCase()
  return (
    normalized.includes('github-issue-handoff') ||
    normalized.includes('github issue handoff')
  )
}

export function extractGithubIssueNumbers(
  text: string,
  repository?: string | null
): number[] {
  if (!text) return []
  const repoEscaped = repository
    ? repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'
  const re = new RegExp(`https://github\\.com/${repoEscaped}/issues/(\\d+)`, 'gi')
  const numbers = new Set<number>()
  for (const match of text.matchAll(re)) {
    const num = Number(match[1])
    if (Number.isInteger(num) && num > 0) {
      numbers.add(num)
    }
  }
  return Array.from(numbers)
}

export function stripTerminalAnsi(rawOutput: string): string {
  return rawOutput
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '')
}

export function hasAutopilotReceipt(rawOutput: string): boolean {
  if (!rawOutput) return false
  const clean = stripTerminalAnsi(rawOutput)
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim()
    if (/^AUTOPILOT_RESULT:\s*\{/.test(line) && !line.includes('<assigned run ID>')) {
      return true
    }
  }
  return false
}

export function looksLikeDuplicateOrConfirmationQuestion(rawOutput: string): boolean {
  if (!rawOutput) return false
  const clean = stripTerminalAnsi(rawOutput)
  const lines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !TERMINAL_CHROME_PATTERNS.some((pattern) => pattern.test(line))
    )
  const tail = lines.slice(-10).join('\n')
  if (!tail) return false
  if (
    /(?:已创建|创建成功|已提交|created\s+issue|issue\s+created|successfully\s+created)/i.test(tail)
  ) {
    return false
  }
  const hasQuestion = /[?？]/.test(tail)
  const hasConfirmCue =
    /(?:重复|duplicate|已存在|already\s+exist|是否|还要|继续创建|确认|要不要|请确认|would\s+you\s+like|should\s+i)/i.test(
      tail
    )
  return hasQuestion && hasConfirmCue
}

export function hasHandoffCreatedIssue(params: {
  output: string
  repository?: string | null
  githubIssues: readonly GithubIssueRow[]
  startedMs?: number
  agentUpdatedMs?: number
  existingIssueNumbers?: ReadonlySet<number> | readonly number[]
}): boolean {
  const mentioned = extractGithubIssueNumbers(params.output, params.repository)
  if (mentioned.length === 0) return false

  const existingSet =
    params.existingIssueNumbers instanceof Set
      ? params.existingIssueNumbers
      : Array.isArray(params.existingIssueNumbers)
        ? new Set(params.existingIssueNumbers)
        : null

  if (!existingSet && looksLikeDuplicateOrConfirmationQuestion(params.output)) {
    return false
  }

  const byNumber = new Map<number, GithubIssueRow>()
  for (const issue of params.githubIssues) {
    byNumber.set(issue.number, issue)
  }

  for (const num of mentioned) {
    if (existingSet && existingSet.has(num)) continue
    const issue = byNumber.get(num)
    if (!issue) continue
    const createdMs = Date.parse(issue.createdAt)
    if (!Number.isFinite(createdMs)) continue
    if (typeof params.startedMs === 'number') {
      if (createdMs >= params.startedMs - 5_000) return true
    } else if (typeof params.agentUpdatedMs === 'number') {
      if (Math.abs(params.agentUpdatedMs - createdMs) <= 30 * 60 * 1000) return true
    } else {
      return true
    }
  }
  return false
}

export function extractTerminalQuestion(rawOutput: string): string {
  const clean = stripTerminalAnsi(rawOutput)
  const lines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !TERMINAL_CHROME_PATTERNS.some((pattern) => pattern.test(line))
    )

  if (lines.length === 0) {
    return '后台任务正在等待你的确认或输入，你可以直接回复指示，或点击「同意继续」。'
  }
  return lines.slice(-8).join('\n').slice(0, 700)
}

export async function inspectLocalBranchSync(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<BranchSyncStatus | null> {
  const branchRes = await runner('git', ['-C', repoPath, 'branch', '--show-current'], {
    timeoutMs: 3_000
  })
  if (branchRes.exitCode !== 0) return null
  const branch = branchRes.stdout.trim()
  if (!branch) return null

  const remoteRef = `refs/remotes/origin/${branch}`
  const verifyRes = await runner('git', ['-C', repoPath, 'rev-parse', '--verify', remoteRef], {
    timeoutMs: 3_000
  })
  if (verifyRes.exitCode !== 0) return null

  const countRes = await runner(
    'git',
    ['-C', repoPath, 'rev-list', '--left-right', '--count', `HEAD...${remoteRef}`],
    { timeoutMs: 3_000 }
  )
  if (countRes.exitCode !== 0) return null
  const parts = countRes.stdout.trim().split(/\s+/)
  if (parts.length !== 2) return null
  const ahead = Number(parts[0])
  const behind = Number(parts[1])
  if (!Number.isFinite(ahead) || !Number.isFinite(behind) || ahead <= 0 || behind <= 0) {
    return null
  }

  const [mergeTreeRes, statusRes] = await Promise.all([
    runner('git', ['-C', repoPath, 'merge-tree', '--write-tree', 'HEAD', remoteRef], {
      timeoutMs: 5_000
    }),
    runner('git', ['-C', repoPath, 'status', '--porcelain'], { timeoutMs: 3_000 })
  ])

  return {
    branch,
    ahead,
    behind,
    hasConflict: mergeTreeRes.exitCode !== 0,
    dirty: statusRes.exitCode !== 0 || statusRes.stdout.trim().length > 0
  }
}

export function buildSystemHealthAlerts(params: {
  repository: string | null
  autopilotInstalled: boolean
  autopilotLabel?: string | null
  pollIntervalSeconds?: number | null
  maxConcurrentWorkers?: number | null
  githubError?: string | null
  branchSync?: BranchSyncStatus | null
  ledgerRows: readonly LedgerIssueRow[]
  githubIssues: readonly GithubIssueRow[]
  nowMs?: number
}): Array<Extract<NeedsYouItem, { kind: 'system-alert' }>> {
  const nowMs = params.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const alerts: Array<Extract<NeedsYouItem, { kind: 'system-alert' }>> = []

  if (params.branchSync && params.branchSync.ahead > 0 && params.branchSync.behind > 0) {
    const sync = params.branchSync
    alerts.push({
      id: 'alert-branch-diverged',
      kind: 'system-alert',
      severity: sync.hasConflict ? 'error' : 'warning',
      badge: sync.hasConflict ? '分支冲突' : '分支分叉',
      title: `本地 ${sync.branch} 与远端分叉（领先 ${sync.ahead} / 落后 ${sync.behind}）`,
      reason: sync.hasConflict
        ? '本地未推送提交与远端新合并代码存在冲突，直接推送会被拒绝。点击「一键自动合并」交由 Agent 自动解冲突并同步。'
        : sync.dirty
          ? '本地有未提交改动，后台暂未自动同步。点击「一键自动合并」交由 Agent 安全合并并同步。'
          : '本地与远端无文件冲突，点击「一键自动合并」即可自动变基同步。',
      updatedAt: nowIso,
      canDismiss: true,
      syncBranch: sync
    })
  }

  if (params.githubError && params.repository) {
    const errText = params.githubError.trim()
    const isAuth =
      /(?:not logged into|gh auth login|authentication|401|bad credentials|token|saml)/i.test(
        errText
      )
    alerts.push({
      id: 'alert-github-cli',
      kind: 'system-alert',
      severity: 'error',
      badge: isAuth ? 'GitHub 鉴权失效' : 'GitHub 同步异常',
      title: isAuth ? 'gh 登录已失效，无法同步或认领 Issue' : '无法从 GitHub 拉取 Issue 列表',
      reason: isAuth
        ? `请运行 gh auth login 重新登录 GitHub CLI。原始错误：${errText.slice(0, 160)}`
        : errText.slice(0, 220),
      updatedAt: nowIso,
      canDismiss: true
    })
  }

  if (params.autopilotInstalled && !params.githubError) {
    const targetLabel = (params.autopilotLabel || 'agent-ready').toLowerCase()
    const pollSec = Math.max(60, params.pollIntervalSeconds ?? 180)
    const staleThresholdMs = Math.max(pollSec * 3, 600) * 1000
    const maxWorkers = Math.max(1, params.maxConcurrentWorkers ?? 3)
    const ledgerNumbers = new Set(params.ledgerRows.map((r) => r.issue_number))
    const runningCount = params.ledgerRows.filter(
      (r) => r.status === 'running' || r.status === 'claimed'
    ).length

    if (runningCount < maxWorkers) {
      const staleUnclaimed = params.githubIssues.filter((gh) => {
        if (gh.state !== 'OPEN') return false
        if (ledgerNumbers.has(gh.number)) return false
        if (!gh.labels.some((l) => l.name.toLowerCase() === targetLabel)) return false
        const createdMs = Date.parse(gh.createdAt)
        return Number.isFinite(createdMs) && nowMs - createdMs >= staleThresholdMs
      })

      if (staleUnclaimed.length > 0) {
        const thresholdMin = Math.round(staleThresholdMs / 60_000)
        const nums = staleUnclaimed
          .slice(0, 3)
          .map((i) => `#${i.number}`)
          .join('、')
        const suffix = staleUnclaimed.length > 3 ? ` 等 ${staleUnclaimed.length} 条` : ''
        alerts.push({
          id: 'alert-autopilot-stalled',
          kind: 'system-alert',
          severity: 'warning',
          badge: '自动化异常',
          title: 'Autopilot 可能已停止轮询',
          reason: `${nums}${suffix} 带有 ${targetLabel} 标签已超过 ${thresholdMin} 分钟未被后台认领，请检查 Autopilot 状态或在设置中重新启用。`,
          updatedAt: nowIso,
          canDismiss: true,
          canOpenSettings: true
        })
      }
    }
  }

  return alerts
}

export function humanizeAttentionReason(status: string, summary: string | null): string {
  const cleaned = (summary || '').trim()
  if (cleaned) {
    return cleaned.length > 260 ? `${cleaned.slice(0, 260)}…` : cleaned
  }
  switch (status) {
    case 'needs-human':
      return '自动执行过程中遇到需要你拍板或人工确认的情况，请查看后决定重试或放弃。'
    case 'blocked':
      return '当前任务被其他前置任务阻塞，或遇到了无法自动绕过的限制。'
    case 'failed':
      return '自动尝试未成功，可以点击「重试」让系统再试一次，或查看详情。'
    case 'ready-for-review':
      return '本地修复与自检已完成，正在等待你验收或决定后续处理。'
    case 'pr-open':
      return 'PR 已创建，正在等待你人工 Review 与合并。'
    default:
      return '需要你确认后续处理方式。'
  }
}

export function humanizeCompletedSummary(summary: string | null): string {
  const cleaned = (summary || '').trim()
  if (!cleaned) return '已完成并合并，可直接体验验收。'
  return cleaned.length > 180 ? `${cleaned.slice(0, 180)}…` : cleaned
}

export function mergeBoardItems(params: {
  ledgerRows: LedgerIssueRow[]
  githubIssues: GithubIssueRow[]
  agentQuestions: NeedsYouItem[]
  systemAlerts?: NeedsYouItem[]
  publication?: 'auto-merge' | 'pr-only' | 'never' | null
}): Pick<BoardSnapshot, 'needsYou' | 'inProgress' | 'completed'> {
  const needsYou: NeedsYouItem[] = [...(params.systemAlerts ?? []), ...params.agentQuestions]
  const inProgress: InProgressItem[] = []
  const completed: CompletedItem[] = []
  const seenNumbers = new Set<number>()

  const ghByNumber = new Map<number, GithubIssueRow>()
  for (const gh of params.githubIssues) {
    ghByNumber.set(gh.number, gh)
  }

  for (const row of params.ledgerRows) {
    seenNumbers.add(row.issue_number)
    const gh = ghByNumber.get(row.issue_number)
    const status = row.status
    const summary = row.attempt_summary || row.summary

    if (status === 'merged' || status === 'accepted' || gh?.state === 'CLOSED') {
      if (status !== 'discarded') {
        completed.push({
          id: `issue-${row.issue_number}`,
          issueNumber: row.issue_number,
          title: row.title,
          summary: humanizeCompletedSummary(summary),
          url: row.url,
          prUrl: row.pr_url,
          completedAt: row.merged_at || gh?.closedAt || row.issue_updated_at
        })
      }
      continue
    }

    if (status === 'discarded') {
      continue
    }

    const needsManualReview =
      status === 'ready-for-review' || (status === 'pr-open' && params.publication === 'pr-only')
    if (
      status === 'needs-human' ||
      status === 'blocked' ||
      status === 'failed' ||
      needsManualReview
    ) {
      needsYou.push({
        id: `issue-${row.issue_number}`,
        kind: 'issue-attention',
        issueNumber: row.issue_number,
        title: row.title,
        reason: humanizeAttentionReason(status, summary),
        url: row.url,
        prUrl: row.pr_url,
        rawStatus: status,
        updatedAt: row.issue_updated_at,
        canRetry: status !== 'pr-open',
        canDiscard: status !== 'pr-open'
      })
      continue
    }

    inProgress.push({
      id: `issue-${row.issue_number}`,
      issueNumber: row.issue_number,
      title: row.title,
      url: row.url,
      prUrl: row.pr_url,
      statusLabel: status === 'pr-open' ? '收尾合并中' : '处理中',
      updatedAt: row.issue_updated_at
    })
  }

  for (const gh of params.githubIssues) {
    if (seenNumbers.has(gh.number)) continue
    const hasAgentLabel = gh.labels.some((l) => l.name.toLowerCase() === 'agent-ready')
    if (gh.state === 'OPEN') {
      inProgress.push({
        id: `gh-${gh.number}`,
        issueNumber: gh.number,
        title: gh.title,
        url: gh.url,
        statusLabel: hasAgentLabel ? '排队处理中' : '待处理',
        updatedAt: gh.updatedAt
      })
    } else if (hasAgentLabel || params.ledgerRows.length === 0) {
      completed.push({
        id: `gh-${gh.number}`,
        issueNumber: gh.number,
        title: gh.title,
        summary: '已完成并关闭，可直接验收效果。',
        url: gh.url,
        prUrl: null,
        completedAt: gh.closedAt || gh.updatedAt
      })
    }
  }

  return {
    needsYou,
    inProgress: inProgress.slice(0, 30),
    completed: completed.slice(0, 30)
  }
}

export async function ensureBoardAnchorFile(
  repoPath: string,
  repository: string | null,
  workspaceId: string | undefined,
  runner: CommandRunner = defaultRunner
): Promise<string> {
  const filePath = join(repoPath, BOARD_FILENAME)
  const payload = {
    version: 1,
    repoPath,
    repository: repository || undefined,
    projectName: basename(repoPath),
    workspaceId
  }
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  // Add to local git exclude so the board anchor file never dirties `git status`
  const common = await runner('git', ['-C', repoPath, 'rev-parse', '--git-common-dir'])
  if (common.exitCode === 0 && common.stdout.trim()) {
    const commonDir = resolve(repoPath, common.stdout.trim())
    const infoDir = join(commonDir, 'info')
    const excludePath = join(infoDir, 'exclude')
    try {
      mkdirSync(infoDir, { recursive: true })
      const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
      const lines = current.split(/\r?\n/)
      if (!lines.includes(BOARD_FILENAME)) {
        const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
        writeFileSync(excludePath, `${current}${prefix}${BOARD_FILENAME}\n`, 'utf8')
      }
    } catch {
      // Non-fatal: board still opens even if exclude couldn't be updated
    }
  }

  return BOARD_FILENAME
}

export function resolvePluginRootDir(): string {
  // worker.ts lives in <pluginRoot>/src/worker.ts
  try {
    const fileUrl = import.meta.url
    if (fileUrl.startsWith('file://')) {
      return resolve(dirname(new URL(fileUrl).pathname), '..')
    }
  } catch {
    // ignore
  }
  return process.cwd()
}
