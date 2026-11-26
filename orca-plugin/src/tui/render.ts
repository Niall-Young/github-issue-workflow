// Pure state-to-ScreenBuffer renderer for the Claude Code-inspired terminal TUI.
// Every interactive element registers a HitBox so mouse clicks and keyboard
// navigation share the exact same action dispatch path.

import type {
  BoardSnapshot,
  CompletedItem,
  InProgressItem,
  IssueKind,
  NeedsYouItem,
  PullRequestItem,
  SubmitMode
} from '../protocol'
import type { InlineAttachment } from './attachments'
import { filterSlashCommands, isSlashMenuOpen, type SlashCommandDef } from './commands'
import {
  PALETTE,
  ScreenBuffer,
  stringDisplayWidth,
  truncateToWidth,
  wrapTextToWidth
} from './screen'

export type ListRow =
  | { kind: 'section'; label: string }
  | { kind: 'inProgress'; item: InProgressItem }
  | { kind: 'completed'; item: CompletedItem }
  | { kind: 'pr'; item: PullRequestItem }

export type ComposerState = {
  text: string
  mode: SubmitMode
  kind: IssueKind
  followUpOf: number | null
  attachments: InlineAttachment[]
  submitting: boolean
  slashIndex: number
}

export type ModalState =
  | { type: 'none' }
  | {
      type: 'settings'
      defaultAgent: string
      allowedAgents: string[]
      cursor: number
      saving: boolean
    }
  | {
      type: 'reply'
      item: Extract<NeedsYouItem, { kind: 'agent-question' }>
      text: string
      attachments: InlineAttachment[]
      sending: boolean
    }
  | {
      type: 'detail'
      title: string
      subtitle: string
      body: string
      url?: string
      prUrl?: string | null
      issueNumber?: number | null
      canRetry?: boolean
      canDiscard?: boolean
      canFollowUp?: boolean
    }

export type TuiState = {
  snapshot: BoardSnapshot | null
  loading: boolean
  activeTab: 'issues' | 'prs'
  activePane: 'main' | 'attention'
  selectedIndex: number
  scrollOffset: number
  attentionIndex: number
  attentionScroll: number
  busyIds: Set<string>
  composer: ComposerState
  modal: ModalState
}

export const ISSUE_KINDS: readonly IssueKind[] = ['feature', 'bug', 'polish']
export const SUBMIT_MODES: readonly SubmitMode[] = ['handoff', 'direct']

export function nextIssueKind(current: IssueKind): IssueKind {
  const idx = ISSUE_KINDS.indexOf(current)
  return ISSUE_KINDS[(idx + 1) % ISSUE_KINDS.length]
}

export function nextSubmitMode(current: SubmitMode): SubmitMode {
  const idx = SUBMIT_MODES.indexOf(current)
  return SUBMIT_MODES[(idx + 1) % SUBMIT_MODES.length]
}

const MODE_LABELS: Record<SubmitMode, string> = {
  handoff: 'Skill 规范提单',
  direct: '快速直提'
}

const KIND_LABELS: Record<IssueKind, string> = {
  feature: '新功能',
  bug: '修 Bug',
  polish: '体验优化'
}

const KIND_STYLES: Record<IssueKind, string> = {
  feature: PALETTE.blue,
  bug: PALETTE.red,
  polish: PALETTE.purple
}

