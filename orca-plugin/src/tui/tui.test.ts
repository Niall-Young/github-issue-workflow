import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoardSnapshot } from '../protocol'
import {
  filterSlashCommands,
  isSlashMenuOpen,
  parseSlashCommand,
  splitComposerText
} from './commands'
import { InputParser } from './input'
import { buildMainRows, renderTui, type TuiState } from './render'
import { ScreenBuffer, stringDisplayWidth, truncateToWidth, wrapTextToWidth } from './screen'

function makeSampleSnapshot(): BoardSnapshot {
  return {
    projectName: 'demo-app',
    repository: 'acme/demo-app',
    repoPath: '/tmp/demo-app',
    autopilotInstalled: true,
    autopilotRunning: true,
    defaultAgent: 'codex',
    allowedAgents: ['codex', 'claude'],
    installedAgents: [
      { id: 'codex', name: 'Codex', isDefault: true },
      { id: 'claude', name: 'Claude', isDefault: false }
    ],
    preferredAgent: 'codex',
    syncedAt: new Date().toISOString(),
    error: null,
    needsYou: [
      {
        id: 'agent-1',
        kind: 'agent-question',
        title: '确认是否修改数据库',
        question: '是否需要同时迁移历史数据？',
        terminalId: 'term-1',
        workspaceId: 'ws-1',
        agentName: 'codex',
        state: 'waiting',
        updatedAt: new Date().toISOString()
      }
    ],
    inProgress: [
      {
        id: 'issue-12',
        issueNumber: 12,
        title: '支持终端鼠标点击',
        url: 'https://github.com/acme/demo-app/issues/12',
        statusLabel: '处理中',
        updatedAt: new Date().toISOString()
      }
    ],
    completed: [],
    pullRequests: [
      {
        number: 18,
        title: 'feat: terminal TUI',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/acme/demo-app/pull/18',
        headRefName: 'feat/tui',
        baseRefName: 'main',
        author: 'alice',
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        ciStatus: 'passing',
        updatedAt: new Date().toISOString(),
        mergedAt: null
      }
    ]
  }
}

function makeBaseState(text = ''): TuiState {
  return {
    snapshot: makeSampleSnapshot(),
    loading: false,
    activeTab: 'issues',
    activePane: 'main',
    selectedIndex: 1,
    scrollOffset: 0,
    attentionIndex: 0,
    attentionScroll: 0,
    busyIds: new Set(),
    composer: {
      text,
      mode: 'handoff',
      kind: 'feature',
      followUpOf: null,
      attachments: [],
      submitting: false,
      slashIndex: 0
    },
    modal: { type: 'none' },
    toast: null
  }
}

test('screen utilities compute CJK double-width accurately', () => {
  assert.equal(stringDisplayWidth('abc'), 3)
  assert.equal(stringDisplayWidth('看板'), 4)
  assert.equal(stringDisplayWidth('Issue 看板'), 10)
  assert.equal(truncateToWidth('中文标题很长需要截断', 9), '中文标题…')
})

test('screen utilities wrap mixed CJK and ASCII text within width', () => {
  const lines = wrapTextToWidth('测试第一行内容超过宽度会自动换行', 12, 4)
  assert.ok(lines.length > 1)
  for (const line of lines) {
    assert.ok(stringDisplayWidth(line) <= 12)
  }
})

test('ScreenBuffer hitTest resolves topmost overlay hit-box first', () => {
  const buf = new ScreenBuffer(60, 20)
  buf.addHitBox(0, 0, 60, 20, 'bg')
  buf.addHitBox(10, 5, 12, 1, 'modal-btn', { id: 1 })
  const hit = buf.hitTest(12, 5)
  assert.equal(hit?.action, 'modal-btn')
  assert.deepEqual(hit?.payload, { id: 1 })
  assert.equal(buf.hitTest(2, 2)?.action, 'bg')
})

