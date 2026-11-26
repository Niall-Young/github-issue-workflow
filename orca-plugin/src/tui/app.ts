#!/usr/bin/env bun
// Interactive Claude Code-style Terminal TUI for GitHub Issue Workflow.
// Features an always-ready bottom composer, slash command palette (/bug, /direct,
// /agent, /refresh, /quit, etc.), mouse clicks, scroll wheel, bracketed paste,
// and macOS clipboard screenshot paste (^V).

import { resolve } from 'node:path'
import type { IssueKind, NeedsYouItem, SubmitMode } from '../protocol'
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
  splitComposerText,
  type SlashCommandId
} from './commands'
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
import {
  buildMainRows,
  computeComposerHeight,
  DEFAULT_SUBMIT_MODE,
  nextIssueKind,
  nextSubmitMode,
  renderTui,
  resolveSelectedMainRowAction,
  type TuiState
} from './render'
import { ANSI, type CursorPosition, type ScreenBuffer } from './screen'

const POLL_INTERVAL_MS = 12_000

export type IssueBoardTuiOptions = {
  openUrl?: (url: string) => Promise<void> | void
  writeOutput?: (chunk: string) => void
}

export class IssueBoardTui {
  private readonly targetPath: string
  private readonly openUrl: (url: string) => Promise<void> | void
  private readonly writeOutput: (chunk: string) => void
  private readonly pendingHandoffs = new Map<string, PendingHandoff>()
  private readonly dismissedAlertIds = new Set<string>()
  private readonly parser = new InputParser()
  private state: TuiState
  private lastBuffer: ScreenBuffer | null = null
  private lastRenderedLines: string[] | null = null
  private lastCursor: CursorPosition | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private errorTimer: ReturnType<typeof setTimeout> | null = null
  private cleanedUp = false

