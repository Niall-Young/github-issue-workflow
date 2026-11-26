import type {
  AttachmentPayload,
  BoardSnapshot,
  IssueKind,
  NeedsYouItem,
  PullRequestItem,
  SubmitMode
} from '../src/protocol'
import { BOARD_STYLES } from './styles'
import { loadBoardDescriptor } from './sync'

const MAX_FILES = 8
const MAX_BYTES = 10 * 1024 * 1024

const styleEl = document.createElement('style')
styleEl.textContent = BOARD_STYLES
document.head.append(styleEl)

const root = document.createElement('div')
root.className = 'tui-shell'
document.body.append(root)

type DraftAttachment = AttachmentPayload & {
  id: string
  previewUrl?: string
}

type UIState = {
  snapshot: BoardSnapshot | null
  loading: boolean
  submitting: boolean
  enablingAutopilot: boolean
  showSettings: boolean
  savingAgentConfig: boolean
  draftDefaultAgent: string
  draftAllowedAgents: string[]
  busyItemIds: Set<string>
  activeTab: 'issues' | 'prs'
  kind: IssueKind
  submitMode: SubmitMode
  titleDraft: string
  detailsDraft: string
  showDetails: boolean
  followUpOf: number | null
  attachments: DraftAttachment[]
  composerDragOver: boolean
  replyDrafts: Map<string, string>
  replyAttachments: Map<string, DraftAttachment[]>
  toast: { kind: 'success' | 'error'; text: string } | null
}

const state: UIState = {
  snapshot: null,
  loading: true,
  submitting: false,
  enablingAutopilot: false,
  showSettings: false,
  savingAgentConfig: false,
  draftDefaultAgent: '',
  draftAllowedAgents: [],
  busyItemIds: new Set(),
  activeTab: 'issues',
  kind: 'feature',
  submitMode: 'handoff',
  titleDraft: '',
  detailsDraft: '',
  showDetails: false,
  followUpOf: null,
  attachments: [],
  composerDragOver: false,
  replyDrafts: new Map(),
  replyAttachments: new Map(),
  toast: null
}

let descriptor = {
  version: 1 as const,
  repoPath: undefined as string | undefined,
  repository: undefined as string | undefined,
  workspaceId: undefined as string | undefined
}
let toastTimer: ReturnType<typeof setTimeout> | null = null
let titleInputRef: HTMLInputElement | null = null

function showToast(kind: 'success' | 'error', text: string) {
  state.toast = { kind, text }
  render()
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    state.toast = null
    render()
  }, 4500)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h前`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d前`
}

function openExternalUrl(url: string) {
  if (!url) return
  if (orca.shell?.openExternal) {
    void orca.shell.openExternal(url)
  }
}

function readFileAsAttachment(file: File): Promise<DraftAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_BYTES) {
      reject(new Error(`文件 ${file.name} 超过 10MB 限制`))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
      const mimeType = file.type || 'application/octet-stream'
      const fallbackName =
        file.name ||
        (mimeType.startsWith('image/')
          ? `screenshot-${Date.now()}.${mimeType.split('/')[1] || 'png'}`
          : `file-${Date.now()}`)
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: fallbackName,
        mimeType,
        size: file.size,
        base64,
        previewUrl: mimeType.startsWith('image/') ? dataUrl : undefined
      })
    }
    reader.readAsDataURL(file)
  })
}

async function addFilesToList(files: File[], target: DraftAttachment[], onDone: () => void) {
  if (files.length === 0) return
  const remaining = MAX_FILES - target.length
  if (remaining <= 0) {
    showToast('error', `最多只能附加 ${MAX_FILES} 个截图或文件`)
    return
  }
  const picked = files.slice(0, remaining)
  let added = 0
  for (const file of picked) {
    try {
      const att = await readFileAsAttachment(file)
      target.push(att)
      added += 1
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err))
    }
  }
  if (added > 0) {
    onDone()
  }
}

function extractFilesFromPaste(e: ClipboardEvent): File[] {
  const files: File[] = []
  const items = e.clipboardData?.items
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  if (files.length === 0 && e.clipboardData?.files?.length) {
    for (let i = 0; i < e.clipboardData.files.length; i += 1) {
      files.push(e.clipboardData.files[i])
    }
  }
  return files
}

function syncAgentDraftFromSnapshot(snap: BoardSnapshot | null) {
  if (!snap) return
  const def = snap.defaultAgent || snap.preferredAgent || 'codex'
  state.draftDefaultAgent = def
  const allowed = snap.allowedAgents.length > 0 ? snap.allowedAgents : [def]
  state.draftAllowedAgents = Array.from(new Set([def, ...allowed]))
}

