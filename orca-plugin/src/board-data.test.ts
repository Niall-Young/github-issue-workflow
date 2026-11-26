import { assert, test } from 'orca/testing'
import {
  buildIssueBody,
  extractTerminalQuestion,
  mergeBoardItems,
  parseGithubRepoFromRemote
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

test('buildIssueBody includes kind, details, and optional follow-up reference', () => {
  const body = buildIssueBody('bug', '导出按钮无响应', '点击页面右上角导出按钮后没有下载', 42)
  assert.equal(body.includes('问题修复 (Bug)'), true)
  assert.equal(body.includes('针对 #42 的后续调整'), true)
  assert.equal(body.includes('点击页面右上角导出按钮后没有下载'), true)
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
