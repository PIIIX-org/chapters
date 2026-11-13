import { TextDecoder } from 'node:util'
import { parseNote, validateNote, withType, type OkfNote } from '../notes/okf.js'
import { resolveNotePath } from '../notes/okf/paths.js'
import { assertBodyFits, assertFrontmatterFits } from '../notes/size-cap.js'
import { isSafeAssetName } from '../notes/store.js'
import { boundedGit, GitPushError, PACK_LIMITS } from './pack.js'

export interface NoteBase { id: string; rev: number; blob: string }
export interface Manifest { notes: Record<string, NoteBase>; assets: Record<string, string> }
export interface TreeFile { oid: string; data: Buffer; note?: OkfNote }
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** No checkout, filesystem paths from Git, submodules, executable files, symlinks, hidden files or configuration. */
export async function validatedTree(dir: string, commit: string, deadline = performance.now() + PACK_LIMITS.milliseconds): Promise<Map<string, TreeFile>> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new GitPushError('invalid commit id')
  if ((await boundedGit(['cat-file', '-t', commit], dir)).toString().trim() !== 'commit') throw new GitPushError('the new ref must name a commit')
  const listing = await boundedGit(['ls-tree', '-r', '-z', '--full-tree', commit], dir, undefined, 1024 * 1024)
  const files = new Map<string, TreeFile>()
  let bytes = 0
  for (const raw of listing.toString('utf8').split('\0')) {
    if (!raw) continue
    if (performance.now() > deadline) throw new GitPushError('tree validation time limit exceeded')
    if (files.size >= PACK_LIMITS.objects) throw new GitPushError('too many files')
    const entry = /^100644 blob ([0-9a-f]{40})\t([^\0]+)$/.exec(raw)
    if (!entry) throw new GitPushError('only regular non-executable files are supported')
    const oid = entry[1]!
    const path = entry[2]!
    const asset = path.startsWith('assets/')
    if (asset) {
      const name = path.slice(7)
      if (!isSafeAssetName(name) || name.startsWith('.')) throw new GitPushError('unsupported asset path')
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
