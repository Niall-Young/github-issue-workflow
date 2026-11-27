// Slash command registry, filtering, and composer text helpers for the terminal TUI.

import { getLocale, pick, type Locale } from '../i18n'

export type SlashCommandId =
  | 'bug'
  | 'feature'
  | 'polish'
  | 'handoff'
  | 'direct'
  | 'local'
  | 'lite'
  | 'agent'
  | 'refresh'
  | 'issues'
  | 'prs'
  | 'autopilot'
  | 'stop'
  | 'paste'
  | 'title'
  | 'lang'
  | 'clear'
  | 'quit'

export type SlashCommandDef = {
  id: SlashCommandId
  name: string
  aliases: string[]
  label: string
  description: string
  takesArg?: boolean
}

type LocalizedText = { es: string; en: string; zh: string }

type SlashCommandSpec = {
  id: SlashCommandId
  name: string
  aliases: string[]
  label: LocalizedText
  description: LocalizedText
  takesArg?: boolean
}

const SLASH_COMMAND_SPECS: readonly SlashCommandSpec[] = [
  {
    id: 'bug',
    name: '/bug',
    aliases: ['b', 'fix', 'error'],
    label: { es: 'Corregir Bug', en: 'Fix Bug', zh: '修 Bug' },
    description: {
      es: 'Cambiar a Bug o crear Issue directo (/bug descripción)',
      en: 'Switch to Bug or submit directly (/bug description)',
      zh: '切换为修 Bug，或直接提单 (/bug 描述)'
    },
    takesArg: true
  },
  {
    id: 'feature',
    name: '/feature',
    aliases: ['feat', 'f', 'nueva'],
    label: { es: 'Nueva función', en: 'New Feature', zh: '新功能' },
    description: {
      es: 'Cambiar a Nueva función o crear Issue (/feature descripción)',
      en: 'Switch to Feature or submit directly (/feature description)',
      zh: '切换为新功能，或直接提单 (/feature 描述)'
    },
    takesArg: true
  },
  {
    id: 'polish',
    name: '/polish',
    aliases: ['ux', 'mejora'],
    label: { es: 'Mejora UX', en: 'Polish / UX', zh: '体验优化' },
    description: {
      es: 'Cambiar a Mejora UX o crear Issue (/polish descripción)',
      en: 'Switch to UX polish or submit directly (/polish description)',
      zh: '切换为体验优化，或直接提单 (/polish 描述)'
    },
    takesArg: true
  },
  {
    id: 'handoff',
    name: '/handoff',
    aliases: ['skill', 'guiado'],
    label: { es: 'Issue guiado (Skill)', en: 'Guided Handoff', zh: 'Skill 规范提单' },
    description: {
      es: 'El agente investiga el repo y redacta un Issue completo (/handoff desc)',
      en: 'Agent researches repo and drafts a structured Issue (/handoff desc)',
      zh: '由 Agent 按 Skill 规范整理提单 (/handoff 描述)'
    },
    takesArg: true
  },
  {
    id: 'direct',
    name: '/direct',
    aliases: ['fast', 'directo'],
    label: { es: 'Issue directo', en: 'Direct Issue', zh: '快速直提' },
    description: {
      es: 'Crear GitHub Issue al instante sin paso previo (/direct descripción)',
      en: 'Create GitHub Issue immediately (/direct description)',
      zh: '跳过整理直接创建 GitHub Issue (/direct 描述)'
    },
    takesArg: true
  },
  {
    id: 'local',
    name: '/local',
    aliases: ['l', 'main', 'dev'],
    label: { es: 'Cambio local directo', en: 'Local Direct Edit', zh: '本地直改' },
    description: {
      es: 'Editar y probar directo en la rama actual sin crear Issue (/local desc)',
      en: 'Develop directly on current branch and sync remote (/local desc)',
      zh: '直接在当前分支新开对话开发并自动对齐远端 (/local 描述)'
    },
    takesArg: true
  },
  {
    id: 'lite',
    name: '/lite',
    aliases: ['solo', 'mode', 'modo'],
    label: { es: 'Modo ligero', en: 'Lite Mode', zh: '轻量模式' },
    description: {
      es: 'Alternar modo ligero de 1 sesión para ahorrar tokens (/lite on|off)',
      en: 'Toggle single-session lite worker mode (/lite on|off)',
      zh: '切换后台单会话轻量模式省 Token (/lite on|off)'
    },
    takesArg: true
  },
  {
    id: 'agent',
    name: '/agent',
    aliases: ['settings', 'model', 'agente', 'config'],
    label: { es: 'Configurar Agente', en: 'Configure Agent', zh: '配置 Agent' },
    description: {
      es: 'Elegir el agente ejecutor predeterminado y agentes permitidos',
      en: 'Select default execution agent and allowed agents',
      zh: '选择工作树默认执行 Agent 与允许列表'
    }
  },
  {
    id: 'refresh',
    name: '/refresh',
    aliases: ['sync', 'r', 'actualizar'],
    label: { es: 'Sincronizar', en: 'Refresh', zh: '刷新同步' },
    description: {
      es: 'Sincronizar ahora Issues, PRs y estado local de agentes',
      en: 'Sync GitHub Issues, PRs, and local agent state now',
      zh: '立即同步 GitHub Issues、PR 与本地状态'
    }
  },
  {
    id: 'issues',
    name: '/issues',
    aliases: ['i'],
    label: { es: 'Ver Issues', en: 'View Issues', zh: '查看 Issues' },
    description: {
      es: 'Cambiar a la pestaña de Issues y tareas',
      en: 'Switch to the Issues list tab',
      zh: '切换到 Issues 任务列表'
    }
  },
  {
    id: 'prs',
    name: '/prs',
    aliases: ['pr'],
    label: { es: 'Ver PRs', en: 'View PRs', zh: '查看 PRs' },
    description: {
      es: 'Cambiar a la pestaña de Pull Requests',
      en: 'Switch to the Pull Requests tab',
      zh: '切换到 Pull Requests 列表'
    }
  },
  {
    id: 'autopilot',
    name: '/autopilot',
    aliases: ['auto'],
    label: { es: 'Interruptor Autopilot', en: 'Toggle Autopilot', zh: '自动处理开关' },
    description: {
      es: 'Activar o pausar el bucle automático de Issues (/autopilot on|off)',
      en: 'Enable or pause background Issue autopilot (/autopilot on|off)',
      zh: '开启或暂停自动处理循环 (/autopilot on|off)'
    },
    takesArg: true
  },
  {
    id: 'stop',
    name: '/stop',
    aliases: ['pause', 'off', 'pausar'],
    label: { es: 'Pausar Autopilot', en: 'Pause Autopilot', zh: '暂停自动处理' },
    description: {
      es: 'Pausar Autopilot en este proyecto conservando el estado',
      en: 'Pause background autopilot for this project (preserves state)',
      zh: '暂停当前项目的自动处理循环（保留状态，可随时重开）'
    }
  },
  {
    id: 'paste',
    name: '/paste',
    aliases: ['img', 'image', 'pegar'],
    label: { es: 'Pegar adjunto', en: 'Paste Attachment', zh: '粘贴附件' },
    description: {
      es: 'Pegar captura o archivo desde el portapapeles como adjunto (^V)',
      en: 'Paste image or file from clipboard as attachment (^V)',
      zh: '从剪贴板粘贴图片或文件作为附件 (^V)'
    }
  },
  {
    id: 'title',
    name: '/title',
    aliases: ['rename', 'name', 'titulo'],
    label: { es: 'Renombrar pestaña', en: 'Rename Tab', zh: '修改终端名称' },
    description: {
      es: 'Personalizar título de la pestaña (/title nombre, vacío restaura)',
      en: 'Customize terminal tab title (/title name, empty resets)',
      zh: '自定义当前终端标签名称 (/title 新名称，留空恢复默认)'
    },
    takesArg: true
  },
  {
    id: 'lang',
    name: '/lang',
    aliases: ['idioma', 'language', 'es', 'en', 'zh'],
    label: { es: 'Idioma (es/en/zh)', en: 'Language (es/en/zh)', zh: '界面语言 (es/en/zh)' },
    description: {
      es: 'Cambiar idioma de la consola: español, inglés o chino (/lang es|en|zh)',
      en: 'Switch UI language: Spanish, English, or Chinese (/lang es|en|zh)',
      zh: '切换控制台语言：西语、英语或中文 (/lang es|en|zh)'
    },
    takesArg: true
  },
  {
    id: 'clear',
    name: '/clear',
    aliases: ['reset', 'limpiar'],
    label: { es: 'Limpiar entrada', en: 'Clear Input', zh: '清空输入' },
    description: {
      es: 'Vaciar texto actual, adjuntos y vínculo de seguimiento',
      en: 'Clear current draft, attachments, and follow-up link',
      zh: '清空当前输入内容、附件与追提关联'
    }
  },
  {
    id: 'quit',
    name: '/quit',
    aliases: ['exit', 'q', 'salir'],
    label: { es: 'Salir', en: 'Quit Console', zh: '退出控制台' },
    description: {
      es: 'Cerrar orca-autopilot y volver a la terminal',
      en: 'Close orca-autopilot and return to shell',
      zh: '关闭 orca-autopilot 返回终端'
    }
  }
]

