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
  extractGithubIssueNumbers,
  extractTerminalQuestion,
  hasHandoffCreatedIssue,
  isHandoffSessionTitle,
  type CommandRunner
} from '../board-data'
import {
  collectOrcaAgentState,
  loadBoardSnapshot,
  type PendingHandoff
} from './orca-cli'
import {
  buildMainRows,
  computeComposerHeight,
  nextIssueKind,
  nextSubmitMode,
  renderTui,
  type TuiState
} from './render'
import {
  ANSI,
  cursorTo,
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

test('renderTui positions native terminal cursor for empty, CJK, wrapped, and trailing-newline composer inputs without pseudo-cursor', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // 1. Empty bottom composer: cursor at (textAreaX=3, composerTop+1=27) for height 30, composerH 3
  const emptyState = makeBaseState('')
  const emptyBuf = renderTui(emptyState, 100, 30)
  assert.deepEqual(emptyBuf.cursor, { x: 3, y: 27 })
  const emptyPlain = emptyBuf.renderLines().map(stripAnsi).join('\n')
  assert.equal(emptyPlain.includes('▏'), false)

  const emptyFrame = emptyBuf.diffOutput(null)
  assert.ok(emptyFrame.output.startsWith(ANSI.cursorHide))
  assert.ok(emptyFrame.output.endsWith(`${cursorTo(3, 27)}${ANSI.cursorShow}`))

  // 2. Mixed CJK + ASCII text: cursor advances by exact display width
  const mixedText = '修复 IME 光标'
  const mixedState = makeBaseState(mixedText)
  const mixedBuf = renderTui(mixedState, 100, 30)
  assert.deepEqual(mixedBuf.cursor, { x: 3 + stringDisplayWidth(mixedText), y: 27 })
  assert.equal(mixedBuf.renderLines().map(stripAnsi).join('\n').includes('▏'), false)

  // 3. Trailing newline moves cursor to start of next line and matches computeComposerHeight
  const newlineState = makeBaseState('第一行\n')
  assert.equal(computeComposerHeight(newlineState.composer, 100), 4)
  const newlineBuf = renderTui(newlineState, 100, 30)
  // footerY=29, composerH=4 -> composerTop=25 -> line 0 at 26, line 1 at 27
  assert.deepEqual(newlineBuf.cursor, { x: 3, y: 27 })

  // 4. Multi-line CJK/ASCII wrapping & exact-width clamping stays within [0, width - 1]
  const narrowW = 20 // textAreaW = 16
  const exactLine = '测试宽字符排12' // 6*2 + 2 = 14; '测试宽字符排版12' = 7*2 + 2 = 16
  const exactFull = '测试宽字符排版12'
  assert.equal(stringDisplayWidth(exactFull), 16)
  const exactState = makeBaseState(exactFull)
  assert.equal(computeComposerHeight(exactState.composer, narrowW), 3)
  const exactBuf = renderTui(exactState, narrowW, 20)
  assert.ok(exactBuf.cursor !== null)
  assert.ok(exactBuf.cursor.x >= 0 && exactBuf.cursor.x < narrowW)
  assert.equal(exactBuf.cursor.x, 19)
  assert.equal(exactBuf.cursor.y, 17)

  const wrappedText = `${exactLine}继续换行ABC`
  const wrappedState = makeBaseState(wrappedText)
  assert.equal(computeComposerHeight(wrappedState.composer, narrowW), 4)
  const wrappedBuf = renderTui(wrappedState, narrowW, 20)
  const expectedLines = wrapTextToWidth(wrappedText, narrowW - 4, 3)
  assert.equal(expectedLines.length, 2)
  assert.deepEqual(wrappedBuf.cursor, {
    x: 3 + stringDisplayWidth(expectedLines[1]!),
    y: 17
  })
})