export function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h`
  return `${Math.floor(diffHour / 24)}d`
}

export function buildMainRows(snapshot: BoardSnapshot | null, tab: 'issues' | 'prs'): ListRow[] {
  if (!snapshot) return []
  const rows: ListRow[] = []
  if (tab === 'issues') {
    if (snapshot.inProgress.length > 0) {
      rows.push({ kind: 'section', label: `进行中 · ${snapshot.inProgress.length}` })
      for (const item of snapshot.inProgress) {
        rows.push({ kind: 'inProgress', item })
      }
    }
    if (snapshot.completed.length > 0) {
      rows.push({ kind: 'section', label: `已完成 · 可验收 · ${snapshot.completed.length}` })
      for (const item of snapshot.completed) {
        rows.push({ kind: 'completed', item })
      }
    }
  } else {
    const openPrs = snapshot.pullRequests.filter((p) => p.state === 'OPEN')
    const closedPrs = snapshot.pullRequests.filter((p) => p.state !== 'OPEN')
    if (openPrs.length > 0) {
      rows.push({ kind: 'section', label: `打开中 PR · ${openPrs.length}` })
      for (const item of openPrs) {
        rows.push({ kind: 'pr', item })
      }
    }
    if (closedPrs.length > 0) {
      rows.push({ kind: 'section', label: `历史 PR · ${closedPrs.length}` })
      for (const item of closedPrs) {
        rows.push({ kind: 'pr', item })
      }
    }
  }
  return rows
}

function prBadge(pr: PullRequestItem): { label: string; style: string } {
  if (pr.state === 'MERGED') return { label: 'MERGED', style: PALETTE.purple }
  if (pr.state === 'CLOSED') return { label: 'CLOSED', style: PALETTE.muted }
  if (pr.mergeable === 'CONFLICTING') return { label: 'CONFLICT', style: PALETTE.red }
  if (pr.isDraft) return { label: 'DRAFT', style: PALETTE.muted }
  if (pr.ciStatus === 'failing') return { label: 'CI FAIL', style: PALETTE.red }
  if (pr.ciStatus === 'pending') return { label: 'CI RUN', style: PALETTE.amber }
  if (pr.ciStatus === 'passing') return { label: 'CI OK', style: PALETTE.green }
  return { label: 'OPEN', style: PALETTE.blue }
}

export function computeComposerHeight(composer: ComposerState, width: number): number {
  const innerW = Math.max(12, width - 6)
  const wrapped = composer.text
    ? wrapTextToWidth(`${composer.text}▏`, innerW, 2)
    : ['']
  const textLines = Math.max(1, Math.min(2, wrapped.length))
  const attachmentLine = composer.attachments.length > 0 ? 1 : 0
  return 2 + textLines + attachmentLine
}

const SLASH_MAX_VISIBLE = 6

export function computeSlashMenuHeight(state: TuiState, maxHeight: number): number {
  if (state.modal.type !== 'none' || !isSlashMenuOpen(state.composer.text)) return 0
  if (maxHeight < 2) return 0
  const matches = filterSlashCommands(state.composer.text)
  const visibleRows =
    matches.length === 0 ? 1 : Math.min(matches.length, Math.min(SLASH_MAX_VISIBLE, maxHeight - 1))
  // 1 top hairline divider + visible command rows (borderless inline Claude Code style)
  return 1 + visibleRows
}

export function renderTui(state: TuiState, width: number, height: number): ScreenBuffer {
  const buf = new ScreenBuffer(width, height)
  const snap = state.snapshot

  // ── Top Header (rows 0..1) ────────────────────────────────────────────────
  const projectLabel = snap ? snap.projectName : 'Issue 看板'
  const repoLabel = snap?.repository ? ` ${snap.repository}` : ''
  const agentName = snap?.defaultAgent || snap?.preferredAgent || 'Agent'
  const syncText = snap ? `同步 ${formatRelativeTime(snap.syncedAt) || '刚刚'}` : '加载中…'
  const rightStatus = `${agentName} · ${syncText}`
  const rightStatusW = stringDisplayWidth(rightStatus)

  let col = 1
  col += buf.writeText(col, 0, '◆ ', PALETTE.accentBold)
  col += buf.writeText(col, 0, projectLabel, PALETTE.bright)
  if (repoLabel) {
    col += buf.writeText(col, 0, repoLabel, PALETTE.muted, Math.max(0, width - col - rightStatusW - 26))
  }
  col += 2
  if (snap) {
    if (snap.autopilotInstalled) {
      col += buf.writeText(col, 0, '● 自动运行中', PALETTE.green)
    } else {
      col += buf.writeText(col, 0, '○ 未开启自动处理 (/autopilot)', PALETTE.amber, Math.max(0, width - col - rightStatusW - 3))
    }
  } else if (state.loading) {
    col += buf.writeText(col, 0, '◌ 同步中…', PALETTE.amber)
  }

  const rightXStart = Math.max(col + 1, width - rightStatusW - 1)
  if (rightXStart < width - 1) {
    const agentW = buf.writeText(rightXStart, 0, agentName, PALETTE.muted)
    buf.addHitBox(rightXStart, 0, agentW, 1, 'open-settings')
    buf.writeText(rightXStart + agentW, 0, ` · ${syncText}`, PALETTE.dim)
  }

  buf.drawHLine(0, 1, width, PALETTE.border)

  // ── Layout Metrics ────────────────────────────────────────────────────────
  const footerY = height - 1
  const composerH = Math.min(5, computeComposerHeight(state.composer, width))
  const composerTop = Math.max(5, footerY - composerH)
  const contentTop = 2
  const maxSlashH = Math.max(0, composerTop - contentTop - 3)
  const slashH = computeSlashMenuHeight(state, maxSlashH)
  const slashTop = composerTop - slashH
  const contentHeight = Math.max(3, slashTop - contentTop)

  const splitMode = width >= 92
  const leftW = splitMode ? Math.floor(width * 0.62) : width
  const rightX = leftW + 1
  const rightW = splitMode ? width - rightX : width

  if (splitMode) {
    buf.drawVLine(leftW, contentTop, contentHeight, PALETTE.border)
  }

  // ── Left Pane: Tabs + Issues / PRs list ───────────────────────────────────
  const issueCount = (snap?.inProgress.length ?? 0) + (snap?.completed.length ?? 0)
  const prCount = snap?.pullRequests.length ?? 0
  let tabX = 1
  tabX +=
    buf.drawButton(
      tabX,
      contentTop,
      `Issues (${issueCount})`,
      state.activeTab === 'issues' ? PALETTE.chipActiveBg : PALETTE.chipBg,
      'switch-tab',
      'issues'
    ) + 1
  tabX +=
    buf.drawButton(
      tabX,
      contentTop,
      `PRs (${prCount})`,
      state.activeTab === 'prs' ? PALETTE.chipActiveBg : PALETTE.chipBg,
      'switch-tab',
      'prs'
    ) + 1

  if (!splitMode) {
    const attCount = snap?.needsYou.length ?? 0
    buf.drawButton(
      tabX,
      contentTop,
      `待处理 (${attCount})`,
      state.activePane === 'attention' ? PALETTE.chipActiveBg : PALETTE.chipBg,
      'focus-pane',
      'attention'
    )
  }

  const listTop = contentTop + 2
  const listHeight = Math.max(1, contentHeight - 2)
  buf.addHitBox(0, listTop, leftW, listHeight, 'pane-scroll-area', 'main')

  if (!splitMode && state.activePane === 'attention') {
    renderAttentionPane(buf, state, 1, listTop, width - 2, listHeight)
  } else {
    renderMainList(buf, state, 1, listTop, leftW - 2, listHeight)
  }

  // ── Right Pane: Needs You (desktop split) ─────────────────────────────────
  if (splitMode) {
    const attCount = snap?.needsYou.length ?? 0
    const attTitle = attCount > 0 ? `● 需要你处理 (${attCount})` : '需要你处理'
    const attStyle = attCount > 0 ? PALETTE.accentBold : PALETTE.muted
    buf.writeText(rightX + 1, contentTop, attTitle, attStyle, rightW - 2)
    buf.addHitBox(rightX, contentTop, rightW, contentHeight, 'focus-pane', 'attention')
    renderAttentionPane(buf, state, rightX + 1, listTop, rightW - 2, listHeight)
  }

  // ── Inline Slash Command List (Claude Code style, directly above composer) ─
  if (slashH > 0) {
    renderSlashMenu(buf, state, width, slashTop, slashH)
  }

  // ── Bottom AI-Chat-Style Composer ─────────────────────────────────────────
  renderBottomComposer(buf, state, 0, composerTop, width, composerH)

  // ── Footer Status Bar (Codex-style active selections below composer) ──────
  renderFooterStatusBar(buf, state, width, footerY)

  // ── Active Modal Overlay ──────────────────────────────────────────────────
  if (state.modal.type !== 'none') {
    renderModal(buf, state, width, height)
  }

  return buf
}

function writeLineWithAttachmentTokens(
  buf: ScreenBuffer,
  x: number,
  y: number,
  line: string,
  baseStyle: string,
  maxWidth: number,
  attachments: readonly InlineAttachment[]
) {
  if (attachments.length === 0) {
    buf.writeText(x, y, line, baseStyle, maxWidth)
    return
  }

  const tokens = attachments.map((a) => a.token)
  let cx = x
  let remainingW = maxWidth
  let pos = 0

  while (pos < line.length && remainingW > 0) {
    let nextIdx = -1
    let matchedToken = ''
    for (const token of tokens) {
      const idx = line.indexOf(token, pos)
      if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
        nextIdx = idx
        matchedToken = token
      }
    }

    if (nextIdx === -1) {
      buf.writeText(cx, y, line.slice(pos), baseStyle, remainingW)
      break
    }

    if (nextIdx > pos) {
      const segment = line.slice(pos, nextIdx)
      const written = buf.writeText(cx, y, segment, baseStyle, remainingW)
      cx += written
      remainingW -= written
      if (remainingW <= 0) break
    }

    const tokenWritten = buf.writeText(cx, y, matchedToken, PALETTE.attachmentBadge, remainingW)
    cx += tokenWritten
    remainingW -= tokenWritten
    pos = nextIdx + matchedToken.length
  }
}

function renderAttachmentChips(
  buf: ScreenBuffer,
  x: number,
  y: number,
  maxWidth: number,
  attachments: readonly InlineAttachment[],
  removeAction: 'remove-composer-attachment' | 'remove-reply-attachment',
  showHint: boolean
) {
  let ax = x
  const rightBound = x + maxWidth
  for (const att of attachments) {
    const label = `${att.token.slice(1, -1)} ×`
    const needed = stringDisplayWidth(label) + 2
    if (ax + needed > rightBound) {
      const remain = rightBound - ax
      if (remain >= 2) {
        buf.writeText(ax, y, '…', PALETTE.dim, remain)
      }
      return
    }
    ax += buf.drawButton(ax, y, label, PALETTE.attachmentBadge, removeAction, att.id) + 1
  }
  if (showHint && ax < rightBound - 6) {
    buf.writeText(ax, y, 'Backspace 或点击 × 删除', PALETTE.dim, rightBound - ax)
  }
}

function renderFooterStatusBar(buf: ScreenBuffer, state: TuiState, width: number, y: number) {
  const c = state.composer
  const rightHint = '⇧Tab 切换类型'
  const rightHintW = stringDisplayWidth(rightHint)
  let cx = 1

  const kindText = `● ${KIND_LABELS[c.kind]}`
  const kindW = buf.writeText(cx, y, kindText, KIND_STYLES[c.kind], Math.max(0, width - cx - 1))
  if (kindW > 0) {
    buf.addHitBox(cx, y, kindW, 1, 'cycle-issue-kind')
    cx += kindW
  }

  if (cx < width - 4) {
    cx += buf.writeText(cx, y, ' · ', PALETTE.dim, Math.max(0, width - cx - 1))
    const modeText = MODE_LABELS[c.mode]
    const modeW = buf.writeText(cx, y, modeText, PALETTE.muted, Math.max(0, width - cx - 1))
    if (modeW > 0) {
      buf.addHitBox(cx, y, modeW, 1, 'cycle-submit-mode')
      cx += modeW
    }
  }

  if (c.followUpOf !== null && cx < width - 6) {
    cx += buf.writeText(cx, y, ' · ', PALETTE.dim, Math.max(0, width - cx - 1))
    cx += buf.writeText(cx, y, `追提 #${c.followUpOf}`, PALETTE.amber, Math.max(0, width - cx - 1))
  }

  const rightX = width - rightHintW - 1
  if (rightX > cx + 2) {
    buf.writeText(rightX, y, rightHint, PALETTE.dim, rightHintW)
  }
}

