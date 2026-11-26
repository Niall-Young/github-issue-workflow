import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  extractGithubIssueNumbers,
  extractTerminalQuestion,
  hasHandoffCreatedIssue,
  isHandoffSessionTitle,
  type CommandRunner
} from '../board-data'
import {
  collectOrcaAgentState,
  detectAutopilotRunning,
  loadBoardSnapshot,
  parseAgentLaunchResult,
  stopAutopilot,
  submitIssueFromTui,
  type PendingHandoff
} from './orca-cli'
import { IssueBoardTui } from './app'
import {
  buildMainRows,
  DEFAULT_SUBMIT_MODE,
  nextIssueKind,
  nextSubmitMode,
  renderTui,
  resolveMainRowUrl,
  resolveSelectedMainRowAction,
  type TuiState
} from './render'
import {
  ANSI,
  PALETTE,
  ScreenBuffer,
  stringDisplayWidth,
  truncateToWidth,
  wrapTextToWidth
} from './screen'

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
      mode: DEFAULT_SUBMIT_MODE,
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

  // Footer shows active kind & default handoff mode, and inline error notice replaces right hint without a banner
  const footerLine = plainLines[plainLines.length - 1]
  assert.ok(footerLine.includes('● 新功能'))
  assert.ok(footerLine.includes('✓ handoff 规范提单'))
  assert.ok(!footerLine.includes('○ direct 快速直提'))

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

test('Codex-style footer defaults to handoff and switches distinct labels/styles cleanly with hit-boxes and slash menu sync', () => {
  assert.equal(DEFAULT_SUBMIT_MODE, 'handoff')
  assert.equal(nextIssueKind('feature'), 'bug')
  assert.equal(nextIssueKind('bug'), 'polish')
  assert.equal(nextIssueKind('polish'), 'feature')
  assert.equal(nextSubmitMode('handoff'), 'direct')
  assert.equal(nextSubmitMode('direct'), 'handoff')

  // IssueBoardTui initializes with 'handoff' by default
  const app = new IssueBoardTui('/tmp/demo-app', { writeOutput: () => {} })
  const initialComposer = (app as unknown as { state: TuiState }).state.composer
  assert.equal(initialComposer.mode, 'handoff')

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // 1. Default state ('handoff'): highlighted handoff label
  const state = makeBaseState('')
  const buf = renderTui(state, 110, 30)
  const rawFooterHandoff = buf.renderLines()[29]!
  const footerHandoff = stripAnsi(rawFooterHandoff)
  assert.ok(footerHandoff.includes('● 新功能'))
  assert.ok(footerHandoff.includes('✓ handoff 规范提单'))
  assert.ok(!footerHandoff.includes('○ direct 快速直提'))
  assert.ok(rawFooterHandoff.includes(`${PALETTE.accentBold}✓ handoff 规范提单`))
  assert.ok(footerHandoff.includes('⇧Tab 切换'))
  assert.ok(!footerHandoff.includes('Enter 提交/执行'))

  const kindHits = buf.hitBoxes.filter((h) => h.action === 'cycle-issue-kind')
  const modeHitsHandoff = buf.hitBoxes.filter((h) => h.action === 'cycle-submit-mode')
  assert.equal(kindHits.length, 1)
  assert.equal(kindHits[0]?.y, 29)
  assert.equal(modeHitsHandoff.length, 1)
  assert.equal(modeHitsHandoff[0]?.y, 29)
  assert.equal(modeHitsHandoff[0]?.w, stringDisplayWidth('✓ handoff 规范提单'))

  // Slash menu reflects default 'handoff' active checkmark
  const slashHandoffState = makeBaseState('/')
  const slashHandoffLines = renderTui(slashHandoffState, 110, 30).renderLines().map(stripAnsi)
  const directRowHandoff = slashHandoffLines.find((l) => l.includes('/direct'))!
  const handoffRowHandoff = slashHandoffLines.find((l) => l.includes('/handoff'))!
  assert.ok(handoffRowHandoff.trimEnd().endsWith('✓'))
  assert.ok(!directRowHandoff.trimEnd().endsWith('✓'))

  // 2. Toggle to 'direct': clearly distinct dimmed direct label and updated hit-box width
  state.composer.kind = nextIssueKind(state.composer.kind)
  state.composer.mode = nextSubmitMode(state.composer.mode)
  state.composer.followUpOf = 42
  assert.equal(state.composer.mode, 'direct')
  const directBuf = renderTui(state, 110, 30)
  const rawFooterDirect = directBuf.renderLines()[29]!
  const footerDirect = stripAnsi(rawFooterDirect)
  assert.ok(footerDirect.includes('● 修 Bug'))
  assert.ok(footerDirect.includes('○ direct 快速直提'))
  assert.ok(!footerDirect.includes('✓ handoff 规范提单'))
  assert.ok(rawFooterDirect.includes(`${PALETTE.dim} · ○ direct 快速直提`))
  assert.ok(footerDirect.includes('追提 #42'))

  const modeHitsDirect = directBuf.hitBoxes.filter((h) => h.action === 'cycle-submit-mode')
  assert.equal(modeHitsDirect.length, 1)
  assert.equal(modeHitsDirect[0]?.y, 29)
  assert.equal(modeHitsDirect[0]?.x, modeHitsHandoff[0]?.x)
  assert.equal(modeHitsDirect[0]?.w, stringDisplayWidth('○ direct 快速直提'))

  // Slash menu reflects 'direct' active checkmark
  const slashDirectState = makeBaseState('/')
  slashDirectState.composer.mode = 'direct'
  const slashDirectLines = renderTui(slashDirectState, 110, 30).renderLines().map(stripAnsi)
  const directRowDirect = slashDirectLines.find((l) => l.includes('/direct'))!
  const handoffRowDirect = slashDirectLines.find((l) => l.includes('/handoff'))!
  assert.ok(directRowDirect.trimEnd().endsWith('✓'))
  assert.ok(!handoffRowDirect.trimEnd().endsWith('✓'))

  // 3. Toggle back to 'handoff' via IssueBoardTui actions (/direct -> /handoff -> click cycle-submit-mode)
  const internalApp = app as unknown as {
    state: TuiState
    dispatchAction: (action: string, payload?: unknown) => void
  }
  internalApp.dispatchAction('exec-slash', 'direct')
  assert.equal(internalApp.state.composer.mode, 'direct')
  internalApp.dispatchAction('exec-slash', 'handoff')
  assert.equal(internalApp.state.composer.mode, 'handoff')
  internalApp.dispatchAction('cycle-submit-mode')
  assert.equal(internalApp.state.composer.mode, 'direct')
  internalApp.dispatchAction('cycle-submit-mode')
  assert.equal(internalApp.state.composer.mode, 'handoff')

  // 4. Toggle back to 'handoff' in render state restores highlighted handoff label
  state.composer.mode = nextSubmitMode(state.composer.mode)
  assert.equal(state.composer.mode, 'handoff')
  const backHandoffBuf = renderTui(state, 110, 30)
  const backHandoffFooter = stripAnsi(backHandoffBuf.renderLines()[29]!)
  assert.ok(backHandoffFooter.includes('✓ handoff 规范提单'))
  assert.ok(!backHandoffFooter.includes('○ direct 快速直提'))
  assert.equal(backHandoffBuf.hitBoxes.filter((h) => h.action === 'cycle-submit-mode').length, 1)

  // 5. Narrow terminal width stays within bounds and preserves error/hint budget for both modes
  const narrowHandoff = makeBaseState('')
  narrowHandoff.composer.mode = 'handoff'
  narrowHandoff.errorNotice = '网络异常'
  const narrowHandoffFooter = stripAnsi(renderTui(narrowHandoff, 46, 20).renderLines()[19]!)
  assert.ok(stringDisplayWidth(narrowHandoffFooter) <= 46)
  assert.ok(narrowHandoffFooter.includes('✓ handoff 规范提单'))
  assert.ok(narrowHandoffFooter.includes('⚠ 网络异常'))

  const narrowDirect = makeBaseState('')
  narrowDirect.composer.mode = 'direct'
  const narrowDirectFooter = stripAnsi(renderTui(narrowDirect, 46, 20).renderLines()[19]!)
  assert.ok(stringDisplayWidth(narrowDirectFooter) <= 46)
  assert.ok(narrowDirectFooter.includes('○ direct 快速直提'))
  assert.ok(narrowDirectFooter.includes('⇧Tab 切换'))
})

