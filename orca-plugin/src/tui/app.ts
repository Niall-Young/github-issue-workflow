#!/usr/bin/env bun
// Interactive Claude Code-style Terminal TUI for GitHub Issue Workflow.
// Supports mouse clicks, scroll wheel, bracketed paste (drag-and-drop files),
// macOS clipboard screenshot paste (^V), and single-key shortcuts.

import { resolve } from 'node:path'
import type { IssueKind, NeedsYouItem, SubmitMode } from '../protocol'
import { InputParser, type InputEvent } from './input'
import {
  attachLocalFilePath,
  captureClipboardImage,
  loadBoardSnapshot,
  openUrlInBrowser,
  replyToAgentTerminal,
  runIssueAdminAction,
  saveAgentConfig,
  submitIssueFromTui,
  type PendingHandoff
} from './orca-cli'
import { buildMainRows, renderTui, type TuiState } from './render'
import { ANSI, type ScreenBuffer } from './screen'

const POLL_INTERVAL_MS = 12_000

export class IssueBoardTui {
  private readonly targetPath: string
  private readonly pendingHandoffs = new Map<string, PendingHandoff>()
  private readonly parser = new InputParser()
  private state: TuiState
  private lastBuffer: ScreenBuffer | null = null
  private lastRenderedLines: string[] | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private cleanedUp = false

  constructor(targetPath: string) {
    this.targetPath = resolve(targetPath)
    this.state = {
      snapshot: null,
      loading: true,
      activeTab: 'issues',
      activePane: 'main',
      selectedIndex: 1,
      scrollOffset: 0,
      attentionIndex: 0,
      attentionScroll: 0,
      busyIds: new Set(),
      modal: { type: 'none' },
      toast: null
    }
  }

