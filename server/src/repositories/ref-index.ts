import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { repositories, repositoryFiles } from '../db/schema.js'
import { config } from '../config.js'
import { resolveRepositoryAccess, isSafeGitUrl } from './permissions.js'
import { authenticatedUrl } from './git-remote.js'
import { decryptCredential } from './credentials.js'
import { openQueryMirror, markMirrorSynced, scanMirrorTree, withMirrorLock, objectFormatOf, MirrorReadLimitError, type TreeEntry } from './git-mirror.js'
import { EXTRACTOR_VERSION, extractStructure, isSupportedLanguage, type ExtractionResult } from './extraction.js'
import { parsed } from './blob-cache.js'
import { codeBlocks, type CodeBlock } from './code-blocks.js'
import { outlineSections } from './outline.js'
import { detectLanguage } from './language.js'
import { applyHunks, parseOverlay, OverlayError, OVERLAY_MAX_PARSED } from './overlay.js'
import { summarizeSkips, type SkippedFile } from './fs-scan.js'

// A view is never installed in repository_files/blocks. Cache only committed, immutable trees;
// an overlay and its parse results belong to the call, not to the tree or another session.
export const REF_LIMITS = { files: 20_000, bytes: 32 * 1024 * 1024, cachedBytes: 64 * 1024 * 1024, trees: 8 }
export class RefError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'BUSY', message: string, readonly field = 'ref') { super(message) }
}
export interface ViewFile {
  id: string
  path: string
  content: string
  contentHash: string
  language: string | null
  size: number
  structure: ExtractionResult
  blocks: CodeBlock[]
}
export interface RepositoryView {
  repositoryId: string
  source: string
  commit?: string
  tree: string
  overlay?: string
  files: ReadonlyMap<string, ViewFile>
  entries?: ReadonlyMap<string, TreeEntry>
  skipped: SkippedFile[]
  bytes: number
}
const cache = new Map<string, RepositoryView>()
export const refCacheStats = { built: 0, reused: 0, blobsRead: 0, overlayParses: 0 }
export function clearRefCache(): void {
  cache.clear()
  for (const key of Object.keys(refCacheStats) as Array<keyof typeof refCacheStats>) refCacheStats[key] = 0
}
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex')
/** Stable UUID-shaped identities for content-scoped files and symbols, never shared-index row ids. */
export function viewId(text: string): string {
  const bytes = createHash('sha256').update(text).digest()
  bytes[6] = (bytes[6]! & 15) | 80
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytes.toString('hex', 0, 16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function sourceIdentity(repo: typeof repositories.$inferSelect): string {
  return contentHash(`${repo.ownerId}\0${repo.createdAt.toISOString()}\0${repo.ingestionMethod}\0${repo.gitUrl ?? ''}\0${repo.localPath ?? ''}`)
}

/** A purge/recreation, source replacement or permission change during slow work cannot publish held bytes. */
export async function requireViewAccess(userId: string, view: RepositoryView): Promise<void> {
  if (!await resolveRepositoryAccess(userId, view.repositoryId)) throw new RefError('NOT_FOUND', 'not found')
  const [current] = await db.select().from(repositories).where(eq(repositories.id, view.repositoryId))
  if (!current || sourceIdentity(current) !== view.source) throw new RefError('NOT_FOUND', 'repository source changed; request the view again')
}

export function viewVersion(view: RepositoryView): Record<string, unknown> {
  const skipped = summarizeSkips(view.skipped)
  return { source: view.source, ...(view.commit ? { commit: view.commit } : {}), tree: view.tree, ...(view.overlay ? { overlay: true, overlay_hash: view.overlay } : {}), ...(view.skipped.length ? { skipped: { binary: skipped.binary, too_large: skipped.too_large, ignored: skipped.ignored, over_file_cap: skipped.over_file_cap } } : {}) }
}
export function checkGitRef(ref: string): void {
  // Ref names and full object ids only, never rev expressions, options, refspecs or paths.
  if (ref.length > 240 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new RefError('INVALID_ARGUMENT', 'ref must be a branch, tag, HEAD or full commit SHA')
  }
}
async function fileIndex(repositoryId: string, path: string, content: string, overlay: boolean): Promise<ViewFile> {
  const hash = contentHash(content)
  // Id includes bytes, never a shared-index row id. It is stable for the same source and content.
  const id = viewId(`${repositoryId}\0${path}\0${hash}`)
  const language = detectLanguage(path)
  const structure = isSupportedLanguage(language)
    ? overlay ? await extractStructure(language, content, path) : await parsed(language, content, path, hash)
    : { symbols: [], imports: [], sites: [] }
  if (overlay && isSupportedLanguage(language)) refCacheStats.overlayParses++
  return { id, path, content, contentHash: hash, language, size: Buffer.byteLength(content), structure, blocks: codeBlocks(id, path, content, structure.symbols, outlineSections(language, content)) }
}
async function buildView(repositoryId: string, source: string, tree: string, files: Array<{ path: string; content: string }>, skipped: RepositoryView['skipped'], commit?: string, entries?: readonly TreeEntry[]): Promise<RepositoryView> {
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)
  if (files.length > REF_LIMITS.files || bytes > REF_LIMITS.bytes || skipped.some((s) => s.reason === 'over_file_cap')) {
    throw new RefError('BUSY', `ref exceeds the bounded index (${REF_LIMITS.files} files, ${REF_LIMITS.bytes / 1024 / 1024} MiB); no partial index was served`)
  }
  const indexed = new Map<string, ViewFile>()
  for (const f of files) indexed.set(f.path, await fileIndex(repositoryId, f.path, f.content, false))
  // Charge metadata, parse records, block text and room for 384-dimensional JS vectors, not just source bytes.
  const weight = bytes + (entries?.reduce((sum, e) => sum + Buffer.byteLength(e.path) + 128, 0) ?? 0)
    + [...indexed.values()].reduce((sum, f) => sum + f.structure.sites.length * 256 + f.structure.symbols.length * 128 + f.blocks.reduce((n, b) => n + Buffer.byteLength(b.embedText) + Buffer.byteLength(b.snippet ?? '') + 4096, 0), 0)
  refCacheStats.built++
  return { repositoryId, source, tree, ...(commit ? { commit } : {}), files: indexed, skipped, bytes: weight, ...(entries ? { entries: new Map(entries.map((e) => [e.path, e])) } : {}) }
}
function remember(key: string, view: RepositoryView): void {
  cache.set(key, view)
  let bytes = [...cache.values()].reduce((sum, v) => sum + v.bytes, 0)
  while (cache.size > REF_LIMITS.trees || bytes > REF_LIMITS.cachedBytes) {
    const first = cache.keys().next().value!
    bytes -= cache.get(first)!.bytes
    cache.delete(first)
  }
}
async function treeView(repositoryId: string, source: string, dir: string, commit: string): Promise<RepositoryView> {
  const tree = (await simpleGit(dir).env('GIT_NO_REPLACE_OBJECTS', '1').raw(['rev-parse', '--verify', `${commit}^{tree}`])).trim()
  const key = `${EXTRACTOR_VERSION}:${repositoryId}:${source}:${tree}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    refCacheStats.reused++
    // Two commits may have identical trees. Never return the first commit's identity.
    return { ...hit, commit }
  }
  const scan = await scanMirrorTree(dir, commit, null, new Set(), REF_LIMITS.files, REF_LIMITS.bytes)
  refCacheStats.blobsRead += scan.blobsRead
  const view = await buildView(repositoryId, source, tree, scan.files, scan.skipped, commit, scan.entries)
  remember(key, view)
  return view
}
async function overlayView(base: RepositoryView, diff: string): Promise<RepositoryView> {
  const files = new Map(base.files)
  const entries = base.entries ? new Map(base.entries) : undefined
  let bytes = 0
  for (const patch of parseOverlay(diff)) {
    if (patch.path.startsWith('/') || patch.path.split('/').some((p) => p === '..' || p === '.' || p === '') || patch.path.includes('\0')) throw new OverlayError('overlay paths must be repository-relative')
    const old = files.get(patch.path)
    if (patch.status === 'added' ? old !== undefined || base.entries?.has(patch.path) : old === undefined) throw new OverlayError(`overlay base does not match ${patch.path}`)
    const content = old?.content ?? ''
    if (patch.oldBlob) {
      const algorithm = base.commit?.length === 64 ? 'sha256' : 'sha1'
      const blob = createHash(algorithm).update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex')
      if (!blob.startsWith(patch.oldBlob)) throw new OverlayError(`stale overlay base for ${patch.path}`)
    }
    const changed = applyHunks(patch.path, content, patch.hunks)
    bytes += Math.max(Buffer.byteLength(content), Buffer.byteLength(changed))
    if (bytes > OVERLAY_MAX_PARSED) throw new OverlayError('overlay files are over 2 MiB of source to read')
    if (patch.status === 'deleted') {
      if (changed !== '') throw new OverlayError(`deletion does not remove all of ${patch.path}`)
      files.delete(patch.path)
      entries?.delete(patch.path)
    } else {
      files.set(patch.path, await fileIndex(base.repositoryId, patch.path, changed, true))
      const algorithm = base.commit?.length === 64 ? 'sha256' : 'sha1'
      const size = Buffer.byteLength(changed)
      if (entries) entries.set(patch.path, { path: patch.path, type: 'blob', mode: entries.get(patch.path)?.mode ?? '100644', size, sha: createHash(algorithm).update(`blob ${size}\0`).update(changed).digest('hex') })
    }
  }
  return { ...base, files, ...(entries ? { entries } : {}), overlay: contentHash(diff) }
}

/** Live authorization precedes every lookup, including warm trees and cursor continuations. */
export async function repositoryViewAt(userId: string, repositoryId: string, args: { ref?: string; overlay?: string }): Promise<RepositoryView> {
  if (!await resolveRepositoryAccess(userId, repositoryId)) throw new RefError('NOT_FOUND', 'not found')
  if (args.ref !== undefined) checkGitRef(args.ref)
  const view = await withMirrorLock(repositoryId, async () => {
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId))
    if (!repo) throw new RefError('NOT_FOUND', 'not found')
    let base: RepositoryView
    if (repo.ingestionMethod === 'git' && repo.gitUrl) {
      if (!isSafeGitUrl(repo.gitUrl)) throw new RefError('INVALID_ARGUMENT', 'repository has no permitted Git source')
      const url = authenticatedUrl(repo.gitUrl, repo.gitCredentialEncrypted ? decryptCredential(repo.gitCredentialEncrypted) : null)
      const ref = args.ref ?? repo.lastSyncedCommit
      if (!ref) throw new RefError('NOT_FOUND', 'no indexed base commit; sync the repository first')
      // Never reveal URLs or credentials in source keys or command errors.
      const source = sourceIdentity(repo)
      const git = simpleGit({ timeout: { block: 30_000 } })
      let commit = ref
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref)) {
        const out = await git.listRemote([url, ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`])
        const rows = out.trim().split('\n').map((line) => line.split('\t')).filter((r) => /^[a-f0-9]{40,64}$/.test(r[0] ?? ''))
        const peeled = rows.find((r) => r[1] === `${ref}^{}` || r[1] === `refs/tags/${ref}^{}`)
        const values = new Set((peeled ? [peeled] : rows).map((r) => r[0]!))
        if (values.size !== 1) throw new RefError('INVALID_ARGUMENT', values.size ? 'ambiguous ref; use refs/heads/ or refs/tags/' : 'ref is not advertised by this repository')
        commit = [...values][0]!
      }
      const dir = await openQueryMirror(repositoryId, source, objectFormatOf(commit))
      try {
        await simpleGit(dir).raw(['cat-file', '-e', `${commit}^{commit}`])
      } catch {
        await simpleGit(dir, { timeout: { block: 60_000 } }).raw(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-write-fetch-head', url, `+${commit}:refs/elara/query`])
      }
      commit = (await simpleGit(dir).raw(['rev-parse', '--verify', `${commit}^{commit}`])).trim()
      base = await treeView(repositoryId, source, dir, commit)
      await markMirrorSynced(dir, commit)
    } else if (repo.ingestionMethod === 'local_path' && repo.localPath && args.ref !== undefined) {
      // Only the registered source under LOCAL_REPOS_ROOT, never a caller-supplied directory.
      const root = await realpath(config.localReposRoot)
      const dir = await realpath(resolve(root, repo.localPath))
      if (dir !== root && !dir.startsWith(root + sep)) throw new RefError('INVALID_ARGUMENT', 'registered repository is outside the local repos root')
      const git = simpleGit(dir, { timeout: { block: 30_000 } }).env('GIT_NO_REPLACE_OBJECTS', '1')
      // Do not discover a parent repository outside the registered source.
      if (await realpath((await git.raw(['rev-parse', '--show-toplevel'])).trim()) !== dir) throw new RefError('INVALID_ARGUMENT', 'registered folder is not a Git work tree root')
      const common = await realpath(resolve(dir, (await git.raw(['rev-parse', '--git-common-dir'])).trim()))
      const objects = await realpath(resolve(common, 'objects'))
      if (![common, objects].every((p) => p === root || p.startsWith(root + sep))) throw new RefError('INVALID_ARGUMENT', 'local Git metadata must stay inside the configured repos root')
      try {
        if ((await readFile(resolve(objects, 'info/alternates'), 'utf8')).trim()) throw new RefError('INVALID_ARGUMENT', 'local Git object alternates are not supported for ref reads')
      } catch (err) {
        if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')) throw err
      }
      const commit = (await git.raw(['rev-parse', '--verify', '--end-of-options', `${args.ref}^{commit}`])).trim()
      base = await treeView(repositoryId, sourceIdentity(repo), dir, commit)
    } else {
      if (args.ref !== undefined) throw new RefError('INVALID_ARGUMENT', 'this ingestion source has no Git refs; use the indexed tree without ref')
      const files = await db.select({ path: repositoryFiles.path, content: repositoryFiles.content }).from(repositoryFiles).where(eq(repositoryFiles.repositoryId, repositoryId)).limit(REF_LIMITS.files + 1)
      files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      if (args.overlay !== undefined) {
        const paths = new Set(parseOverlay(args.overlay).map((p) => p.path))
        if (files.reduce((sum, f) => sum + (paths.has(f.path) ? Buffer.byteLength(f.content) : 0), 0) > OVERLAY_MAX_PARSED) throw new OverlayError('overlay files are over 2 MiB of source to read')
      }
      // Indexed pushes/folders do not prove a Git commit. Name the exact content tree instead.
      const tree = contentHash(files.map((f) => `${f.path}\0${contentHash(f.content)}`).join('\n'))
      base = await buildView(repositoryId, sourceIdentity(repo), tree, files, [])
    }
    return args.overlay === undefined ? base : overlayView(base, args.overlay)
  }).catch((err: unknown) => {
    if (err instanceof MirrorReadLimitError) throw new RefError('BUSY', err.message)
    if (err instanceof RefError) throw err
    if (err instanceof OverlayError) throw new RefError('INVALID_ARGUMENT', err.message, 'overlay')
    // Git messages can contain both authenticated URLs and local server paths.
    throw new RefError('NOT_FOUND', 'requested Git source or commit is unavailable')
  })
  await requireViewAccess(userId, view)
  return view
}