async function fetchSnapshot(silent = false) {
  if (!silent) {
    state.loading = true
    render()
  }
  try {
    const reqInput: { repoPath?: string; repository?: string; workspaceId?: string } = {}
    if (descriptor.repoPath) reqInput.repoPath = descriptor.repoPath
    if (descriptor.repository) reqInput.repository = descriptor.repository
    if (descriptor.workspaceId) reqInput.workspaceId = descriptor.workspaceId

    const snap = await orca.plugin.request('board.snapshot', reqInput)
    state.snapshot = snap
    if (!state.showSettings || !state.draftDefaultAgent) {
      syncAgentDraftFromSnapshot(snap)
    }
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
    showToast('error', '未检测到当前项目路径，请按 r 刷新重试')
    return
  }
  const title = state.titleDraft.trim()
  if (!title) {
    showToast('error', '请先输入需求或问题描述')
    return
  }
  state.submitting = true
  render()
  try {
    const attachments: AttachmentPayload[] = state.attachments.map(({ name, mimeType, size, base64 }) => ({
      name,
      mimeType,
      size,
      base64
    }))
    const details = state.detailsDraft.trim()
    const payload: {
      repoPath: string
      workspaceId?: string
      mode: SubmitMode
      kind: IssueKind
      title: string
      details?: string
      followUpOf?: number | null
      attachments?: AttachmentPayload[]
    } = {
      repoPath,
      mode: state.submitMode,
      kind: state.kind,
      title
    }
    if (descriptor.workspaceId) payload.workspaceId = descriptor.workspaceId
    if (details) payload.details = details
    if (state.followUpOf !== null) payload.followUpOf = state.followUpOf
    if (attachments.length > 0) payload.attachments = attachments

    const res = await orca.plugin.request('board.createIssue', payload)
    state.titleDraft = ''
    state.detailsDraft = ''
    state.showDetails = false
    state.followUpOf = null
    state.attachments = []
    const attMsg = res.savedAttachments.length > 0 ? `（含 ${res.savedAttachments.length} 个附件）` : ''
    if (res.mode === 'handoff') {
      showToast(
        'success',
        `已启动 ${res.agent || 'Agent'} 按 github-issue-handoff 整理并提单${attMsg}；如需补充信息会出现在右侧「需要你处理」`
      )
    } else {
      showToast(
        'success',
        `已直接提交${res.issueNumber ? ` #${res.issueNumber}` : ''}${attMsg}，后台助手会自动接手`
      )
    }
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.submitting = false
    render()
  }
}

async function handleReplyAgent(
  item: Extract<NeedsYouItem, { kind: 'agent-question' }>,
  preset?: string
) {
  const message = (preset ?? state.replyDrafts.get(item.id) ?? '').trim()
  const draftAtts = state.replyAttachments.get(item.id) ?? []
  if (!message && draftAtts.length === 0) {
    showToast('error', '请先输入回复或粘贴截图')
    return
  }
  state.busyItemIds.add(item.id)
  render()
  try {
    const payload: {
      terminalId: string
      message: string
      repoPath?: string
      attachments?: AttachmentPayload[]
    } = {
      terminalId: item.terminalId,
      message
    }
    if (state.snapshot?.repoPath) payload.repoPath = state.snapshot.repoPath
    if (draftAtts.length > 0) {
      payload.attachments = draftAtts.map(({ name, mimeType, size, base64 }) => ({
        name,
        mimeType,
        size,
        base64
      }))
    }
    await orca.plugin.request('board.replyAgent', payload)
    state.replyDrafts.delete(item.id)
    state.replyAttachments.delete(item.id)
    showToast('success', '已发送给助手，正在继续处理')
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
    showToast('success', action === 'retry' ? '已重新派发处理' : '已放弃该任务')
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.busyItemIds.delete(item.id)
    render()
  }
}

async function handleEnableAutopilot(overrideAgent?: string, overrideAllowed?: string[]) {
  const repoPath = state.snapshot?.repoPath
  if (!repoPath) return
  state.enablingAutopilot = true
  render()
  try {
    const agent = overrideAgent || state.draftDefaultAgent || state.snapshot?.preferredAgent
    const allowedAgents = overrideAllowed ?? state.draftAllowedAgents
    const res = await orca.plugin.request('board.enableAutopilot', {
      repoPath,
      ...(agent ? { agent } : {}),
      ...(allowedAgents.length > 0 ? { allowedAgents } : {})
    })
    state.showSettings = false
    showToast('success', res.message)
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.enablingAutopilot = false
    render()
  }
}

