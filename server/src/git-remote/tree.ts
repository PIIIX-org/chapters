import { TextDecoder } from 'node:util'
import { parseNote, validateNote, withType, type OkfNote } from '../notes/okf.js'
import { resolveNotePath } from '../notes/okf/paths.js'
import { assertBodyFits, assertFrontmatterFits } from '../notes/size-cap.js'
import { isSafeAssetName } from '../notes/store.js'
import { boundedGit, GitPushError, PACK_LIMITS } from './pack.js'

/** Hidden attachment namespace shared with physical storage; HTTP attachment paths remain assets/. */
export const ASSET_PREFIX = '.assets/'

/** Bijective Git-only encoding; store/HTTP filename validation remains a separate boundary. */
export function assetGitPath(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0-\x1f\x7f]/.test(name)) throw new GitPushError('unsupported asset filename')
  let encoded = ''
  try {
    for (const character of name) {
      if (/^[a-z0-9._-]$/.test(character)) encoded += character
      else if (character.charCodeAt(0) < 128) encoded += `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      else encoded += encodeURIComponent(character)
    }
  } catch { throw new GitPushError('asset filename must be UTF-8') }
  if (encoded.startsWith('.') || (!encoded.startsWith('%') && /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))) {
    encoded = `%${name.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}${encoded.slice(1)}`
  }
  if (encoded.endsWith('.')) encoded = `${encoded.slice(0, -1)}%2E`
  if (encoded.length <= 255) return `${ASSET_PREFIX}${encoded}`
  // `%00` cannot encode a valid filename. Framing avoids both basename
  // overflow after escaping and file/directory prefix collisions.
  const chunks: string[] = []
  let start = 0
  for (let at = 0; at < encoded.length;) {
    const width = encoded[at] === '%' ? 3 : 1
    if (at - start + width > 200) {
      chunks.push(`x${encoded.slice(start, at)}x`)
      start = at
    }
    at += width
  }
  chunks.push(`x${encoded.slice(start)}x`)
  return `${ASSET_PREFIX}%00/${chunks.join('/')}/%00`
}

export function assetNameFromGitPath(path: string): string {
  let encoded = path.slice(ASSET_PREFIX.length)
  if (encoded.startsWith('%00/')) {
    const parts = encoded.split('/')
    if (parts.at(-1) !== '%00' || parts.length < 3) throw new GitPushError('unsupported asset framing')
    const chunks = parts.slice(1, -1)
    if (chunks.some(part => !part.startsWith('x') || !part.endsWith('x') || part.length > 202)) throw new GitPushError('unsupported asset framing')
    encoded = chunks.map(part => part.slice(1, -1)).join('')
  }
  let name: string
  try { name = decodeURIComponent(encoded) } catch { throw new GitPushError('unsupported asset encoding') }
  if (!path.startsWith(ASSET_PREFIX) || assetGitPath(name) !== path) throw new GitPushError('unsupported noncanonical asset path')
  return name
}

export interface NoteBase { id: string; rev: number; blob: string }
export interface Manifest {
  notes: Record<string, NoteBase>
  assets: Record<string, string>
  /** Server-only export journal: rebuild the same child after losing its quarantine. */
  prepared?: { parent: string; when: number }
}
export interface TreeFile { oid: string; data: Buffer; note?: OkfNote }
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** No checkout, filesystem paths from Git, submodules, executable files, symlinks, hidden files or configuration. */
export async function validatedTree(dir: string, commit: string, deadline = performance.now() + PACK_LIMITS.milliseconds): Promise<Map<string, TreeFile>> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new GitPushError('invalid commit id')
  if ((await boundedGit(['cat-file', '-t', commit], dir)).toString().trim() !== 'commit') throw new GitPushError('the new ref must name a commit')
  const listing = await boundedGit(['ls-tree', '-r', '-z', '--full-tree', commit], dir, undefined, 1024 * 1024)
  const files = new Map<string, TreeFile>()
  const assetNames = new Set<string>()
  let bytes = 0
  let paths: string
  try { paths = utf8.decode(listing) } catch { throw new GitPushError('Git paths must be UTF-8') }
  for (const raw of paths.split('\0')) {
    if (!raw) continue
    if (performance.now() > deadline) throw new GitPushError('tree validation time limit exceeded')
    if (files.size >= PACK_LIMITS.objects) throw new GitPushError('too many files')
    const entry = /^100644 blob ([0-9a-f]{40})\t([^\0]+)$/.exec(raw)
    if (!entry) throw new GitPushError('only regular non-executable files are supported')
    const oid = entry[1]!
    const path = entry[2]!
    if (Buffer.byteLength(path) > 1024) throw new GitPushError('Git paths are limited to 1024 UTF-8 bytes')
    const asset = path.startsWith(ASSET_PREFIX)
    if (asset) {
      const name = assetNameFromGitPath(path)
      if (!isSafeAssetName(name) || assetNames.has(name)) throw new GitPushError('unsupported or duplicate decoded asset path')
      assetNames.add(name)
    } else {
      if (!path.endsWith('.md') || resolveNotePath(path.slice(0, -3)).fullPath + '.md' !== path) throw new GitPushError('only canonical note paths and assets are supported')
    }
    const size = Number((await boundedGit(['cat-file', '-s', oid], dir)).toString().trim())
    if (!Number.isSafeInteger(size) || size < 0 || size > PACK_LIMITS.object || bytes + size > PACK_LIMITS.expanded) throw new GitPushError('proposed tree exceeds size limit')
    const data = await boundedGit(['cat-file', 'blob', oid], dir, undefined, PACK_LIMITS.object)
    bytes += data.length
    let note: OkfNote | undefined
    if (!asset) {
      let text: string
      try { text = utf8.decode(data) } catch { throw new GitPushError('notes must be UTF-8') }
      if (text.includes('\0')) throw new GitPushError('notes cannot contain NUL bytes')
      // Require a real frontmatter fence. The shared parser otherwise treats a plain file as body-only.
      if (!/^---\r?\n/.test(text)) throw new GitPushError('notes need YAML frontmatter')
      note = parseNote(text)
      const resolved = resolveNotePath(path.slice(0, -3))
      note.frontmatter = withType(note.frontmatter, resolved.type)
      validateNote(resolved.type, resolved.name, note.frontmatter, note.body)
      assertBodyFits(note.body)
      assertFrontmatterFits(note.frontmatter)
    }
    files.set(path, { oid, data, note })
  }
  return files
}
