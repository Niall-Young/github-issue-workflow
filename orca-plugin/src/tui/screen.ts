// Zero-dependency terminal canvas with CJK width awareness, hit-box click regions,
// Claude Code-inspired palette, and flicker-free ANSI diff rendering.

export const ANSI = {
  altScreenOn: '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  cursorHide: '\x1b[?25l',
  cursorShow: '\x1b[?25h',
  mouseOn: '\x1b[?1000h\x1b[?1006h',
  mouseOff: '\x1b[?1006l\x1b[?1000l',
  bracketedPasteOn: '\x1b[?2004h',
  bracketedPasteOff: '\x1b[?2004l',
  clearScreen: '\x1b[2J\x1b[H',
  reset: '\x1b[0m'
} as const

export const PALETTE = {
  // Adaptive terminal palette: relies on native terminal fg/bold/dim for text & surfaces
  // paired with balanced mid-tone accents that stay crisp on both light and dark themes.
  text: '',
  bright: '\x1b[1m',
  muted: '\x1b[38;2;130;132;140m',
  dim: '\x1b[2m',
  border: '\x1b[2m',
  borderActive: '\x1b[38;2;204;107;73m',
  accent: '\x1b[38;2;204;107;73m', // warm terracotta
  accentBold: '\x1b[1;38;2;204;107;73m',
  accentBg: '\x1b[48;2;204;107;73;38;2;255;255;255;1m',
  green: '\x1b[38;2;52;160;104m',
  amber: '\x1b[38;2;198;134;38m',
  red: '\x1b[38;2;206;76;76m',
  blue: '\x1b[38;2;72;132;214m',
  purple: '\x1b[38;2;146;104;214m',
  tabActive: '\x1b[1;4;38;2;204;107;73m',
  tabInactive: '\x1b[38;2;130;132;140m',
  attachmentToken: '\x1b[1;38;2;46;150;108m'
} as const

export type CursorPosition = {
  x: number
  y: number
}

export function cursorTo(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`
}

export type HitBox = {
  x: number
  y: number
  w: number
  h: number
  action: string
  payload?: unknown
}

export function charDisplayWidth(codePoint: number): number {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0
  // Zero-width combining / variation selectors / ZWJ
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0x200d
  ) {
    return 0
  }
  // Wide CJK, Hangul, Fullwidth forms, Emoji blocks
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

export function stringDisplayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp !== undefined) width += charDisplayWidth(cp)
  }
  return width
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return ''
  if (stringDisplayWidth(text) <= maxWidth) return text
  const ellW = stringDisplayWidth(ellipsis)
  if (maxWidth <= ellW) return ellipsis.slice(0, maxWidth)
  let out = ''
  let w = 0
  const limit = maxWidth - ellW
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const cw = cp !== undefined ? charDisplayWidth(cp) : 1
    if (w + cw > limit) break
    out += ch
    w += cw
  }
  return out + ellipsis
}

export function wrapTextToWidth(text: string, maxWidth: number, maxLines = 8): string[] {
  if (maxWidth <= 0 || maxLines <= 0) return []
  const result: string[] = []
  const rawLines = text.replace(/\r/g, '').split('\n')
  for (const rawLine of rawLines) {
    if (result.length >= maxLines) break
    if (!rawLine) {
      result.push('')
      continue
    }
    let current = ''
    let w = 0
    for (const ch of rawLine) {
      const cp = ch.codePointAt(0)
      const cw = cp !== undefined ? charDisplayWidth(cp) : 1
      if (w + cw > maxWidth) {
        result.push(current)
        if (result.length >= maxLines) break
        current = ch
        w = cw
      } else {
        current += ch
        w += cw
      }
    }
    if (result.length < maxLines && current) {
      result.push(current)
    }
  }
  return result
}

type Cell = {
  ch: string
  style: string
  wideTrail?: boolean
}

export class ScreenBuffer {
  readonly width: number
  readonly height: number
  private cells: Cell[][]
  private _cursor: CursorPosition | null = null
  readonly hitBoxes: HitBox[] = []

  constructor(width: number, height: number) {
    this.width = Math.max(20, width)
    this.height = Math.max(10, height)
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ ch: ' ', style: '' }))
    )
  }

  get cursor(): CursorPosition | null {
    return this._cursor ? { ...this._cursor } : null
  }

  setCursor(x: number, y: number) {
    const cx = Math.max(0, Math.min(this.width - 1, Math.floor(x)))
    const cy = Math.max(0, Math.min(this.height - 1, Math.floor(y)))
    this._cursor = { x: cx, y: cy }
  }

  clearCursor() {
    this._cursor = null
  }

  addHitBox(x: number, y: number, w: number, h: number, action: string, payload?: unknown) {
    if (w <= 0 || h <= 0) return
    this.hitBoxes.push({ x, y, w, h, action, payload })
  }

  hitTest(x: number, y: number): HitBox | null {
    // Search in reverse so overlays/modals added later win over background elements
    for (let i = this.hitBoxes.length - 1; i >= 0; i -= 1) {
      const b = this.hitBoxes[i]
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        return b
      }
    }
    return null
  }

  fillRect(x: number, y: number, w: number, h: number, style = '', ch = ' ') {
    const x0 = Math.max(0, x)
    const y0 = Math.max(0, y)
    const x1 = Math.min(this.width, x + w)
    const y1 = Math.min(this.height, y + h)
    for (let row = y0; row < y1; row += 1) {
      for (let col = x0; col < x1; col += 1) {
        this.cells[row][col] = { ch, style }
      }
    }
  }

  writeText(
    x: number,
    y: number,
    text: string,
    style = '',
    maxWidth?: number
  ): number {
    if (y < 0 || y >= this.height || x >= this.width) return 0
    const available = maxWidth !== undefined ? Math.min(maxWidth, this.width - x) : this.width - x
    if (available <= 0) return 0
    const clipped = truncateToWidth(text, available)
    let col = x
    for (const ch of clipped) {
      const cp = ch.codePointAt(0)
      const cw = cp !== undefined ? charDisplayWidth(cp) : 1
      if (cw === 0) continue
      if (col + cw > this.width) break
      if (col >= 0) {
        // Clear any wide char we are overwriting
        if (this.cells[y][col].wideTrail && col > 0) {
          this.cells[y][col - 1] = { ch: ' ', style: this.cells[y][col - 1].style }
        }
        this.cells[y][col] = { ch, style }
        if (cw === 2 && col + 1 < this.width) {
          this.cells[y][col + 1] = { ch: '', style, wideTrail: true }
        }
      }
      col += cw
    }
    return col - x
  }

  drawButton(
    x: number,
    y: number,
    label: string,
    style: string,
    action: string,
    payload?: unknown
  ): number {
    const text = ` ${label} `
    const w = this.writeText(x, y, text, style)
    this.addHitBox(x, y, w, 1, action, payload)
    return w
  }

  drawLinkButton(
    x: number,
    y: number,
    label: string,
    style: string,
    action: string,
    payload?: unknown
  ): number {
    const w = this.writeText(x, y, label, style)
    this.addHitBox(x, y, w, 1, action, payload)
    return w
  }

  drawHLine(x: number, y: number, w: number, style: string = PALETTE.border, ch = '─') {
    if (y < 0 || y >= this.height || w <= 0) return
    const x0 = Math.max(0, x)
    const x1 = Math.min(this.width, x + w)
    for (let col = x0; col < x1; col += 1) {
      this.cells[y][col] = { ch, style }
    }
  }

  drawVLine(x: number, y: number, h: number, style: string = PALETTE.border, ch = '│') {
    if (x < 0 || x >= this.width || h <= 0) return
    const y0 = Math.max(0, y)
    const y1 = Math.min(this.height, y + h)
    for (let row = y0; row < y1; row += 1) {
      this.cells[row][x] = { ch, style }
    }
  }

  drawBox(
    x: number,
    y: number,
    w: number,
    h: number,
    options?: {
      borderStyle?: string
      fillStyle?: string
      clearInterior?: boolean
      title?: string
      titleStyle?: string
      rounded?: boolean
    }
  ) {
    if (w < 2 || h < 2) return
    const borderStyle = options?.borderStyle ?? PALETTE.border
    const tl = options?.rounded === false ? '┌' : '╭'
    const tr = options?.rounded === false ? '┐' : '╮'
    const bl = options?.rounded === false ? '└' : '╰'
    const br = options?.rounded === false ? '┘' : '╯'

    if (options?.fillStyle !== undefined) {
      this.fillRect(x + 1, y + 1, w - 2, h - 2, options.fillStyle)
    } else if (options?.clearInterior) {
      this.fillRect(x + 1, y + 1, w - 2, h - 2, '')
    }

    this.writeText(x, y, tl, borderStyle, 1)
    this.drawHLine(x + 1, y, w - 2, borderStyle, '─')
    this.writeText(x + w - 1, y, tr, borderStyle, 1)

    this.drawVLine(x, y + 1, h - 2, borderStyle, '│')
    this.drawVLine(x + w - 1, y + 1, h - 2, borderStyle, '│')

    this.writeText(x, y + h - 1, bl, borderStyle, 1)
    this.drawHLine(x + 1, y + h - 1, w - 2, borderStyle, '─')
    this.writeText(x + w - 1, y + h - 1, br, borderStyle, 1)

    if (options?.title) {
      this.writeText(
        x + 2,
        y,
        ` ${options.title} `,
        options.titleStyle ?? PALETTE.bright,
        Math.max(0, w - 4)
      )
    }
  }

  renderLines(): string[] {
    const lines: string[] = []
    for (let row = 0; row < this.height; row += 1) {
      let line = ''
      let activeStyle = ''
      for (let col = 0; col < this.width; col += 1) {
        const cell = this.cells[row][col]
        if (cell.wideTrail) continue
        if (cell.style !== activeStyle) {
          line += ANSI.reset + cell.style
          activeStyle = cell.style
        }
        line += cell.ch
      }
      if (activeStyle) line += ANSI.reset
      lines.push(line)
    }
    return lines
  }

  diffOutput(
    previousLines: string[] | null,
    previousCursor?: CursorPosition | null
  ): { output: string; lines: string[]; cursor: CursorPosition | null } {
    const lines = this.renderLines()
    let body = ''
    for (let row = 0; row < lines.length; row += 1) {
      if (!previousLines || previousLines[row] !== lines[row]) {
        body += `\x1b[${row + 1};1H${lines[row]}`
      }
    }

    const cur = this.cursor
    let out = ''
    if (body) {
      out = ANSI.cursorHide + body
      if (cur) {
        out += cursorTo(cur.x, cur.y) + ANSI.cursorShow
      }
    } else if (cur) {
      const sameCursor =
        previousCursor !== undefined &&
        previousCursor !== null &&
        previousCursor.x === cur.x &&
        previousCursor.y === cur.y
      if (!sameCursor) {
        out = cursorTo(cur.x, cur.y) + ANSI.cursorShow
      }
    } else if (previousCursor !== null) {
      out = ANSI.cursorHide
    }

    return { output: out, lines, cursor: cur }
  }
}