function renderBottomComposer(
  buf: ScreenBuffer,
  state: TuiState,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const c = state.composer
  const isActive = state.modal.type === 'none'
  const title = c.followUpOf ? `追提 #${c.followUpOf}` : '提需求'

  buf.drawBox(x, y, w, h, {
    borderStyle: isActive ? PALETTE.borderActive : PALETTE.border,
    title,
    titleStyle: isActive ? PALETTE.accentBold : PALETTE.muted
  })
  buf.addHitBox(x, y, w, h, 'focus-composer')

  // Right-side hint on top border of composer
  const rightHint = ' / 命令 · ^V 贴图 '
  const rightHintW = stringDisplayWidth(rightHint)
  if (w > stringDisplayWidth(title) + rightHintW + 8) {
    buf.writeText(x + w - rightHintW - 2, y, rightHint, PALETTE.dim, rightHintW)
  }

  const innerX = x + 2
  const innerW = Math.max(8, w - 4)
  const textAreaX = innerX + 2
  const textAreaW = Math.max(6, innerW - 2)

  if (c.submitting) {
    buf.writeText(innerX, y + 1, '◌', PALETTE.amber, 2)
    buf.writeText(textAreaX, y + 1, '正在提交需求…', PALETTE.amber, textAreaW)
    return
  }

  buf.writeText(innerX, y + 1, '❯', isActive ? PALETTE.accentBold : PALETTE.muted, 2)

  const maxTextLines = Math.max(1, h - 2 - (c.attachments.length > 0 ? 1 : 0))
  if (!c.text) {
    const placeholder = isActive
      ? '▏输入需求直接提交，或输入 / 使用斜杠命令…'
      : '输入需求直接提交，或输入 / 使用斜杠命令…'
    buf.writeText(textAreaX, y + 1, placeholder, PALETTE.dim, textAreaW)
  } else {
    const displayText = isActive ? `${c.text}▏` : c.text
    const lines = wrapTextToWidth(displayText, textAreaW, maxTextLines)
    lines.forEach((line, idx) => {
      const style = c.text.startsWith('/') ? PALETTE.accent : PALETTE.bright
      writeLineWithAttachmentTokens(buf, textAreaX, y + 1 + idx, line, style, textAreaW, c.attachments)
    })
  }

  if (c.attachments.length > 0) {
    const attRowY = y + h - 2
    const prefixW = buf.writeText(textAreaX, attRowY, '📎 ', PALETTE.green, 3)
    renderAttachmentChips(
      buf,
      textAreaX + prefixW,
      attRowY,
      Math.max(0, textAreaW - prefixW),
      c.attachments,
      'remove-composer-attachment',
      true
    )
  }
}