test('extractTerminalQuestion strips CLI chrome and handoff issue detection matches created URLs', () => {
  const raw = [
    '为避免理解偏差，请确认方案：',
    '1. 默认关闭 Skill 规范提单',
    '2. 新增第 3 个独立开关',
    '您直接回复编号即可。',
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    '? for shortcuts',
    '剩余 80% 3d 16h'
  ].join('\n')
  const question = extractTerminalQuestion(raw)
  assert.ok(question.includes('1. 默认关闭 Skill 规范提单'))
  assert.ok(question.includes('您直接回复编号即可。'))
  assert.ok(!question.includes('Auto mode'))
  assert.ok(!question.includes('for shortcuts'))
  assert.ok(!question.includes('剩余 80%'))

  assert.equal(isHandoffSessionTitle('请严格按照 github issue handoff Skill'), true)
  assert.equal(isHandoffSessionTitle('普通终端任务'), false)
  assert.deepEqual(
    extractGithubIssueNumbers(
      '已创建 Issue: https://github.com/acme/demo-app/issues/12',
      'acme/demo-app'
    ),
    [12]
  )

  const startedMs = Date.parse('2026-11-26T08:40:00Z')
  assert.equal(
    hasHandoffCreatedIssue({
      output: '已创建 https://github.com/acme/demo-app/issues/12',
      repository: 'acme/demo-app',
      githubIssues: [
        {
          number: 12,
          title: '[Feature] 新开关',
          state: 'OPEN',
          url: 'https://github.com/acme/demo-app/issues/12',
          createdAt: '2026-11-26T08:42:00Z',
          updatedAt: '2026-11-26T08:42:00Z',
          closedAt: null,
          labels: []
        }
      ],
      startedMs
    }),
    true
  )
  // Mentioning an old issue from days ago does not count as creating a new issue
  assert.equal(
    hasHandoffCreatedIssue({
      output: '发现可能与历史单 https://github.com/acme/demo-app/issues/3 相关，请确认是否继续？',
      repository: 'acme/demo-app',
      githubIssues: [
        {
          number: 3,
          title: '[Feature] 旧单',
          state: 'CLOSED',
          url: 'https://github.com/acme/demo-app/issues/3',
          createdAt: '2026-11-20T08:00:00Z',
          updatedAt: '2026-11-20T08:00:00Z',
          closedAt: '2026-11-20T09:00:00Z',
          labels: []
        }
      ],
      startedMs
    }),
    false
  )
})