  constructor(targetPath: string, options?: IssueBoardTuiOptions) {
    this.targetPath = resolve(targetPath)
    this.openUrl = options?.openUrl ?? openUrlInBrowser
    this.writeOutput = options?.writeOutput ?? ((chunk: string) => {
      process.stdout.write(chunk)
    })
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
      composer: {
        text: '',
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
    this.lastCursor = null
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
    if (this.errorTimer) clearTimeout(this.errorTimer)
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

  private showError(text: string) {
    this.state.errorNotice = text
    this.render()
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => {
      this.state.errorNotice = null
      this.render()
    }, 3500)
    this.errorTimer.unref?.()
  }

  private clearError() {
    if (!this.state.errorNotice) return
    this.state.errorNotice = null
    if (this.errorTimer) {
      clearTimeout(this.errorTimer)
      this.errorTimer = null
    }
  }

  private cycleIssueKind() {
    this.state.composer.kind = nextIssueKind(this.state.composer.kind)
    this.render()
  }

  private cycleSubmitMode() {
    this.state.composer.mode = nextSubmitMode(this.state.composer.mode)
    this.render()
  }

  private render(forceClear = false) {
    const width = process.stdout.columns || 100
    const height = process.stdout.rows || 30
    const buf = renderTui(this.state, width, height)
    this.lastBuffer = buf
    if (forceClear) {
      this.lastRenderedLines = null
      this.lastCursor = null
      this.writeOutput(ANSI.cursorHide + ANSI.clearScreen)
    }
    const { output, lines, cursor } = buf.diffOutput(this.lastRenderedLines, this.lastCursor)
    this.lastRenderedLines = lines
    this.lastCursor = cursor
    if (output) {
      this.writeOutput(output)
    }
  }

  private async refresh(silent = false) {
    if (!silent) {
      this.state.loading = true
      this.render()
    }
    try {
      const snap = await loadBoardSnapshot(this.targetPath, this.pendingHandoffs, undefined, {
        dismissedAlertIds: this.dismissedAlertIds
      })
      this.state.snapshot = snap
      this.state.loading = false
      this.normalizeSelection()
      this.render()
    } catch {
      this.state.loading = false
      this.render()
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
      const width = process.stdout.columns || 100
      const height = process.stdout.rows || 30
      const composerH = Math.min(5, computeComposerHeight(this.state.composer, width))
      const listH = Math.max(1, height - composerH - 5)
      if (next < this.state.scrollOffset) {
        this.state.scrollOffset = Math.max(0, next - 1)
      } else if (next >= this.state.scrollOffset + listH) {
        this.state.scrollOffset = next - listH + 1
      }
      this.render()
    }
  }

  private openCurrentMainRow() {
    const result = resolveSelectedMainRowAction(this.state)
    if (result.kind === 'open') {
      this.dispatchAction('open-url', result.url)
    } else if (result.kind === 'no-url') {
      this.showError('该条目尚未生成 GitHub 链接')
    }
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

  private executeSlashCommand(id: SlashCommandId, arg: string) {
    const c = this.state.composer
    c.text = ''
    c.slashIndex = 0

    switch (id) {
      case 'bug':
      case 'feature':
      case 'polish': {
        c.kind = id as IssueKind
        if (arg.trim()) {
          void this.handleComposerSubmit(arg)
        } else {
          this.render()
        }
        return
      }
      case 'handoff':
      case 'direct': {
        c.mode = id as SubmitMode
        if (arg.trim()) {
          void this.handleComposerSubmit(arg)
        } else {
          this.render()
        }
        return
      }
      case 'agent':
        this.openSettingsModal()
        return
      case 'refresh':
        void this.refresh()
        return
      case 'issues':
        this.dispatchAction('switch-tab', 'issues')
        return
      case 'prs':
        this.dispatchAction('switch-tab', 'prs')
        return
      case 'autopilot':
        void this.handleEnableAutopilot()
        return
      case 'paste':
        void this.handlePasteClipboardImage()
        return
      case 'clear':
        c.attachments = []
        c.followUpOf = null
        this.render()
        return
      case 'quit':
        this.quit(0)
        return
    }
  }

  private dispatchAction(action: string, payload?: unknown) {
    switch (action) {
      case 'noop':
      case 'focus-composer':
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
          this.openCurrentMainRow()
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
      case 'cycle-issue-kind':
        this.cycleIssueKind()
        return
      case 'cycle-submit-mode':
        this.cycleSubmitMode()
        return
      case 'open-followup': {
        const num = Number(payload) || null
        this.state.modal = { type: 'none' }
        this.state.composer.followUpOf = num
        this.render()
        return
      }
      case 'exec-slash':
        this.executeSlashCommand(payload as SlashCommandId, '')
        return
      case 'open-settings':
        this.openSettingsModal()
        return
      case 'enable-autopilot':
        void this.handleEnableAutopilot()
        return
      case 'open-url':
        if (typeof payload === 'string' && payload.trim()) {
          void this.openUrl(payload.trim())
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
      case 'dismiss-alert': {
        const alertId = String(payload || '')
        if (!alertId) return
        this.dismissedAlertIds.add(alertId)
        if (alertId.startsWith('handoff-exited-')) {
          this.pendingHandoffs.delete(alertId.slice('handoff-exited-'.length))
        }
        if (this.state.snapshot) {
          this.state.snapshot = {
            ...this.state.snapshot,
            needsYou: this.state.snapshot.needsYou.filter((i) => i.id !== alertId)
          }
          this.normalizeSelection()
        }
        this.render()
        return
      }
      case 'retry-handoff-alert': {
        const item = payload as Extract<NeedsYouItem, { kind: 'system-alert' }>
        if (item.id.startsWith('handoff-exited-')) {
          this.pendingHandoffs.delete(item.id.slice('handoff-exited-'.length))
        }
        if (item.retryTitle) {
          this.state.composer.text = item.retryTitle
          this.state.composer.mode = 'handoff'
          this.state.composer.slashIndex = 0
        }
        if (this.state.snapshot) {
          this.state.snapshot = {
            ...this.state.snapshot,
            needsYou: this.state.snapshot.needsYou.filter((i) => i.id !== item.id)
          }
          this.normalizeSelection()
        }
        this.render()
        return
      }
      case 'reply-paste-image':
        void this.handlePasteClipboardImage()
        return
      case 'remove-composer-attachment': {
        const id = Number(payload)
        const c = this.state.composer
        const next = removeInlineAttachmentById(c.text, c.attachments, id)
        c.text = next.text
        c.attachments = next.attachments
        c.slashIndex = 0
        this.render()
        return
      }
      case 'remove-reply-attachment': {
        if (this.state.modal.type !== 'reply') return
        const id = Number(payload)
        const next = removeInlineAttachmentById(this.state.modal.text, this.state.modal.attachments, id)
        this.state.modal.text = next.text
        this.state.modal.attachments = next.attachments
        this.render()
        return
      }
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
    this.clearError()
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

    const c = this.state.composer
    const slashOpen = isSlashMenuOpen(c.text)

    if (ev.type === 'paste') {
      const repoPath = this.state.snapshot?.repoPath || this.targetPath
      try {
        const att = attachLocalFilePath(repoPath, ev.text)
        if (att) {
          const next = appendInlineAttachment(c.text, c.attachments, att)
          c.text = next.text
          c.attachments = next.attachments
          c.slashIndex = 0
          this.render()
          return
        }
      } catch (err) {
        this.showError(err instanceof Error ? err.message : String(err))
        return
      }
      c.text += ev.text
      c.slashIndex = 0
      this.render()
      return
    }

    if (ev.type === 'key') {
      if (ev.key === 'tab' && ev.shift) {
        this.cycleIssueKind()
        return
      }
      if (ev.ctrl && ev.key === 'v') {
        void this.handlePasteClipboardImage()
        return
      }
      if (ev.ctrl && ev.key === 'u') {
        c.text = ''
        c.attachments = []
        c.slashIndex = 0
        this.render()
        return
      }

      if (slashOpen) {
        const matches = filterSlashCommands(c.text)
        if (ev.key === 'up') {
          if (matches.length > 0) {
            c.slashIndex = (c.slashIndex - 1 + matches.length) % matches.length
            this.render()
          }
          return
        }
        if (ev.key === 'down') {
          if (matches.length > 0) {
            c.slashIndex = (c.slashIndex + 1) % matches.length
            this.render()
          }
          return
        }
        if (ev.key === 'tab') {
          const picked = matches[Math.max(0, Math.min(c.slashIndex, matches.length - 1))]
          if (picked) {
            c.text = picked.takesArg ? `${picked.name} ` : picked.name
            c.slashIndex = 0
            this.render()
          }
          return
        }
        if (ev.key === 'escape') {
          c.text = ''
          c.slashIndex = 0
          this.render()
          return
        }
        if (ev.key === 'enter') {
          const picked = matches[Math.max(0, Math.min(c.slashIndex, matches.length - 1))]
          if (picked) {
            this.executeSlashCommand(picked.id, '')
          } else {
            this.showError(`未知命令：${c.text.trim()}`)
          }
          return
        }
      }

      if (ev.key === 'escape') {
        if (c.text || c.attachments.length > 0 || c.followUpOf !== null) {
          c.text = ''
          c.attachments = []
          c.followUpOf = null
          c.slashIndex = 0
          this.render()
        }
        return
      }
      if (ev.key === 'backspace') {
        if (c.text.length > 0 || c.attachments.length > 0) {
          const next = backspaceWithInlineAttachments(c.text, c.attachments)
          c.text = next.text
          c.attachments = next.attachments
          c.slashIndex = 0
          this.render()
        }
        return
      }
      if (ev.key === 'enter') {
        if (ev.shift) {
          c.text += '\n'
          this.render()
          return
        }
        const trimmed = c.text.trim()
        if (!trimmed) {
          this.openCurrentMainRow()
          return
        }
        if (trimmed.startsWith('/')) {
          const parsed = parseSlashCommand(trimmed)
          if (parsed?.kind === 'command') {
            this.executeSlashCommand(parsed.command.id, parsed.arg)
          } else if (parsed?.kind === 'unknown') {
            this.showError(`未知命令：${parsed.name}`)
          }
          return
        }
        void this.handleComposerSubmit()
        return
      }
      if (ev.key === 'up') {
        this.moveSelection(-1)
        return
      }
      if (ev.key === 'down') {
        this.moveSelection(1)
        return
      }
      if (ev.key === 'tab' && !c.text) {
        this.dispatchAction('switch-tab', this.state.activeTab === 'issues' ? 'prs' : 'issues')
        return
      }
      if (ev.key === 'left' && !c.text) {
        this.state.activePane = 'main'
        this.render()
        return
      }
      if (ev.key === 'right' && !c.text) {
        this.state.activePane = 'attention'
        this.render()
        return
      }
      return
    }

    if (ev.type === 'text') {
      c.text += ev.text
      c.slashIndex = 0
      this.render()
    }
  }

  private handleMouse(ev: Extract<InputEvent, { type: 'mouse' }>) {
    if (ev.kind === 'scrollUp' || ev.kind === 'scrollDown') {
      if (this.state.modal.type === 'none') {
        const delta = ev.kind === 'scrollUp' ? -1 : 1
        if (isSlashMenuOpen(this.state.composer.text)) {
          const matches = filterSlashCommands(this.state.composer.text)
          if (matches.length > 0) {
            this.state.composer.slashIndex =
              (this.state.composer.slashIndex + delta + matches.length) % matches.length
            this.render()
          }
          return
        }
        this.moveSelection(delta)
      }
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

    if (modal.type === 'reply') {
      if (ev.type === 'key') {
        if (ev.key === 'enter') {
          void this.handleReplySubmit()
        } else if (ev.ctrl && ev.key === 'v') {
          void this.handlePasteClipboardImage()
        } else if (ev.ctrl && ev.key === 'u') {
          modal.text = ''
          modal.attachments = []
          this.render()
        } else if (ev.key === 'backspace') {
          const next = backspaceWithInlineAttachments(modal.text, modal.attachments)
          modal.text = next.text
          modal.attachments = next.attachments
          this.render()
        }
      } else if (ev.type === 'paste') {
        const repoPath = this.state.snapshot?.repoPath || this.targetPath
        try {
          const att = attachLocalFilePath(repoPath, ev.text)
          if (att) {
            const next = appendInlineAttachment(modal.text, modal.attachments, att)
            modal.text = next.text
            modal.attachments = next.attachments
            this.render()
            return
          }
        } catch (err) {
          this.showError(err instanceof Error ? err.message : String(err))
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
      this.showError('剪贴板中未检测到截图')
      return
    }
    if (this.state.modal.type === 'reply') {
      const next = appendInlineAttachment(this.state.modal.text, this.state.modal.attachments, att)
      this.state.modal.text = next.text
      this.state.modal.attachments = next.attachments
      this.render()
      return
    }
    const c = this.state.composer
    const next = appendInlineAttachment(c.text, c.attachments, att)
    c.text = next.text
    c.attachments = next.attachments
    c.slashIndex = 0
    this.render()
  }

  private async handleComposerSubmit(overrideText?: string) {
    const c = this.state.composer
    if (c.submitting) return
    const rawText = overrideText !== undefined ? overrideText : c.text
    const cleanedText = stripInlineAttachmentTokens(rawText, c.attachments)
    const { title, details } = splitComposerText(cleanedText)
    if (!title) {
      this.showError('请先输入需求描述')
      return
    }
    const snap = this.state.snapshot
    const repoPath = snap?.repoPath || this.targetPath
    const attachments = [...c.attachments]
    const followUpOf = c.followUpOf
    c.submitting = true
    this.render()
    try {
      const existingIssueNumbers = snap
        ? Array.from(
            new Set([
              ...snap.inProgress
                .map((i) => i.issueNumber)
                .filter((n): n is number => typeof n === 'number'),
              ...snap.completed.map((i) => i.issueNumber),
              ...snap.needsYou
                .filter(
                  (i): i is Extract<NeedsYouItem, { kind: 'issue-attention' }> =>
                    i.kind === 'issue-attention'
                )
                .map((i) => i.issueNumber)
            ])
          )
        : undefined
      await submitIssueFromTui({
        repoPath,
        repository: snap?.repository ?? null,
        autopilotInstalled: Boolean(snap?.autopilotInstalled),
        defaultAgent: snap?.defaultAgent ?? null,
        mode: c.mode,
        kind: c.kind,
        title,
        details,
        followUpOf,
        savedAttachments: attachments,
        existingIssueNumbers,
        pendingHandoffs: this.pendingHandoffs
      })
      c.text = ''
      c.attachments = []
      c.followUpOf = null
      c.slashIndex = 0
      c.submitting = false
      this.render()
      void this.refresh(true)
    } catch (err) {
      c.submitting = false
      this.showError(err instanceof Error ? err.message : String(err))
    }
  }

  private async handleReplySubmit() {
    if (this.state.modal.type !== 'reply' || this.state.modal.sending) return
    const modal = this.state.modal
    modal.sending = true
    this.render()
    try {
      const cleanedMessage = stripInlineAttachmentTokens(modal.text, modal.attachments)
      await replyToAgentTerminal(modal.item.terminalId, cleanedMessage, modal.attachments)
      this.state.modal = { type: 'none' }
      this.render()
      void this.refresh(true)
    } catch (err) {
      modal.sending = false
      this.showError(err instanceof Error ? err.message : String(err))
    }
  }

  private async handleApproveAgent(item: Extract<NeedsYouItem, { kind: 'agent-question' }>) {
    if (this.state.busyIds.has(item.id)) return
    this.state.busyIds.add(item.id)
    this.render()
    try {
      await replyToAgentTerminal(item.terminalId, '同意，请继续执行')
      void this.refresh(true)
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err))
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
      void this.refresh(true)
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err))
    } finally {
      this.state.busyIds.delete(item.id)
      this.render()
    }
  }

  private async handleEnableAutopilot() {
    const snap = this.state.snapshot
    const repoPath = snap?.repoPath || this.targetPath
    const agent = snap?.defaultAgent || snap?.preferredAgent || 'codex'
    this.state.loading = true
    this.render()
    try {
      await saveAgentConfig({
        repoPath,
        defaultAgent: agent,
        allowedAgents: [agent]
      })
      void this.refresh(true)
    } catch (err) {
      this.state.loading = false
      this.showError(err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSettingsSave() {
    if (this.state.modal.type !== 'settings' || this.state.modal.saving) return
    const modal = this.state.modal
    const repoPath = this.state.snapshot?.repoPath || this.targetPath
    modal.saving = true
    this.render()
    try {
      await saveAgentConfig({
        repoPath,
        defaultAgent: modal.defaultAgent,
        allowedAgents: modal.allowedAgents
      })
      this.state.modal = { type: 'none' }
      this.render()
      void this.refresh(true)
    } catch (err) {
      modal.saving = false
      this.showError(err instanceof Error ? err.message : String(err))
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
