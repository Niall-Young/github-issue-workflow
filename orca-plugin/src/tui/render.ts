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
  SavedAttachment,
  SubmitMode
} from '../protocol'
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

export type ModalState =
  | { type: 'none' }
  | {
      type: 'compose'
      mode: SubmitMode
      kind: IssueKind
      title: string
      details: string
      focus: 'title' | 'details'
      followUpOf: number | null
      attachments: SavedAttachment[]
      submitting: boolean
    }
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
      attachments: SavedAttachment[]
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
  modal: ModalState
  toast: { kind: 'ok' | 'err'; text: string } | null
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

export function renderTui(state: TuiState, width: number, height: number): ScreenBuffer {
  const buf = new ScreenBuffer(width, height)
  const snap = state.snapshot

  // ── Top Header (rows 0..1) ────────────────────────────────────────────────
  const projectLabel = snap ? snap.projectName : 'Issue 看板'
  const repoLabel = snap?.repository ? ` ${snap.repository}` : ''
  let col = 1
  col += buf.writeText(col, 0, '◆ ', PALETTE.accentBold)
  col += buf.writeText(col, 0, projectLabel, PALETTE.bright)
  if (repoLabel) {
    col += buf.writeText(col, 0, repoLabel, PALETTE.muted, Math.max(0, width - col - 46))
  }
  col += 2
  if (snap) {
    if (snap.autopilotInstalled) {
      col += buf.writeText(col, 0, '● 自动运行中', PALETTE.green)
    } else {
      col += buf.drawButton(col, 0, '+ 开启自动处理', PALETTE.chipActiveBg, 'enable-autopilot')
    }
  } else if (state.loading) {
    col += buf.writeText(col, 0, '◌ 同步中…', PALETTE.amber)
  }

  // Right-aligned header action buttons
  const agentLabel = `⚙ ${snap?.defaultAgent || snap?.preferredAgent || 'Agent'}`
  const btns: Array<{ label: string; style: string; action: string }> = [
    { label: '+ 提需求', style: PALETTE.accentBg, action: 'open-compose' },
    { label: agentLabel, style: PALETTE.chipBg, action: 'open-settings' },
    { label: '↻', style: PALETTE.chipBg, action: 'refresh' },
    { label: '×', style: PALETTE.chipBg, action: 'quit' }
  ]
  const totalBtnW = btns.reduce((acc, b) => acc + stringDisplayWidth(b.label) + 3, 0)
  let btnX = Math.max(col + 1, width - totalBtnW)
  for (const b of btns) {
    if (btnX + stringDisplayWidth(b.label) + 2 <= width) {
      btnX += buf.drawButton(btnX, 0, b.label, b.style, b.action) + 1
    }
  }

  buf.drawHLine(0, 1, width, PALETTE.border)

  // ── Main Content Area (rows 2 .. height - 3) ──────────────────────────────
  const contentTop = 2
  const contentHeight = Math.max(4, height - 4)
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

  // ── Footer (rows height - 2 .. height - 1) ────────────────────────────────
  buf.drawHLine(0, height - 2, width, PALETTE.border)
  if (state.toast) {
    const style = state.toast.kind === 'ok' ? PALETTE.toastOk : PALETTE.toastErr
    buf.fillRect(0, height - 1, width, 1, style)
    buf.writeText(1, height - 1, state.toast.text, style, width - 2)
  } else {
    const syncText = snap ? `同步 ${formatRelativeTime(snap.syncedAt) || '刚刚'}` : '加载中…'
    const hints =
      '↑↓/滚轮 移动 · 点击/Enter 打开 · n 提需求 · i/p 切换 · , 配Agent · r 刷新 · q 退出'
    const syncW = stringDisplayWidth(syncText)
    buf.writeText(1, height - 1, hints, PALETTE.muted, Math.max(0, width - syncW - 3))
    buf.writeText(Math.max(1, width - syncW - 1), height - 1, syncText, PALETTE.dim)
  }

  // ── Active Modal Overlay ──────────────────────────────────────────────────
  if (state.modal.type !== 'none') {
    renderModal(buf, state, width, height)
  }

  return buf
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
        ? '暂无任务 · 按 n 或点击右上角「+ 提需求」开始'
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
  const mh =
    modal.type === 'compose'
      ? Math.min(18, height - 4)
      : modal.type === 'settings'
        ? Math.min(16, height - 4)
        : Math.min(14, height - 4)
  const mx = Math.floor((width - mw) / 2)
  const my = Math.floor((height - mh) / 2)

  // Consume background clicks outside modal as close
  buf.addHitBox(0, 0, width, height, 'close-modal')

  const titleMap = {
    compose: modal.type === 'compose' && modal.followUpOf ? `追提需求 (基于 #${modal.followUpOf})` : '提新需求 / 报问题',
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

  if (modal.type === 'compose') {
    let row = my + 2
    // Mode selector
    let cx = ix
    cx += buf.writeText(cx, row, '方式: ', PALETTE.muted)
    cx +=
      buf.drawButton(
        cx,
        row,
        'Skill 规范提单',
        modal.mode === 'handoff' ? PALETTE.chipActiveBg : PALETTE.chipBg,
        'compose-mode',
        'handoff'
      ) + 1
    buf.drawButton(
      cx,
      row,
      '快速直提',
      modal.mode === 'direct' ? PALETTE.chipActiveBg : PALETTE.chipBg,
      'compose-mode',
      'direct'
    )

    row += 2
    cx = ix
    cx += buf.writeText(cx, row, '类型: ', PALETTE.muted)
    const kinds: Array<{ id: IssueKind; label: string }> = [
      { id: 'feature', label: '新功能' },
      { id: 'bug', label: '修 Bug' },
      { id: 'polish', label: '体验优化' }
    ]
    for (const k of kinds) {
      cx +=
        buf.drawButton(
          cx,
          row,
          k.label,
          modal.kind === k.id ? PALETTE.chipActiveBg : PALETTE.chipBg,
          'compose-kind',
          k.id
        ) + 1
    }

    row += 2
    buf.writeText(ix, row, '标题（必填）:', modal.focus === 'title' ? PALETTE.accent : PALETTE.muted)
    row += 1
    const titleStyle = modal.focus === 'title' ? PALETTE.inputFocusBg : PALETTE.inputBg
    buf.fillRect(ix, row, iw, 1, titleStyle)
    const titleDisplay = modal.title + (modal.focus === 'title' ? '▏' : '')
    buf.writeText(ix + 1, row, titleDisplay || '用大白话描述想做什么…', modal.title ? titleStyle : PALETTE.dim, iw - 2)
    buf.addHitBox(ix, row, iw, 1, 'compose-focus', 'title')

    row += 2
    buf.writeText(ix, row, '补充说明（可选，Tab 切换焦点）:', modal.focus === 'details' ? PALETTE.accent : PALETTE.muted)
    row += 1
    const detStyle = modal.focus === 'details' ? PALETTE.inputFocusBg : PALETTE.inputBg
    buf.fillRect(ix, row, iw, 2, detStyle)
    const detLines = wrapTextToWidth(modal.details + (modal.focus === 'details' ? '▏' : ''), iw - 2, 2)
    if (detLines.length === 0) {
      buf.writeText(ix + 1, row, '背景、复现步骤或拖拽文件到此终端…', PALETTE.dim, iw - 2)
    } else {
      detLines.forEach((l, idx) => buf.writeText(ix + 1, row + idx, l, detStyle, iw - 2))
    }
    buf.addHitBox(ix, row, iw, 2, 'compose-focus', 'details')

    row += 3
    let ax = ix
    ax += buf.drawButton(ax, row, '+ 粘贴截图 (^V)', PALETTE.chipBg, 'compose-paste-image') + 1
    if (modal.attachments.length > 0) {
      buf.writeText(
        ax,
        row,
        `已附 ${modal.attachments.length} 个: ${modal.attachments.map((a) => a.name).join(', ')}`,
        PALETTE.green,
        Math.max(0, ix + iw - ax)
      )
    } else {
      buf.writeText(ax, row, '支持拖入文件路径或 ^V 贴截图', PALETTE.dim, Math.max(0, ix + iw - ax))
    }

    const footerY = my + mh - 2
    let fx = ix
    fx +=
      buf.drawButton(
        fx,
        footerY,
        modal.submitting ? '提交中…' : '提交 (Enter)',
        PALETTE.accentBg,
        'compose-submit'
      ) + 1
    buf.drawButton(fx, footerY, '取消 (Esc)', PALETTE.chipBg, 'close-modal')
    return
  }

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
    rLines.forEach((l, i) => buf.writeText(ix + 1, inputY + i, l, PALETTE.inputFocusBg, iw - 2))
    const attY = inputY + 3
    let ax = ix
    ax += buf.drawButton(ax, attY, '+ 粘贴截图 (^V)', PALETTE.chipBg, 'reply-paste-image') + 1
    if (modal.attachments.length > 0) {
      buf.writeText(ax, attY, `已附 ${modal.attachments.length} 个`, PALETTE.green, Math.max(0, ix + iw - ax))
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
