import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { repositories } from '../db/schema.js'
import { BINARY_EXTENSIONS, GIT_METADATA, MAX_FILE_BYTES, MAX_INDEXED_FILES, type RepositoryScan, type SkippedFile } from './fs-scan.js'

/**
 * Persistent git mirrors (#684): one bare, shallow repository per git
 * repository at `DATA_DIR/git-mirrors/<repositoryId>.git`. A sync fetches
 * the remote's default branch into it at depth 1, so a change costs the
 * objects that are new since the last fetch instead of a whole clone (#542:
 * the rea upstream, 71 MB every 5 minutes), and reads only the blobs whose
 * SHA differs from the last synced commit's tree.
 *
 * The remote URL (with its credential) is passed on each command and never
 * written to the mirror: no `origin`, no FETCH_HEAD.
 *
 * Disk stays bounded by the indexed tree plus at most `gc.autoPackLimit`
 * fetches' worth of superseded objects: only `refs/elara/head` (the last
 * fetch) and `refs/elara/synced` (the last indexed commit) are kept, each
 * fetch is stored as one pack, and `git gc --auto` after each changed sync
 * folds the packs and drops unreachable objects and stale shallow roots
 * (`gc.pruneExpire=now`) once there are more than 4. Repository delete
 * removes the mirror; the boot sweep removes any left behind (a vault or
 * user delete cascading rows, a crash).
 */

const HEAD_REF = 'refs/elara/head'
const SYNCED_REF = 'refs/elara/synced'

const MIRROR_CONFIG: ReadonlyArray<[string, string]> = [
  // One pack per fetch, so gc --auto counts fetches, not loose objects.
  ['fetch.unpackLimit', '1'],
  ['gc.autoPackLimit', '4'],
  ['gc.pruneExpire', 'now'],
  // In the foreground: a detached gc would race the next fetch.
  ['gc.autoDetach', 'false'],
]

export function gitMirrorsRoot(): string {
  return join(config.dataDir, 'git-mirrors')
}

export function gitMirrorDir(repositoryId: string): string {
  return join(gitMirrorsRoot(), `${repositoryId}.git`)
}

const locks = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` with the repository's mirror to itself in this process: a poll
 * and a webhook delivery never fetch into one mirror at once (git would
 * fail the second on `shallow.lock`), and a delete removes the mirror only
 * after a running sync is done with it.
 */
export async function withMirrorLock<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(repositoryId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(repositoryId, settled)
  try {
    return await run
  } finally {
    if (locks.get(repositoryId) === settled) locks.delete(repositoryId)
  }
}

/** Removes a repository's mirror, after any sync still using it. */
export async function removeGitMirror(repositoryId: string): Promise<void> {
  await withMirrorLock(repositoryId, () => rm(gitMirrorDir(repositoryId), { recursive: true, force: true }))
}

/**
 * Boot pass: removes every mirror whose repository is gone or no longer a
 * git repository. Runs before the server listens, so no sync is using one.
 * Returns how many it removed.
 */
export async function sweepGitMirrors(): Promise<number> {
  if (!existsSync(gitMirrorsRoot())) return 0
  const rows = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.ingestionMethod, 'git'))
  const keep = new Set(rows.map((r) => `${r.id}.git`))
  let removed = 0
  for (const name of await readdir(gitMirrorsRoot())) {
    if (keep.has(name)) continue
    await rm(join(gitMirrorsRoot(), name), { recursive: true, force: true })
    removed++
  }
  return removed
}

/** The mirror's directory, created (or re-created when it is not a usable bare repository). */
export async function openMirror(repositoryId: string): Promise<string> {
  const dir = gitMirrorDir(repositoryId)
  if (existsSync(dir)) {
    try {
      if ((await simpleGit(dir).raw(['rev-parse', '--is-bare-repository'])).trim() === 'true') return dir
    } catch {
      // Not a repository (an interrupted init): start it again.
    }
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(gitMirrorsRoot(), { recursive: true })
  await simpleGit().raw(['init', '--bare', '--quiet', dir])
  for (const [key, value] of MIRROR_CONFIG) await simpleGit(dir).raw(['config', key, value])
  return dir
}

/** The remote's default branch (null when the server does not advertise HEAD as a symref) and its commit. */
export interface RemoteHead {
  branch: string | null
  commit: string
}

/** The remote's HEAD, from one `ls-remote --symref`; null when it advertises none (an empty repository). */
export async function remoteHead(url: string): Promise<RemoteHead | null> {
  const out = await simpleGit({ timeout: { block: 30_000 } }).listRemote(['--symref', url, 'HEAD'])
  let branch: string | null = null
  let commit: string | null = null
  for (const line of out.split('\n')) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line)
    if (symref) branch = symref[1]!
    const head = /^([0-9a-f]{40,64})\tHEAD$/.exec(line)
    if (head) commit = head[1]!
  }
  return commit ? { branch, commit } : null
}

/**
 * Fetches the tip of `branch` (the remote's HEAD when null) at depth 1 and
 * returns its commit. Only objects the mirror lacks cross the wire: a
 * one-file commit is a handful of objects; a force-push or a branch switch
 * fetches what the new tip has that the mirror does not.
 */
export async function fetchIntoMirror(dir: string, url: string, branch: string | null): Promise<string> {
  const source = branch ? `refs/heads/${branch}` : 'HEAD'
  await simpleGit(dir, { timeout: { block: 300_000 } }).raw([
    'fetch',
    '--quiet',
    '--depth',
    '1',
    '--no-tags',
    '--no-write-fetch-head',
    url,
    `+${source}:${HEAD_REF}`,
  ])
  return (await simpleGit(dir).raw(['rev-parse', '--verify', `${HEAD_REF}^{commit}`])).trim()
}

/** Whether the mirror holds `commit` (with its tree): a diff base for the next sync. */
export async function mirrorHasCommit(dir: string, commit: string): Promise<boolean> {
  try {
    await simpleGit(dir).raw(['cat-file', '-e', `${commit}^{tree}`])
    return true
  } catch {
    return false
  }
}

/** Records `commit` as indexed (the next sync's diff base) and lets gc fold old fetches. */
export async function markMirrorSynced(dir: string, commit: string): Promise<void> {
  await simpleGit(dir).raw(['update-ref', SYNCED_REF, commit])
  await simpleGit(dir).raw(['gc', '--auto', '--quiet'])
}

interface TreeEntry {
  mode: string
  type: string
  sha: string
  /** Null for a submodule (a commit entry). */
  size: number | null
  path: string
}

async function listTree(dir: string, commit: string): Promise<TreeEntry[]> {
  const out = await simpleGit(dir).raw(['ls-tree', '-r', '-l', '-z', '--full-tree', commit])
  const entries: TreeEntry[] = []
  for (const record of out.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]+)$/.exec(record)
    if (!m) continue
    entries.push({ mode: m[1]!, type: m[2]!, sha: m[3]!, size: m[4] === '-' ? null : Number(m[4]), path: m[5]! })
  }
  return entries
}

/** The contents of `shas`, through one `git cat-file --batch`. */
function readBlobs(dir: string, shas: string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>()
  if (shas.length === 0) return Promise.resolve(blobs)
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file --batch exited with ${code}: ${stderr.trim()}`))
      const out = Buffer.concat(chunks)
      let at = 0
      while (at < out.length) {
        const eol = out.indexOf(0x0a, at)
        if (eol < 0) break
        const [sha, type, size] = out.subarray(at, eol).toString().split(' ')
        at = eol + 1
        if (type === 'missing' || size === undefined) continue
        const length = Number(size)
        blobs.set(sha!, out.subarray(at, at + length))
        at += length + 1
      }
      resolve(blobs)
    })
    child.stdin.end(`${shas.join('\n')}\n`)
  })
}