test('InputParser parses SGR 1006 mouse clicks and wheel events', () => {
  const parser = new InputParser()
  const events = parser.feed('\x1b[<0;15;4M\x1b[<0;15;4m\x1b[<64;10;10M\x1b[<65;10;10M')
  assert.deepEqual(events, [
    { type: 'mouse', kind: 'press', button: 'left', x: 14, y: 3 },
    { type: 'mouse', kind: 'release', button: 'left', x: 14, y: 3 },
    { type: 'mouse', kind: 'scrollUp', button: 'other', x: 9, y: 9 },
    { type: 'mouse', kind: 'scrollDown', button: 'other', x: 9, y: 9 }
  ])
})

test('InputParser parses bracketed paste split across chunks', () => {
  const parser = new InputParser()
  const e1 = parser.feed('\x1b[200~/tmp/demo')
  const e2 = parser.feed(' shot.png\x1b[201~')
  assert.deepEqual(e1, [])
  assert.deepEqual(e2, [{ type: 'paste', text: '/tmp/demo shot.png' }])
})

test('InputParser parses arrow keys, shift+enter, ctrl shortcuts and CJK text', () => {
  const parser = new InputParser()
  const events = parser.feed('\x1b[A\x1b[B\x1b[13;2u\x16你好\r')
  assert.deepEqual(events, [
    { type: 'key', key: 'up', raw: '\x1b[A' },
    { type: 'key', key: 'down', raw: '\x1b[B' },
    { type: 'key', key: 'enter', shift: true, raw: '\x1b[13;2u' },
    { type: 'key', key: 'v', ctrl: true, raw: '\x16' },
    { type: 'text', text: '你好' },
    { type: 'key', key: 'enter', raw: '\r' }
  ])
})

test('slash command filtering and parsing handle commands, aliases, and arguments', () => {
  assert.equal(isSlashMenuOpen('/'), true)
  assert.equal(isSlashMenuOpen('/bu'), true)
  assert.equal(isSlashMenuOpen('/bug 修复登录'), false)
  assert.equal(isSlashMenuOpen('普通需求'), false)

  const bugMatches = filterSlashCommands('/bu')
  assert.equal(bugMatches[0]?.id, 'bug')

  const parsedInline = parseSlashCommand('/bug 登录按钮点击无响应')
  assert.equal(parsedInline?.kind, 'command')
  if (parsedInline?.kind === 'command') {
    assert.equal(parsedInline.command.id, 'bug')
    assert.equal(parsedInline.arg, '登录按钮点击无响应')
  }

  const parsedAlias = parseSlashCommand('/settings')
  assert.equal(parsedAlias?.kind, 'command')
  if (parsedAlias?.kind === 'command') {
    assert.equal(parsedAlias.command.id, 'agent')
  }

  const parsedUnknown = parseSlashCommand('/doesnotexist')
  assert.deepEqual(parsedUnknown, { kind: 'unknown', name: '/doesnotexist' })

  assert.deepEqual(splitComposerText('第一行标题\n第二行补充说明\n第三行'), {
    title: '第一行标题',
    details: '第二行补充说明\n第三行'
  })
})

test('renderTui renders bottom composer, clickable rows, and floating slash menu', () => {
  const state = makeBaseState('')
  const rows = buildMainRows(state.snapshot, 'issues')
  assert.equal(rows.length, 2)

  const buf = renderTui(state, 110, 30)
  const actions = new Set(buf.hitBoxes.map((h) => h.action))
  assert.equal(actions.has('focus-composer'), true)
  assert.equal(actions.has('open-settings'), true)
  assert.equal(actions.has('switch-tab'), true)
  assert.equal(actions.has('select-main-row'), true)
  assert.equal(actions.has('approve-agent'), true)
  assert.equal(actions.has('open-reply'), true)
  assert.equal(actions.has('exec-slash'), false)

  // Typing "/" opens the floating slash command menu with clickable command rows
  const slashState = makeBaseState('/')
  const slashBuf = renderTui(slashState, 110, 30)
  const slashHits = slashBuf.hitBoxes.filter((h) => h.action === 'exec-slash')
  assert.ok(slashHits.length >= 5)
  assert.equal(slashHits[0]?.payload, 'bug')
})
