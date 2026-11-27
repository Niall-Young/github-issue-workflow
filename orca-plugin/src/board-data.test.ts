import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildAutopilotInstallArgs,
  buildHandoffPrompt,
  buildIssueBody,
  buildLocalDevPrompt,
  buildSystemHealthAlerts,
  extractTerminalQuestion,
  fetchGithubPullRequests,
  findAutopilotConfigForRepo,
  findBundledHandoffSkill,
  hasAutopilotReceipt,
  hasHandoffCreatedIssue,
  isAutopilotRuntimeOutdated,
  listInstalledAgents,
  looksLikeDuplicateOrConfirmationQuestion,
  mergeBoardItems,
  normalizePullRequests,
  parseGithubRepoFromRemote,
  resolvePreferredAgent,
  saveAttachmentsLocally,
  summarizePrChecks,
  syncBundledSkillsAndCli
} from './board-data'

test('parseGithubRepoFromRemote handles SSH and HTTPS GitHub URLs', () => {
  assert.equal(
    parseGithubRepoFromRemote('git@github.com:Niall-Young/orca-autopilot.git'),
    'Niall-Young/orca-autopilot'
  )
  assert.equal(
    parseGithubRepoFromRemote('https://github.com/Niall-Young/orca-autopilot.git'),
    'Niall-Young/orca-autopilot'
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

    const liteArgs = buildAutopilotInstallArgs({
      adminScript: '/opt/autopilot_admin.py',
      repoPath: '/Users/demo/project',
      defaultAgent: 'codex',
      allowedAgents: ['codex'],
      workerMode: 'lite',
      existing: found
    })
    assert.ok(liteArgs.includes('--worker-mode'))
    assert.equal(liteArgs[liteArgs.indexOf('--worker-mode') + 1], 'lite')

    const localPrompt = buildLocalDevPrompt({
      repoPath: '/Users/demo/project',
      branch: 'main',
      title: '修复按钮对齐',
      lockPath: '/tmp/demo/.git/autopilot-local-dev.lock.json'
    })
    assert.ok(localPrompt.includes('单会话本地直改模式'))
    assert.ok(!localPrompt.includes('- 类型：'))
    assert.ok(localPrompt.includes('git pull --rebase origin main'))
    assert.ok(localPrompt.includes('git push origin main'))
    assert.ok(localPrompt.includes('/tmp/demo/.git/autopilot-local-dev.lock.json'))
  } finally {
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('isAutopilotRuntimeOutdated detects stale or missing runtime copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-runtime-sync-'))
  try {
    const srcDir = join(root, 'src')
    const rtDir = join(root, 'runtime')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(rtDir, { recursive: true })

    const srcAdmin = join(srcDir, 'autopilot_admin.py')
    const srcWatcher = join(srcDir, 'issue_watcher.py')
    const rtAdmin = join(rtDir, 'autopilot_admin.py')
    const rtWatcher = join(rtDir, 'issue_watcher.py')

    writeFileSync(srcAdmin, 'admin-v2', 'utf8')
    writeFileSync(srcWatcher, 'watcher-v2', 'utf8')

    assert.equal(isAutopilotRuntimeOutdated(srcAdmin, rtAdmin), true)

    writeFileSync(rtAdmin, 'admin-v2', 'utf8')
    writeFileSync(rtWatcher, 'watcher-v1', 'utf8')
    assert.equal(isAutopilotRuntimeOutdated(srcAdmin, rtAdmin), true)

    writeFileSync(rtWatcher, 'watcher-v2', 'utf8')
    assert.equal(isAutopilotRuntimeOutdated(srcAdmin, rtAdmin), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hasHandoffCreatedIssue avoids false positives on pre-existing duplicate Issue URLs', () => {
  const now = Date.parse('2026-11-26T17:00:00Z')
  const existingIssue = {
    number: 42,
    title: '已有重复 Issue',
    state: 'OPEN' as const,
    url: 'https://github.com/acme/demo/issues/42',
    createdAt: new Date(now - 2 * 60_000).toISOString(),
    updatedAt: new Date(now - 2 * 60_000).toISOString(),
    closedAt: null,
    labels: [{ name: 'agent-ready' }]
  }

  assert.equal(
    hasHandoffCreatedIssue({
      output: '检测到可能重复的 Issue：https://github.com/acme/demo/issues/42，是否还要继续创建？',
      repository: 'acme/demo',
      githubIssues: [existingIssue],
      startedMs: now,
      existingIssueNumbers: [42]
    }),
    false
  )

  assert.equal(
    looksLikeDuplicateOrConfirmationQuestion(
      '检测到可能重复的 Issue：https://github.com/acme/demo/issues/42\n是否还要继续创建？'
    ),
    true
  )
  assert.equal(
    hasHandoffCreatedIssue({
      output: '检测到可能重复的 Issue：https://github.com/acme/demo/issues/42\n是否还要继续创建？',
      repository: 'acme/demo',
      githubIssues: [existingIssue],
      agentUpdatedMs: now
    }),
    false
  )

  assert.equal(
    hasHandoffCreatedIssue({
      output: '已创建 Issue：https://github.com/acme/demo/issues/42',
      repository: 'acme/demo',
      githubIssues: [existingIssue],
      agentUpdatedMs: now
    }),
    true
  )
})

test('hasAutopilotReceipt detects real receipts and ignores template placeholders', () => {
  assert.equal(
    hasAutopilotReceipt(
      'AUTOPILOT_RESULT: {"status":"needs-human","summary":"explain why","run_id":"<assigned run ID>"}'
    ),
    false
  )
  assert.equal(
    hasAutopilotReceipt(
      'Done!\nAUTOPILOT_RESULT: {"status":"ready-for-review","summary":"fixed","run_id":"run-1"}'
    ),
    true
  )
  assert.equal(hasAutopilotReceipt('需求不够明确，请问你想改哪个文件？'), false)
})

test('mergeBoardItems surfaces ready-for-review and pr-only pr-open in needsYou', () => {
  const baseRow = {
    node_id: 'n1',
    repository: 'acme/demo',
    issue_number: 10,
    url: 'https://github.com/acme/demo/issues/10',
    title: '本地验收任务',
    created_at: '2026-11-26T10:00:00Z',
    issue_updated_at: '2026-11-26T10:10:00Z',
    status: 'ready-for-review',
    attempts: 1,
    summary: null,
    pr_url: null,
    merged_at: null,
    attempt_status: 'ready-for-review',
    attempt_summary: null
  }
  const prOpenRow = {
    ...baseRow,
    node_id: 'n2',
    issue_number: 11,
    url: 'https://github.com/acme/demo/issues/11',
    title: 'PR Review 任务',
    status: 'pr-open',
    pr_url: 'https://github.com/acme/demo/pull/99',
    attempt_status: 'pr-open'
  }

  const prOnlyResult = mergeBoardItems({
    ledgerRows: [baseRow, prOpenRow],
    githubIssues: [],
    agentQuestions: [],
    publication: 'pr-only'
  })
  assert.equal(prOnlyResult.needsYou.length, 2)
  assert.equal(prOnlyResult.inProgress.length, 0)

  const autoMergeResult = mergeBoardItems({
    ledgerRows: [baseRow, prOpenRow],
    githubIssues: [],
    agentQuestions: [],
    publication: 'auto-merge'
  })
  assert.equal(autoMergeResult.needsYou.length, 1)
  assert.equal(autoMergeResult.inProgress.length, 1)
})

test('buildSystemHealthAlerts flags gh auth failures and stalled autopilot polling', () => {
  const now = Date.parse('2026-11-26T17:00:00Z')
  const authAlerts = buildSystemHealthAlerts({
    repository: 'acme/demo',
    autopilotInstalled: true,
    githubError: 'To get started with GitHub CLI, please run:  gh auth login',
    ledgerRows: [],
    githubIssues: [],
    nowMs: now
  })
  assert.equal(authAlerts.length, 1)
  assert.equal(authAlerts[0]?.badge, 'GitHub 鉴权失效')

  const stalledAlerts = buildSystemHealthAlerts({
    repository: 'acme/demo',
    autopilotInstalled: true,
    pollIntervalSeconds: 180,
    maxConcurrentWorkers: 3,
    githubError: null,
    ledgerRows: [],
    githubIssues: [
      {
        number: 77,
        title: '超过 15 分钟未认领的 Issue',
        state: 'OPEN',
        url: 'https://github.com/acme/demo/issues/77',
        createdAt: new Date(now - 15 * 60_000).toISOString(),
        updatedAt: new Date(now - 15 * 60_000).toISOString(),
        closedAt: null,
        labels: [{ name: 'agent-ready' }]
      }
    ],
    nowMs: now
  })
  assert.equal(stalledAlerts.length, 1)
  assert.equal(stalledAlerts[0]?.id, 'alert-autopilot-stalled')
  assert.ok(stalledAlerts[0]?.reason.includes('#77'))
})

test('syncBundledSkillsAndCli installs all four skills and CLI links for native orca plugin install', () => {
  const temp = mkdtempSync(join(tmpdir(), 'autopilot-sync-'))
  try {
    const fakeRepo = join(temp, 'installed-plugin')
    const fakeHome = join(temp, 'home')
    mkdirSync(join(fakeHome, '.claude'), { recursive: true })
    mkdirSync(join(fakeHome, '.codex'), { recursive: true })
    mkdirSync(join(fakeRepo, 'scripts'), { recursive: true })
    writeFileSync(join(fakeRepo, 'scripts', 'orca-autopilot'), '#!/usr/bin/env python3\n', 'utf8')
    for (const skill of [
      'github-issue-handoff',
      'github-issue-repair',
      'github-issue-autopilot',
      'github-issue-workflow-update'
    ]) {
      mkdirSync(join(fakeRepo, skill), { recursive: true })
      writeFileSync(join(fakeRepo, skill, 'SKILL.md'), `# ${skill}\n`, 'utf8')
    }
    writeFileSync(join(fakeRepo, 'github-issue-workflow-update', 'VERSION'), '0.2.1\n', 'utf8')

    const first = syncBundledSkillsAndCli(fakeRepo, { homeDir: fakeHome })
    assert.equal(first.syncedSkillDirs.length, 2)
    assert.equal(first.installedCliPaths.length, 2)
    assert.equal(existsSync(join(fakeHome, '.claude', 'skills', 'github-issue-handoff', 'SKILL.md')), true)
    assert.equal(existsSync(join(fakeHome, '.codex', 'skills', 'github-issue-autopilot', 'SKILL.md')), true)
    assert.equal(existsSync(join(fakeHome, '.local', 'bin', 'orca-autopilot')), true)

    // Second call with same version is a fast no-op
    const second = syncBundledSkillsAndCli(fakeRepo, { homeDir: fakeHome })
    assert.equal(second.syncedSkillDirs.length, 0)
    assert.equal(second.installedCliPaths.length, 0)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