async function handleSaveAgentConfig() {
  const repoPath = state.snapshot?.repoPath
  if (!repoPath) return
  const defaultAgent = state.draftDefaultAgent.trim()
  if (!defaultAgent) {
    showToast('error', '请先选择默认执行 Agent')
    return
  }
  state.savingAgentConfig = true
  render()
  try {
    const allowedAgents = Array.from(new Set([defaultAgent, ...state.draftAllowedAgents]))
    const res = await orca.plugin.request('board.updateAgentConfig', {
      repoPath,
      defaultAgent,
      allowedAgents
    })
    state.showSettings = false
    showToast('success', res.message)
    await fetchSnapshot(true)
  } catch (err) {
    showToast('error', err instanceof Error ? err.message : String(err))
  } finally {
    state.savingAgentConfig = false
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

function renderAttachmentsStrip(
  list: DraftAttachment[],
  onRemove: (id: string) => void
): HTMLElement {
  const wrap = el('div', 'tui-attachments')
  for (const att of list) {
    const chip = el('div', 'tui-att-chip')
    if (att.previewUrl) {
      const img = el('img', 'tui-att-thumb')
      img.src = att.previewUrl
      img.alt = att.name
      chip.append(img)
    } else {
      chip.append(el('span', 'tui-row-num', '[FILE]'))
    }
    chip.append(
      el('span', 'tui-att-name', att.name),
      el('span', 'tui-att-size', formatBytes(att.size))
    )
    const rm = el('button', 'tui-btn tui-btn-link', '×')
    rm.type = 'button'
    rm.addEventListener('click', () => onRemove(att.id))
    chip.append(rm)
    wrap.append(chip)
  }
  return wrap
}

function renderTopBar(snap: BoardSnapshot | null): HTMLElement {
  const bar = el('header', 'tui-topbar')
  const left = el('div', 'tui-topbar-left')
  left.append(
    el('span', 'tui-brand', '[ISSUE-BOARD]'),
    el('span', 'tui-project', snap ? snap.projectName : '加载中...')
  )
  if (snap?.repository) {
    left.append(el('span', 'tui-repo', `(${snap.repository})`))
  }

  const right = el('div', 'tui-topbar-right')
  if (snap && !snap.error) {
    if (snap.repoPath) {
      const currentAgent = snap.defaultAgent || snap.preferredAgent || 'codex'
      const cfgBtn = el(
        'button',
        `tui-btn${state.showSettings ? ' tui-btn-primary' : ''}`,
        `⚙ Agent: ${currentAgent}`
      )
      cfgBtn.type = 'button'
      cfgBtn.title = '配置工作树默认执行 Agent 及允许通过 agent:<id> 标签切换的 Agent（快捷键 ,）'
      cfgBtn.addEventListener('click', () => {
        state.showSettings = !state.showSettings
        if (state.showSettings) {
          syncAgentDraftFromSnapshot(snap)
        }
        render()
      })
      right.append(cfgBtn)
    }

    if (snap.autopilotInstalled) {
      right.append(el('span', 'tui-state-tag ok', '● 自动处理中'))
    } else if (snap.repoPath) {
      const btn = el(
        'button',
        'tui-btn tui-btn-primary',
        state.enablingAutopilot ? '开启中...' : '+ 开启自动处理'
      )
      btn.disabled = state.enablingAutopilot
      btn.addEventListener('click', () => void handleEnableAutopilot())
      right.append(btn)
    }
  }

  const refreshBtn = el('button', 'tui-btn', state.loading ? '刷新中...' : 'r 刷新')
  refreshBtn.disabled = state.loading
  refreshBtn.addEventListener('click', () => void fetchSnapshot(false))
  right.append(refreshBtn)

  bar.append(left, right)
  return bar
}

function renderSettingsDrawer(snap: BoardSnapshot): HTMLElement {
  const drawer = el('section', 'tui-settings')

  const head = el('div', 'tui-settings-head')
  head.append(
    el('span', undefined, '⚙ 工作树执行 Agent 配置'),
    el(
      'span',
      'tui-repo',
      snap.autopilotInstalled ? '保存后将同步更新 Orca Automation 并重启协调器' : '尚未开启自动处理，保存时将以此配置开启'
    )
  )
  drawer.append(head)

  const installed = snap.installedAgents
  const currentDraft = state.draftDefaultAgent || snap.defaultAgent || snap.preferredAgent || 'codex'
  const candidateIds = Array.from(
    new Set([
      ...installed.map((a) => a.id),
      currentDraft,
      ...state.draftAllowedAgents
    ].filter(Boolean))
  )
  const labelFor = (id: string): string => {
    const found = installed.find((a) => a.id === id)
    if (!found) return id
    const base = found.name && found.name !== found.id ? `${found.name} (${found.id})` : found.id
    return found.isDefault ? `${base} · Orca 默认` : base
  }

  // Default agent selector
  const rowDefault = el('div', 'tui-settings-row')
  rowDefault.append(el('label', 'tui-settings-label', '默认执行 Agent：'))
  const select = el('select', 'tui-select')
  select.disabled = state.savingAgentConfig || state.enablingAutopilot
  for (const id of candidateIds) {
    const opt = el('option')
    opt.value = id
    opt.textContent = labelFor(id)
    opt.selected = id === currentDraft
    select.append(opt)
  }
  select.addEventListener('change', () => {
    state.draftDefaultAgent = select.value
    if (!state.draftAllowedAgents.includes(select.value)) {
      state.draftAllowedAgents = Array.from(new Set([select.value, ...state.draftAllowedAgents]))
    }
    render()
  })
  rowDefault.append(select)
  drawer.append(rowDefault)

  // Allowed agents for per-issue label overrides
  const rowAllowed = el('div', 'tui-settings-row')
  rowAllowed.append(el('span', 'tui-settings-label', '允许标签切换 (agent:*)：'))
  const chipGroup = el('div', 'tui-group')
  for (const id of candidateIds) {
    const isDefault = id === currentDraft
    const isAllowed = isDefault || state.draftAllowedAgents.includes(id)
    const chip = el(
      'button',
      `tui-agent-chip${isAllowed ? ' active' : ''}`,
      isDefault ? `[✓ ${id} · 默认]` : isAllowed ? `[✓ ${id}]` : `[  ${id}]`
    )
    chip.type = 'button'
    chip.disabled = isDefault || state.savingAgentConfig || state.enablingAutopilot
    chip.addEventListener('click', () => {
      if (isDefault) return
      if (state.draftAllowedAgents.includes(id)) {
        state.draftAllowedAgents = state.draftAllowedAgents.filter((x) => x !== id)
      } else {
        state.draftAllowedAgents = [...state.draftAllowedAgents, id]
      }
      render()
    })
    chipGroup.append(chip)
  }
  rowAllowed.append(chipGroup)
  drawer.append(rowAllowed)

  // Footer actions
  const foot = el('div', 'tui-settings-foot')
  foot.append(
    el(
      'span',
      'tui-drop-hint',
      '单条 Issue 可通过 GitHub 标签 agent:<id> 临时覆盖默认 Agent；修改对后续新派发的工作树生效'
    )
  )
  const actions = el('div', 'tui-group')
  const busy = state.savingAgentConfig || state.enablingAutopilot

  if (snap.autopilotInstalled) {
    const saveBtn = el(
      'button',
      'tui-btn tui-btn-primary',
      state.savingAgentConfig ? '保存并应用中...' : '保存并应用'
    )
    saveBtn.type = 'button'
    saveBtn.disabled = busy
    saveBtn.addEventListener('click', () => void handleSaveAgentConfig())
    actions.append(saveBtn)
  } else {
    const enableBtn = el(
      'button',
      'tui-btn tui-btn-primary',
      state.enablingAutopilot ? '开启中...' : '使用该 Agent 开启自动处理'
    )
    enableBtn.type = 'button'
    enableBtn.disabled = busy
    enableBtn.addEventListener(
      'click',
      () => void handleEnableAutopilot(currentDraft, state.draftAllowedAgents)
    )
    actions.append(enableBtn)
  }

  const closeBtn = el('button', 'tui-btn', '关闭')
  closeBtn.type = 'button'
  closeBtn.disabled = busy
  closeBtn.addEventListener('click', () => {
    state.showSettings = false
    render()
  })
  actions.append(closeBtn)

  foot.append(actions)
  drawer.append(foot)
  return drawer
}

function renderComposer(): HTMLElement {
  const box = el('div', `tui-composer${state.composerDragOver ? ' dragover' : ''}`)

  box.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!state.composerDragOver) {
      state.composerDragOver = true
      box.classList.add('dragover')
    }
  })
  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget as Node | null)) {
      state.composerDragOver = false
      box.classList.remove('dragover')
    }
  })
  box.addEventListener('drop', (e) => {
    e.preventDefault()
    state.composerDragOver = false
    box.classList.remove('dragover')
    const dropped = Array.from(e.dataTransfer?.files || [])
    void addFilesToList(dropped, state.attachments, () => render())
  })

  if (state.followUpOf) {
    const f = el('div', 'tui-followup')
    f.append(el('span', undefined, `↳ 针对 #${state.followUpOf} 的补充验收修改`))
    const clear = el('button', 'tui-btn tui-btn-link', '[×]')
    clear.type = 'button'
    clear.addEventListener('click', () => {
      state.followUpOf = null
      render()
    })
    f.append(clear)
    box.append(f)
  }

  const promptLine = el('div', 'tui-prompt-line')
  promptLine.append(el('span', 'tui-prompt-glyph', '>'))
  const titleInput = el('input', 'tui-input')
  titleInput.type = 'text'
  titleInput.placeholder = '输入新需求或问题（支持直接 Cmd+V 粘贴截图 / 拖入文件）...'
  titleInput.value = state.titleDraft
  titleInput.disabled = state.submitting
  titleInputRef = titleInput
  titleInput.addEventListener('input', () => {
    state.titleDraft = titleInput.value
  })
  titleInput.addEventListener('paste', (e) => {
    const files = extractFilesFromPaste(e)
    if (files.length > 0) {
      e.preventDefault()
      void addFilesToList(files, state.attachments, () => render())
    }
  })
  titleInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleCreateIssue()
    } else if (e.key === 'Escape') {
      titleInput.blur()
    }
  })
  promptLine.append(titleInput)
  box.append(promptLine)

  if (state.showDetails) {
    const details = el('textarea', 'tui-textarea')
    details.placeholder = '补充背景、复现步骤或期望效果（选填，也可直接 Cmd+V 贴图）...'
    details.value = state.detailsDraft
    details.disabled = state.submitting
    details.addEventListener('input', () => {
      state.detailsDraft = details.value
    })
    details.addEventListener('paste', (e) => {
      const files = extractFilesFromPaste(e)
      if (files.length > 0) {
        e.preventDefault()
        void addFilesToList(files, state.attachments, () => render())
      }
    })
    details.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleCreateIssue()
      }
    })
    box.append(details)
  }

  if (state.attachments.length > 0) {
    box.append(
      renderAttachmentsStrip(state.attachments, (id) => {
        state.attachments = state.attachments.filter((a) => a.id !== id)
        render()
      })
    )
  }

  const fileInput = el('input')
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.style.display = 'none'
  fileInput.addEventListener('change', () => {
    const picked = Array.from(fileInput.files || [])
    fileInput.value = ''
    void addFilesToList(picked, state.attachments, () => render())
  })
  box.append(fileInput)

  const bar = el('div', 'tui-composer-bar')
  const kinds = el('div', 'tui-group')
  const kindMeta: Array<{ id: IssueKind; label: string; key: string }> = [
    { id: 'feature', label: '新功能', key: '1' },
    { id: 'bug', label: '修Bug', key: '2' },
    { id: 'polish', label: '优化', key: '3' }
  ]
  for (const item of kindMeta) {
    const btn = el(
      'button',
      `tui-kind${state.kind === item.id ? ' active' : ''}`,
      `[${item.key}:${item.label}]`
    )
    btn.type = 'button'
    btn.addEventListener('click', () => {
      state.kind = item.id
      render()
    })
    kinds.append(btn)
  }

  const rightActions = el('div', 'tui-group')
  const modeBtn = el(
    'button',
    `tui-kind${state.submitMode === 'handoff' ? ' active' : ''}`,
    state.submitMode === 'handoff' ? '[模式: Skill 提单]' : '[模式: 直提]'
  )
  modeBtn.type = 'button'
  modeBtn.disabled = state.submitting
  modeBtn.title =
    state.submitMode === 'handoff'
      ? '当前通过 github-issue-handoff Skill 读代码、查重并按模板提单（点击切换直提）'
      : '当前直接调用 gh issue create 快速提单（点击切换 Skill 提单）'
  modeBtn.addEventListener('click', () => {
    state.submitMode = state.submitMode === 'handoff' ? 'direct' : 'handoff'
    render()
  })

  const attachBtn = el('button', 'tui-btn', '+ 截图/文件')
  attachBtn.type = 'button'
  attachBtn.disabled = state.submitting
  attachBtn.addEventListener('click', () => fileInput.click())

  const detailsBtn = el('button', 'tui-btn tui-btn-link', state.showDetails ? '收起说明' : '+ 补充说明')
  detailsBtn.type = 'button'
  detailsBtn.addEventListener('click', () => {
    state.showDetails = !state.showDetails
    render()
  })

  const submitBtn = el(
    'button',
    'tui-btn tui-btn-primary',
    state.submitting
      ? state.submitMode === 'handoff'
        ? '启动 Skill 中...'
        : '提交中...'
      : state.submitMode === 'handoff'
        ? '⌘↵ Skill 提单'
        : '⌘↵ 直接提交'
  )
  submitBtn.type = 'button'
  submitBtn.disabled = state.submitting
  submitBtn.addEventListener('click', () => void handleCreateIssue())

  rightActions.append(modeBtn, attachBtn, detailsBtn, submitBtn)
  bar.append(kinds, rightActions)
  box.append(bar)
  return box
}

