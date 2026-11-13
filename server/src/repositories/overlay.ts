/** Unified Git patches, parsed and applied as data only; never checked out or executed. */
import { isUtf8 } from 'node:buffer'

/** Bytes of diff and files it changes one call takes. */
export const OVERLAY_MAX_BYTES = 200_000
export const OVERLAY_MAX_FILES = 50
/** Characters of file content one call parses (the diff cap bounds the diff, not the files it changes). */
export const OVERLAY_MAX_PARSED = 2 * 1024 * 1024

/** A refused overlay: the MCP layer shows its message as `INVALID_ARGUMENT` on `overlay`. */
export class OverlayError extends Error {}

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  oldNoNewline?: boolean
  newNoNewline?: boolean
  /** Lines with their marker: ' ' context, '-' removed, '+' added. */
  lines: string[]
}

export interface FilePatch {
  path: string
  /** The abbreviated blob id of the old file from git's `index` line, when the diff has one. */
  oldBlob?: string
  status: 'added' | 'modified' | 'deleted'
  hunks: Hunk[]
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 }

/** A git C-quoted path without its quotes, decoded to text (`\\303\\251` is the two bytes of `é`). */
function unquote(quoted: string): string {
  const bytes: number[] = []
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i]!
    if (c !== '\\') {
      const codepoint = quoted.codePointAt(i)!
      bytes.push(...Buffer.from(String.fromCodePoint(codepoint)))
      if (codepoint > 0xffff) i++
      continue
    }
    const next = quoted[++i]!
    const octal = /^[0-7]{3}/.exec(quoted.slice(i, i + 3))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 2
    } else if (next !== undefined && next in ESCAPES) bytes.push(ESCAPES[next]!)
    else throw new OverlayError(`unreadable quoted path: ${quoted.slice(0, 60)}`)
  }
  const encoded = Buffer.from(bytes)
  if (!isUtf8(encoded)) throw new OverlayError('non-UTF-8 quoted paths are not supported')
  return encoded.toString('utf8')
}

