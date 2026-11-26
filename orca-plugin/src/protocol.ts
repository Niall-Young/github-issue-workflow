export type IssueKind = 'feature' | 'bug' | 'polish'

export type BoardFileDescriptor = {
  version: 1
  repoPath?: string
  repository?: string
  projectName?: string
  workspaceId?: string
}

export type NeedsYouItem =
  | {
      id: string
      kind: 'agent-question'
      title: string
      question: string
      terminalId: string
      workspaceId: string
      agentName: string
      state: 'blocked' | 'permission' | 'waiting'
      updatedAt: string
    }
  | {
      id: string
      kind: 'issue-attention'
      issueNumber: number
      title: string
      reason: string
      url: string
      rawStatus: string
      updatedAt: string
      canRetry: boolean
      canDiscard: boolean
    }

export type InProgressItem = {
  id: string
  issueNumber: number
  title: string
  url: string
  statusLabel: string
  updatedAt: string
}

export type CompletedItem = {
  id: string
  issueNumber: number
  title: string
  summary: string
  url: string
  prUrl: string | null
  completedAt: string
}

export type BoardSnapshot = {
  projectName: string
  repository: string | null
  repoPath: string | null
  autopilotInstalled: boolean
  autopilotRunning: boolean
  syncedAt: string
  error: string | null
  needsYou: NeedsYouItem[]
  inProgress: InProgressItem[]
  completed: CompletedItem[]
}

export type CreateIssueInput = {
  repoPath: string
  kind: IssueKind
  title: string
  details?: string
  followUpOf?: number | null
}

export type CreateIssueResult = {
  ok: true
  issueNumber: number | null
  url: string
  title: string
}

export type ReplyAgentInput = {
  terminalId: string
  message: string
}

export type IssueActionInput = {
  repoPath: string
  issueUrl: string
  action: 'retry' | 'discard'
}

export type EnableAutopilotInput = {
  repoPath: string
}

declare module 'orca/host' {
  interface PluginRequests {
    'board.snapshot': {
      input: { repoPath?: string; repository?: string; workspaceId?: string } | undefined
      output: BoardSnapshot
    }
    'board.createIssue': {
      input: CreateIssueInput
      output: CreateIssueResult
    }
    'board.replyAgent': {
      input: ReplyAgentInput
      output: { ok: true }
    }
    'board.issueAction': {
      input: IssueActionInput
      output: { ok: true }
    }
    'board.enableAutopilot': {
      input: EnableAutopilotInput
      output: { ok: true; message: string }
    }
  }

  interface PluginPanelEvents {
    'board.updated': {
      repoPath: string | null
      needsYouCount: number
    }
  }
}
