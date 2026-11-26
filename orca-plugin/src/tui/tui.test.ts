import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoardSnapshot, SavedAttachment } from '../protocol'
import {
  appendInlineAttachment,
  backspaceWithInlineAttachments,
  removeInlineAttachmentById,
  stripInlineAttachmentTokens
} from './attachments'
import {
  filterSlashCommands,
  isSlashMenuOpen,
  parseSlashCommand,
  splitComposerText
} from './commands'
import { InputParser } from './input'
import {
  buildMainRows,
  computeComposerHeight,
  nextIssueKind,
  nextSubmitMode,
  renderTui,
  type TuiState
} from './render'
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
    errorNotice: null
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

test('InputParser parses arrow keys, shift+enter, shift+tab, ctrl shortcuts and CJK text', () => {
  const parser = new InputParser()
  const events = parser.feed('\x1b[A\x1b[B\x1b[13;2u\x1b[Z\x1b[9;2u\x16你好\r')
  assert.deepEqual(events, [
    { type: 'key', key: 'up', raw: '\x1b[A' },
    { type: 'key', key: 'down', raw: '\x1b[B' },
    { type: 'key', key: 'enter', shift: true, raw: '\x1b[13;2u' },
    { type: 'key', key: 'tab', shift: true, raw: '\x1b[Z' },
    { type: 'key', key: 'tab', shift: true, raw: '\x1b[9;2u' },
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

test('renderTui renders bottom composer, clickable rows, and inline Claude Code-style slash menu', () => {
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

  // Typing "/" opens the borderless inline slash command list directly above the composer
  const slashState = makeBaseState('/')
  slashState.composer.slashIndex = 1
  const slashBuf = renderTui(slashState, 110, 30)
  const slashHits = slashBuf.hitBoxes.filter((h) => h.action === 'exec-slash')
  assert.ok(slashHits.length >= 5)
  assert.equal(slashHits[0]?.payload, 'bug')
  assert.equal(slashHits[0]?.x, 0)
  assert.equal(slashHits[0]?.w, 110)

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const lines = slashBuf.renderLines().map(stripAnsi)
  const selectedRow = lines[slashHits[1]!.y]
  const unselectedRow = lines[slashHits[0]!.y]
  assert.ok(selectedRow.includes('❯ /feature'))
  assert.ok(!selectedRow.includes('│'))
  assert.ok(unselectedRow.includes('  /bug'))
  assert.ok(!unselectedRow.includes('│'))
  // Hairline divider immediately above the first inline command row
  assert.equal(lines[slashHits[0]!.y - 1], '─'.repeat(110))
})

test('inline attachment tokens support insertion, atomic Backspace, click removal, and clean submit stripping', () => {
  const img1: SavedAttachment = {
    name: 'orca-paste-1.png',
    mimeType: 'image/png',
    size: 1024,
    path: '/tmp/orca-paste-1.png'
  }
  const pdf2: SavedAttachment = {
    name: 'spec.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    path: '/tmp/spec.pdf'
  }
  const img3: SavedAttachment = {
    name: 'orca-paste-3.png',
    mimeType: 'image/png',
    size: 512,
    path: '/tmp/orca-paste-3.png'
  }

  // Insert into empty text -> [Image #1]
  const s1 = appendInlineAttachment('', [], img1)
  assert.equal(s1.text, '[Image #1]')
  assert.equal(s1.added.token, '[Image #1]')
  assert.equal(s1.attachments.length, 1)

  // Immediate Backspace deletes entire [Image #1] token and removes attachment
  const bsEmpty = backspaceWithInlineAttachments(s1.text, s1.attachments)
  assert.equal(bsEmpty.text, '')
  assert.equal(bsEmpty.attachments.length, 0)
  assert.equal(bsEmpty.removed?.token, '[Image #1]')

  // Insert after text + second non-image attachment
  const s2 = appendInlineAttachment('看看这个报错', [], img1)
  assert.equal(s2.text, '看看这个报错 [Image #1]')
  const s3 = appendInlineAttachment(s2.text, s2.attachments, pdf2)
  assert.equal(s3.text, '看看这个报错 [Image #1] [File #2]')
  assert.equal(s3.attachments.length, 2)

  // Click-remove #1 from the middle without leaving double spaces
  const removedMid = removeInlineAttachmentById(s3.text, s3.attachments, 1)
  assert.equal(removedMid.text, '看看这个报错 [File #2]')
  assert.deepEqual(
    removedMid.attachments.map((a) => a.token),
    ['[File #2]']
  )

  // Next attachment gets monotonic id #3
  const s4 = appendInlineAttachment(removedMid.text, removedMid.attachments, img3)
  assert.equal(s4.text, '看看这个报错 [File #2] [Image #3]')

  // Backspace deletes [Image #3] atomically, then space, then [File #2]
  const bs1 = backspaceWithInlineAttachments(s4.text, s4.attachments)
  assert.equal(bs1.text, '看看这个报错 [File #2] ')
  assert.deepEqual(
    bs1.attachments.map((a) => a.token),
    ['[File #2]']
  )
  const bs2 = backspaceWithInlineAttachments(bs1.text, bs1.attachments)
  assert.equal(bs2.text, '看看这个报错 [File #2]')
  const bs3 = backspaceWithInlineAttachments(bs2.text, bs2.attachments)
  assert.equal(bs3.text, '看看这个报错 ')
  assert.equal(bs3.attachments.length, 0)

  // Stripping tokens before submit yields clean title & details
  const cleaned = stripInlineAttachmentTokens('[Image #1] 修复按钮样式 [File #2]\n补充说明', s3.attachments)
  assert.deepEqual(splitComposerText(cleaned), {
    title: '修复按钮样式',
    details: '补充说明'
  })
})

test('renderTui keeps inline [Image #1] on a single composer line without duplicate attachment rows or toast banners', () => {
  const saved: SavedAttachment = {
    name: 'orca-paste-123.png',
    mimeType: 'image/png',
    size: 4096,
    path: '/tmp/orca-paste-123.png'
  }
  const inserted = appendInlineAttachment('修复这个界面', [], saved)
  const state = makeBaseState(inserted.text)
  state.composer.attachments = inserted.attachments

  assert.equal(computeComposerHeight(state.composer, 110), 3)

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const buf = renderTui(state, 110, 30)
  const plainLines = buf.renderLines().map(stripAnsi)
  const fullText = plainLines.join('\n')

  assert.ok(fullText.includes('[Image #1]'))
  assert.ok(!fullText.includes('📎'))
  assert.ok(!fullText.includes('Backspace 或点击 × 删除'))
  assert.equal(buf.hitBoxes.filter((h) => h.action === 'remove-composer-attachment').length, 0)
  assert.equal(buf.hitBoxes.some((h) => h.action === 'cycle-issue-kind'), true)
  assert.equal(buf.hitBoxes.some((h) => h.action === 'cycle-submit-mode'), true)

  // Footer shows active kind & mode, and inline error notice replaces right hint without a banner
  const footerLine = plainLines[plainLines.length - 1]
  assert.ok(footerLine.includes('● 新功能'))
  assert.ok(footerLine.includes('Skill 规范提单'))

  state.errorNotice = '剪贴板中未检测到截图'
  const errBuf = renderTui(state, 110, 30)
  const errFooter = stripAnsi(errBuf.renderLines()[29])
  assert.ok(errFooter.includes('⚠ 剪贴板中未检测到截图'))

  // Reply modal also keeps [Image #1] inline without duplicate attachment chips
  const snap = state.snapshot!
  const questionItem = snap.needsYou[0]
  assert.equal(questionItem.kind, 'agent-question')
  if (questionItem.kind === 'agent-question') {
    state.modal = {
      type: 'reply',
      item: questionItem,
      text: inserted.text,
      attachments: inserted.attachments,
      sending: false
    }
    const modalBuf = renderTui(state, 110, 30)
    const modalText = modalBuf.renderLines().map(stripAnsi).join('\n')
    assert.ok(modalText.includes('[Image #1]'))
    assert.equal(modalBuf.hitBoxes.filter((h) => h.action === 'remove-reply-attachment').length, 0)
  }
})

test('Codex-style footer displays active issue kind and submit mode with cycling helpers and hit-boxes', () => {
  assert.equal(nextIssueKind('feature'), 'bug')
  assert.equal(nextIssueKind('bug'), 'polish')
  assert.equal(nextIssueKind('polish'), 'feature')
  assert.equal(nextSubmitMode('handoff'), 'direct')
  assert.equal(nextSubmitMode('direct'), 'handoff')

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  const state = makeBaseState('')
  const buf = renderTui(state, 110, 30)
  const footerLine = stripAnsi(buf.renderLines()[29]!)
  assert.ok(footerLine.includes('● 新功能'))
  assert.ok(footerLine.includes('Skill 规范提单'))
  assert.ok(footerLine.includes('⇧Tab 切换'))
  assert.ok(!footerLine.includes('Enter 提交/执行'))

  const kindHits = buf.hitBoxes.filter((h) => h.action === 'cycle-issue-kind')
  const modeHits = buf.hitBoxes.filter((h) => h.action === 'cycle-submit-mode')
  assert.equal(kindHits.length, 1)
  assert.equal(kindHits[0]?.y, 29)
  assert.equal(modeHits.length, 1)
  assert.equal(modeHits[0]?.y, 29)

  // Cycling to bug and direct mode updates the footer directly without any toast bar
  state.composer.kind = nextIssueKind(state.composer.kind)
  state.composer.mode = nextSubmitMode(state.composer.mode)
  state.composer.followUpOf = 42
  const updatedBuf = renderTui(state, 110, 30)
  const updatedFooter = stripAnsi(updatedBuf.renderLines()[29]!)
  assert.ok(updatedFooter.includes('● 修 Bug'))
  assert.ok(updatedFooter.includes('快速直提'))
  assert.ok(updatedFooter.includes('追提 #42'))
})