function renderPullRequestRow(pr: PullRequestItem): HTMLElement {
  const row = el('div', 'tui-row')
  const main = el('div', 'tui-row-main')
  const line = el('div', 'tui-row-line')

  const glyphClass =
    pr.state === 'MERGED'
      ? 'tui-glyph-ok'
      : pr.state === 'OPEN'
        ? pr.isDraft
          ? 'tui-row-num'
          : 'tui-glyph-run'
        : 'tui-row-num'
  const glyph = pr.state === 'MERGED' ? '✓' : pr.state === 'OPEN' ? '⎇' : '×'

  line.append(
    el('span', glyphClass, glyph),
    el('span', 'tui-row-num', `#${pr.number}`),
    el('span', 'tui-row-title', pr.title)
  )
  main.append(line)

  const branchText =
    pr.headRefName && pr.baseRefName
      ? `${pr.headRefName} → ${pr.baseRefName}`
      : pr.headRefName || pr.baseRefName
  const subParts: string[] = []
  if (branchText) subParts.push(branchText)
  if (pr.author) subParts.push(`@${pr.author}`)
  if (pr.state === 'MERGED') subParts.push('已合并')
  else if (pr.state === 'CLOSED') subParts.push('已关闭')
  if (subParts.length > 0) {
    main.append(el('div', 'tui-row-sub', subParts.join(' · ')))
  }

  const meta = el('div', 'tui-row-meta')
  if (pr.state === 'OPEN') {
    if (pr.isDraft) {
      meta.append(el('span', 'tui-badge', 'DRAFT'))
    }
    if (pr.mergeable === 'CONFLICTING') {
      meta.append(el('span', 'tui-badge err', '有冲突'))
    }
    if (pr.ciStatus === 'passing') {
      meta.append(el('span', 'tui-badge ok', 'CI ✓'))
    } else if (pr.ciStatus === 'failing') {
      meta.append(el('span', 'tui-badge err', 'CI ✗'))
    } else if (pr.ciStatus === 'pending') {
      meta.append(el('span', 'tui-badge warn', 'CI ◌'))
    }
  }
  const rel = formatRelativeTime(pr.mergedAt || pr.updatedAt)
  if (rel) meta.append(el('span', undefined, rel))
  if (pr.url) {
    const openBtn = el('button', 'tui-btn tui-btn-link', pr.state === 'OPEN' ? '[打开 PR]' : '[查看]')
    openBtn.addEventListener('click', () => openExternalUrl(pr.url))
    meta.append(openBtn)
  }

  row.append(main, meta)
  return row
}

