import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import {
  buildAutopilotInstallArgs,
  buildHandoffPrompt,
  buildIssueBody,
  extractTerminalQuestion,
  fetchGithubPullRequests,
  findAutopilotConfigForRepo,
  findBundledHandoffSkill,
  listInstalledAgents,
  mergeBoardItems,
  normalizePullRequests,
  parseGithubRepoFromRemote,
  resolvePreferredAgent,
  saveAttachmentsLocally,
  summarizePrChecks
} from './board-data'

test('parseGithubRepoFromRemote handles SSH and HTTPS GitHub URLs', () => {
  assert.equal(
    parseGithubRepoFromRemote('git@github.com:Niall-Young/github-issue-workflow.git'),
    'Niall-Young/github-issue-workflow'
  )
  assert.equal(
    parseGithubRepoFromRemote('https://github.com/Niall-Young/github-issue-workflow.git'),
    'Niall-Young/github-issue-workflow'
  )
  assert.equal(parseGithubRepoFromRemote('https://gitlab.com/org/repo.git'), null)
})

test('buildIssueBody includes kind, details, follow-up, and local attachment paths', () => {
  const body = buildIssueBody('bug', '导出按钮无响应', '点击页面右上角导出按钮后没有下载', 42, [
    {
      name: 'error.png',
      mimeType: 'image/png',
      size: 2048,
      path: '/tmp/attachments/01-error.png'
    }
  ])
  assert.equal(body.includes('问题修复 (Bug)'), true)
  assert.equal(body.includes('针对 #42 的后续调整'), true)
  assert.equal(body.includes('点击页面右上角导出按钮后没有下载'), true)
  assert.equal(body.includes('## 附件（本地截图与文件）'), true)
  assert.equal(body.includes('/tmp/attachments/01-error.png'), true)
})

test('saveAttachmentsLocally writes decoded files into isolated state folder', () => {
  const tempState = mkdtempSync(join(tmpdir(), 'issue-board-test-'))
  try {
    const content = Buffer.from('hello screenshot bytes')
    const saved = saveAttachmentsLocally(
      '/Users/demo/my-project',
      [
        {
          name: 'bug shot.png',
          mimeType: 'image/png',
          size: content.byteLength,
          base64: content.toString('base64')
        }
      ],
      tempState
    )
    assert.equal(saved.length, 1)
    assert.equal(existsSync(saved[0].path), true)
    assert.equal(readFileSync(saved[0].path, 'utf8'), 'hello screenshot bytes')
    assert.equal(saved[0].path.includes('my-project'), true)
  } finally {
    rmSync(tempState, { recursive: true, force: true })
  }
})

test('extractTerminalQuestion strips ANSI codes and returns concise tail', () => {
  const raw = '\u001b[32m✓ Done\u001b[0m\n────────────\n请问默认勾选记住密码吗？(y/n)\n'
  const result = extractTerminalQuestion(raw)
  assert.equal(result.includes('\u001b'), false)
  assert.equal(result.includes('请问默认勾选记住密码吗？'), true)
})

test('mergeBoardItems separates needsYou, inProgress, and completed cleanly', () => {
  const merged = mergeBoardItems({
    agentQuestions: [
      {
        id: 'agent-t1',
        kind: 'agent-question',
        title: '登录页改动',
        question: '要默认勾选记住密码吗？',
        terminalId: 't1',
        workspaceId: 'w1',
        agentName: 'codex',
        state: 'waiting',
        updatedAt: '2026-11-26T05:00:00Z'
      }
    ],
    ledgerRows: [
      {
        node_id: 'n1',
        repository: 'owner/repo',
        issue_number: 1,
        url: 'https://github.com/owner/repo/issues/1',
        title: '修复首页白屏',
        created_at: '2026-11-26T01:00:00Z',
        issue_updated_at: '2026-11-26T02:00:00Z',
        status: 'merged',
        attempts: 1,
        summary: '已修复空数据导致的白屏问题',
        pr_url: 'https://github.com/owner/repo/pull/10',
        merged_at: '2026-11-26T02:00:00Z',
        attempt_status: 'merged',
        attempt_summary: '已修复空数据导致的白屏问题'
      },
      {
        node_id: 'n2',
        repository: 'owner/repo',
        issue_number: 2,
        url: 'https://github.com/owner/repo/issues/2',
        title: '支持深色模式',
        created_at: '2026-11-26T03:00:00Z',
        issue_updated_at: '2026-11-26T03:30:00Z',
        status: 'running',
        attempts: 1,
        summary: null,
        pr_url: null,
        merged_at: null,
        attempt_status: 'running',
        attempt_summary: null
      },
      {
        node_id: 'n3',
        repository: 'owner/repo',
        issue_number: 3,
        url: 'https://github.com/owner/repo/issues/3',
        title: '修改支付回调',
        created_at: '2026-11-26T03:00:00Z',
        issue_updated_at: '2026-11-26T04:00:00Z',
        status: 'needs-human',
        attempts: 1,
        summary: '涉及支付逻辑，需要人工确认',
        pr_url: null,
        merged_at: null,
        attempt_status: 'needs-human',
        attempt_summary: '涉及支付逻辑，需要人工确认'
      }
    ],
    githubIssues: [
      {
        number: 4,
        title: '新加的排队任务',
        state: 'OPEN',
        url: 'https://github.com/owner/repo/issues/4',
        createdAt: '2026-11-26T04:30:00Z',
        updatedAt: '2026-11-26T04:30:00Z',
        closedAt: null,
        labels: [{ name: 'agent-ready' }]
      }
    ]
  })

  assert.equal(merged.needsYou.length, 2)
  assert.equal(merged.inProgress.length, 2)
  assert.equal(merged.completed.length, 1)
  assert.equal(merged.completed[0].prUrl, 'https://github.com/owner/repo/pull/10')
})

