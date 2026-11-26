// Slash command registry, filtering, and composer text helpers for the terminal TUI.

export type SlashCommandId =
  | 'bug'
  | 'feature'
  | 'polish'
  | 'handoff'
  | 'direct'
  | 'agent'
  | 'refresh'
  | 'issues'
  | 'prs'
  | 'autopilot'
  | 'stop'
  | 'paste'
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

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: 'bug',
    name: '/bug',
    aliases: ['b', 'fix'],
    label: '修 Bug',
    description: '切换为修 Bug，或直接提单 (/bug 描述)',
    takesArg: true
  },
  {
    id: 'feature',
    name: '/feature',
    aliases: ['feat', 'f'],
    label: '新功能',
    description: '切换为新功能，或直接提单 (/feature 描述)',
    takesArg: true
  },
  {
    id: 'polish',
    name: '/polish',
    aliases: ['ux'],
    label: '体验优化',
    description: '切换为体验优化，或直接提单 (/polish 描述)',
    takesArg: true
  },
  {
    id: 'handoff',
    name: '/handoff',
    aliases: ['skill'],
    label: 'Skill 规范提单',
    description: '由 Agent 按 Skill 规范整理提单 (/handoff 描述)',
    takesArg: true
  },
  {
    id: 'direct',
    name: '/direct',
    aliases: ['fast'],
    label: '快速直提',
    description: '跳过整理直接创建 GitHub Issue (/direct 描述)',
    takesArg: true
  },
  {
    id: 'agent',
    name: '/agent',
    aliases: ['settings', 'model'],
    label: '配置 Agent',
    description: '选择工作树默认执行 Agent 与允许列表'
  },
  {
    id: 'refresh',
    name: '/refresh',
    aliases: ['sync', 'r'],
    label: '刷新同步',
    description: '立即同步 GitHub Issues、PR 与本地状态'
  },
  {
    id: 'issues',
    name: '/issues',
    aliases: ['i'],
    label: '查看 Issues',
    description: '切换到 Issues 任务列表'
  },
  {
    id: 'prs',
    name: '/prs',
    aliases: ['pr'],
    label: '查看 PRs',
    description: '切换到 Pull Requests 列表'
  },
  {
    id: 'autopilot',
    name: '/autopilot',
    aliases: ['auto'],
    label: '自动处理开关',
    description: '开启或暂停自动处理循环 (/autopilot on|off)',
    takesArg: true
  },
  {
    id: 'stop',
    name: '/stop',
    aliases: ['pause', 'off'],
    label: '暂停自动处理',
    description: '暂停当前项目的自动处理循环（保留状态，可随时重开）'
  },
  {
    id: 'paste',
    name: '/paste',
    aliases: ['img', 'image'],
    label: '粘贴截图',
    description: '从 macOS 剪贴板粘贴截图作为附件 (^V)'
  },
  {
    id: 'clear',
    name: '/clear',
    aliases: ['reset'],
    label: '清空输入',
    description: '清空当前输入内容、附件与追提关联'
  },
  {
    id: 'quit',
    name: '/quit',
    aliases: ['exit', 'q'],
    label: '退出看板',
    description: '关闭 orca-board 返回终端'
  }
] as const

export function isSlashMenuOpen(input: string): boolean {
  if (!input.startsWith('/')) return false
  if (input.includes('\n') || input.includes(' ')) return false
  return true
}

export function filterSlashCommands(input: string): SlashCommandDef[] {
  if (!isSlashMenuOpen(input)) return []
  const query = input.slice(1).trim().toLowerCase()
  if (!query) return [...SLASH_COMMANDS]

  const prefixMatches: SlashCommandDef[] = []
  const otherMatches: SlashCommandDef[] = []

  for (const cmd of SLASH_COMMANDS) {
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

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const token = match[1].toLowerCase()
  const arg = (match[2] ?? '').trim()

  for (const cmd of SLASH_COMMANDS) {
    if (cmd.id === token || cmd.aliases.includes(token)) {
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