function renderLeftPane(snap: BoardSnapshot | null): HTMLElement {
  const pane = el('section', 'tui-pane')
  const inProgress = snap?.inProgress ?? []
  const completed = snap?.completed ?? []
  const pullRequests = snap?.pullRequests ?? []
  const openPrs = pullRequests.filter((pr) => pr.state === 'OPEN')
  const closedPrs = pullRequests.filter((pr) => pr.state !== 'OPEN')

  const head = el('div', 'tui-pane-head')
  const tabs = el('div', 'tui-tabs')
  const issueTab = el(
    'button',
    `tui-tab${state.activeTab === 'issues' ? ' active' : ''}`,
    `▸ Issues (${inProgress.length + completed.length})`
  )
  issueTab.type = 'button'
  issueTab.addEventListener('click', () => {
    state.activeTab = 'issues'
    render()
  })

  const prTab = el(
    'button',
    `tui-tab${state.activeTab === 'prs' ? ' active' : ''}`,
    `⎇ PRs (${openPrs.length}/${pullRequests.length})`
  )
  prTab.type = 'button'
  prTab.addEventListener('click', () => {
    state.activeTab = 'prs'
    render()
  })
  tabs.append(issueTab, prTab)

  const summaryText =
    state.activeTab === 'issues'
      ? `进行中 ${inProgress.length} · 已完成 ${completed.length}`
      : `打开中 ${openPrs.length} · 历史 ${closedPrs.length}`
  head.append(tabs, el('span', 'tui-repo', summaryText))
  pane.append(head)

  const body = el('div', 'tui-pane-body')

  if (state.activeTab === 'prs') {
    const openWrap = el('div')
    const openHead = el('div', 'tui-sec-title')
    openHead.append(el('span', undefined, `打开中 PR (${openPrs.length})`))
    openWrap.append(openHead)

    if (openPrs.length === 0) {
      openWrap.append(el('div', 'tui-empty', '当前没有打开中的 Pull Request'))
    } else {
      const rows = el('div', 'tui-rows')
      for (const pr of openPrs) {
        rows.append(renderPullRequestRow(pr))
      }
      openWrap.append(rows)
    }
    body.append(openWrap)

    const histWrap = el('div')
    const histHead = el('div', 'tui-sec-title')
    histHead.append(el('span', undefined, `已合并 / 已关闭 PR (${closedPrs.length})`))
    histWrap.append(histHead)

    if (closedPrs.length === 0) {
      histWrap.append(el('div', 'tui-empty', '已合并或关闭的 PR 会显示在这里'))
    } else {
      const rows = el('div', 'tui-rows')
      for (const pr of closedPrs) {
        rows.append(renderPullRequestRow(pr))
      }
      histWrap.append(rows)
    }
    body.append(histWrap)

    pane.append(body)
    return pane
  }

  body.append(renderComposer())

  // In progress
  const ipWrap = el('div')
  const ipHead = el('div', 'tui-sec-title')
  ipHead.append(el('span', undefined, `进行中 (${inProgress.length})`))
  ipWrap.append(ipHead)

  if (inProgress.length === 0) {
    ipWrap.append(el('div', 'tui-empty', '当前没有正在处理的任务'))
  } else {
    const rows = el('div', 'tui-rows')
    for (const item of inProgress) {
      const row = el('div', 'tui-row')
      const main = el('div', 'tui-row-main')
      const line = el('div', 'tui-row-line')
      line.append(
        el('span', 'tui-glyph-run', '◌'),
        el('span', 'tui-row-num', item.issueNumber !== null ? `#${item.issueNumber}` : '[SKILL]'),
        el('span', 'tui-row-title', item.title)
      )
      main.append(line)

      const meta = el('div', 'tui-row-meta')
      meta.append(el('span', undefined, item.statusLabel))
      const rel = formatRelativeTime(item.updatedAt)
      if (rel) meta.append(el('span', undefined, rel))
      if (item.prUrl) {
        const prBtn = el('button', 'tui-btn tui-btn-link', '[PR]')
        prBtn.addEventListener('click', () => openExternalUrl(item.prUrl!))
        meta.append(prBtn)
      }
      if (item.url) {
        const openBtn = el('button', 'tui-btn tui-btn-link', '[打开]')
        openBtn.addEventListener('click', () => openExternalUrl(item.url))
        meta.append(openBtn)
      }
      row.append(main, meta)
      rows.append(row)
    }
    ipWrap.append(rows)
  }
  body.append(ipWrap)

  // Completed
  const cWrap = el('div')
  const cHead = el('div', 'tui-sec-title')
  cHead.append(el('span', undefined, `已完成 · 可直接验收 (${completed.length})`))
  cWrap.append(cHead)

  if (completed.length === 0) {
    cWrap.append(el('div', 'tui-empty', '完成的任务会出现在这里，合并后可直接验收'))
  } else {
    const rows = el('div', 'tui-rows')
    for (const item of completed) {
      const row = el('div', 'tui-row')
      const main = el('div', 'tui-row-main')
      const line = el('div', 'tui-row-line')
      line.append(
        el('span', 'tui-glyph-ok', '✓'),
        el('span', 'tui-row-num', `#${item.issueNumber}`),
        el('span', 'tui-row-title', item.title)
      )
      main.append(line, el('div', 'tui-row-sub', item.summary))

      const meta = el('div', 'tui-row-meta')
      const rel = formatRelativeTime(item.completedAt)
      if (rel) meta.append(el('span', undefined, rel))
      if (item.prUrl) {
        const prBtn = el('button', 'tui-btn tui-btn-link', '[PR]')
        prBtn.addEventListener('click', () => openExternalUrl(item.prUrl!))
        meta.append(prBtn)
      }
      if (item.url) {
        const viewBtn = el('button', 'tui-btn tui-btn-link', '[Issue]')
        viewBtn.addEventListener('click', () => openExternalUrl(item.url))
        meta.append(viewBtn)
      }
      const followBtn = el('button', 'tui-btn tui-btn-link', '[再提一条]')
      followBtn.addEventListener('click', () => {
        state.followUpOf = item.issueNumber
        state.kind = 'polish'
        state.showDetails = true
        render()
        titleInputRef?.focus()
      })
      meta.append(followBtn)

      row.append(main, meta)
      rows.append(row)
    }
    cWrap.append(rows)
  }
  body.append(cWrap)

  pane.append(body)
  return pane
}