  start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('orca-board 需要在交互式终端（TTY）中运行。')
      process.exit(1)
    }

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    process.stdout.write(
      ANSI.altScreenOn +
        ANSI.cursorHide +
        ANSI.mouseOn +
        ANSI.bracketedPasteOn +
        ANSI.clearScreen
    )

    process.stdin.on('data', this.onStdinData)
    process.stdout.on('resize', this.onResize)
    process.on('SIGINT', this.onSignal)
    process.on('SIGTERM', this.onSignal)

    this.render(true)
    void this.refresh()
    this.pollTimer = setInterval(() => {
      void this.refresh(true)
    }, POLL_INTERVAL_MS)
  }

  private onSignal = () => {
    this.quit(0)
  }

  private onResize = () => {
    this.lastRenderedLines = null
    this.render(true)
  }

  private onStdinData = (chunk: string) => {
    const events = this.parser.feed(chunk)
    for (const ev of events) {
      this.handleEvent(ev)
    }
  }

  private quit(code = 0) {
    if (this.cleanedUp) return
    this.cleanedUp = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.toastTimer) clearTimeout(this.toastTimer)
    process.stdin.off('data', this.onStdinData)
    process.stdout.off('resize', this.onResize)
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
    } catch {
      // ignore
    }
    process.stdout.write(
      ANSI.bracketedPasteOff + ANSI.mouseOff + ANSI.cursorShow + ANSI.altScreenOff + ANSI.reset
    )
    process.exit(code)
  }

  private showToast(kind: 'ok' | 'err', text: string) {
    this.state.toast = { kind, text }
    this.render()
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.state.toast = null
      this.render()
    }, 4500)
  }

  private render(forceClear = false) {
    const width = process.stdout.columns || 100
    const height = process.stdout.rows || 30
    const buf = renderTui(this.state, width, height)
    this.lastBuffer = buf
    if (forceClear) {
      this.lastRenderedLines = null
      process.stdout.write(ANSI.clearScreen)
    }
    const { output, lines } = buf.diffOutput(this.lastRenderedLines)
    this.lastRenderedLines = lines
    if (output) {
      process.stdout.write(output)
    }
  }

  private async refresh(silent = false) {
    if (!silent) {
      this.state.loading = true
      this.render()
    }
    try {
      const snap = await loadBoardSnapshot(this.targetPath, this.pendingHandoffs)
      this.state.snapshot = snap
      this.state.loading = false
      this.normalizeSelection()
      this.render()
    } catch (err) {
      this.state.loading = false
      this.showToast('err', `同步失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private normalizeSelection() {
    const rows = buildMainRows(this.state.snapshot, this.state.activeTab)
    if (rows.length === 0) {
      this.state.selectedIndex = 0
      this.state.scrollOffset = 0
      return
    }
    if (
      this.state.selectedIndex < 0 ||
      this.state.selectedIndex >= rows.length ||
      rows[this.state.selectedIndex].kind === 'section'
    ) {
      const firstSelectable = rows.findIndex((r) => r.kind !== 'section')
      this.state.selectedIndex = firstSelectable >= 0 ? firstSelectable : 0
    }
  }

  private moveSelection(delta: number) {
    if (this.state.activePane === 'attention') {
      const len = this.state.snapshot?.needsYou.length ?? 0
      if (len === 0) return
      this.state.attentionIndex = Math.max(0, Math.min(len - 1, this.state.attentionIndex + delta))
      this.state.attentionScroll = Math.min(this.state.attentionScroll, this.state.attentionIndex)
      this.render()
      return
    }

    const rows = buildMainRows(this.state.snapshot, this.state.activeTab)
    if (rows.length === 0) return
    let next = this.state.selectedIndex + delta
    while (next >= 0 && next < rows.length && rows[next].kind === 'section') {
      next += delta > 0 ? 1 : -1
    }
    if (next >= 0 && next < rows.length) {
      this.state.selectedIndex = next
      const listH = Math.max(1, (process.stdout.rows || 30) - 6)
      if (next < this.state.scrollOffset) {
        this.state.scrollOffset = Math.max(0, next - 1)
      } else if (next >= this.state.scrollOffset + listH) {
        this.state.scrollOffset = next - listH + 1
      }
      this.render()
    }
  }

  private openDetailForCurrent() {
    const rows = buildMainRows(this.state.snapshot, this.state.activeTab)
    const row = rows[this.state.selectedIndex]
    if (!row || row.kind === 'section') return
    if (row.kind === 'inProgress') {
      this.state.modal = {
        type: 'detail',
        title: `${row.item.issueNumber ? `#${row.item.issueNumber} ` : ''}${row.item.title}`,
        subtitle: `状态：${row.item.statusLabel}`,
        body: row.item.url || '正在由本地 Agent 整理并提交 GitHub Issue。',
        url: row.item.url,
        prUrl: row.item.prUrl,
        issueNumber: row.item.issueNumber
      }
    } else if (row.kind === 'completed') {
      this.state.modal = {
        type: 'detail',
        title: `#${row.item.issueNumber} ${row.item.title}`,
        subtitle: '状态：已完成 · 可验收',
        body: row.item.summary,
        url: row.item.url,
        prUrl: row.item.prUrl,
        issueNumber: row.item.issueNumber,
        canFollowUp: true
      }
    } else if (row.kind === 'pr') {
      const pr = row.item
      this.state.modal = {
        type: 'detail',
        title: `PR #${pr.number} ${pr.title}`,
        subtitle: `${pr.headRefName} → ${pr.baseRefName} · ${pr.state} · CI: ${pr.ciStatus}`,
        body: `作者：${pr.author || '未知'}\n合并状态：${pr.mergeable || '未知'}\n链接：${pr.url}`,
        url: pr.url
      }
    }
    this.render()
  }

  private openComposeModal(followUpOf: number | null = null) {
    this.state.modal = {
      type: 'compose',
      mode: 'handoff',
      kind: 'feature',
      title: '',
      details: '',
      focus: 'title',
      followUpOf,
      attachments: [],
      submitting: false
    }
    this.render()
  }

  private openSettingsModal() {
    const snap = this.state.snapshot
    const def = snap?.defaultAgent || snap?.preferredAgent || 'codex'
    const allowed =
      snap && snap.allowedAgents.length > 0 ? Array.from(new Set([def, ...snap.allowedAgents])) : [def]
    this.state.modal = {
      type: 'settings',
      defaultAgent: def,
      allowedAgents: allowed,
      cursor: 0,
      saving: false
    }
    this.render()
  }

  private getSettingsAgentIds(): string[] {
    const modal = this.state.modal
    if (modal.type !== 'settings') return []
    const installed = this.state.snapshot?.installedAgents ?? []
    return Array.from(
      new Set([
        ...installed.map((a) => a.id),
        ...(modal.defaultAgent ? [modal.defaultAgent] : []),
        ...modal.allowedAgents
      ])
    )
  }

  private dispatchAction(action: string, payload?: unknown) {
    switch (action) {
      case 'noop':
        return
      case 'quit':
        this.quit(0)
        return
      case 'refresh':
        void this.refresh()
        return
      case 'close-modal':
        this.state.modal = { type: 'none' }
        this.render()
        return
      case 'switch-tab': {
        const nextTab = payload as 'issues' | 'prs'
        this.state.activeTab = nextTab
        this.state.activePane = 'main'
        this.state.selectedIndex = 1
        this.state.scrollOffset = 0
        this.normalizeSelection()
        this.render()
        return
      }
      case 'focus-pane':
        this.state.activePane = payload === 'attention' ? 'attention' : 'main'
        this.render()
        return
      case 'select-main-row': {
        const idx = Number(payload)
        const alreadySelected =
          this.state.activePane === 'main' && this.state.selectedIndex === idx
        this.state.activePane = 'main'
        this.state.selectedIndex = idx
        if (alreadySelected) {
          this.openDetailForCurrent()
        } else {
          this.render()
        }
        return
      }
      case 'select-attention':
        this.state.activePane = 'attention'
        this.state.attentionIndex = Number(payload)
        this.render()
        return
      case 'open-compose':
        this.openComposeModal(null)
        return
      case 'open-followup':
        this.openComposeModal(Number(payload) || null)
        return
      case 'open-settings':
        this.openSettingsModal()
        return
      case 'enable-autopilot':
        void this.handleEnableAutopilot()
        return
      case 'open-url':
        if (typeof payload === 'string' && payload) {
          void openUrlInBrowser(payload)
          this.showToast('ok', `已在浏览器打开：${payload}`)
        }
        return
      case 'approve-agent': {
        const item = payload as Extract<NeedsYouItem, { kind: 'agent-question' }>
        void this.handleApproveAgent(item)
        return
      }
      case 'open-reply': {
        const item = payload as Extract<NeedsYouItem, { kind: 'agent-question' }>
        this.state.modal = {
          type: 'reply',
          item,
          text: '',
          attachments: [],
          sending: false
        }
        this.render()
        return
      }
      case 'issue-retry': {
        const item = payload as Extract<NeedsYouItem, { kind: 'issue-attention' }>
        void this.handleIssueAction(item, 'retry')
        return
      }
      case 'issue-discard': {
        const item = payload as Extract<NeedsYouItem, { kind: 'issue-attention' }>
        void this.handleIssueAction(item, 'discard')
        return
      }
      case 'compose-mode':
        if (this.state.modal.type === 'compose') {
          this.state.modal.mode = payload as SubmitMode
          this.render()
        }
        return
      case 'compose-kind':
        if (this.state.modal.type === 'compose') {
          this.state.modal.kind = payload as IssueKind
          this.render()
        }
        return
      case 'compose-focus':
        if (this.state.modal.type === 'compose') {
          this.state.modal.focus = payload === 'details' ? 'details' : 'title'
          this.render()
        }
        return
      case 'compose-paste-image':
        void this.handlePasteClipboardImage()
        return
      case 'compose-submit':
        void this.handleComposeSubmit()
        return
      case 'reply-paste-image':
        void this.handlePasteClipboardImage()
        return
      case 'reply-submit':
        void this.handleReplySubmit()
        return
      case 'settings-click-agent': {
        if (this.state.modal.type !== 'settings') return
        const idx = Number(payload)
        const ids = this.getSettingsAgentIds()
        const id = ids[idx]
        if (!id) return
        if (this.state.modal.cursor === idx && this.state.modal.defaultAgent === id) {
          // Clicking an already-default agent does nothing; clicking another sets default
          return
        }
        this.state.modal.cursor = idx
        this.state.modal.defaultAgent = id
        if (!this.state.modal.allowedAgents.includes(id)) {
          this.state.modal.allowedAgents.push(id)
        }
        this.render()
        return
      }
      case 'settings-save':
        void this.handleSettingsSave()
        return
    }
  }

  private handleEvent(ev: InputEvent) {
    if (ev.type === 'mouse') {
      this.handleMouse(ev)
      return
    }
    if (ev.type === 'key' && ev.ctrl && ev.key === 'c') {
      this.quit(0)
      return
    }

    if (this.state.modal.type !== 'none') {
      this.handleModalInput(ev)
      return
    }

    // Global shortcuts in main view
    if (ev.type === 'key') {
      if (ev.key === 'up') this.moveSelection(-1)
      else if (ev.key === 'down') this.moveSelection(1)
      else if (ev.key === 'enter') this.openDetailForCurrent()
      else if (ev.key === 'tab') {
        this.dispatchAction('switch-tab', this.state.activeTab === 'issues' ? 'prs' : 'issues')
      } else if (ev.key === 'left') {
        this.state.activePane = 'main'
        this.render()
      } else if (ev.key === 'right') {
        this.state.activePane = 'attention'
        this.render()
      }
      return
    }

    if (ev.type === 'text') {
      const ch = ev.text
      if (ch === 'q') this.quit(0)
      else if (ch === 'r') void this.refresh()
      else if (ch === 'n') this.openComposeModal(null)
      else if (ch === ',') this.openSettingsModal()
      else if (ch === 'i') this.dispatchAction('switch-tab', 'issues')
      else if (ch === 'p') this.dispatchAction('switch-tab', 'prs')
      else if (ch === 'j') this.moveSelection(1)
      else if (ch === 'k') this.moveSelection(-1)
    }
  }

  private handleMouse(ev: Extract<InputEvent, { type: 'mouse' }>) {
    if (ev.kind === 'scrollUp') {
      if (this.state.modal.type === 'none') this.moveSelection(-1)
      return
    }
    if (ev.kind === 'scrollDown') {
      if (this.state.modal.type === 'none') this.moveSelection(1)
      return
    }
    if (ev.kind === 'press' && ev.button === 'left' && this.lastBuffer) {
      const hit = this.lastBuffer.hitTest(ev.x, ev.y)
      if (hit) {
        this.dispatchAction(hit.action, hit.payload)
      }
    }
  }

  private handleModalInput(ev: InputEvent) {
    const modal = this.state.modal
    if (modal.type === 'none') return

    if (ev.type === 'key' && ev.key === 'escape') {
      this.state.modal = { type: 'none' }
      this.render()
      return
    }

    if (modal.type === 'detail') {
      if (ev.type === 'key' && ev.key === 'enter' && modal.url) {
        this.dispatchAction('open-url', modal.url)
      }
      return
    }

    if (modal.type === 'settings') {
      const ids = this.getSettingsAgentIds()
      if (ev.type === 'key') {
        if (ev.key === 'up') {
          modal.cursor = Math.max(0, modal.cursor - 1)
          this.render()
        } else if (ev.key === 'down') {
          modal.cursor = Math.min(Math.max(0, ids.length - 1), modal.cursor + 1)
          this.render()
        } else if (ev.key === 'enter') {
          const id = ids[modal.cursor]
          if (id) {
            modal.defaultAgent = id
            if (!modal.allowedAgents.includes(id)) modal.allowedAgents.push(id)
            this.render()
          }
        } else if (ev.ctrl && ev.key === 's') {
          void this.handleSettingsSave()
        }
      } else if (ev.type === 'text' && ev.text === ' ') {
        const id = ids[modal.cursor]
        if (id && id !== modal.defaultAgent) {
          if (modal.allowedAgents.includes(id)) {
            modal.allowedAgents = modal.allowedAgents.filter((a) => a !== id)
          } else {
            modal.allowedAgents.push(id)
          }
          this.render()
        }
      }
      return
    }

    if (modal.type === 'compose') {
      if (ev.type === 'key') {
        if (ev.key === 'tab') {
          modal.focus = modal.focus === 'title' ? 'details' : 'title'
          this.render()
        } else if (ev.ctrl && ev.key === 'v') {
          void this.handlePasteClipboardImage()
        } else if (ev.ctrl && ev.key === 'm') {
          modal.mode = modal.mode === 'handoff' ? 'direct' : 'handoff'
          this.render()
        } else if ((ev.ctrl && ev.key === 's') || (ev.key === 'enter' && modal.focus === 'title')) {
          void this.handleComposeSubmit()
        } else if (ev.key === 'enter' && modal.focus === 'details') {
          modal.details += '\n'
          this.render()
        } else if (ev.key === 'backspace') {
          if (modal.focus === 'title') modal.title = modal.title.slice(0, -1)
          else modal.details = modal.details.slice(0, -1)
          this.render()
        }
      } else if (ev.type === 'paste') {
        const repoPath = this.state.snapshot?.repoPath || this.targetPath
        try {
          const att = attachLocalFilePath(repoPath, ev.text)
          if (att) {
            modal.attachments.push(att)
            this.showToast('ok', `已附加文件：${att.name}`)
            return
          }
        } catch (err) {
          this.showToast('err', err instanceof Error ? err.message : String(err))
          return
        }
        if (modal.focus === 'title') modal.title += ev.text.replace(/\r?\n/g, ' ')
        else modal.details += ev.text
        this.render()
      } else if (ev.type === 'text') {
        if (modal.focus === 'title') modal.title += ev.text
        else modal.details += ev.text
        this.render()
      }
      return
    }

    if (modal.type === 'reply') {
      if (ev.type === 'key') {
        if (ev.key === 'enter') {
          void this.handleReplySubmit()
        } else if (ev.ctrl && ev.key === 'v') {
          void this.handlePasteClipboardImage()
        } else if (ev.key === 'backspace') {
          modal.text = modal.text.slice(0, -1)
          this.render()
        }
      } else if (ev.type === 'paste') {
        const repoPath = this.state.snapshot?.repoPath || this.targetPath
        try {
          const att = attachLocalFilePath(repoPath, ev.text)
          if (att) {
            modal.attachments.push(att)
            this.showToast('ok', `已附加文件：${att.name}`)
            return
          }
        } catch (err) {
          this.showToast('err', err instanceof Error ? err.message : String(err))
          return
        }
        modal.text += ev.text.replace(/\r?\n/g, ' ')
        this.render()
      } else if (ev.type === 'text') {
        modal.text += ev.text
        this.render()
      }
    }
  }

  private async handlePasteClipboardImage() {
    const repoPath = this.state.snapshot?.repoPath || this.targetPath
    const att = await captureClipboardImage(repoPath)
    if (!att) {
      this.showToast('err', '剪贴板中未检测到截图（也可直接将文件拖入终端）')
      return
    }
    if (this.state.modal.type === 'compose' || this.state.modal.type === 'reply') {
      this.state.modal.attachments.push(att)
      this.showToast('ok', `已粘贴剪贴板截图：${att.name}`)
    }
  }

  private async handleComposeSubmit() {
    if (this.state.modal.type !== 'compose' || this.state.modal.submitting) return
    const modal = this.state.modal
    if (!modal.title.trim()) {
      this.showToast('err', '请先输入需求标题或问题描述')
      return
    }
    const snap = this.state.snapshot
    const repoPath = snap?.repoPath || this.targetPath
    modal.submitting = true
    this.render()
    try {
      const res = await submitIssueFromTui({
        repoPath,
        repository: snap?.repository ?? null,
        autopilotInstalled: Boolean(snap?.autopilotInstalled),
        defaultAgent: snap?.defaultAgent ?? null,
        mode: modal.mode,
        kind: modal.kind,
        title: modal.title,
        details: modal.details,
        followUpOf: modal.followUpOf,
        savedAttachments: modal.attachments,
        pendingHandoffs: this.pendingHandoffs
      })
      this.state.modal = { type: 'none' }
      this.showToast(
        'ok',
        res.mode === 'handoff'
          ? `已启动 ${res.agent || 'Agent'} 按 Skill 规范提单`
          : `已直接提交 Issue${res.issueNumber ? ` #${res.issueNumber}` : ''}`
      )
      void this.refresh(true)
    } catch (err) {
      modal.submitting = false
      this.showToast('err', err instanceof Error ? err.message : String(err))
    }
  }

  private async handleReplySubmit() {
    if (this.state.modal.type !== 'reply' || this.state.modal.sending) return
    const modal = this.state.modal
    modal.sending = true
    this.render()
    try {
      await replyToAgentTerminal(modal.item.terminalId, modal.text, modal.attachments)
      this.state.modal = { type: 'none' }
      this.showToast('ok', `已发送回复给 ${modal.item.agentName}`)
      void this.refresh(true)
    } catch (err) {
      modal.sending = false
      this.showToast('err', err instanceof Error ? err.message : String(err))
    }
  }

  private async handleApproveAgent(item: Extract<NeedsYouItem, { kind: 'agent-question' }>) {
    if (this.state.busyIds.has(item.id)) return
    this.state.busyIds.add(item.id)
    this.render()
    try {
      await replyToAgentTerminal(item.terminalId, '同意，请继续执行')
      this.showToast('ok', `已回复「同意继续」给 ${item.agentName}`)
      void this.refresh(true)
    } catch (err) {
      this.showToast('err', err instanceof Error ? err.message : String(err))
    } finally {
      this.state.busyIds.delete(item.id)
      this.render()
    }
  }

  private async handleIssueAction(
    item: Extract<NeedsYouItem, { kind: 'issue-attention' }>,
    action: 'retry' | 'discard'
  ) {
    if (this.state.busyIds.has(item.id)) return
    const repoPath = this.state.snapshot?.repoPath || this.targetPath
    this.state.busyIds.add(item.id)
    this.render()
    try {
      await runIssueAdminAction(repoPath, item.url, action)
      this.showToast('ok', action === 'retry' ? `已安排重试 #${item.issueNumber}` : `已放弃 #${item.issueNumber}`)
      void this.refresh(true)
    } catch (err) {
      this.showToast('err', err instanceof Error ? err.message : String(err))
    } finally {
      this.state.busyIds.delete(item.id)
      this.render()
    }
  }

  private async handleEnableAutopilot() {
    const snap = this.state.snapshot
    const repoPath = snap?.repoPath || this.targetPath
    const agent = snap?.defaultAgent || snap?.preferredAgent || 'codex'
    this.showToast('ok', `正在为当前项目开启自动处理循环 (${agent})…`)
    try {
      const msg = await saveAgentConfig({
        repoPath,
        defaultAgent: agent,
        allowedAgents: [agent]
      })
      this.showToast('ok', msg)
      void this.refresh(true)
    } catch (err) {
      this.showToast('err', err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSettingsSave() {
    if (this.state.modal.type !== 'settings' || this.state.modal.saving) return
    const modal = this.state.modal
    const repoPath = this.state.snapshot?.repoPath || this.targetPath
    modal.saving = true
    this.render()
    try {
      const msg = await saveAgentConfig({
        repoPath,
        defaultAgent: modal.defaultAgent,
        allowedAgents: modal.allowedAgents
      })
      this.state.modal = { type: 'none' }
      this.showToast('ok', msg)
      void this.refresh(true)
    } catch (err) {
      modal.saving = false
      this.showToast('err', err instanceof Error ? err.message : String(err))
    }
  }
}

// Run when executed directly
const isDirectEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith('app.ts')

if (isDirectEntry) {
  const target = process.argv[2] || process.cwd()
  const app = new IssueBoardTui(target)
  app.start()
}