/** The text patches of a unified diff. Unsupported changes are refused, never silently left out. */
export function parseOverlay(diff: string): FilePatch[] {
  if (Buffer.byteLength(diff) > OVERLAY_MAX_BYTES) throw new OverlayError(`the overlay is over ${OVERLAY_MAX_BYTES / 1000} KB`)
  if (Buffer.from(diff).toString('utf8') !== diff) throw new OverlayError('the overlay must be well-formed UTF-8 text')
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const patches: FilePatch[] = []
  let current: { from: string | null; to: string | null; patch: FilePatch | null; oldBlob?: string } | null = null
  const finish = () => {
    if (current?.patch) patches.push(current.patch)
    else if (current) throw new OverlayError('a file has no supported text patch (mode-only and empty-file metadata changes are not supported)')
    current = null
  }
  const stripped = (name: string): string | null => {
    const raw = name.split('\t')[0]!
    // git quotes a path with non-ASCII bytes, a quote, backslash or control character (core.quotepath): C-style escapes,
    // octal for each byte of the UTF-8 name.
    const text = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? unquote(raw.slice(1, -1)) : raw
    return text === '/dev/null' ? null : text.replace(/^[ab]\//, '')
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('diff --git ')) {
      finish()
      current = { from: null, to: null, patch: null }
    } else if (line.startsWith('index ') && current) {
      const m = /^index ([0-9a-f]{7,64})\.\.[0-9a-f]+/.exec(line)
      if (m && !/^0+$/.test(m[1]!)) current.oldBlob = m[1]
    } else if (/^(?:new file mode|deleted file mode|old mode|new mode) (?!100(?:644|755)$)\d+/.test(line)) {
      throw new OverlayError('symlink and submodule overlays are not supported')
    } else if (/^(rename|copy) (from|to) /.test(line) || /^similarity index /.test(line)) {
      throw new OverlayError('renames and copies are not supported: make the diff with `git diff --no-renames`')
    } else if (/^(Binary files|GIT binary patch)/.test(line)) {
      throw new OverlayError('binary changes are not supported: leave them out of the overlay')
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (current?.patch) finish()
      current ??= { from: null, to: null, patch: null }
      current.from = stripped(line.slice(4))
      current.to = stripped(lines[i + 1]!.slice(4))
      const path = current.to ?? current.from
      if (path === null) throw new OverlayError('a file header names no file')
      if (path.startsWith('/') || path.split('/').some((p) => p === '' || p === '.' || p === '..') || path.includes('\0')) throw new OverlayError('overlay paths must be repository-relative')
      if (current.from !== null && current.to !== null && current.from !== current.to) throw new OverlayError('renames are not supported: use git diff --no-renames')
      current.patch = { path, ...(current.oldBlob ? { oldBlob: current.oldBlob } : {}), status: current.from === null ? 'added' : current.to === null ? 'deleted' : 'modified', hunks: [] }
      i++
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m || !current?.patch) throw new OverlayError(`unreadable hunk header: ${line.slice(0, 60)}`)
      const hunk: Hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), lines: [] }
      let oldSeen = 0
      while (i + 1 < lines.length && (oldSeen < hunk.oldCount || /^[+\\]/.test(lines[i + 1]!)) && !lines[i + 1]!.startsWith('@@') && !lines[i + 1]!.startsWith('diff --git ')) {
        const next = lines[++i]!
        if (next === '\\ No newline at end of file') {
          const prior = hunk.lines.at(-1)?.[0]
          if (!prior) throw new OverlayError('newline marker has no preceding line')
          if (prior !== '+') hunk.oldNoNewline = true
          if (prior !== '-') hunk.newNoNewline = true
          continue
        }
        if (next[0] !== ' ' && next[0] !== '-' && next[0] !== '+' && next !== '') throw new OverlayError(`unreadable hunk line: ${next.slice(0, 60)}`)
        hunk.lines.push(next === '' ? ' ' : next)
        if (next[0] !== '+') oldSeen++
      }
      if (oldSeen !== hunk.oldCount || hunk.lines.filter((l) => l[0] !== '-').length !== hunk.newCount) throw new OverlayError('hunk line counts do not match its header')
      current.patch.hunks.push(hunk)
    }
  }
  finish()
  if (patches.length === 0) throw new OverlayError('no file changes found: pass the output of `git diff --no-renames`')
  if (new Set(patches.map((p) => p.path)).size !== patches.length) throw new OverlayError('a file appears twice in the overlay')
  if (patches.length > OVERLAY_MAX_FILES) throw new OverlayError(`the overlay changes more than ${OVERLAY_MAX_FILES} files`)
  return patches
}

/** `base` with the hunks applied; each context and removed line must equal the base line it sits on. */
export function applyHunks(path: string, base: string, hunks: readonly Hunk[]): string {
  const old = base === '' ? [] : (base.endsWith('\n') ? base.slice(0, -1) : base).split('\n')
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    if (start < at || start > old.length) throw new OverlayError(`a hunk does not apply to ${path}: the overlay is not a diff against the indexed content`)
    if (h.newCount > 0 && h.newStart !== start + out.length - at + 1) throw new OverlayError(`new hunk position does not apply to ${path}`)
    if ((h.oldNoNewline || h.newNoNewline) && start + h.oldCount !== old.length) throw new OverlayError(`newline marker is not at the end of ${path}`)
    if (h.oldCount > 0 && start + h.oldCount === old.length && Boolean(h.oldNoNewline) === base.endsWith('\n')) throw new OverlayError(`newline does not match the base of ${path}`)
    for (let k = at; k < start; k++) out.push(old[k]!)
    at = start
    for (const l of h.lines) {
      const text = l.slice(1)
      if (l[0] === '+') {
        out.push(text)
        continue
      }
      if (old[at] !== text) throw new OverlayError(`a hunk does not apply to ${path} at line ${at + 1}: the overlay is not a diff against the indexed content`)
      if (l[0] === ' ') out.push(text)
      at++
    }
  }
  for (let k = at; k < old.length; k++) out.push(old[k]!)
  const last = hunks.at(-1)
  const touchesEnd = last !== undefined && (last.oldCount === 0 ? last.oldStart : last.oldStart - 1) + last.oldCount === old.length
  const newline = touchesEnd ? !last.newNoNewline : base.endsWith('\n')
  return out.length === 0 ? '' : out.join('\n') + (newline ? '\n' : '')
}