function renderRightPane(snap: BoardSnapshot | null): HTMLElement {
  const items = snap?.needsYou ?? []
  const pane = el('section', `tui-pane${items.length > 0 ? ' alert' : ''}`)

  const head = el('div', 'tui-pane-head')
  head.append(
    el('span', items.length > 0 ? 'tui-glyph-warn' : undefined, `▸ 需要你处理 (${items.length})`),
    el('span', 'tui-repo', items.length > 0 ? '等待回复/确认' : '空闲')
  )
  pane.append(head)

  const body = el('div', 'tui-pane-body')

  if (items.length === 0) {
    const empty = el('div', 'tui-empty tui-empty-calm')
    empty.append(
      el('div', 'tui-glyph-ok', '[ ✓ ALL CLEAR ]'),
      el('div', undefined, '一切自动运行中，暂时不需要你操心'),
      el('div', 'tui-drop-hint', '只有助手提问或卡住需要拍板时才会出现在这里')
    )
    body.append(empty)
    pane.append(body)
    return pane
  }

  for (const item of items) {
    const busy = state.busyItemIds.has(item.id)
    const card = el('div', 'tui-needs-card')

    if (item.kind === 'agent-question') {
      const cardAtts = state.replyAttachments.get(item.id) ?? []

      const h = el('div', 'tui-needs-head')
      h.append(
        el('span', 'tui-needs-tag', '! 助手等你回复'),
        el('span', 'tui-repo', formatRelativeTime(item.updatedAt))
      )
      card.append(
        h,
        el('div', 'tui-needs-title', item.title),
        el('pre', 'tui-needs-pre', item.question)
      )

      const replyBox = el('textarea', 'tui-reply-input')
      replyBox.placeholder = '输入回复（也可直接 Cmd+V 粘贴截图）...'
      replyBox.value = state.replyDrafts.get(item.id) ?? ''
      replyBox.disabled = busy
      replyBox.addEventListener('input', () => {
        state.replyDrafts.set(item.id, replyBox.value)
      })
      replyBox.addEventListener('paste', (e) => {
        const files = extractFilesFromPaste(e)
        if (files.length > 0) {
          e.preventDefault()
          const target = state.replyAttachments.get(item.id) ?? []
          state.replyAttachments.set(item.id, target)
          void addFilesToList(files, target, () => render())
        }
      })
      replyBox.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          void handleReplyAgent(item)
        }
      })
      card.append(replyBox)

      if (cardAtts.length > 0) {
        card.append(
          renderAttachmentsStrip(cardAtts, (id) => {
            state.replyAttachments.set(
              item.id,
              cardAtts.filter((a) => a.id !== id)
            )
            render()
          })
        )
      }

      const fileInput = el('input')
      fileInput.type = 'file'
      fileInput.multiple = true
      fileInput.style.display = 'none'
      fileInput.addEventListener('change', () => {
        const picked = Array.from(fileInput.files || [])
        fileInput.value = ''
        const target = state.replyAttachments.get(item.id) ?? []
        state.replyAttachments.set(item.id, target)
        void addFilesToList(picked, target, () => render())
      })
      card.append(fileInput)

      const actions = el('div', 'tui-group')
      const sendBtn = el('button', 'tui-btn tui-btn-primary', busy ? '发送中...' : '发送回复')
      sendBtn.disabled = busy
      sendBtn.addEventListener('click', () => void handleReplyAgent(item))

      const okBtn = el('button', 'tui-btn', '同意继续')
      okBtn.disabled = busy
      okBtn.addEventListener('click', () => void handleReplyAgent(item, '同意，请继续'))

      const attBtn = el('button', 'tui-btn tui-btn-link', '+ 附截图/文件')
      attBtn.disabled = busy
      attBtn.addEventListener('click', () => fileInput.click())

      actions.append(sendBtn, okBtn, attBtn)
      card.append(actions)
    } else {
      const h = el('div', 'tui-needs-head')
      h.append(
        el('span', 'tui-needs-tag', '! 需要你拍板'),
        el('span', 'tui-repo', `#${item.issueNumber}`)
      )
      card.append(
        h,
        el('div', 'tui-needs-title', item.title),
        el('div', 'tui-needs-pre', item.reason)
      )

      const actions = el('div', 'tui-group')
      if (item.canRetry) {
        const retryBtn = el('button', 'tui-btn tui-btn-primary', busy ? '处理中...' : '重试一次')
        retryBtn.disabled = busy
        retryBtn.addEventListener('click', () => void handleIssueAction(item, 'retry'))
        actions.append(retryBtn)
      }
      if (item.canDiscard) {
        const discardBtn = el('button', 'tui-btn tui-btn-danger', '放弃这条')
        discardBtn.disabled = busy
        discardBtn.addEventListener('click', () => void handleIssueAction(item, 'discard'))
        actions.append(discardBtn)
      }
      if (item.prUrl) {
        const prBtn = el('button', 'tui-btn tui-btn-link', '[PR]')
        prBtn.addEventListener('click', () => openExternalUrl(item.prUrl!))
        actions.append(prBtn)
      }
      if (item.url) {
        const linkBtn = el('button', 'tui-btn tui-btn-link', '[GitHub]')
        linkBtn.addEventListener('click', () => openExternalUrl(item.url))
        actions.append(linkBtn)
      }
      card.append(actions)
    }

    body.append(card)
  }

  pane.append(body)
  return pane
}

