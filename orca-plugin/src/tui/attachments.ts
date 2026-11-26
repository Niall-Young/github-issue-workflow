// Inline attachment identifier helpers (e.g. [Image #1], [File #1]) for TUI text inputs.
// Keeps text tokens and attachment lists synchronized for atomic Backspace deletion,
// click-to-remove chips, and clean text extraction on submit.

import type { SavedAttachment } from '../protocol'

export type InlineAttachment = SavedAttachment & {
  id: number
  token: string
}

function dropLastCodePoint(str: string): string {
  const chars = Array.from(str)
  chars.pop()
  return chars.join('')
}

export function isImageAttachment(att: Pick<SavedAttachment, 'mimeType'>): boolean {
  return att.mimeType.toLowerCase().startsWith('image/')
}

export function nextAttachmentId(attachments: readonly InlineAttachment[]): number {
  let maxId = 0
  for (const att of attachments) {
    if (att.id > maxId) maxId = att.id
  }
  return maxId + 1
}

export function formatAttachmentToken(att: Pick<SavedAttachment, 'mimeType'>, id: number): string {
  return isImageAttachment(att) ? `[Image #${id}]` : `[File #${id}]`
}

export function syncAttachmentsWithText(
  text: string,
  attachments: readonly InlineAttachment[]
): InlineAttachment[] {
  return attachments.filter((att) => text.includes(att.token))
}

export function appendInlineAttachment(
  text: string,
  attachments: readonly InlineAttachment[],
  saved: SavedAttachment
): { text: string; attachments: InlineAttachment[]; added: InlineAttachment } {
  const id = nextAttachmentId(attachments)
  const token = formatAttachmentToken(saved, id)
  const added: InlineAttachment = { ...saved, id, token }
  const needsLeadingSpace = text.length > 0 && !/\s$/.test(text)
  const nextText = needsLeadingSpace ? `${text} ${token}` : `${text}${token}`
  return {
    text: nextText,
    attachments: [...attachments, added],
    added
  }
}

export function backspaceWithInlineAttachments(
  text: string,
  attachments: readonly InlineAttachment[]
): { text: string; attachments: InlineAttachment[]; removed: InlineAttachment | null } {
  if (!text) {
    if (attachments.length === 0) {
      return { text: '', attachments: [], removed: null }
    }
    const nextAttachments = attachments.slice(0, -1)
    return {
      text: '',
      attachments: nextAttachments,
      removed: attachments[attachments.length - 1] ?? null
    }
  }

  for (let i = attachments.length - 1; i >= 0; i -= 1) {
    const att = attachments[i]
    if (text.endsWith(att.token)) {
      const nextText = text.slice(0, text.length - att.token.length)
      return {
        text: nextText,
        attachments: syncAttachmentsWithText(nextText, attachments.filter((item) => item.id !== att.id)),
        removed: att
      }
    }
  }

  const nextText = dropLastCodePoint(text)
  return {
    text: nextText,
    attachments: syncAttachmentsWithText(nextText, attachments),
    removed: null
  }
}

export function removeInlineAttachmentById(
  text: string,
  attachments: readonly InlineAttachment[],
  id: number
): { text: string; attachments: InlineAttachment[]; removed: InlineAttachment | null } {
  const target = attachments.find((att) => att.id === id) ?? null
  if (!target) {
    return { text, attachments: [...attachments], removed: null }
  }

  let nextText = text
  const idx = nextText.indexOf(target.token)
  if (idx !== -1) {
    const before = nextText.slice(0, idx)
    const after = nextText.slice(idx + target.token.length)
    if (before.endsWith(' ') && after.startsWith(' ')) {
      nextText = before + after.slice(1)
    } else if (!before && after.startsWith(' ')) {
      nextText = after.slice(1)
    } else if (!after && before.endsWith(' ')) {
      nextText = before.slice(0, -1)
    } else {
      nextText = before + after
    }
  }

  const remaining = syncAttachmentsWithText(
    nextText,
    attachments.filter((att) => att.id !== id)
  )
  return { text: nextText, attachments: remaining, removed: target }
}

export function stripInlineAttachmentTokens(
  text: string,
  attachments: readonly InlineAttachment[]
): string {
  if (attachments.length === 0) return text
  let result = text
  for (const att of attachments) {
    if (!result.includes(att.token)) continue
    result = result.split(att.token).join('')
  }
  return result
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim()
}