function isCommandActive(cmd: SlashCommandDef, composer: ComposerState): boolean {
  if (cmd.id === 'bug' || cmd.id === 'feature' || cmd.id === 'polish') {
    return composer.kind === cmd.id
  }
  if (cmd.id === 'handoff' || cmd.id === 'direct') {
    return composer.mode === cmd.id
  }
  return false
}

function renderSlashMenu(
  buf: ScreenBuffer,
  state: TuiState,
  width: number,
  slashTop: number,
  slashH: number
) {
  const matches = filterSlashCommands(state.composer.text)
  const rowCount = Math.max(1, slashH - 1)

  // Clean hairline separator above the borderless inline command list
  buf.drawHLine(0, slashTop, width, PALETTE.border)
  buf.fillRect(0, slashTop + 1, width, rowCount, '')

  if (matches.length === 0) {
    buf.writeText(
      3,
      slashTop + 1,
      '无匹配命令 · 按 Esc 清空或继续输入',
      PALETTE.muted,
      Math.max(4, width - 4)
    )
    return
  }

  const clampedIdx = Math.max(0, Math.min(state.composer.slashIndex, matches.length - 1))
  let start = 0
  if (clampedIdx >= rowCount) {
    start = clampedIdx - rowCount + 1
  }

  const leftPad = 1
  const indicatorW = 2 // "❯ " or "  "
  const cmdColW = Math.min(22, Math.max(14, Math.floor(width * 0.22)))
  const descX = leftPad + indicatorW + cmdColW

  for (let i = 0; i < rowCount; i += 1) {
    const idx = start + i
    const cmd = matches[idx]
    if (!cmd) break
    const rowY = slashTop + 1 + i
    const isSel = idx === clampedIdx
    const isActive = isCommandActive(cmd, state.composer)

    const prefix = isSel ? '❯ ' : '  '
    const cmdStyle = isSel ? PALETTE.accentBold : PALETTE.text
    const descStyle = isSel ? PALETTE.accent : PALETTE.muted
    const activeTag = isActive ? '[当前]' : ''
    const activeW = stringDisplayWidth(activeTag)

    buf.writeText(leftPad, rowY, prefix, isSel ? PALETTE.accentBold : PALETTE.muted, indicatorW)
    buf.writeText(leftPad + indicatorW, rowY, cmd.name, cmdStyle, cmdColW - 1)

    const rightMargin = 2
    const descBudget = Math.max(
      4,
      width - descX - rightMargin - (isActive ? activeW + 2 : 0)
    )
    buf.writeText(descX, rowY, cmd.description, descStyle, descBudget)

    if (isActive && width - rightMargin - activeW > descX + 4) {
      buf.writeText(
        width - rightMargin - activeW,
        rowY,
        activeTag,
        isSel ? PALETTE.accentBold : PALETTE.green,
        activeW
      )
    }

    buf.addHitBox(0, rowY, width, 1, 'exec-slash', cmd.id)
  }
}