test('buildHandoffPrompt embeds skill paths, attachments, follow-up, and autopilot label rule', () => {
  const prompt = buildHandoffPrompt({
    repoPath: '/Users/demo/project',
    repository: 'owner/repo',
    kind: 'bug',
    title: '导出按钮点击无反应',
    details: '点击右上角导出后没有任何下载动作',
    followUpOf: 18,
    savedAttachments: [
      {
        name: 'shot.png',
        mimeType: 'image/png',
        size: 1024,
        path: '/tmp/attachments/01-shot.png'
      }
    ],
    autopilotInstalled: true,
    skillPaths: {
      skillMdPath: '/repo/github-issue-handoff/SKILL.md',
      templatesPath: '/repo/github-issue-handoff/references/issue-templates.md'
    }
  })

  assert.equal(prompt.includes('github-issue-handoff'), true)
  assert.equal(prompt.includes('/repo/github-issue-handoff/SKILL.md'), true)
  assert.equal(prompt.includes('/repo/github-issue-handoff/references/issue-templates.md'), true)
  assert.equal(prompt.includes('https://github.com/owner/repo'), true)
  assert.equal(prompt.includes('Bug（问题修复）'), true)
  assert.equal(prompt.includes('针对 #18 的后续调整'), true)
  assert.equal(prompt.includes('/tmp/attachments/01-shot.png'), true)
  assert.equal(prompt.includes('agent-ready'), true)
})

test('resolvePreferredAgent prefers autopilot default, then Orca default, then codex', async () => {
  const fromAutopilot = await resolvePreferredAgent('claude', async () => {
    throw new Error('should not call runner when autopilotDefaultAgent is set')
  })
  assert.equal(fromAutopilot, 'claude')

  const fromOrca = await resolvePreferredAgent(null, async () => ({
    stdout: JSON.stringify({
      ok: true,
      result: {
        agents: [
          { id: 'codex', default: false },
          { id: 'antigravity', default: true }
        ]
      }
    }),
    stderr: '',
    exitCode: 0
  }))
  assert.equal(fromOrca, 'antigravity')

  const fallback = await resolvePreferredAgent(null, async () => ({
    stdout: '',
    stderr: 'not available',
    exitCode: 1
  }))
  assert.equal(fallback, 'codex')
})

