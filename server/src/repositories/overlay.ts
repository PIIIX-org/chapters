/**
 * The overlay of `find_symbols` (#676): the agent's uncommitted changes as a unified diff against the indexed
 * commit (`git diff --no-renames`), applied in memory to the stored content of the files it changes. Nothing here
 * writes: the overlay is one call's, never part of the shared index. A hunk is checked against the indexed content
 * line by line, so a diff made against another commit is refused, naming the file, not guessed at.
 */
import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositoryFiles } from '../db/schema.js'
import { detectLanguage } from './language.js'
import { extractStructure, isSupportedLanguage, type ExtractedSymbol } from './extraction.js'

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
      bytes.push(...Buffer.from(c))
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
  return Buffer.from(bytes).toString('utf8')
}

/** The file patches of a unified diff, by path. Renames, binary files and mode-only changes are refused or skipped. */
export function parseOverlay(diff: string): FilePatch[] {
  if (Buffer.byteLength(diff) > OVERLAY_MAX_BYTES) throw new OverlayError(`the overlay is over ${OVERLAY_MAX_BYTES / 1000} KB`)
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const patches: FilePatch[] = []
  let current: { from: string | null; to: string | null; patch: FilePatch | null; oldBlob?: string } | null = null
  const finish = () => {
    if (current?.patch) patches.push(current.patch)
    current = null
  }
  const stripped = (name: string): string | null => {
    const raw = name.split('\t')[0]!.trim()
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
      current.patch = { path, ...(current.oldBlob ? { oldBlob: current.oldBlob } : {}), status: current.from === null ? 'added' : current.to === null ? 'deleted' : 'modified', hunks: [] }
      i++
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
      if (!m || !current?.patch) throw new OverlayError(`unreadable hunk header: ${line.slice(0, 60)}`)
      const hunk: Hunk = { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), lines: [] }
      let oldSeen = 0
      while (i + 1 < lines.length && (oldSeen < hunk.oldCount || /^[+\\]/.test(lines[i + 1]!)) && !lines[i + 1]!.startsWith('@@') && !lines[i + 1]!.startsWith('diff --git ')) {
        const next = lines[++i]!
        if (next.startsWith('\\')) continue
        if (next[0] !== ' ' && next[0] !== '-' && next[0] !== '+' && next !== '') throw new OverlayError(`unreadable hunk line: ${next.slice(0, 60)}`)
        hunk.lines.push(next === '' ? ' ' : next)
        if (next[0] !== '+') oldSeen++
      }
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
  const old = base === '' ? [] : base.split('\n')
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    if (start < at || start > old.length) throw new OverlayError(`a hunk does not apply to ${path}: the overlay is not a diff against the indexed content`)
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
  return out.join('\n')
}

export interface OverlaySymbol extends ExtractedSymbol {
  path: string
  /** The symbol's first lines in the overlay's version of the file (at most 8 lines, 400 characters). */
  snippet: string
}

/**
 * The symbols of the overlay's added and modified files, computed in memory from the indexed content plus the
 * hunks (`path` order, then line), and the paths whose indexed symbols the overlay replaces (every changed file).
 * A file the extractor does not read has no symbols. `skipped`: changed files that are not in the index (nothing to
 * apply the diff to; left out, the rest is answered). `stale`: files whose stored content is not the blob the diff
 * says it was made against (git's `index` line), so the diff is against another commit; their hunks applied anyway.
 * At most `OVERLAY_MAX_PARSED` characters are parsed, edge sites are not extracted.
 */
export async function overlaySymbols(
  repositoryId: string,
  patches: readonly FilePatch[],
): Promise<{ symbols: OverlaySymbol[]; changed: Set<string>; skipped: string[]; stale: string[] }> {
  const modified = patches.filter((p) => p.status !== 'added').map((p) => p.path)
  const stored = modified.length === 0 ? [] : await db.select({ path: repositoryFiles.path, content: repositoryFiles.content }).from(repositoryFiles).where(and(eq(repositoryFiles.repositoryId, repositoryId), inArray(repositoryFiles.path, modified)))
  const contents = new Map(stored.map((f) => [f.path, f.content]))
  const symbols: OverlaySymbol[] = []
  const skipped: string[] = []
  const stale: string[] = []
  let parsed = 0
  for (const p of [...patches].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const base = p.status === 'added' ? '' : contents.get(p.path)
    if (base === undefined) {
      skipped.push(p.path)
      continue
    }
    if (p.oldBlob && p.status !== 'added' && createHash('sha1').update(`blob ${Buffer.byteLength(base)}\0`).update(base).digest('hex').slice(0, p.oldBlob.length) !== p.oldBlob.toLowerCase()) stale.push(p.path)
    if (p.status === 'deleted') continue
    const language = detectLanguage(p.path)
    if (!isSupportedLanguage(language)) continue
    const content = applyHunks(p.path, base, p.hunks)
    parsed += content.length
    if (parsed > OVERLAY_MAX_PARSED) throw new OverlayError(`the files the overlay changes are over ${OVERLAY_MAX_PARSED / (1024 * 1024)} MiB of source to read: leave some out`)
    const lines = content.split('\n')
    const { symbols: found } = await extractStructure(language, content, p.path, { edges: false })
    for (const s of found) symbols.push({ ...s, path: p.path, snippet: [...lines.slice(s.startLine - 1, Math.min(s.endLine, s.startLine + 7)).join('\n')].slice(0, 400).join('') })
  }
  return { symbols, changed: new Set(patches.map((p) => p.path)), skipped, stale }
}