function renderMainList(
  buf: ScreenBuffer,
  state: TuiState,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const snap = state.snapshot
  if (snap?.error) {
    buf.writeText(x, y, `⚠ ${snap.error}`, PALETTE.amber, w)
    return
  }
  const rows = buildMainRows(snap, state.activeTab)
  if (rows.length === 0) {
    const emptyMsg = state.loading
      ? '正在同步 GitHub 与本地任务状态…'
      : state.activeTab === 'issues'
        ? '暂无任务 · 直接在下方输入框输入需求并按 Enter 提交'
        : '暂无 Pull Request'
    buf.writeText(x, y + 1, emptyMsg, PALETTE.muted, w)
    return
  }

  const start = Math.max(0, Math.min(state.scrollOffset, Math.max(0, rows.length - h)))
  for (let i = 0; i < h; i += 1) {
    const idx = start + i
    if (idx >= rows.length) break
    const row = rows[idx]
    const rowY = y + i
    const isSelected = state.activePane === 'main' && idx === state.selectedIndex

    if (row.kind === 'section') {
      buf.writeText(x, rowY, row.label, PALETTE.dim, w)
      continue
    }

    if (isSelected) {
      buf.fillRect(x, rowY, w, 1, PALETTE.selBg)
    }

    const baseStyle = isSelected ? PALETTE.selBg : PALETTE.text
    const prefix = isSelected ? '▸ ' : '  '

    if (row.kind === 'inProgress') {
      const it = row.item
      const numStr = it.issueNumber ? `#${it.issueNumber}` : '···'
      const timeStr = formatRelativeTime(it.updatedAt)
      const statusStr = `[${it.statusLabel}]`
      const rightMeta = `${statusStr} ${timeStr}`.trim()
      const rightW = stringDisplayWidth(rightMeta)

      let cx = x
      cx += buf.writeText(cx, rowY, prefix, isSelected ? PALETTE.selBg : PALETTE.accent)
      cx += buf.writeText(cx, rowY, `${numStr} `, isSelected ? PALETTE.selBg : PALETTE.amber)
      const titleBudget = Math.max(6, w - (cx - x) - rightW - 2)
      buf.writeText(cx, rowY, it.title, baseStyle, titleBudget)
      buf.writeText(
        x + w - rightW,
        rowY,
        rightMeta,
        isSelected ? PALETTE.selBg : PALETTE.muted,
        rightW
      )
      buf.addHitBox(x, rowY, w, 1, 'select-main-row', idx)
    } else if (row.kind === 'completed') {
      const it = row.item
      const numStr = `#${it.issueNumber}`
      const timeStr = formatRelativeTime(it.completedAt)
      const rightMeta = `✓ ${timeStr}`.trim()
      const rightW = stringDisplayWidth(rightMeta)

      let cx = x
      cx += buf.writeText(cx, rowY, prefix, isSelected ? PALETTE.selBg : PALETTE.green)
      cx += buf.writeText(cx, rowY, `${numStr} `, isSelected ? PALETTE.selBg : PALETTE.green)
      const titleBudget = Math.max(6, w - (cx - x) - rightW - 2)
      buf.writeText(cx, rowY, it.title, baseStyle, titleBudget)
      buf.writeText(
        x + w - rightW,
        rowY,
        rightMeta,
        isSelected ? PALETTE.selBg : PALETTE.dim,
        rightW
      )
      buf.addHitBox(x, rowY, w, 1, 'select-main-row', idx)
    } else if (row.kind === 'pr') {
      const pr = row.item
      const badge = prBadge(pr)
      const timeStr = formatRelativeTime(pr.mergedAt || pr.updatedAt)
      const rightMeta = `${badge.label} ${timeStr}`.trim()
      const rightW = stringDisplayWidth(rightMeta)

      let cx = x
      cx += buf.writeText(cx, rowY, prefix, isSelected ? PALETTE.selBg : PALETTE.blue)
      cx += buf.writeText(cx, rowY, `#${pr.number} `, isSelected ? PALETTE.selBg : PALETTE.blue)
      const titleBudget = Math.max(6, w - (cx - x) - rightW - 2)
      buf.writeText(cx, rowY, pr.title, baseStyle, titleBudget)
      buf.writeText(
        x + w - rightW,
        rowY,
        rightMeta,
        isSelected ? PALETTE.selBg : badge.style,
        rightW
      )
      buf.addHitBox(x, rowY, w, 1, 'select-main-row', idx)
    }
  }
}

