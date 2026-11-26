export const BOARD_STYLES = `
:root {
  --tui-bg: var(--orca-background, #0b0d11);
  --tui-surface: var(--orca-card, #11141b);
  --tui-surface-alt: var(--orca-accent, #171b24);
  --tui-border: var(--orca-border, #262c38);
  --tui-border-strong: color-mix(in srgb, var(--orca-foreground, #e5e7eb) 28%, transparent);
  --tui-fg: var(--orca-foreground, #e4e7ee);
  --tui-muted: var(--orca-muted-foreground, #7d8699);
  --tui-accent: var(--orca-primary, #58a6ff);
  --tui-accent-fg: var(--orca-primary-foreground, #0b0d11);
  --tui-green: #3fb950;
  --tui-amber: #d29922;
  --tui-red: #f85149;
  --tui-mono: var(--orca-font-mono, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "PingFang SC", monospace);
}

html.light {
  --tui-bg: var(--orca-background, #f6f7f9);
  --tui-surface: var(--orca-card, #ffffff);
  --tui-surface-alt: var(--orca-accent, #eef1f5);
  --tui-border: var(--orca-border, #d0d7de);
  --tui-fg: var(--orca-foreground, #1f2328);
  --tui-muted: var(--orca-muted-foreground, #656d76);
  --tui-accent: var(--orca-primary, #0969da);
  --tui-accent-fg: #ffffff;
  --tui-green: #1a7f37;
  --tui-amber: #9a6700;
  --tui-red: #cf222e;
}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--tui-bg);
  color: var(--tui-fg);
  font-family: var(--tui-mono);
  font-size: 12.5px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

.tui-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 12px 14px 10px;
  gap: 10px;
}

/* Top TUI Header Bar */
.tui-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  border: 1px solid var(--tui-border);
  background: var(--tui-surface);
  flex-shrink: 0;
}

.tui-topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.tui-brand {
  font-weight: 700;
  color: var(--tui-accent);
  white-space: nowrap;
}

.tui-project {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tui-repo {
  color: var(--tui-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tui-topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.tui-state-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--tui-muted);
}

.tui-state-tag.ok { color: var(--tui-green); }
.tui-state-tag.warn { color: var(--tui-amber); }

/* TUI Buttons */
.tui-btn {
  appearance: none;
  font-family: var(--tui-mono);
  font-size: 12px;
  color: var(--tui-fg);
  background: transparent;
  border: 1px solid var(--tui-border);
  padding: 3px 9px;
  cursor: pointer;
  transition: background 100ms ease, border-color 100ms ease, color 100ms ease;
}

.tui-btn:hover:not(:disabled) {
  background: var(--tui-surface-alt);
  border-color: var(--tui-border-strong);
}

.tui-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.tui-btn-primary {
  background: var(--tui-accent);
  border-color: var(--tui-accent);
  color: var(--tui-accent-fg);
  font-weight: 600;
}

.tui-btn-primary:hover:not(:disabled) {
  background: var(--tui-accent);
  opacity: 0.88;
}

.tui-btn-link {
  border: none;
  padding: 2px 5px;
  color: var(--tui-muted);
}

.tui-btn-link:hover:not(:disabled) {
  color: var(--tui-fg);
  background: var(--tui-surface-alt);
}

.tui-btn-danger {
  color: var(--tui-red);
  border-color: color-mix(in srgb, var(--tui-red) 45%, var(--tui-border));
}

/* Toast Banner */
.tui-banner {
  padding: 6px 10px;
  border: 1px solid var(--tui-border);
  background: var(--tui-surface);
  font-size: 12px;
  flex-shrink: 0;
}

.tui-banner.success {
  border-color: var(--tui-green);
  color: var(--tui-green);
}

.tui-banner.error {
  border-color: var(--tui-red);
  color: var(--tui-red);
}

/* Two-Column TUI Split */
.tui-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.38fr) minmax(310px, 1fr);
  gap: 10px;
  flex: 1;
  min-height: 0;
}

@media (max-width: 820px) {
  .tui-grid {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
}

.tui-pane {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--tui-border);
  background: var(--tui-surface);
  min-height: 0;
}

.tui-pane.alert {
  border-color: color-mix(in srgb, var(--tui-amber) 55%, var(--tui-border));
}

.tui-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--tui-border);
  background: var(--tui-surface-alt);
  font-weight: 600;
  flex-shrink: 0;
}

.tui-tabs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tui-tab {
  appearance: none;
  font-family: var(--tui-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--tui-muted);
  background: transparent;
  border: 1px solid transparent;
  padding: 2px 7px;
  cursor: pointer;
}

.tui-tab:hover {
  color: var(--tui-fg);
  background: var(--tui-surface);
}

.tui-tab.active {
  color: var(--tui-accent);
  border-color: var(--tui-accent);
  background: color-mix(in srgb, var(--tui-accent) 12%, var(--tui-surface));
}

.tui-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  border: 1px solid var(--tui-border);
  font-size: 11px;
  color: var(--tui-muted);
  white-space: nowrap;
}

.tui-badge.ok {
  color: var(--tui-green);
  border-color: color-mix(in srgb, var(--tui-green) 45%, var(--tui-border));
}

.tui-badge.warn {
  color: var(--tui-amber);
  border-color: color-mix(in srgb, var(--tui-amber) 45%, var(--tui-border));
}

.tui-badge.err {
  color: var(--tui-red);
  border-color: color-mix(in srgb, var(--tui-red) 45%, var(--tui-border));
}

.tui-pane-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

/* Composer Box */
.tui-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--tui-border);
  background: var(--tui-bg);
  transition: border-color 120ms ease, background 120ms ease;
}

.tui-composer.dragover {
  border: 1px dashed var(--tui-accent);
  background: color-mix(in srgb, var(--tui-accent) 8%, var(--tui-bg));
}

.tui-prompt-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tui-prompt-glyph {
  color: var(--tui-accent);
  font-weight: 700;
  flex-shrink: 0;
}

.tui-input, .tui-textarea {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--tui-fg);
  font-family: var(--tui-mono);
  font-size: 12.5px;
  line-height: 1.5;
  outline: none;
  padding: 2px 0;
}

.tui-textarea {
  border-top: 1px dashed var(--tui-border);
  padding-top: 7px;
  resize: vertical;
  min-height: 54px;
}

.tui-reply-input {
  width: 100%;
  background: var(--tui-bg);
  border: 1px solid var(--tui-border);
  color: var(--tui-fg);
  font-family: var(--tui-mono);
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
  min-height: 52px;
}

.tui-reply-input:focus {
  border-color: var(--tui-accent);
}

.tui-composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px solid var(--tui-border);
}

.tui-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tui-kind {
  appearance: none;
  font-family: var(--tui-mono);
  font-size: 11.5px;
  color: var(--tui-muted);
  background: transparent;
  border: 1px solid transparent;
  padding: 2px 6px;
  cursor: pointer;
}

.tui-kind.active {
  color: var(--tui-accent);
  border-color: var(--tui-accent);
  background: color-mix(in srgb, var(--tui-accent) 12%, transparent);
}

.tui-followup {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--tui-accent);
  padding: 3px 7px;
  border: 1px dashed var(--tui-accent);
}

/* Attachments Strip */
.tui-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 4px;
}

.tui-att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 7px;
  border: 1px solid var(--tui-border);
  background: var(--tui-surface);
  font-size: 11.5px;
  max-width: 240px;
}

.tui-att-thumb {
  width: 26px;
  height: 26px;
  object-fit: cover;
  border: 1px solid var(--tui-border);
  flex-shrink: 0;
}

.tui-att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tui-att-size {
  color: var(--tui-muted);
  flex-shrink: 0;
}

.tui-drop-hint {
  font-size: 11px;
  color: var(--tui-muted);
}

/* Section Headers & Task Rows */
.tui-sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--tui-muted);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--tui-border);
  margin-bottom: 6px;
}

.tui-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tui-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--tui-border);
  background: var(--tui-bg);
}

.tui-row:hover {
  border-color: var(--tui-border-strong);
}

.tui-row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.tui-row-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.tui-glyph-run { color: var(--tui-accent); }
.tui-glyph-ok { color: var(--tui-green); }
.tui-glyph-warn { color: var(--tui-amber); }

.tui-row-num {
  color: var(--tui-muted);
  flex-shrink: 0;
}

.tui-row-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tui-row-sub {
  color: var(--tui-muted);
  font-size: 11.5px;
  padding-left: 16px;
}

.tui-row-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--tui-muted);
  font-size: 11.5px;
  flex-shrink: 0;
}

/* Needs You Cards */
.tui-needs-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--tui-amber) 55%, var(--tui-border));
  background: var(--tui-bg);
}

.tui-needs-card.dragover {
  border-style: dashed;
  border-color: var(--tui-accent);
}

.tui-needs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tui-needs-tag {
  color: var(--tui-amber);
  font-weight: 600;
  font-size: 11.5px;
}

.tui-needs-title {
  font-weight: 600;
  margin: 0;
  font-size: 12.5px;
}

.tui-needs-pre {
  margin: 0;
  padding: 7px 9px;
  border-left: 2px solid var(--tui-amber);
  background: var(--tui-surface);
  color: var(--tui-muted);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 170px;
  overflow-y: auto;
}

.tui-empty {
  padding: 18px 12px;
  color: var(--tui-muted);
  text-align: center;
  border: 1px dashed var(--tui-border);
}

.tui-empty-calm {
  padding: 36px 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

/* Bottom Keybind Strip */
.tui-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 10px;
  border: 1px solid var(--tui-border);
  background: var(--tui-surface);
  color: var(--tui-muted);
  font-size: 11.5px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.tui-kbd {
  display: inline-block;
  padding: 0 4px;
  border: 1px solid var(--tui-border);
  background: var(--tui-bg);
  color: var(--tui-fg);
  margin-right: 3px;
}
`