function renderFooter(): HTMLElement {
  const footer = el('footer', 'tui-footer')
  const left = el('div', 'tui-group')
  const hints: Array<[string, string]> = [
    ['n', '提需求'],
    ['i/p', '切Issues/PR'],
    [',', '配置Agent'],
    ['r', '刷新'],
    ['1/2/3', '切换类型'],
    ['⌘V', '贴截图'],
    ['⌘↵', '提交']
  ]
  for (const [k, label] of hints) {
    const span = el('span')
    span.append(el('span', 'tui-kbd', k), document.createTextNode(label))
    left.append(span)
  }
  const right = el('span', undefined, '截图与文件自动保存在本地目录，供助手直接读取')
  footer.append(left, right)
  return footer
}

function render() {
  const activeEl = document.activeElement
  const wasTitleFocused = activeEl === titleInputRef

  root.replaceChildren()
  root.append(renderTopBar(state.snapshot))

  if (state.showSettings && state.snapshot && !state.snapshot.error && state.snapshot.repoPath) {
    root.append(renderSettingsDrawer(state.snapshot))
  }

  if (state.toast) {
    root.append(el('div', `tui-banner ${state.toast.kind}`, state.toast.text))
  } else if (state.snapshot?.error) {
    root.append(el('div', 'tui-banner error', state.snapshot.error))
  }

  const grid = el('main', 'tui-grid')
  grid.append(renderLeftPane(state.snapshot), renderRightPane(state.snapshot))
  root.append(grid, renderFooter())

  if (wasTitleFocused && titleInputRef) {
    titleInputRef.focus()
    const len = titleInputRef.value.length
    titleInputRef.setSelectionRange(len, len)
  }
}

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null
  const inInput =
    target?.tagName === 'INPUT' ||
    target?.tagName === 'TEXTAREA' ||
    target?.tagName === 'SELECT' ||
    target?.isContentEditable
  if (inInput || e.metaKey || e.ctrlKey || e.altKey) return

  if (e.key === 'Escape' && state.showSettings) {
    e.preventDefault()
    state.showSettings = false
    render()
  } else if (e.key === ',') {
    if (state.snapshot && !state.snapshot.error && state.snapshot.repoPath) {
      e.preventDefault()
      state.showSettings = !state.showSettings
      if (state.showSettings) {
        syncAgentDraftFromSnapshot(state.snapshot)
      }
      render()
    }
  } else if (e.key === 'n') {
    e.preventDefault()
    if (state.activeTab !== 'issues') {
      state.activeTab = 'issues'
      render()
    }
    titleInputRef?.focus()
  } else if (e.key === 'i') {
    e.preventDefault()
    state.activeTab = 'issues'
    render()
  } else if (e.key === 'p') {
    e.preventDefault()
    state.activeTab = 'prs'
    render()
  } else if (e.key === 'r') {
    e.preventDefault()
    void fetchSnapshot(false)
  } else if (e.key === '1') {
    state.kind = 'feature'
    render()
  } else if (e.key === '2') {
    state.kind = 'bug'
    render()
  } else if (e.key === '3') {
    state.kind = 'polish'
    render()
  }
})

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
    // --orca-* variables update automatically on <html>
  })
}

void init()
