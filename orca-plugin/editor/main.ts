import type { BoardSnapshot, IssueKind, NeedsYouItem } from '../src/protocol'
import { BOARD_STYLES } from './styles'
import { loadBoardDescriptor } from './sync'

const styleEl = document.createElement('style')
styleEl.textContent = BOARD_STYLES
document.head.append(styleEl)

const root = document.createElement('div')
root.className = 'ib-app'
document.body.append(root)

type UIState = {
  snapshot: BoardSnapshot | null
  loading: boolean
  submitting: boolean
  enablingAutopilot: boolean
  busyItemIds: Set<string>
  kind: IssueKind
  titleDraft: string
  detailsDraft: string
  showDetails: boolean
  followUpOf: number | null
  replyDrafts: Map<string, string>
  toast: { kind: 'success' | 'error'; text: string } | null
}

const state: UIState = {
  snapshot: null,
  loading: true,
  submitting: false,
  enablingAutopilot: false,
  busyItemIds: new Set(),
  kind: 'feature',
  titleDraft: '',
  detailsDraft: '',
  showDetails: false,
  followUpOf: null,
  replyDrafts: new Map(),
  toast: null
}

let descriptor = { version: 1 as const, repoPath: undefined as string | undefined, repository: undefined as string | undefined, workspaceId: undefined as string | undefined }
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(kind: 'success' | 'error', text: string) {
  state.toast = { kind, text }
  render()
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    state.toast = null
    render()
  }, 4500)
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} 小时前`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} 天前`
}

function openExternalUrl(url: string) {
  if (!url) return
  if (orca.shell?.openExternal) {
    void orca.shell.openExternal(url)
  }
}