test('findBundledHandoffSkill locates sibling SKILL.md and issue-templates.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-skill-test-'))
  try {
    const pluginDir = join(root, 'orca-plugin')
    const skillDir = join(root, 'github-issue-handoff')
    const refDir = join(skillDir, 'references')
    mkdirSync(pluginDir, { recursive: true })
    mkdirSync(refDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '# skill', 'utf8')
    writeFileSync(join(refDir, 'issue-templates.md'), '# templates', 'utf8')

    const found = findBundledHandoffSkill(pluginDir)
    assert.equal(found?.skillMdPath, join(skillDir, 'SKILL.md'))
    assert.equal(found?.templatesPath, join(refDir, 'issue-templates.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('summarizePrChecks and normalizePullRequests classify CI and sort OPEN PRs first', async () => {
  assert.equal(summarizePrChecks([]), 'none')
  assert.equal(summarizePrChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'passing')
  assert.equal(summarizePrChecks([{ status: 'IN_PROGRESS' }]), 'pending')
  assert.equal(
    summarizePrChecks([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' }
    ]),
    'failing'
  )

  const normalized = normalizePullRequests([
    {
      number: 10,
      title: '已合并的旧 PR',
      state: 'MERGED',
      isDraft: false,
      url: 'https://github.com/owner/repo/pull/10',
      headRefName: 'fix/old',
      baseRefName: 'main',
      author: { login: 'alice' },
      mergeable: 'UNKNOWN',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      updatedAt: '2026-11-26T06:00:00Z',
      mergedAt: '2026-11-26T06:00:00Z'
    },
    {
      number: 12,
      title: '正在运行的 PR',
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/owner/repo/pull/12',
      headRefName: 'feat/new',
      baseRefName: 'main',
      author: { login: 'bob' },
      mergeable: 'MERGEABLE',
      reviewDecision: null,
      statusCheckRollup: [{ status: 'IN_PROGRESS' }],
      updatedAt: '2026-11-26T05:00:00Z',
      mergedAt: null
    }
  ])

  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].number, 12)
  assert.equal(normalized[0].ciStatus, 'pending')
  assert.equal(normalized[0].isDraft, true)
  assert.equal(normalized[1].number, 10)
  assert.equal(normalized[1].ciStatus, 'passing')

  const fetched = await fetchGithubPullRequests('/tmp/repo', async () => ({
    stdout: JSON.stringify([
      {
        number: 15,
        title: 'PR from gh',
        state: 'OPEN',
        url: 'https://github.com/owner/repo/pull/15',
        headRefName: 'issue-9',
        baseRefName: 'main',
        author: { login: 'dev' },
        statusCheckRollup: [],
        updatedAt: '2026-11-26T07:00:00Z'
      }
    ]),
    stderr: '',
    exitCode: 0
  }))
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].number, 15)
  assert.equal(fetched[0].ciStatus, 'none')
})

test('listInstalledAgents parses Orca CLI JSON and deduplicates ids', async () => {
  const agents = await listInstalledAgents(async () => ({
    stdout: JSON.stringify({
      ok: true,
      result: {
        agents: [
          { id: 'claude', name: 'Claude', default: false },
          { id: 'antigravity', name: 'Antigravity', default: true },
          { id: 'claude', name: 'Claude Duplicate', default: false }
        ]
      }
    }),
    stderr: '',
    exitCode: 0
  }))
  assert.equal(agents.length, 2)
  assert.equal(agents[0].id, 'claude')
  assert.equal(agents[0].isDefault, false)
  assert.equal(agents[1].id, 'antigravity')
  assert.equal(agents[1].isDefault, true)

  const empty = await listInstalledAgents(async () => ({
    stdout: '',
    stderr: 'failed',
    exitCode: 1
  }))
  assert.equal(empty.length, 0)
})

test('findAutopilotConfigForRepo reads agent and policy settings and buildAutopilotInstallArgs preserves them', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'autopilot-config-test-'))
  try {
    const repoDir = join(stateRoot, 'repo-a')
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(
      join(repoDir, 'autopilot.json'),
      JSON.stringify({
        schema_version: 3,
        state_db: 'state.sqlite3',
        max_concurrent_workers: 2,
        max_attempts: 3,
        worker_timeout_seconds: 1800,
        heartbeat_timeout_seconds: 600,
        policy: {
          publication: 'pr-only',
          merge_method: 'rebase',
          pre_merge_commands: ['npm test'],
          require_ci: false
        },
        orca: {
          default_agent: 'codex',
          allowed_agents: ['codex', 'claude']
        },
        repositories: [
          {
            repository: 'owner/demo',
            repo_path: '/Users/demo/project',
            labels: ['custom-ready']
          }
        ]
      }),
      'utf8'
    )

    const found = findAutopilotConfigForRepo('/Users/demo/project', 'owner/demo', stateRoot)
    assert.equal(found?.defaultAgent, 'codex')
    assert.deepEqual(found?.allowedAgents, ['codex', 'claude'])
    assert.equal(found?.publication, 'pr-only')
    assert.equal(found?.requireCi, false)

    const args = buildAutopilotInstallArgs({
      adminScript: '/scripts/autopilot_admin.py',
      repoPath: '/Users/demo/project',
      defaultAgent: 'antigravity',
      allowedAgents: ['antigravity', 'claude', 'codex'],
      existing: found
    })
    assert.deepEqual(args, [
      '/scripts/autopilot_admin.py',
      'install',
      '--repo-path',
      '/Users/demo/project',
      '--agent',
      'antigravity',
      '--allow-agent',
      'claude',
      '--allow-agent',
      'codex',
      '--label',
      'custom-ready',
      '--max-concurrent',
      '2',
      '--max-attempts',
      '3',
      '--worker-timeout',
      '1800',
      '--heartbeat-timeout',
      '600',
      '--publication',
      'pr-only',
      '--merge-method',
      'rebase',
      '--pre-merge-command',
      'npm test',
      '--no-require-ci'
    ])
  } finally {
    rmSync(stateRoot, { recursive: true, force: true })
  }
})