/**
 * The scan of `commit`'s tree, with the rules of a clone's scan (fs-scan.ts
 * `scanRepository` with no ignore rules, #465): `.git`, symlinks and
 * submodules left out unreported; binary extensions, files over
 * MAX_FILE_BYTES (from the tree, unread), files with a NUL byte, and files
 * past `maxFiles` (in tree order) reported and left out of `currentPaths`.
 *
 * `files` holds only what has to be read: a path whose blob differs from
 * `previous`'s tree (the last synced commit) or that has no row in
 * `indexedPaths`. Without `previous` every file is read and the store's
 * content-hash skip keeps the unchanged ones from extraction.
 */
export async function scanMirrorTree(
  dir: string,
  commit: string,
  previous: string | null,
  indexedPaths: ReadonlySet<string>,
  maxFiles = MAX_INDEXED_FILES,
): Promise<RepositoryScan & { read: number }> {
  const before = previous ? new Map((await listTree(dir, previous)).map((e) => [e.path, e.sha])) : null
  const listed: TreeEntry[] = []
  const skipped: SkippedFile[] = []
  for (const entry of await listTree(dir, commit)) {
    // A clone checks a symlink out as a link and a submodule as an empty directory: the scan reads neither.
    if (entry.type !== 'blob' || entry.mode === '120000' || GIT_METADATA.test(entry.path)) continue
    if (BINARY_EXTENSIONS.test(entry.path)) skipped.push({ path: entry.path, reason: 'binary' })
    else listed.push(entry)
  }
  const inCap = listed.slice(0, maxFiles)
  const toRead = inCap.filter(
    (e) => e.size! <= MAX_FILE_BYTES && !(before?.get(e.path) === e.sha && indexedPaths.has(e.path)),
  )
  const blobs = await readBlobs(dir, [...new Set(toRead.map((e) => e.sha))])
  const readPaths = new Set(toRead.map((e) => e.path))
  const scan: RepositoryScan & { read: number } = { files: [], currentPaths: [], skipped, read: toRead.length }
  for (const entry of inCap) {
    if (entry.size! > MAX_FILE_BYTES) {
      skipped.push({ path: entry.path, reason: 'too_large' })
      continue
    }
    if (readPaths.has(entry.path)) {
      const bytes = blobs.get(entry.sha)
      if (!bytes) throw new Error(`git mirror is missing blob ${entry.sha} (${entry.path})`)
      // Only a 0x00 byte decodes to U+0000 in UTF-8, so a binary is never decoded.
      if (bytes.includes(0)) {
        skipped.push({ path: entry.path, reason: 'binary' })
        continue
      }
      scan.files.push({ path: entry.path, content: bytes.toString('utf8') })
    }
    scan.currentPaths.push(entry.path)
  }
  for (const entry of listed.slice(maxFiles)) skipped.push({ path: entry.path, reason: 'over_file_cap' })
  return scan
}
