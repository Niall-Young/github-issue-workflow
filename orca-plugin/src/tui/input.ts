// Pure ANSI / UTF-8 terminal input parser supporting:
// - SGR 1006 mouse clicks & scroll wheel
// - Bracketed paste (text & dragged file paths)
// - Navigation keys, Ctrl shortcuts, and UTF-8/CJK text

export type InputEvent =
  | { type: 'key'; key: string; ctrl?: boolean; shift?: boolean; raw: string }
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string }
  | {
      type: 'mouse'
      kind: 'press' | 'release' | 'scrollUp' | 'scrollDown'
      button: 'left' | 'middle' | 'right' | 'other'
      x: number // 0-based column
      y: number // 0-based row
    }

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export class InputParser {
  private pending = ''
  private inPaste = false
  private pasteBuf = ''

  feed(chunk: string): InputEvent[] {
    const events: InputEvent[] = []
    let data = this.pending + chunk
    this.pending = ''

    while (data.length > 0) {
      if (this.inPaste) {
        const endIdx = data.indexOf(PASTE_END)
        if (endIdx === -1) {
          // Keep tail in case PASTE_END is split across chunks
          const keep = Math.min(data.length, PASTE_END.length - 1)
          this.pasteBuf += data.slice(0, data.length - keep)
          this.pending = data.slice(data.length - keep)
          return events
        }
        this.pasteBuf += data.slice(0, endIdx)
        events.push({ type: 'paste', text: this.pasteBuf })
        this.pasteBuf = ''
        this.inPaste = false
        data = data.slice(endIdx + PASTE_END.length)
        continue
      }

      if (data.startsWith(PASTE_START)) {
        this.inPaste = true
        this.pasteBuf = ''
        data = data.slice(PASTE_START.length)
        continue
      }

      // Check if chunk ends with a partial PASTE_START prefix
      if (data.length < PASTE_START.length && PASTE_START.startsWith(data)) {
        this.pending = data
        return events
      }

      // SGR 1006 mouse sequence: \x1b[<btn;col;rowM or m
      if (data.startsWith('\x1b[<')) {
        const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
        if (!match) {
          if (data.length < 24 && /^\x1b\[<[0-9;]*$/.test(data)) {
            this.pending = data
            return events
          }
          // Malformed sequence, consume ESC
          data = data.slice(1)
          continue
        }
        const cb = Number(match[1])
        const col = Math.max(0, Number(match[2]) - 1)
        const row = Math.max(0, Number(match[3]) - 1)
        const actionChar = match[4]
        data = data.slice(match[0].length)

        if (cb === 64) {
          events.push({ type: 'mouse', kind: 'scrollUp', button: 'other', x: col, y: row })
        } else if (cb === 65) {
          events.push({ type: 'mouse', kind: 'scrollDown', button: 'other', x: col, y: row })
        } else if ((cb & 32) === 0) {
          // Ignore motion drag events (bit 5); handle press/release
          const btnCode = cb & 3
          const button =
            btnCode === 0 ? 'left' : btnCode === 1 ? 'middle' : btnCode === 2 ? 'right' : 'other'
          events.push({
            type: 'mouse',
            kind: actionChar === 'M' ? 'press' : 'release',
            button,
            x: col,
            y: row
          })
        }
        continue
      }

      // CSI escape sequences (\x1b[...)
      if (data.startsWith('\x1b[')) {
        const csi = data.match(/^\x1b\[([0-9;?]*)([A-Za-z~])/)
        if (!csi) {
          if (data.length < 16 && /^\x1b\[[0-9;?]*$/.test(data)) {
            this.pending = data
            return events
          }
          events.push({ type: 'key', key: 'escape', raw: '\x1b' })
          data = data.slice(1)
          continue
        }
        const seq = csi[0]
        const params = csi[1]
        const code = csi[2]
        data = data.slice(seq.length)

        if (code === 'A') events.push({ type: 'key', key: 'up', raw: seq })
        else if (code === 'B') events.push({ type: 'key', key: 'down', raw: seq })
        else if (code === 'C') events.push({ type: 'key', key: 'right', raw: seq })
        else if (code === 'D') events.push({ type: 'key', key: 'left', raw: seq })
        else if (code === 'H') events.push({ type: 'key', key: 'home', raw: seq })
        else if (code === 'F') events.push({ type: 'key', key: 'end', raw: seq })
        else if (code === 'Z') events.push({ type: 'key', key: 'tab', shift: true, raw: seq })
        else if (code === 'u' && (params === '13;2' || params === '13;5')) {
          events.push({ type: 'key', key: 'enter', shift: true, raw: seq })
        } else if (code === '~') {
          if (params === '3') events.push({ type: 'key', key: 'delete', raw: seq })
          else if (params === '5') events.push({ type: 'key', key: 'pageup', raw: seq })
          else if (params === '6') events.push({ type: 'key', key: 'pagedown', raw: seq })
          else if (params === '1' || params === '7') events.push({ type: 'key', key: 'home', raw: seq })
          else if (params === '4' || params === '8') events.push({ type: 'key', key: 'end', raw: seq })
        }
        continue
      }

      // Alt/Option + Enter (\x1b\r or \x1b\n) -> newline in composer
      if (data.startsWith('\x1b\r') || data.startsWith('\x1b\n')) {
        events.push({ type: 'key', key: 'enter', shift: true, raw: data.slice(0, 2) })
        data = data.slice(2)
        continue
      }

      // SS3 sequences (\x1bO...)
      if (data.startsWith('\x1bO')) {
        if (data.length < 3) {
          this.pending = data
          return events
        }
        const seq = data.slice(0, 3)
        data = data.slice(3)
        const map: Record<string, string> = {
          '\x1bOA': 'up',
          '\x1bOB': 'down',
          '\x1bOC': 'right',
          '\x1bOD': 'left',
          '\x1bOH': 'home',
          '\x1bOF': 'end'
        }
        if (map[seq]) events.push({ type: 'key', key: map[seq], raw: seq })
        continue
      }

      // Lone ESC
      if (data[0] === '\x1b') {
        events.push({ type: 'key', key: 'escape', raw: '\x1b' })
        data = data.slice(1)
        continue
      }

      const code = data.charCodeAt(0)
      if (code === 0x0d || code === 0x0a) {
        events.push({ type: 'key', key: 'enter', raw: data[0] })
        data = data.slice(1)
        continue
      }
      if (code === 0x09) {
        events.push({ type: 'key', key: 'tab', raw: '\t' })
        data = data.slice(1)
        continue
      }
      if (code === 0x7f || code === 0x08) {
        events.push({ type: 'key', key: 'backspace', raw: data[0] })
        data = data.slice(1)
        continue
      }
      if (code >= 0x01 && code <= 0x1a) {
        const letter = String.fromCharCode(code + 96)
        events.push({ type: 'key', key: letter, ctrl: true, raw: data[0] })
        data = data.slice(1)
        continue
      }

      // Collect contiguous printable text (handling surrogate pairs / UTF-8)
      let i = 0
      while (i < data.length) {
        const c = data.charCodeAt(i)
        if (c < 0x20 || c === 0x7f) break
        const cp = data.codePointAt(i)
        i += cp !== undefined && cp > 0xffff ? 2 : 1
      }
      if (i > 0) {
        events.push({ type: 'text', text: data.slice(0, i) })
        data = data.slice(i)
      } else {
        data = data.slice(1)
      }
    }

    return events
  }
}
