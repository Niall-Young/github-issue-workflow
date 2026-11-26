export type IssueKind = 'feature' | 'bug' | 'polish'

export type SubmitMode = 'handoff' | 'direct'

export type BoardFileDescriptor = {
  version: 1
  repoPath?: string
  repository?: string
  projectName?: string
  workspaceId?: string
}

export type AttachmentPayload = {
  name: string
  mimeType: string
  size: number
  base64: string
}

export type SavedAttachment = {
  name: string
  mimeType: string
  size: number
  path: string
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
  issueNumber: number | null
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
  workspaceId?: string
  mode?: SubmitMode
  kind: IssueKind
  title: string
  details?: string
  followUpOf?: number | null
  attachments?: AttachmentPayload[]
}

export type CreateIssueResult = {
  ok: true
  mode: SubmitMode
  issueNumber: number | null
  url: string
  title: string
  savedAttachments: SavedAttachment[]
  terminalId?: string
  agent?: string
}

export type ReplyAgentInput = {
  terminalId: string
  message: string
  repoPath?: string
  attachments?: AttachmentPayload[]
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
      output: { ok: true; savedAttachments: SavedAttachment[] }
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