async function fetchSnapshot(silent = false) {
  if (!silent) {
    state.loading = true
    render()
  }
  try {
    const snap = await orca.plugin.request('board.snapshot', {
      repoPath: descriptor.repoPath,
      repository: descriptor.repository,
      workspaceId: descriptor.workspaceId
    })
    state.snapshot = snap
  } catch (err) {
    showToast('error', `刷新失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    state.loading = false
    render()
  }
}

async function handleCreateIssue() {
  const repoPath = state.snapshot?.repoPath
  if (!repoPath) {
    showToast('error', '未检测到当前项目路径，请刷新重试')
    return
  }
  const title = state.titleDraft.trim()
  if (!title) {
    showToast('error', '请先输入你想做的需求或遇到的问题')
    return
  }
  state.submitting = true
  render()
  try {
    const res = await orca.plugin.request('board.createIssue', {
      repoPath,
      kind: state.kind,
      title,
      details: state.detailsDraft.trim() || undefined,
      followUpOf: state.followUpOf
    })
    state.titleDraft = ''
    state.detailsDraft = ''
    state.showDetails = false
    state.followUpOf = null
    showToast('success', `已提交${res.issueNumber ? ` #${res.issueNumber}` : ''}，后台助手会自动接手处理`)
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.submitting = false
    render()
  }
}

async function handleReplyAgent(item: Extract<NeedsYouItem, { kind: 'agent-question' }>, preset?: string) {
  const message = (preset ?? state.replyDrafts.get(item.id) ?? '').trim()
  if (!message) {
    showToast('error', '请先输入回复内容')
    return
  }
  state.busyItemIds.add(item.id)
  render()
  try {
    await orca.plugin.request('board.replyAgent', {
      terminalId: item.terminalId,
      message
    })
    state.replyDrafts.delete(item.id)
    showToast('success', '已发送回复，助手正在继续处理')
    setTimeout(() => void fetchSnapshot(true), 1200)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.busyItemIds.delete(item.id)
    render()
  }
}

async function handleIssueAction(
  item: Extract<NeedsYouItem, { kind: 'issue-attention' }>,
  action: 'retry' | 'discard'
) {
  const repoPath = state.snapshot?.repoPath
  if (!repoPath) return
  state.busyItemIds.add(item.id)
  render()
  try {
    await orca.plugin.request('board.issueAction', {
      repoPath,
      issueUrl: item.url,
      action
    })
    showToast('success', action === 'retry' ? '已安排重新尝试处理' : '已放弃该任务')
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.busyItemIds.delete(item.id)
    render()
  }
}

async function handleEnableAutopilot() {
  const repoPath = state.snapshot?.repoPath
  if (!repoPath) return
  state.enablingAutopilot = true
  render()
  try {
    const res = await orca.plugin.request('board.enableAutopilot', { repoPath })
    showToast('success', res.message)
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.enablingAutopilot = false
    render()
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderHeader(snap: BoardSnapshot | null): HTMLElement {
  const header = el('header', 'ib-header')
  const left = el('div', 'ib-header-left')
  left.append(el('h1', 'ib-title', snap ? `${snap.projectName} · Issue 看板` : 'Issue 看板'))
  if (snap?.repository) {
    left.append(el('span', 'ib-repo-pill', snap.repository))
  }

  const right = el('div', 'ib-header-right')
  if (snap && !snap.error) {
    if (snap.autopilotInstalled) {
      const pill = el('span', 'ib-status-pill')
      pill.append(el('span', 'ib-dot ib-dot-green'), document.createTextNode('自动处理运行中'))
      right.append(pill)
    } else if (snap.repoPath) {
      const enableBtn = el(
        'button',
        'ib-btn ib-btn-primary',
        state.enablingAutopilot ? '开启中...' : '开启自动处理'
      )
      enableBtn.disabled = state.enablingAutopilot
      enableBtn.addEventListener('click', () => void handleEnableAutopilot())
      right.append(enableBtn)
    }
  }

  const refreshBtn = el('button', 'ib-btn', state.loading ? '刷新中...' : '刷新')
  refreshBtn.disabled = state.loading
  refreshBtn.addEventListener('click', () => void fetchSnapshot(false))
  right.append(refreshBtn)

  header.append(left, right)
  return header
}

function renderComposer(): HTMLElement {
  const card = el('div', 'ib-card ib-composer')

  if (state.followUpOf) {
    const banner = el('div', 'ib-followup-banner')
    banner.append(el('span', undefined, `针对 #${state.followUpOf} 的补充修改`))
    const clearBtn = el('button', 'ib-btn ib-btn-ghost', '×')
    clearBtn.addEventListener('click', () => {
      state.followUpOf = null
      render()
    })
    banner.append(clearBtn)
    card.append(banner)
  }

  const titleInput = el('input', 'ib-input ib-input-title')
  titleInput.type = 'text'
  titleInput.placeholder = '+ 提一个新需求或报个问题，直接说人话就行...'
  titleInput.value = state.titleDraft
  titleInput.disabled = state.submitting
  titleInput.addEventListener('input', () => {
    state.titleDraft = titleInput.value
  })
  titleInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleCreateIssue()
    }
  })
  card.append(titleInput)

  if (state.showDetails) {
    const detailsInput = el('textarea', 'ib-textarea')
    detailsInput.placeholder = '补充一点背景、复现步骤或你希望的效果（选填）'
    detailsInput.value = state.detailsDraft
    detailsInput.disabled = state.submitting
    detailsInput.addEventListener('input', () => {
      state.detailsDraft = detailsInput.value
    })
    detailsInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleCreateIssue()
      }
    })
    card.append(detailsInput)
  }

  const footer = el('div', 'ib-composer-footer')
  const kinds = el('div', 'ib-kind-group')
  const kindMeta: Array<{ id: IssueKind; label: string }> = [
    { id: 'feature', label: '新功能' },
    { id: 'bug', label: '修 Bug' },
    { id: 'polish', label: '体验优化' }
  ]
  for (const item of kindMeta) {
    const chip = el('button', `ib-chip${state.kind === item.id ? ' active' : ''}`, item.label)
    chip.type = 'button'
    chip.addEventListener('click', () => {
      state.kind = item.id
      render()
    })
    kinds.append(chip)
  }

  const actions = el('div', 'ib-needs-actions')
  const toggleDetails = el(
    'button',
    'ib-btn ib-btn-ghost',
    state.showDetails ? '收起补充说明' : '+ 补充说明'
  )
  toggleDetails.type = 'button'
  toggleDetails.addEventListener('click', () => {
    state.showDetails = !state.showDetails
    render()
  })

  const submitBtn = el(
    'button',
    'ib-btn ib-btn-primary',
    state.submitting ? '提交中...' : '提交给助手'
  )
  submitBtn.type = 'button'
  submitBtn.disabled = state.submitting
  submitBtn.addEventListener('click', () => void handleCreateIssue())

  actions.append(toggleDetails, submitBtn)
  footer.append(kinds, actions)
  card.append(footer)
  return card
}

