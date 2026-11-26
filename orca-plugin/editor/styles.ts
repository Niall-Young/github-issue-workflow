export const BOARD_STYLES = `
:root {
  --ib-bg: var(--orca-background, #0f1115);
  --ib-surface: var(--orca-card, #161920);
  --ib-surface-hover: var(--orca-accent, rgba(255, 255, 255, 0.04));
  --ib-border: var(--orca-border, rgba(255, 255, 255, 0.09));
  --ib-fg: var(--orca-foreground, #eceef2);
  --ib-muted: var(--orca-muted-foreground, #8c95a6);
  --ib-primary: var(--orca-primary, #3b82f6);
  --ib-primary-fg: var(--orca-primary-foreground, #ffffff);
  --ib-radius: var(--orca-radius, 10px);
  --ib-green: #22c55e;
  --ib-amber: #f59e0b;
  --ib-red: #ef4444;
  --ib-font: var(--orca-font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif);
}

html.light {
  --ib-bg: var(--orca-background, #f8f9fb);
  --ib-surface: var(--orca-card, #ffffff);
  --ib-surface-hover: var(--orca-accent, rgba(0, 0, 0, 0.03));
  --ib-border: var(--orca-border, rgba(15, 23, 42, 0.1));
  --ib-fg: var(--orca-foreground, #111827);
  --ib-muted: var(--orca-muted-foreground, #6b7280);
}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--ib-bg);
  color: var(--ib-fg);
  font-family: var(--ib-font);
  font-size: 13.5px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.ib-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: 1360px;
  margin: 0 auto;
  padding: 20px 24px 24px;
  gap: 18px;
}

.ib-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.ib-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ib-title {
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ib-repo-pill {
  font-size: 12px;
  color: var(--ib-muted);
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
}

.ib-header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.ib-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ib-muted);
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
}

.ib-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.ib-dot-green { background: var(--ib-green); }
.ib-dot-amber { background: var(--ib-amber); }
.ib-dot-blue {
  background: var(--ib-primary);
  animation: ib-pulse 1.8s ease-in-out infinite;
}

@keyframes ib-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.85); }
}

.ib-btn {
  appearance: none;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
  color: var(--ib-fg);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}

.ib-btn:hover:not(:disabled) {
  background: var(--ib-surface-hover);
  border-color: color-mix(in srgb, var(--ib-fg) 22%, transparent);
}

.ib-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ib-btn-primary {
  background: var(--ib-primary);
  border-color: var(--ib-primary);
  color: var(--ib-primary-fg);
}

.ib-btn-primary:hover:not(:disabled) {
  background: var(--ib-primary);
  opacity: 0.9;
}

.ib-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--ib-muted);
  padding: 4px 8px;
}

.ib-btn-ghost:hover:not(:disabled) {
  color: var(--ib-fg);
  background: var(--ib-surface-hover);
}

.ib-btn-danger {
  color: var(--ib-red);
}

.ib-toast {
  font-size: 12.5px;
  padding: 9px 14px;
  border-radius: 8px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ib-toast-error {
  border-color: color-mix(in srgb, var(--ib-red) 45%, transparent);
  color: var(--ib-red);
}

.ib-toast-success {
  border-color: color-mix(in srgb, var(--ib-green) 45%, transparent);
  color: var(--ib-green);
}

.ib-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr);
  gap: 20px;
  flex: 1;
  min-height: 0;
}

@media (max-width: 820px) {
  .ib-columns {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
}

.ib-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.ib-card {
  background: var(--ib-surface);
  border: 1px solid var(--ib-border);
  border-radius: var(--ib-radius);
  padding: 14px 16px;
}

.ib-composer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ib-followup-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ib-primary);
  background: color-mix(in srgb, var(--ib-primary) 10%, transparent);
  padding: 4px 10px;
  border-radius: 6px;
  align-self: flex-start;
}

.ib-input, .ib-textarea {
  width: 100%;
  background: transparent;
  border: 1px solid var(--ib-border);
  border-radius: 8px;
  color: var(--ib-fg);
  font: inherit;
  padding: 9px 12px;
  outline: none;
  transition: border-color 120ms ease;
}

.ib-input:focus, .ib-textarea:focus {
  border-color: var(--ib-primary);
}

.ib-input-title {
  font-size: 14px;
  font-weight: 500;
  border: none;
  padding: 4px 2px;
}

.ib-textarea {
  resize: vertical;
  min-height: 62px;
  font-size: 13px;
}

.ib-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.ib-kind-group {
  display: inline-flex;
  gap: 6px;
}

.ib-chip {
  appearance: none;
  border: 1px solid var(--ib-border);
  background: transparent;
  color: var(--ib-muted);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
}

.ib-chip.active {
  color: var(--ib-fg);
  border-color: var(--ib-primary);
  background: color-mix(in srgb, var(--ib-primary) 14%, transparent);
}

.ib-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.ib-section-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ib-fg);
  margin: 0;
}

.ib-badge {
  font-size: 11.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--ib-surface-hover);
  border: 1px solid var(--ib-border);
  color: var(--ib-muted);
}

.ib-badge-alert {
  background: color-mix(in srgb, var(--ib-amber) 18%, transparent);
  border-color: color-mix(in srgb, var(--ib-amber) 45%, transparent);
  color: var(--ib-amber);
}

.ib-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ib-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 13px;
  border-radius: 9px;
  border: 1px solid var(--ib-border);
  background: var(--ib-surface);
  transition: border-color 120ms ease;
}

.ib-row:hover {
  border-color: color-mix(in srgb, var(--ib-fg) 20%, transparent);
}

.ib-row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.ib-row-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ib-row-title {
  font-weight: 550;
  color: var(--ib-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ib-row-summary {
  font-size: 12.5px;
  color: var(--ib-muted);
  margin-left: 15px;
}

.ib-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--ib-muted);
}

.ib-needs-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-color: color-mix(in srgb, var(--ib-amber) 40%, var(--ib-border));
}

.ib-needs-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ib-amber);
}

.ib-needs-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.ib-needs-body {
  margin: 0;
  font-size: 12.5px;
  color: var(--ib-muted);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--ib-bg);
  border: 1px solid var(--ib-border);
  border-radius: 8px;
  padding: 10px 12px;
  max-height: 180px;
  overflow-y: auto;
}

.ib-needs-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ib-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--ib-muted);
  font-size: 13px;
  border: 1px dashed var(--ib-border);
  border-radius: var(--ib-radius);
}

.ib-empty-calm {
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.ib-check-circle {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 16px;
  color: var(--ib-green);
  background: color-mix(in srgb, var(--ib-green) 14%, transparent);
}
`
