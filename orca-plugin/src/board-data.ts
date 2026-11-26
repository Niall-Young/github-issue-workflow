import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  BoardSnapshot,
  CompletedItem,
  CreateIssueInput,
  CreateIssueResult,
  InProgressItem,
  IssueKind,
  NeedsYouItem
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
        repositories?: Array<{ repository?: string; repo_path?: string }>
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
        return {
          configPath,
          dbPath,
          repository: entry.repository || repository || '',
          repoPath: entryRepoPath || normalizedRepoPath || '',
          runtimeAdminPath: join(dir, 'runtime', 'autopilot_admin.py')
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
      a.summary AS attempt_summary
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

export async function fetchGithubIssues(
  repoPath: string,
  runner: CommandRunner = defaultRunner
): Promise<GithubIssueRow[]> {
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
  if (res.exitCode !== 0 || !res.stdout.trim()) return []
  try {
    const parsed = JSON.parse(res.stdout)
    return Array.isArray(parsed) ? (parsed as GithubIssueRow[]) : []
  } catch {
    return []
  }
}

export function buildIssueBody(kind: IssueKind, title: string, details?: string, followUpOf?: number | null): string {
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
  // Ensure agent-ready label exists (best-effort, ignore if already present)
  await runner(
    'gh',
    ['label', 'create', 'agent-ready', '--color', '0E8A16', '--description', 'Ready for automated agent execution'],
    { cwd: input.repoPath, timeoutMs: 10_000 }
  )

  const body = buildIssueBody(input.kind, title, input.details, input.followUpOf)
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
    issueNumber: numMatch ? Number(numMatch[1]) : null,
    url,
    title
  }
}

export function extractTerminalQuestion(rawOutput: string): string {
  // Strip ANSI escape sequences
  const clean = rawOutput
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '')
  const lines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[─━═\-_=│┃┌┐└┘├┤┬┴┼]+$/.test(line))

  if (lines.length === 0) {
    return '后台任务正在等待你的确认或输入，你可以直接回复指示，或点击「同意继续」。'
  }
  return lines.slice(-8).join('\n').slice(0, 700)
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
}): Pick<BoardSnapshot, 'needsYou' | 'inProgress' | 'completed'> {
  const needsYou: NeedsYouItem[] = [...params.agentQuestions]
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

    if (status === 'needs-human' || status === 'blocked' || status === 'failed') {
      needsYou.push({
        id: `issue-${row.issue_number}`,
        kind: 'issue-attention',
        issueNumber: row.issue_number,
        title: row.title,
        reason: humanizeAttentionReason(status, summary),
        url: row.url,
        rawStatus: status,
        updatedAt: row.issue_updated_at,
        canRetry: true,
        canDiscard: true
      })
      continue
    }

    inProgress.push({
      id: `issue-${row.issue_number}`,
      issueNumber: row.issue_number,
      title: row.title,
      url: row.url,
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