function renderLeftColumn(snap: BoardSnapshot | null): HTMLElement {
  const col = el('section', 'ib-col')
  col.append(renderComposer())

  const inProgress = snap?.inProgress ?? []
  const inProgressWrap = el('div')
  const ipHead = el('div', 'ib-section-head')
  const ipTitle = el('h2', 'ib-section-title')
  ipTitle.append(
    document.createTextNode('进行中'),
    el('span', 'ib-badge', String(inProgress.length))
  )
  ipHead.append(ipTitle)
  inProgressWrap.append(ipHead)

  if (inProgress.length === 0) {
    inProgressWrap.append(el('div', 'ib-empty', '当前没有正在处理的任务'))
  } else {
    const list = el('div', 'ib-list')
    for (const item of inProgress) {
      const row = el('div', 'ib-row')
      const main = el('div', 'ib-row-main')
      const titleLine = el('div', 'ib-row-title-line')
      titleLine.append(
        el('span', 'ib-dot ib-dot-blue'),
        el('span', 'ib-row-title', item.title)
      )
      main.append(titleLine)

      const meta = el('div', 'ib-row-meta')
      meta.append(el('span', undefined, item.statusLabel))
      const rel = formatRelativeTime(item.updatedAt)
      if (rel) meta.append(el('span', undefined, rel))
      if (item.url) {
        const viewBtn = el('button', 'ib-btn ib-btn-ghost', '查看')
        viewBtn.addEventListener('click', () => openExternalUrl(item.url))
        meta.append(viewBtn)
      }

      row.append(main, meta)
      list.append(row)
    }
    inProgressWrap.append(list)
  }
  col.append(inProgressWrap)

  const completed = snap?.completed ?? []
  const completedWrap = el('div')
  const cHead = el('div', 'ib-section-head')
  const cTitle = el('h2', 'ib-section-title')
  cTitle.append(
    document.createTextNode('已完成（可直接验收）'),
    el('span', 'ib-badge', String(completed.length))
  )
  cHead.append(cTitle)
  completedWrap.append(cHead)

  if (completed.length === 0) {
    completedWrap.append(el('div', 'ib-empty', '完成的任务会出现在这里，方便你直接体验验收'))
  } else {
    const list = el('div', 'ib-list')
    for (const item of completed) {
      const row = el('div', 'ib-row')
      const main = el('div', 'ib-row-main')
      const titleLine = el('div', 'ib-row-title-line')
      titleLine.append(
        el('span', 'ib-dot ib-dot-green'),
        el('span', 'ib-row-title', item.title)
      )
      main.append(titleLine, el('div', 'ib-row-summary', item.summary))

      const meta = el('div', 'ib-row-meta')
      const rel = formatRelativeTime(item.completedAt)
      if (rel) meta.append(el('span', undefined, rel))
      const targetUrl = item.prUrl || item.url
      if (targetUrl) {
        const openBtn = el('button', 'ib-btn ib-btn-ghost', '查看')
        openBtn.addEventListener('click', () => openExternalUrl(targetUrl))
        meta.append(openBtn)
      }
      const followBtn = el('button', 'ib-btn ib-btn-ghost', '再提一条')
      followBtn.addEventListener('click', () => {
        state.followUpOf = item.issueNumber
        state.kind = 'polish'
        state.showDetails = true
        render()
      })
      meta.append(followBtn)

      row.append(main, meta)
      list.append(row)
    }
    completedWrap.append(list)
  }
  col.append(completedWrap)

  return col
}