function renderAttentionPane(
  buf: ScreenBuffer,
  state: TuiState,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const items = state.snapshot?.needsYou ?? []
  if (items.length === 0) {
    buf.writeText(x, y + 1, '✓ 当前无需人工介入', PALETTE.green, w)
    buf.writeText(x, y + 2, '助手提问或需要拍板时会出现在这里', PALETTE.dim, w)
    return
  }

  let curY = y
  const start = Math.max(0, Math.min(state.attentionScroll, items.length - 1))
  for (let i = start; i < items.length; i += 1) {
    const item = items[i]
    if (curY + 4 > y + h) break
    const isSelected = state.activePane === 'attention' && i === state.attentionIndex
    const busy = state.busyIds.has(item.id)

    const bodyText = item.kind === 'agent-question' ? item.question : item.reason
    const wrapped = wrapTextToWidth(bodyText, Math.max(10, w - 4), 2)
    const cardH = 3 + wrapped.length + 1
    if (curY + cardH > y + h && i > start) break

    buf.drawBox(x, curY, w, cardH, {
      borderStyle: isSelected ? PALETTE.borderActive : PALETTE.border,
      title: item.kind === 'agent-question' ? `${item.agentName} 提问` : `#${item.issueNumber} 需关注`,
      titleStyle: item.kind === 'agent-question' ? PALETTE.accentBold : PALETTE.amber
    })
    buf.addHitBox(x, curY, w, cardH, 'select-attention', i)

    buf.writeText(x + 2, curY + 1, item.title, PALETTE.bright, w - 4)
    wrapped.forEach((line, li) => {
      buf.writeText(x + 2, curY + 2 + li, line, PALETTE.muted, w - 4)
    })

    const btnY = curY + 2 + wrapped.length
    let bx = x + 2
    if (busy) {
      buf.writeText(bx, btnY, '处理中…', PALETTE.amber, w - 4)
    } else if (item.kind === 'agent-question') {
      bx += buf.drawButton(bx, btnY, '同意继续', PALETTE.accentBg, 'approve-agent', item) + 1
      buf.drawButton(bx, btnY, '回复', PALETTE.chipBg, 'open-reply', item)
    } else {
      if (item.canRetry) {
        bx += buf.drawButton(bx, btnY, '重试', PALETTE.accentBg, 'issue-retry', item) + 1
      }
      if (item.canDiscard) {
        bx += buf.drawButton(bx, btnY, '放弃', PALETTE.chipBg, 'issue-discard', item) + 1
      }
      if (item.url) {
        buf.drawButton(bx, btnY, '打开', PALETTE.chipBg, 'open-url', item.url)
      }
    }

    curY += cardH + 1
  }
}

