import type { BoardFileDescriptor } from '../src/protocol'

export function parseDescriptor(text: string): BoardFileDescriptor {
  try {
    const parsed = JSON.parse(text) as Partial<BoardFileDescriptor>
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        repoPath: typeof parsed.repoPath === 'string' ? parsed.repoPath : undefined,
        repository: typeof parsed.repository === 'string' ? parsed.repository : undefined,
        projectName: typeof parsed.projectName === 'string' ? parsed.projectName : undefined,
        workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined
      }
    }
  } catch {
    // fallback to empty descriptor
  }
  return { version: 1 }
}

export async function loadBoardDescriptor(): Promise<BoardFileDescriptor> {
  if (!orca.document) {
    return { version: 1 }
  }
  const doc = await orca.document.get()
  if (doc.content.kind === 'text') {
    return parseDescriptor(doc.content.text)
  }
  return { version: 1 }
}