test('renderTui positions cursor for reply modal and hides cursor for submitting, sending, settings, and detail states', () => {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  // 1. Submitting bottom composer hides cursor
  const submittingState = makeBaseState('准备提交')
  submittingState.composer.submitting = true
  const submittingBuf = renderTui(submittingState, 100, 30)
  assert.equal(submittingBuf.cursor, null)
  const subFrame = submittingBuf.diffOutput(null)
  assert.ok(subFrame.output.includes(ANSI.cursorHide))
  assert.equal(subFrame.output.includes(ANSI.cursorShow), false)

  // 2. Settings modal hides cursor
  const settingsState = makeBaseState('hello')
  settingsState.modal = {
    type: 'settings',
    defaultAgent: 'codex',
    allowedAgents: ['codex'],
    cursor: 0,
    saving: false
  }
  const settingsBuf = renderTui(settingsState, 100, 30)
  assert.equal(settingsBuf.cursor, null)
  const settingsFrame = settingsBuf.diffOutput(null)
  assert.ok(settingsFrame.output.includes(ANSI.cursorHide))
  assert.equal(settingsFrame.output.includes(ANSI.cursorShow), false)

  // 3. Detail modal hides cursor
  const detailState = makeBaseState('hello')
  detailState.modal = {
    type: 'detail',
    title: '#10 Bug',
    subtitle: '状态：处理中',
    body: '详情内容'
  }
  const detailBuf = renderTui(detailState, 100, 30)
  assert.equal(detailBuf.cursor, null)

  // 4. Reply modal positions cursor when active and hides cursor when sending
  const replyState = makeBaseState('')
  const questionItem = replyState.snapshot!.needsYou[0]!
  assert.equal(questionItem.kind, 'agent-question')
  if (questionItem.kind === 'agent-question') {
    replyState.modal = {
      type: 'reply',
      item: questionItem,
      text: '',
      attachments: [],
      sending: false
    }
    const emptyReplyBuf = renderTui(replyState, 100, 30)
    assert.ok(emptyReplyBuf.cursor !== null)
    const emptyReplyPlain = emptyReplyBuf.renderLines().map(stripAnsi)
    assert.equal(emptyReplyPlain.join('\n').includes('▏'), false)
    // Reply prompt '❯' sits two columns left of the cursor
    assert.equal(emptyReplyPlain[emptyReplyBuf.cursor.y]![emptyReplyBuf.cursor.x - 2], '❯')

    const replyText = '好的，继续执行'
    replyState.modal.text = replyText
    const filledReplyBuf = renderTui(replyState, 100, 30)
    assert.deepEqual(filledReplyBuf.cursor, {
      x: emptyReplyBuf.cursor.x + stringDisplayWidth(replyText),
      y: emptyReplyBuf.cursor.y
    })
    const replyFrame = filledReplyBuf.diffOutput(null)
    assert.ok(
      replyFrame.output.endsWith(
        `${cursorTo(filledReplyBuf.cursor!.x, filledReplyBuf.cursor!.y)}${ANSI.cursorShow}`
      )
    )

    replyState.modal.sending = true
    const sendingReplyBuf = renderTui(replyState, 100, 30)
    assert.equal(sendingReplyBuf.cursor, null)
    const sendingFrame = sendingReplyBuf.diffOutput(replyFrame.lines, replyFrame.cursor)
    assert.ok(sendingFrame.output.includes(ANSI.cursorHide))
    assert.equal(sendingFrame.output.includes(ANSI.cursorShow), false)
  }
})

test('ScreenBuffer.diffOutput preserves cursor position across incremental and no-op redraws without flicker', () => {
  const buf1 = new ScreenBuffer(40, 12)
  buf1.writeText(0, 0, 'Header v1')
  buf1.setCursor(5, 10)
  const f1 = buf1.diffOutput(null)
  assert.ok(f1.output.startsWith(ANSI.cursorHide))
  assert.ok(f1.output.endsWith(`${cursorTo(5, 10)}${ANSI.cursorShow}`))

  // Unchanged lines + unchanged cursor with previousCursor -> empty output (no flicker on 12s poll)
  const buf2 = new ScreenBuffer(40, 12)
  buf2.writeText(0, 0, 'Header v1')
  buf2.setCursor(5, 10)
  const f2 = buf2.diffOutput(f1.lines, f1.cursor)
  assert.equal(f2.output, '')

  // Unchanged lines + changed cursor -> moves & shows cursor
  const buf3 = new ScreenBuffer(40, 12)
  buf3.writeText(0, 0, 'Header v1')
  buf3.setCursor(8, 10)
  const f3 = buf3.diffOutput(f2.lines, f2.cursor)
  assert.equal(f3.output, `${cursorTo(8, 10)}${ANSI.cursorShow}`)

  // Partial line refresh (e.g. header updated during background poll) -> hides before row write, restores cursor at end
  const buf4 = new ScreenBuffer(40, 12)
  buf4.writeText(0, 0, 'Header v2')
  buf4.setCursor(8, 10)
  const f4 = buf4.diffOutput(f3.lines, f3.cursor)
  assert.ok(f4.output.startsWith(ANSI.cursorHide))
  assert.ok(f4.output.includes('Header v2'))
  assert.ok(f4.output.endsWith(`${cursorTo(8, 10)}${ANSI.cursorShow}`))
})