export function getSlashCommands(locale: Locale = getLocale()): SlashCommandDef[] {
  return SLASH_COMMAND_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    aliases: spec.aliases,
    label: pick(spec.label, locale),
    description: pick(spec.description, locale),
    ...(spec.takesArg ? { takesArg: true } : {})
  }))
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = getSlashCommands('zh')

export function isSlashMenuOpen(input: string): boolean {
  if (!input.startsWith('/')) return false
  if (input.includes('\n') || input.includes(' ')) return false
  return true
}

export function filterSlashCommands(input: string, locale: Locale = getLocale()): SlashCommandDef[] {
  if (!isSlashMenuOpen(input)) return []
  const commands = getSlashCommands(locale)
  const query = input.slice(1).trim().toLowerCase()
  if (!query) return commands

  const prefixMatches: SlashCommandDef[] = []
  const otherMatches: SlashCommandDef[] = []

  for (const cmd of commands) {
    const idMatch = cmd.id.startsWith(query)
    const aliasMatch = cmd.aliases.some((a) => a.startsWith(query))
    if (idMatch || aliasMatch) {
      prefixMatches.push(cmd)
    } else if (
      cmd.id.includes(query) ||
      cmd.aliases.some((a) => a.includes(query)) ||
      cmd.label.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    ) {
      otherMatches.push(cmd)
    }
  }

  return [...prefixMatches, ...otherMatches]
}

export type ParsedSlashCommand =
  | { kind: 'command'; command: SlashCommandDef; arg: string }
  | { kind: 'unknown'; name: string }

export function parseSlashCommand(input: string, locale: Locale = getLocale()): ParsedSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const token = match[1].toLowerCase()
  const arg = (match[2] ?? '').trim()

  const commands = getSlashCommands(locale)
  for (const cmd of commands) {
    if (cmd.id === token || cmd.aliases.includes(token)) {
      if (cmd.id === 'lang' && !arg && (token === 'es' || token === 'en' || token === 'zh')) {
        return { kind: 'command', command: cmd, arg: token }
      }
      return { kind: 'command', command: cmd, arg }
    }
  }
  return { kind: 'unknown', name: `/${token}` }
}

export function splitComposerText(raw: string): { title: string; details: string } {
  const normalized = raw.replace(/\r/g, '').trim()
  if (!normalized) return { title: '', details: '' }
  const lines = normalized.split('\n')
  const firstIdx = lines.findIndex((line) => line.trim().length > 0)
  if (firstIdx === -1) return { title: '', details: '' }
  const title = lines[firstIdx].trim()
  const details = lines
    .slice(firstIdx + 1)
    .join('\n')
    .trim()
  return { title, details }
}