function renderRightColumn(snap: BoardSnapshot | null): HTMLElement {
  const col = el('section', 'ib-col')
  const items = snap?.needsYou ?? []

  const head = el('div', 'ib-section-head')
  const title = el('h2', 'ib-section-title')
  title.append(
    document.createTextNode('需要你处理'),
    el('span', `ib-badge${items.length > 0 ? ' ib-badge-alert' : ''}`, String(items.length))
  )
  head.append(title)
  col.append(head)

  if (items.length === 0) {
    const empty = el('div', 'ib-empty ib-empty-calm')
    empty.append(
      el('div', 'ib-check-circle', '✓'),
      el('div', undefined, '一切自动运行中，暂时不需要你操心'),
      el('div', undefined, '只有助手向你提问或需要拍板时，才会在这里提醒你')
    )
    col.append(empty)
    return col
  }

  const list = el('div', 'ib-list')
  for (const item of items) {
    const busy = state.busyItemIds.has(item.id)
    const card = el('div', 'ib-card ib-needs-card')

    if (item.kind === 'agent-question') {
      const tag = el('div', 'ib-needs-tag')
      tag.append(el('span', 'ib-dot ib-dot-amber'), document.createTextNode('助手等你回复'))
      card.append(
        tag,
        el('h3', 'ib-needs-title', item.title),
        el('pre', 'ib-needs-body', item.question)
      )

      const replyBox = el('textarea', 'ib-textarea')
      replyBox.placeholder = '直接输入你的回答或要求...'
      replyBox.value = state.replyDrafts.get(item.id) ?? ''
      replyBox.disabled = busy
      replyBox.addEventListener('input', () => {
        state.replyDrafts.set(item.id, replyBox.value)
      })
      card.append(replyBox)

      const actions = el('div', 'ib-needs-actions')
      const sendBtn = el('button', 'ib-btn ib-btn-primary', busy ? '发送中...' : '发送回复')
      sendBtn.disabled = busy
      sendBtn.addEventListener('click', () => void handleReplyAgent(item))

      const approveBtn = el('button', 'ib-btn', '同意继续')
      approveBtn.disabled = busy
      approveBtn.addEventListener('click', () => void handleReplyAgent(item, '同意，请继续'))

      actions.append(sendBtn, approveBtn)
      card.append(actions)
    } else {
      const tag = el('div', 'ib-needs-tag')
      tag.append(el('span', 'ib-dot ib-dot-amber'), document.createTextNode('需要你拍板'))
      card.append(
        tag,
        el('h3', 'ib-needs-title', `#${item.issueNumber} ${item.title}`),
        el('div', 'ib-needs-body', item.reason)
      )

      const actions = el('div', 'ib-needs-actions')
      if (item.canRetry) {
        const retryBtn = el('button', 'ib-btn ib-btn-primary', busy ? '处理中...' : '重试一次')
        retryBtn.disabled = busy
        retryBtn.addEventListener('click', () => void handleIssueAction(item, 'retry'))
        actions.append(retryBtn)
      }
      if (item.canDiscard) {
        const discardBtn = el('button', 'ib-btn ib-btn-danger', '放弃这条')
        discardBtn.disabled = busy
        discardBtn.addEventListener('click', () => void handleIssueAction(item, 'discard'))
        actions.append(discardBtn)
      }
      if (item.url) {
        const linkBtn = el('button', 'ib-btn ib-btn-ghost', '打开 GitHub 查看')
        linkBtn.addEventListener('click', () => openExternalUrl(item.url))
        actions.append(linkBtn)
      }
      card.append(actions)
    }

    list.append(card)
  }

  col.append(list)
  return col
}

function render() {
  root.replaceChildren()
  root.append(renderHeader(state.snapshot))

  if (state.toast) {
    const toast = el('div', `ib-toast ib-toast-${state.toast.kind}`, state.toast.text)
    root.append(toast)
  } else if (state.snapshot?.error) {
    root.append(el('div', 'ib-toast ib-toast-error', state.snapshot.error))
  }

  const columns = el('main', 'ib-columns')
  columns.append(renderLeftColumn(state.snapshot), renderRightColumn(state.snapshot))
  root.append(columns)
}

async function init() {
  render()
  descriptor = await loadBoardDescriptor()
  await fetchSnapshot(false)

  orca.plugin.on('board.updated', (payload) => {
    if (!payload.repoPath || !state.snapshot?.repoPath || payload.repoPath === state.snapshot.repoPath) {
      void fetchSnapshot(true)
    }
  })

  orca.on('theme', () => {
    // CSS variables update automatically on <html>
  })
}

void init()