function renderModal(buf: ScreenBuffer, state: TuiState, width: number, height: number) {
  const modal = state.modal
  if (modal.type === 'none') return

  const mw = Math.min(Math.max(48, Math.floor(width * 0.72)), width - 4)
  const mh = modal.type === 'settings' ? Math.min(16, height - 4) : Math.min(14, height - 4)
  const mx = Math.floor((width - mw) / 2)
  const my = Math.floor((height - mh) / 2)

  // Consume background clicks outside modal as close
  buf.addHitBox(0, 0, width, height, 'close-modal')

  const titleMap = {
    settings: '配置工作树执行 Agent',
    reply: modal.type === 'reply' ? `回复 ${modal.item.agentName}` : '回复助手',
    detail: '任务详情'
  }

  buf.drawBox(mx, my, mw, mh, {
    borderStyle: PALETTE.borderActive,
    fillStyle: PALETTE.modalBg,
    title: titleMap[modal.type],
    titleStyle: PALETTE.accentBold
  })
  // Block backdrop clicks inside modal
  buf.addHitBox(mx, my, mw, mh, 'noop')

  const ix = mx + 2
  const iw = mw - 4

  if (modal.type === 'settings') {
    const installed = state.snapshot?.installedAgents ?? []
    const ids = Array.from(
      new Set([
        ...installed.map((a) => a.id),
        ...(modal.defaultAgent ? [modal.defaultAgent] : []),
        ...modal.allowedAgents
      ])
    )
    buf.writeText(
      ix,
      my + 2,
      '点击或 ↑↓ 选择，Enter 设为默认，Space 切换允许标签覆盖：',
      PALETTE.muted,
      iw
    )
    const listH = Math.max(2, mh - 7)
    for (let i = 0; i < Math.min(ids.length, listH); i += 1) {
      const id = ids[i]
      const rowY = my + 4 + i
      const isCur = i === modal.cursor
      const isDef = id === modal.defaultAgent
      const isAllowed = modal.allowedAgents.includes(id)
      if (isCur) buf.fillRect(ix, rowY, iw, 1, PALETTE.selBg)
      const st = isCur ? PALETTE.selBg : PALETTE.text
      const line = `${isCur ? '▸ ' : '  '}${isDef ? '★ 默认' : '  可选'}  [${isAllowed ? 'x' : ' '}]  ${id}`
      buf.writeText(ix, rowY, line, st, iw)
      buf.addHitBox(ix, rowY, iw, 1, 'settings-click-agent', i)
    }
    const footerY = my + mh - 2
    let fx = ix
    fx +=
      buf.drawButton(
        fx,
        footerY,
        modal.saving ? '保存中…' : '保存配置',
        PALETTE.accentBg,
        'settings-save'
      ) + 1
    buf.drawButton(fx, footerY, '取消 (Esc)', PALETTE.chipBg, 'close-modal')
    return
  }

  if (modal.type === 'reply') {
    const qLines = wrapTextToWidth(modal.item.question, iw, 3)
    qLines.forEach((l, i) => buf.writeText(ix, my + 2 + i, l, PALETTE.muted, iw))
    const inputY = my + 6
    buf.fillRect(ix, inputY, iw, 2, PALETTE.inputFocusBg)
    const rLines = wrapTextToWidth(`${modal.text}▏`, iw - 2, 2)
    rLines.forEach((l, i) =>
      writeLineWithAttachmentTokens(buf, ix + 1, inputY + i, l, PALETTE.inputFocusBg, iw - 2, modal.attachments)
    )
    const attY = inputY + 3
    let ax = ix
    ax += buf.drawButton(ax, attY, '+ 粘贴截图 (^V)', PALETTE.chipBg, 'reply-paste-image') + 1
    if (modal.attachments.length > 0) {
      renderAttachmentChips(
        buf,
        ax,
        attY,
        Math.max(0, ix + iw - ax),
        modal.attachments,
        'remove-reply-attachment',
        false
      )
    }
    const footerY = my + mh - 2
    let fx = ix
    fx +=
      buf.drawButton(
        fx,
        footerY,
        modal.sending ? '发送中…' : '发送 (Enter)',
        PALETTE.accentBg,
        'reply-submit'
      ) + 1
    buf.drawButton(fx, footerY, '取消 (Esc)', PALETTE.chipBg, 'close-modal')
    return
  }

  if (modal.type === 'detail') {
    buf.writeText(ix, my + 2, truncateToWidth(modal.title, iw), PALETTE.bright, iw)
    buf.writeText(ix, my + 3, truncateToWidth(modal.subtitle, iw), PALETTE.muted, iw)
    const bodyLines = wrapTextToWidth(modal.body, iw, Math.max(2, mh - 8))
    bodyLines.forEach((l, i) => buf.writeText(ix, my + 5 + i, l, PALETTE.text, iw))

    const footerY = my + mh - 2
    let fx = ix
    if (modal.url) {
      fx += buf.drawButton(fx, footerY, '浏览器打开', PALETTE.accentBg, 'open-url', modal.url) + 1
    }
    if (modal.prUrl) {
      fx += buf.drawButton(fx, footerY, '打开 PR', PALETTE.chipBg, 'open-url', modal.prUrl) + 1
    }
    if (modal.canFollowUp && modal.issueNumber) {
      fx += buf.drawButton(fx, footerY, '基于此追提', PALETTE.chipBg, 'open-followup', modal.issueNumber) + 1
    }
    buf.drawButton(fx, footerY, '关闭 (Esc)', PALETTE.chipBg, 'close-modal')
  }
}
