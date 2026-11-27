import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildHandoffPrompt, buildIssueBody, buildLocalDevPrompt } from './board-data'
import { getLocale, normalizeLocaleTag, readSavedLocale, saveLocalePreference, setLocale } from './i18n'
import { filterSlashCommands, parseSlashCommand } from './tui/commands'
import { DEFAULT_SUBMIT_MODE, renderTui, type TuiState } from './tui/render'
import { stripTerminalAnsi } from './board-data'

test('i18n supports es, en, and zh in TUI rendering, slash commands, and prompts', () => {
  const temp = mkdtempSync(join(tmpdir(), 'autopilot-i18n-'))
  try {
    assert.equal(normalizeLocaleTag('es-AR'), 'es')
    assert.equal(normalizeLocaleTag('español'), 'es')
    assert.equal(normalizeLocaleTag('en_US'), 'en')
    assert.equal(normalizeLocaleTag('zh-CN'), 'zh')

    saveLocalePreference('es', temp)
    assert.equal(readSavedLocale(temp), 'es')

    setLocale('es')
    assert.equal(getLocale(), 'es')

    const state: TuiState = {
      snapshot: {
        projectName: 'wezbridge',
        repoPath: '/tmp/wezbridge',
        repository: 'wolverin0/wezbridge',
        autopilotInstalled: false,
        autopilotRunning: false,
        workerMode: 'standard',
        defaultAgent: 'codex',
        allowedAgents: ['codex'],
        preferredAgent: 'codex',
        installedAgents: [{ id: 'codex', name: 'Codex', default: true }],
        needsYou: [
          {
            id: 'agent-1',
            kind: 'agent-question',
            title: 'Confirmar alcance',
            question: '¿Avanzamos con la opción A?',
            terminalId: 'term_1',
            workspaceId: 'ws_1',
            agentName: 'codex',
            state: 'waiting',
            updatedAt: new Date().toISOString()
          }
        ],
        inProgress: [],
        completed: [],
        pullRequests: [],
        syncedAt: new Date().toISOString(),
        error: null
      },
      loading: false,
      activeTab: 'issues',
      activePane: 'main',
      selectedIndex: 0,
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

    const buf = renderTui(state, 120, 28)
    const plain = stripTerminalAnsi(buf.diffOutput(null, null).lines.join('\n'))
    assert.ok(plain.includes('Pendientes 1'))
    assert.ok(plain.includes('Aprobar y seguir'))
    assert.ok(plain.includes('[Responder]'))
    assert.ok(plain.includes('Nueva función'))
    assert.ok(plain.includes('Issue guiado'))
    assert.ok(plain.includes('Escribí qué necesitás hacer'))

    const esCommands = filterSlashCommands('/idioma')
    assert.equal(esCommands[0]?.id, 'lang')
    const parsedEs = parseSlashCommand('/es')
    assert.equal(parsedEs?.kind, 'command')
    if (parsedEs?.kind === 'command') {
      assert.equal(parsedEs.command.id, 'lang')
      assert.equal(parsedEs.arg, 'es')
    }

    const handoffPrompt = buildHandoffPrompt({
      repoPath: '/tmp/wezbridge',
      repository: 'wolverin0/wezbridge',
      kind: 'bug',
      title: 'Arreglar timeout en reconexión'
    })
    assert.ok(handoffPrompt.includes('redactado en **español**'))

    const directBody = buildIssueBody('feature', 'Panel de métricas')
    assert.ok(directBody.includes('## Tipo de tarea'))
    assert.ok(directBody.includes('## Criterios de aceptación'))

    const localPrompt = buildLocalDevPrompt({
      repoPath: '/tmp/wezbridge',
      branch: 'main',
      title: 'Ajustar estilos',
      lockPath: '/tmp/lock.json'
    })
    assert.ok(localPrompt.includes('Tarea solicitada'))
  } finally {
    setLocale(null)
    rmSync(temp, { recursive: true, force: true })
  }
})