test('collectOrcaAgentState resolves real term_ handle via paneKey and surfaces handoff questions when agent stops in done state', async () => {
  const repoPath = '/tmp/demo-handoff-repo'
  const nowMs = Date.now()
  const startedMs = nowMs - 60_000 // Past 25s boot grace window!

  const makeRunner = (opts: {
    agentState: string
    preview: string
    githubIssues?: Array<Record<string, unknown>>
  }): CommandRunner => {
    return async (cmd, args) => {
      if (cmd === 'git' && args.includes('--show-toplevel')) {
        return { stdout: `${repoPath}\n`, stderr: '', exitCode: 0 }
      }
      if (cmd === 'git' && args.includes('get-url')) {
        return { stdout: 'https://github.com/acme/demo-handoff-repo.git\n', stderr: '', exitCode: 0 }
      }
      if (cmd === 'gh' && args[0] === 'issue') {
        return { stdout: JSON.stringify(opts.githubIssues ?? []), stderr: '', exitCode: 0 }
      }
      if (cmd === 'gh' && args[0] === 'pr') {
        return { stdout: '[]', stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'installed') {
        return { stdout: JSON.stringify({ result: { agents: [{ id: 'antigravity', default: true }] } }), stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              agents: [
                {
                  orcaSessionId: 'sess-1',
                  kind: 'terminal',
                  agent: 'antigravity',
                  state: opts.agentState,
                  worktreeId: `wt::${repoPath}`,
                  workspace: 'main',
                  repo: 'demo-handoff-repo',
                  paneKey: 'tab-1:leaf-1',
                  title: '请严格按照 github issue handoff Skill',
                  lastAssistantMessage: null,
                  updatedAt: nowMs
                }
              ]
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            result: {
              terminals: [
                {
                  handle: 'term_real_123',
                  worktreeId: `wt::${repoPath}`,
                  worktreePath: repoPath,
                  tabId: 'tab-1',
                  leafId: 'leaf-1',
                  title: '请严格按照 github issue handoff Skill',
                  connected: true,
                  writable: true,
                  lastOutputAt: nowMs,
                  preview: opts.preview,
                  agentIdentity: 'antigravity'
                }
              ]
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        return {
          stdout: JSON.stringify({ result: { terminal: { tail: opts.preview.split('\n') } } }),
          stderr: '',
          exitCode: 0
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
  }

  // 1. Agent still working after 60s: matched via term_real_123 <-> paneKey, stays in inProgress
  const pending = new Map<string, PendingHandoff>([
    [
      'term_real_123',
      {
        terminalId: 'term_real_123',
        repoPath,
        title: '支持配置 Skill 提单开关',
        agent: 'antigravity',
        startedAt: new Date(startedMs).toISOString(),
        startedMs
      }
    ]
  ])

  const workingSnap = await loadBoardSnapshot(
    repoPath,
    pending,
    makeRunner({ agentState: 'working', preview: 'Reading repo files...' })
  )
  assert.equal(workingSnap.inProgress.length, 1)
  assert.equal(workingSnap.inProgress[0]?.title, '支持配置 Skill 提单开关')
  assert.equal(workingSnap.inProgress[0]?.statusLabel, 'Skill 整理提单中 (antigravity)')
  assert.equal(workingSnap.needsYou.length, 0)
  assert.equal(pending.has('term_real_123'), true)

  // 2. Agent finishes turn (state: "done") with a clarifying question and no Issue URL:
  //    stays visible in inProgress as "Skill 等待确认" AND appears in needsYou with real term_ handle!
  const questionPreview =
    '请确认您的期望更接近哪种方案：\n1. 默认关闭 Skill 提单\n2. 新增第 3 个独立开关\n> Auto mode: edits\n? for shortcuts'
  const waitingSnap = await loadBoardSnapshot(
    repoPath,
    pending,
    makeRunner({ agentState: 'done', preview: questionPreview })
  )
  assert.equal(waitingSnap.inProgress.length, 1)
  assert.equal(waitingSnap.inProgress[0]?.statusLabel, 'Skill 等待确认 (antigravity)')
  assert.equal(waitingSnap.needsYou.length, 1)
  const qItem = waitingSnap.needsYou[0]
  assert.equal(qItem?.kind, 'agent-question')
  if (qItem?.kind === 'agent-question') {
    assert.equal(qItem.terminalId, 'term_real_123')
    assert.equal(qItem.title, '支持配置 Skill 提单开关')
    assert.ok(qItem.question.includes('1. 默认关闭 Skill 提单'))
    assert.ok(!qItem.question.includes('for shortcuts'))
  }
  assert.equal(pending.has('term_real_123'), true)

  // 3. Even if pendingHandoffs is empty (e.g. TUI restarted), unanswered handoff is still discovered
  const discoveredSnap = await loadBoardSnapshot(
    repoPath,
    new Map(),
    makeRunner({ agentState: 'done', preview: questionPreview })
  )
  assert.equal(discoveredSnap.inProgress.length, 1)
  assert.equal(discoveredSnap.inProgress[0]?.statusLabel, 'Skill 等待确认 (antigravity)')
  assert.equal(discoveredSnap.needsYou.length, 1)

  // 4. Once the agent creates the GitHub Issue and finishes, pendingHandoff is cleared
  const createdSnap = await loadBoardSnapshot(
    repoPath,
    pending,
    makeRunner({
      agentState: 'done',
      preview: '已创建 Issue：https://github.com/acme/demo-handoff-repo/issues/15',
      githubIssues: [
        {
          number: 15,
          title: '[Feature] 支持配置 Skill 提单开关',
          state: 'OPEN',
          url: 'https://github.com/acme/demo-handoff-repo/issues/15',
          createdAt: new Date(nowMs - 5_000).toISOString(),
          updatedAt: new Date(nowMs - 5_000).toISOString(),
          closedAt: null,
          labels: [{ name: 'agent-ready' }]
        }
      ]
    })
  )
  assert.equal(pending.has('term_real_123'), false)
  assert.equal(createdSnap.needsYou.length, 0)
  assert.equal(createdSnap.inProgress.some((it) => it.issueNumber === 15), true)

  // 5. Explicit waiting agent resolves real term_ handle instead of stale paneKey
  const explicitWait = await collectOrcaAgentState(
    repoPath,
    makeRunner({ agentState: 'waiting', preview: '是否允许执行数据库迁移？' })
  )
  assert.equal(explicitWait.questions.length, 1)
  assert.equal(
    explicitWait.questions[0]?.kind === 'agent-question' ? explicitWait.questions[0].terminalId : '',
    'term_real_123'
  )
})

test('resolveMainRowUrl and resolveSelectedMainRowAction handle issues, PRs, empty handoff URLs, sections, and attention pane', () => {
  const snap = makeSampleSnapshot()
  snap.inProgress.push({
    id: 'handoff-term-1',
    issueNumber: null,
    title: '本地整理中的需求',
    url: '',
    statusLabel: 'Skill 整理提单中',
    updatedAt: new Date().toISOString()
  })
  snap.completed.push({
    id: 'completed-9',
    issueNumber: 9,
    title: '已修复布局偏移',
    url: 'https://github.com/acme/demo-app/issues/9',
    prUrl: 'https://github.com/acme/demo-app/pull/19',
    summary: '已合并',
    completedAt: new Date().toISOString()
  })

  const issueRows = buildMainRows(snap, 'issues')
  // [0]: section 进行中, [1]: inProgress #12, [2]: handoff (empty url), [3]: section 已完成, [4]: completed #9
  assert.equal(resolveMainRowUrl(issueRows[0]), null)
  assert.equal(resolveMainRowUrl(issueRows[1]), 'https://github.com/acme/demo-app/issues/12')
  assert.equal(resolveMainRowUrl(issueRows[2]), null)
  assert.equal(resolveMainRowUrl(issueRows[3]), null)
  assert.equal(resolveMainRowUrl(issueRows[4]), 'https://github.com/acme/demo-app/issues/9')

  const base = makeBaseState('')
  base.snapshot = snap

  // Section header -> ignore
  base.selectedIndex = 0
  assert.deepEqual(resolveSelectedMainRowAction(base), { kind: 'ignore' })

  // inProgress with valid URL -> open
  base.selectedIndex = 1
  assert.deepEqual(resolveSelectedMainRowAction(base), {
    kind: 'open',
    url: 'https://github.com/acme/demo-app/issues/12'
  })

  // Local handoff with empty URL -> no-url
  base.selectedIndex = 2
  assert.deepEqual(resolveSelectedMainRowAction(base), { kind: 'no-url' })

  // Completed issue with valid URL -> open
  base.selectedIndex = 4
  assert.deepEqual(resolveSelectedMainRowAction(base), {
    kind: 'open',
    url: 'https://github.com/acme/demo-app/issues/9'
  })

  // Attention pane focused -> ignore (must not open main list item)
  base.activePane = 'attention'
  assert.deepEqual(resolveSelectedMainRowAction(base), { kind: 'ignore' })

  // PRs tab -> open PR URL
  base.activePane = 'main'
  base.activeTab = 'prs'
  base.selectedIndex = 1
  assert.deepEqual(resolveSelectedMainRowAction(base), {
    kind: 'open',
    url: 'https://github.com/acme/demo-app/pull/18'
  })
})

test('IssueBoardTui opens selected Issue/PR directly in browser on Enter or second click without detail modal', () => {
  const openedUrls: string[] = []
  const tui = new IssueBoardTui('/tmp/demo-app', {
    openUrl: (url) => {
      openedUrls.push(url)
    },
    writeOutput: () => {}
  })

  const snap = makeSampleSnapshot()
  snap.inProgress.push({
    id: 'handoff-local',
    issueNumber: null,
    title: '本地待提单',
    url: '',
    statusLabel: 'Skill 整理提单中',
    updatedAt: new Date().toISOString()
  })
  snap.completed.push({
    id: 'completed-9',
    issueNumber: 9,
    title: '已完成需求',
    url: 'https://github.com/acme/demo-app/issues/9',
    prUrl: null,
    summary: 'done',
    completedAt: new Date().toISOString()
  })

  const internal = tui as unknown as {
    state: TuiState
    handleEvent: (ev: { type: 'key'; key: string; raw: string; shift?: boolean; ctrl?: boolean }) => void
    dispatchAction: (action: string, payload?: unknown) => void
  }
  internal.state.snapshot = snap
  internal.state.loading = false
  internal.state.activeTab = 'issues'
  internal.state.activePane = 'main'
  internal.state.selectedIndex = 1

  // 1. Pressing Enter with empty composer on inProgress issue opens browser directly, no modal
  internal.handleEvent({ type: 'key', key: 'enter', raw: '\r' })
  assert.deepEqual(openedUrls, ['https://github.com/acme/demo-app/issues/12'])
  assert.equal(internal.state.modal.type, 'none')

  // 2. Clicking an unselected row (completed #9 at index 4) only selects it; second click opens browser
  internal.dispatchAction('select-main-row', 4)
  assert.equal(internal.state.selectedIndex, 4)
  assert.equal(openedUrls.length, 1)
  assert.equal(internal.state.modal.type, 'none')

  internal.dispatchAction('select-main-row', 4)
  assert.deepEqual(openedUrls, [
    'https://github.com/acme/demo-app/issues/12',
    'https://github.com/acme/demo-app/issues/9'
  ])
  assert.equal(internal.state.modal.type, 'none')

  // 3. Local handoff row (index 2, empty url) does not open browser or modal, sets errorNotice
  internal.state.selectedIndex = 2
  internal.handleEvent({ type: 'key', key: 'enter', raw: '\r' })
  assert.equal(openedUrls.length, 2)
  assert.equal(internal.state.modal.type, 'none')
  assert.equal(internal.state.errorNotice, '该条目尚未生成 GitHub 链接')

  // 4. Section header row (index 0) is safely ignored
  internal.state.selectedIndex = 0
  internal.handleEvent({ type: 'key', key: 'enter', raw: '\r' })
  assert.equal(openedUrls.length, 2)
  assert.equal(internal.state.modal.type, 'none')
  assert.equal(internal.state.errorNotice, null)

  // 5. Switching to PRs tab and pressing Enter opens PR URL directly
  internal.dispatchAction('switch-tab', 'prs')
  assert.equal(internal.state.selectedIndex, 1)
  internal.handleEvent({ type: 'key', key: 'enter', raw: '\r' })
  assert.deepEqual(openedUrls, [
    'https://github.com/acme/demo-app/issues/12',
    'https://github.com/acme/demo-app/issues/9',
    'https://github.com/acme/demo-app/pull/18'
  ])
  assert.equal(internal.state.modal.type, 'none')

  // 6. Focus on attention pane: pressing Enter does not open main list item
  internal.state.activePane = 'attention'
  internal.handleEvent({ type: 'key', key: 'enter', raw: '\r' })
  assert.equal(openedUrls.length, 3)
  assert.equal(internal.state.modal.type, 'none')

  // 7. Settings and reply modals remain functional and close on Escape
  internal.dispatchAction('open-settings')
  assert.equal(internal.state.modal.type, 'settings')
  const settingsBuf = renderTui(internal.state, 110, 30)
  assert.equal(settingsBuf.hitBoxes.some((h) => h.action === 'settings-save'), true)
  internal.handleEvent({ type: 'key', key: 'escape', raw: '\x1b' })
  assert.equal(internal.state.modal.type, 'none')

  const qItem = snap.needsYou[0]
  assert.equal(qItem?.kind, 'agent-question')
  internal.dispatchAction('open-reply', qItem)
  assert.equal(internal.state.modal.type, 'reply')
  const replyBuf = renderTui(internal.state, 110, 30)
  assert.equal(replyBuf.hitBoxes.some((h) => h.action === 'reply-submit'), true)
  internal.handleEvent({ type: 'key', key: 'escape', raw: '\x1b' })
  assert.equal(internal.state.modal.type, 'none')
})

test('loadBoardSnapshot surfaces handoff unexpected exit, handoff stall, and system-alert rendering', async () => {
  const repoPath = '/tmp/demo-fallback-repo'
  const nowMs = Date.parse('2026-11-26T17:30:00Z')
  const startedMs = nowMs - 12 * 60_000

  const makeRunner = (opts: {
    agents: unknown[]
    terminals: unknown[]
    ghExitCode?: number
    ghStderr?: string
  }): CommandRunner => {
    return async (cmd, args) => {
      if (cmd === 'git' && args.includes('--show-toplevel')) {
        return { stdout: `${repoPath}\n`, stderr: '', exitCode: 0 }
      }
      if (cmd === 'git' && args.includes('get-url')) {
        return { stdout: 'https://github.com/acme/demo-fallback-repo.git\n', stderr: '', exitCode: 0 }
      }
      if (cmd === 'gh' && args[0] === 'issue') {
        return {
          stdout: opts.ghExitCode ? '' : '[]',
          stderr: opts.ghStderr || '',
          exitCode: opts.ghExitCode ?? 0
        }
      }
      if (cmd === 'gh' && args[0] === 'pr') {
        return { stdout: '[]', stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'installed') {
        return { stdout: JSON.stringify({ result: { agents: [] } }), stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'list') {
        return { stdout: JSON.stringify({ result: { agents: opts.agents } }), stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
        return { stdout: JSON.stringify({ result: { terminals: opts.terminals } }), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
  }

  // 1. Handoff terminal exited unexpectedly without creating an Issue -> surfaces system-alert instead of vanishing
  const exitedPending = new Map<string, PendingHandoff>([
    [
      'term_crashed',
      {
        terminalId: 'term_crashed',
        repoPath,
        title: '修复崩溃提单任务',
        agent: 'codex',
        startedAt: new Date(startedMs).toISOString(),
        startedMs
      }
    ]
  ])
  const exitedSnap = await loadBoardSnapshot(
    repoPath,
    exitedPending,
    makeRunner({ agents: [], terminals: [] }),
    { nowMs }
  )
  assert.equal(exitedSnap.needsYou.length, 1)
  assert.equal(exitedSnap.needsYou[0]?.kind, 'system-alert')
  if (exitedSnap.needsYou[0]?.kind === 'system-alert') {
    assert.equal(exitedSnap.needsYou[0].badge, '提单中断')
    assert.equal(exitedSnap.needsYou[0].retryTitle, '修复崩溃提单任务')
  }

  // Verify renderTui renders system-alert buttons cleanly
  const state = makeBaseState()
  state.snapshot = exitedSnap
  const buf = renderTui(state, 120, 32)
  const actions = new Set(buf.hitBoxes.map((h) => h.action))
  assert.equal(actions.has('retry-handoff-alert'), true)
  assert.equal(actions.has('dismiss-alert'), true)

  // 2. Handoff stalled in working state for > 10 minutes -> surfaces agent-question & Skill 可能卡住
  const stalledPending = new Map<string, PendingHandoff>([
    [
      'term_stalled',
      {
        terminalId: 'term_stalled',
        repoPath,
        title: '卡住的提单任务',
        agent: 'codex',
        startedAt: new Date(startedMs).toISOString(),
        startedMs,
        lastActivityMs: startedMs
      }
    ]
  ])
  const stalledSnap = await loadBoardSnapshot(
    repoPath,
    stalledPending,
    makeRunner({
      agents: [
        {
          agent: 'codex',
          state: 'working',
          worktreeId: `wt::${repoPath}`,
          paneKey: 'tab-9:leaf-9',
          title: 'github-issue-handoff',
          updatedAt: startedMs
        }
      ],
      terminals: [
        {
          handle: 'term_stalled',
          worktreeId: `wt::${repoPath}`,
          worktreePath: repoPath,
          tabId: 'tab-9',
          leafId: 'leaf-9',
          title: 'github-issue-handoff',
          connected: true,
          lastOutputAt: startedMs,
          preview: 'Running git status...'
        }
      ]
    }),
    { nowMs }
  )
  assert.equal(stalledSnap.inProgress[0]?.statusLabel, 'Skill 可能卡住 (codex)')
  assert.equal(stalledSnap.needsYou.length, 1)
  assert.equal(stalledSnap.needsYou[0]?.kind, 'agent-question')
  if (stalledSnap.needsYou[0]?.kind === 'agent-question') {
    assert.ok(stalledSnap.needsYou[0].question.includes('无新输出'))
  }

  // 3. gh auth failure surfaces system-alert
  const ghErrSnap = await loadBoardSnapshot(
    repoPath,
    new Map(),
    makeRunner({
      agents: [],
      terminals: [],
      ghExitCode: 4,
      ghStderr: 'not logged into any GitHub hosts. Run gh auth login'
    }),
    { nowMs }
  )
  assert.equal(ghErrSnap.needsYou.some((i) => i.kind === 'system-alert' && i.badge === 'GitHub 鉴权失效'), true)
})

test('bottom composer keeps its borders fixed and the native cursor at the visible end of the draft', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // Empty composer: cursor at (textAreaX=3, composerTop+1=27)
  const emptyState = makeBaseState('')
  const emptyBuf = renderTui(emptyState, 100, 30)
  assert.deepEqual(emptyBuf.cursor, { x: 3, y: 27 })
  assert.ok(!emptyBuf.renderLines().map(stripAnsi).join('\n').includes('▏'))
  const emptyDiff = emptyBuf.diffOutput(null, null)
  assert.ok(emptyDiff.output.startsWith(ANSI.cursorHide))
  assert.ok(emptyDiff.output.endsWith(`\x1b[28;4H${ANSI.cursorShow}`))

  // Mixed CJK + ASCII: "修复 Bug 123" has display width 12 -> cursor x = 3 + 12 = 15
  const mixedState = makeBaseState('修复 Bug 123')
  const mixedBuf = renderTui(mixedState, 100, 30)
  assert.deepEqual(mixedBuf.cursor, { x: 15, y: 27 })
  assert.ok(!mixedBuf.renderLines().map(stripAnsi).join('\n').includes('▏'))

  // Keep both dividers, the prompt and the status bar fixed throughout editing.
  const width = 24
  const height = 30
  const empty = renderTui(makeBaseState(''), width, height)
  const bounds = empty.hitBoxes.find((box) => box.action === 'focus-composer')!
  const original = empty.renderLines()
  for (const [draft, visible] of [
    ['a'.repeat(20), 'a'.repeat(20)],
    ['a'.repeat(19) + '中', 'a'.repeat(18) + '中'],
    ['中' + 'a'.repeat(19), 'a'.repeat(19)],
    ['a'.repeat(80) + '最新abc', 'a'.repeat(13) + '最新abc'],
    ['第一行\n第二行\n第三行\n第四行', '第四行'],
    ['第一行\n', ''],
    ['/', '/']
  ]) {
    const frame = renderTui(makeBaseState(draft), width, height)
    const lines = frame.renderLines()
    assert.deepEqual(frame.hitBoxes.find((box) => box.action === 'focus-composer'), bounds)
    assert.equal(lines[bounds.y], original[bounds.y])
    assert.equal(lines[bounds.y + 2], original[bounds.y + 2])
    assert.equal(lines[height - 1], original[height - 1])
    assert.equal(stripAnsi(lines[bounds.y + 1]).trimEnd(), (' ❯ ' + visible).trimEnd())
    const caret = { x: 3 + stringDisplayWidth(visible), y: bounds.y + 1 }
    assert.deepEqual(frame.cursor, caret)
    assert.ok(frame.diffOutput(original, empty.cursor).output.endsWith(
      `\x1b[${caret.y + 1};${caret.x + 1}H${ANSI.cursorShow}`
    ))
  }
})

test('renderTui positions native cursor in reply modal and hides cursor in non-editable states', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const state = makeBaseState('')
  const questionItem = state.snapshot!.needsYou[0]
  assert.equal(questionItem.kind, 'agent-question')

  if (questionItem.kind === 'agent-question') {
    // Empty reply modal
    state.modal = {
      type: 'reply',
      item: questionItem,
      text: '',
      attachments: [],
      sending: false
    }
    const emptyReplyBuf = renderTui(state, 100, 30)
    assert.ok(emptyReplyBuf.cursor !== null)
    const emptyPos = emptyReplyBuf.cursor!
    assert.ok(!emptyReplyBuf.renderLines().map(stripAnsi).join('\n').includes('▏'))
    const emptyReplyDiff = emptyReplyBuf.diffOutput(null, null)
    assert.ok(
      emptyReplyDiff.output.endsWith(`\x1b[${emptyPos.y + 1};${emptyPos.x + 1}H${ANSI.cursorShow}`)
    )

    // Mixed CJK reply text shifts cursor by display width (10)
    state.modal.text = '收到，继续'
    const cjkReplyBuf = renderTui(state, 100, 30)
    assert.deepEqual(cjkReplyBuf.cursor, { x: emptyPos.x + 10, y: emptyPos.y })
    assert.ok(!cjkReplyBuf.renderLines().map(stripAnsi).join('\n').includes('▏'))

    // Sending reply hides cursor
    state.modal.sending = true
    const sendingReplyBuf = renderTui(state, 100, 30)
    assert.equal(sendingReplyBuf.cursor, null)
    const sendingDiff = sendingReplyBuf.diffOutput(null, emptyPos)
    assert.ok(sendingDiff.output.includes(ANSI.cursorHide))
    assert.ok(!sendingDiff.output.includes(ANSI.cursorShow))
  }

  // Submitting bottom composer hides cursor
  const submittingState = makeBaseState('提交中测试')
  submittingState.composer.submitting = true
  const submittingBuf = renderTui(submittingState, 100, 30)
  assert.equal(submittingBuf.cursor, null)
  const submittingDiff = submittingBuf.diffOutput(null, null)
  assert.ok(submittingDiff.output.includes(ANSI.cursorHide))
  assert.ok(!submittingDiff.output.includes(ANSI.cursorShow))

  // Settings modal hides cursor
  const settingsState = makeBaseState('')
  settingsState.modal = {
    type: 'settings',
    defaultAgent: 'codex',
    allowedAgents: ['codex', 'claude'],
    cursor: 0,
    saving: false
  }
  const settingsBuf = renderTui(settingsState, 100, 30)
  assert.equal(settingsBuf.cursor, null)

  // Detail modal hides cursor
  const detailState = makeBaseState('')
  detailState.modal = {
    type: 'detail',
    title: '#12 支持终端鼠标点击',
    subtitle: '状态：处理中',
    body: '详情内容'
  }
  const detailBuf = renderTui(detailState, 100, 30)
  assert.equal(detailBuf.cursor, null)
})

test('ScreenBuffer diffOutput keeps cursor accurate across partial updates, unchanged frames, and cursor-only changes', () => {
  const buf1 = new ScreenBuffer(40, 12)
  buf1.writeText(0, 0, 'Header 1')
  buf1.setCursor(5, 10)
  const f1 = buf1.diffOutput(null, null)
  assert.ok(f1.output.startsWith(ANSI.cursorHide))
  assert.ok(f1.output.endsWith(`\x1b[11;6H${ANSI.cursorShow}`))

  // Identical frame and identical cursor -> no output
  const f2 = buf1.diffOutput(f1.lines, f1.cursor)
  assert.equal(f2.output, '')

  // Background partial row update while cursor stays at (5, 10)
  const buf3 = new ScreenBuffer(40, 12)
  buf3.writeText(0, 0, 'Header 2')
  buf3.setCursor(5, 10)
  const f3 = buf3.diffOutput(f2.lines, f2.cursor)
  assert.ok(f3.output.startsWith(ANSI.cursorHide))
  assert.ok(f3.output.includes('\x1b[1;1H'))
  assert.ok(f3.output.endsWith(`\x1b[11;6H${ANSI.cursorShow}`))

  // Same lines, cursor hidden -> only ANSI.cursorHide
  buf3.clearCursor()
  const f4 = buf3.diffOutput(f3.lines, f3.cursor)
  assert.equal(f4.output, ANSI.cursorHide)

  // Same lines, cursor restored -> move + show
  buf3.setCursor(8, 10)
  const f5 = buf3.diffOutput(f4.lines, f4.cursor)
  assert.equal(f5.output, `\x1b[11;9H${ANSI.cursorShow}`)
})

test('ScreenBuffer diffOutput avoids bottom-right corner writes with CSI K to prevent wrap scrolling', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  const width = 100
  const height = 30

  for (const errorNotice of [null, '剪贴板中未检测到截图']) {
    const state = makeBaseState('')
    state.errorNotice = errorNotice
    const buf = renderTui(state, width, height)
    const { output } = buf.diffOutput(null, null)

    const lastRowMarker = `\x1b[${height};1H`
    const startIdx = output.indexOf(lastRowMarker)
    assert.ok(startIdx >= 0, 'expected last row output')
    const afterMarker = output.slice(startIdx + lastRowMarker.length)
    const nextCursorMove = afterMarker.indexOf('\x1b[28;')
    assert.ok(nextCursorMove > 0, 'expected cursor restore after last row')
    const lastRowChunk = afterMarker.slice(0, nextCursorMove)

    assert.ok(
      lastRowChunk.endsWith(ANSI.clearToLineEnd),
      'last row should end with CSI K instead of padding to bottom-right corner'
    )
    const visibleWidth = stringDisplayWidth(stripAnsi(lastRowChunk))
    assert.ok(
      visibleWidth < width,
      `last row visible width (${visibleWidth}) must stay strictly below terminal width (${width})`
    )
  }
})

test('IssueBoardTui emits atomic synchronized frames on initial render and keeps composer fixed on image paste', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'orca-tui-paste-test-'))
  const prevStateRoot = process.env.GITHUB_ISSUE_AUTOPILOT_STATE_ROOT
  process.env.GITHUB_ISSUE_AUTOPILOT_STATE_ROOT = join(tmpDir, 'state')

  try {
    const sampleImg = join(tmpDir, 'shot.png')
    writeFileSync(sampleImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const chunks: string[] = []
    const app = new IssueBoardTui(tmpDir, {
      writeOutput: (chunk) => chunks.push(chunk)
    })
    const internal = app as unknown as {
      state: TuiState
      lastBuffer: ScreenBuffer | null
      render: (forceClear?: boolean) => void
      handleEvent: (ev: { type: 'paste'; text: string }) => void
      showError: (text: string) => void
    }
    internal.state.snapshot = makeSampleSnapshot()
    internal.state.loading = false

    // 1. Initial forceClear render must be a single atomic synchronized write (no split clearScreen)
    internal.render(true)
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].startsWith(ANSI.syncStart))
    assert.ok(chunks[0].endsWith(ANSI.syncEnd))
    assert.ok(chunks[0].includes(ANSI.clearScreen))
    const initialBounds = internal.lastBuffer!.hitBoxes.find((b) => b.action === 'focus-composer')
    const initialCursor = internal.lastBuffer!.cursor
    assert.ok(initialBounds)
    assert.ok(initialCursor)
    const composerInputRow1Based = initialBounds.y + 2

    // 2. Bracketed paste (Cmd+V local image path) inserts [Image #1] and only updates the composer input row
    chunks.length = 0
    internal.handleEvent({ type: 'paste', text: sampleImg })
    assert.equal(internal.state.composer.text, '[Image #1]')
    assert.equal(internal.state.composer.attachments.length, 1)
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].startsWith(ANSI.syncStart))
    assert.ok(chunks[0].endsWith(ANSI.syncEnd))
    assert.ok(!chunks[0].includes(ANSI.clearScreen))
    assert.ok(chunks[0].includes(`\x1b[${composerInputRow1Based};1H`))
    assert.ok(!chunks[0].includes(`\x1b[${initialBounds.y + 1};1H`))
    assert.ok(!chunks[0].includes(`\x1b[${initialBounds.y + 3};1H`))
    assert.deepEqual(
      internal.lastBuffer!.hitBoxes.find((b) => b.action === 'focus-composer'),
      initialBounds
    )
    assert.equal(internal.lastBuffer!.cursor?.y, initialCursor.y)
    assert.equal(
      internal.lastBuffer!.cursor?.x,
      initialCursor.x + stringDisplayWidth('[Image #1]')
    )

    // 3. Error notice on footer (e.g. Ctrl+V when clipboard has no image) updates only footer safely with CSI K
    chunks.length = 0
    internal.showError('剪贴板中未检测到截图')
    assert.equal(chunks.length, 1)
    assert.ok(chunks[0].startsWith(ANSI.syncStart))
    assert.ok(chunks[0].endsWith(ANSI.syncEnd))
    assert.ok(chunks[0].includes(ANSI.clearToLineEnd))
    assert.deepEqual(
      internal.lastBuffer!.hitBoxes.find((b) => b.action === 'focus-composer'),
      initialBounds
    )
    assert.equal(internal.lastBuffer!.cursor?.y, initialCursor.y)
  } finally {
    if (prevStateRoot === undefined) {
      delete process.env.GITHUB_ISSUE_AUTOPILOT_STATE_ROOT
    } else {
      process.env.GITHUB_ISSUE_AUTOPILOT_STATE_ROOT = prevStateRoot
    }
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('parseAgentLaunchResult handles modern outcome.handle, nested launch.outcome, and legacy shapes', () => {
  assert.deepEqual(
    parseAgentLaunchResult(
      JSON.stringify({
        ok: true,
        result: {
          outcome: {
            kind: 'terminal',
            handle: 'term_modern_1',
            paneKey: 'tab-1:leaf-1',
            orcaSessionId: 'sess-1'
          }
        }
      })
    ),
    {
      terminalId: 'term_modern_1',
      paneKey: 'tab-1:leaf-1',
      orcaSessionId: 'sess-1'
    }
  )

  assert.deepEqual(
    parseAgentLaunchResult(
      JSON.stringify({
        ok: true,
        result: {
          launch: {
            outcome: {
              kind: 'terminal',
              handle: 'term_nested_2'
            },
            terminal: { tabId: 'tab-2', leafId: 'leaf-2' }
          }
        }
      })
    ),
    {
      terminalId: 'term_nested_2',
      paneKey: 'tab-2:leaf-2',
      orcaSessionId: undefined
    }
  )

  assert.deepEqual(
    parseAgentLaunchResult(
      JSON.stringify({
        ok: true,
        result: { agentTerminalHandle: 'term_legacy_3' }
      })
    ),
    {
      terminalId: 'term_legacy_3',
      paneKey: undefined,
      orcaSessionId: undefined
    }
  )

  assert.deepEqual(parseAgentLaunchResult('not-json'), {})
})

test('handoff tracking avoids false exit alert for outcome.handle launches, synthetic fallback adoption, and transient Orca CLI errors', async () => {
  const repoPath = '/tmp/demo-handoff-tracking'
  const pendingHandoffs = new Map<string, PendingHandoff>()
  const launchedHandle = 'term_live_handoff'
  const launchedPaneKey = 'tab-live:leaf-live'
  const launchedSessionId = 'sess-live-handoff'

  const baseRunner = (opts: { orcaReachable?: boolean; includeLiveAgent?: boolean }): CommandRunner => {
    return async (cmd, args) => {
      if (cmd === 'git' && args.includes('--show-toplevel')) {
        return { stdout: `${repoPath}\n`, stderr: '', exitCode: 0 }
      }
      if (cmd === 'git' && args.includes('get-url')) {
        return { stdout: 'https://github.com/acme/demo-handoff-tracking.git\n', stderr: '', exitCode: 0 }
      }
      if (cmd === 'gh' && (args[0] === 'issue' || args[0] === 'pr')) {
        return { stdout: '[]', stderr: '', exitCode: 0 }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'installed') {
        return {
          stdout: JSON.stringify({ result: { agents: [{ id: 'antigravity', default: true }] } }),
          stderr: '',
          exitCode: 0
        }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'launch') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              outcome: {
                kind: 'terminal',
                handle: launchedHandle
              },
              receipt: { detail: 'started terminal' }
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      if (cmd === 'orca' && args[0] === 'agent' && args[1] === 'list') {
        if (opts.orcaReachable === false) {
          return { stdout: '', stderr: 'runtime_unavailable', exitCode: 1 }
        }
        return {
          stdout: JSON.stringify({
            result: {
              agents:
                opts.includeLiveAgent === false
                  ? []
                  : [
                      {
                        orcaSessionId: launchedSessionId,
                        kind: 'terminal',
                        agent: 'antigravity',
                        state: 'working',
                        worktreeId: `wt::${repoPath}`,
                        repo: 'demo-handoff-tracking',
                        paneKey: launchedPaneKey,
                        title: '请严格按照 github issue handoff Skill',
                        updatedAt: Date.now()
                      }
                    ]
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
        if (opts.orcaReachable === false) {
          return { stdout: '', stderr: 'runtime_unavailable', exitCode: 1 }
        }
        return {
          stdout: JSON.stringify({
            result: {
              terminals:
                opts.includeLiveAgent === false
                  ? []
                  : [
                      {
                        handle: launchedHandle,
                        worktreeId: `wt::${repoPath}`,
                        worktreePath: repoPath,
                        tabId: 'tab-live',
                        leafId: 'leaf-live',
                        title: '请严格按照 github issue handoff Skill',
                        connected: true,
                        lastOutputAt: Date.now(),
                        preview: 'Running gh issue list...'
                      }
                    ]
            }
          }),
          stderr: '',
          exitCode: 0
        }
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    }
  }

  // 1. Launch with outcome.handle -> tracked cleanly even past 25s grace window
  const created = await submitIssueFromTui({
    repoPath,
    repository: 'acme/demo-handoff-tracking',
    autopilotInstalled: true,
    defaultAgent: 'antigravity',
    mode: 'handoff',
    kind: 'bug',
    title: '切换为 handoff 没有任何下方变化',
    pendingHandoffs,
    runner: baseRunner({})
  })
  assert.equal(created.terminalId, launchedHandle)
  const entry = pendingHandoffs.get(launchedHandle)
  assert.ok(entry)

  const snapAfterGrace = await loadBoardSnapshot(
    repoPath,
    pendingHandoffs,
    baseRunner({}),
    { nowMs: entry.startedMs + 60_000 }
  )
  assert.equal(
    snapAfterGrace.needsYou.some((i) => i.kind === 'system-alert' && i.badge === '提单中断'),
    false
  )
  assert.equal(snapAfterGrace.inProgress.length, 1)
  assert.equal(snapAfterGrace.inProgress[0]?.title, '切换为 handoff 没有任何下方变化')
  assert.equal(snapAfterGrace.inProgress[0]?.statusLabel, 'Skill 整理提单中 (antigravity)')

  // 2. Transient Orca CLI failure past 25s grace window -> must not falsely mark exited
  const snapDuringOutage = await loadBoardSnapshot(
    repoPath,
    pendingHandoffs,
    baseRunner({ orcaReachable: false }),
    { nowMs: entry.startedMs + 90_000 }
  )
  assert.equal(
    snapDuringOutage.needsYou.some((i) => i.kind === 'system-alert' && i.badge === '提单中断'),
    false
  )
  assert.equal(entry.exitedWithoutIssue, undefined)

  // 3. Synthetic handoff-* fallback adopts an unclaimed live handoff agent instead of false-alarming
  const syntheticPending = new Map<string, PendingHandoff>([
    [
      'handoff-synthetic-1',
      {
        terminalId: 'handoff-synthetic-1',
        repoPath,
        title: '兜底认领正在运行的提单任务',
        agent: 'antigravity',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        startedMs: Date.now() - 60_000
      }
    ]
  ])
  const adoptedSnap = await loadBoardSnapshot(
    repoPath,
    syntheticPending,
    baseRunner({}),
    { nowMs: Date.now() }
  )
  assert.equal(
    adoptedSnap.needsYou.some((i) => i.kind === 'system-alert' && i.badge === '提单中断'),
    false
  )
  assert.equal(adoptedSnap.inProgress.length, 1)
  assert.equal(adoptedSnap.inProgress[0]?.title, '兜底认领正在运行的提单任务')
  assert.equal(syntheticPending.get('handoff-synthetic-1')?.terminalId, launchedHandle)
})

test('stop slash command and header autopilot toggle button hitboxes', () => {
  const stopCmd = parseSlashCommand('/stop')
  assert.equal(stopCmd?.kind, 'command')
  if (stopCmd?.kind === 'command') {
    assert.equal(stopCmd.command.id, 'stop')
  }

  const pauseAlias = parseSlashCommand('/pause')
  assert.equal(pauseAlias?.kind, 'command')
  if (pauseAlias?.kind === 'command') {
    assert.equal(pauseAlias.command.id, 'stop')
  }

  const offArg = parseSlashCommand('/autopilot off')
  assert.equal(offArg?.kind, 'command')
  if (offArg?.kind === 'command') {
    assert.equal(offArg.command.id, 'autopilot')
    assert.equal(offArg.arg, 'off')
  }

  const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '')
  const runningState = makeBaseState()
  runningState.snapshot = { ...makeSampleSnapshot(), autopilotInstalled: true, autopilotRunning: true }
  const runningBuf = renderTui(runningState, 120, 30)
  const runningHeader = strip(runningBuf.renderLines()[0] ?? '')
  assert.match(runningHeader, /● 自动处理 \[关闭\]/)
  const stopHit = runningBuf.hitBoxes.find((h) => h.action === 'stop-autopilot')
  assert.ok(stopHit, 'running header should expose clickable stop-autopilot hitbox')

  const pausedState = makeBaseState()
  pausedState.snapshot = { ...makeSampleSnapshot(), autopilotInstalled: true, autopilotRunning: false }
  const pausedBuf = renderTui(pausedState, 120, 30)
  const pausedHeader = strip(pausedBuf.renderLines()[0] ?? '')
  assert.match(pausedHeader, /○ 已暂停自动处理 \[开启\]/)
  const resumeHit = pausedBuf.hitBoxes.find((h) => h.action === 'enable-autopilot')
  assert.ok(resumeHit, 'paused header should expose clickable enable-autopilot hitbox')
})

test('detectAutopilotRunning and stopAutopilot call orca automation and admin stop', async () => {
  const baseConfig = {
    configPath: '/tmp/autopilot.json',
    dbPath: '/tmp/state.sqlite3',
    repository: 'acme/demo-app',
    repoPath: '/tmp/demo-app',
    runtimeAdminPath: '/tmp/autopilot_admin.py',
    defaultAgent: 'codex',
    allowedAgents: ['codex'],
    label: 'agent-ready',
    maxConcurrentWorkers: 3,
    maxAttempts: 2,
    pollIntervalSeconds: 60,
    workerTimeoutSeconds: 2700,
    heartbeatTimeoutSeconds: 900,
    publication: 'auto-merge' as const,
    mergeMethod: 'squash' as const,
    preMergeCommands: [],
    requireCi: true,
    automationId: 'auto-123'
  }

  const pausedRunner: CommandRunner = async (cmd, args) => {
    if (cmd === 'orca' && args[0] === 'automations' && args[1] === 'show') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { automation: { id: 'auto-123', enabled: false } } }),
        stderr: ''
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
  assert.equal(await detectAutopilotRunning(baseConfig, pausedRunner), false)

  const enabledRunner: CommandRunner = async (cmd, args) => {
    if (cmd === 'orca' && args[0] === 'automations' && args[1] === 'show') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { automation: { id: 'auto-123', enabled: true } } }),
        stderr: ''
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
  assert.equal(await detectAutopilotRunning(baseConfig, enabledRunner), true)

  const calls: Array<{ cmd: string; args: string[] }> = []
  const stopRunner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args })
    return { exitCode: 0, stdout: '{"status":"stopped"}', stderr: '' }
  }
  const msg = await stopAutopilot({ repoPath: '/tmp/demo-app', runner: stopRunner })
  assert.match(msg, /已暂停自动处理循环/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.cmd, 'python3')
  assert.equal(calls[0]?.args[1], 'stop')
  assert.equal(calls[0]?.args[2], '--repo-path')
  assert.equal(calls[0]?.args[3], '/tmp/demo-app')
})
