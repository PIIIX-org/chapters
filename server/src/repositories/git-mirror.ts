import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
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

/** A repository's hash algorithm, as `git init --object-format` names it. */
export type ObjectFormat = 'sha1' | 'sha256'

/** The object format of a commit id: 64 hex digits are SHA-256, 40 are SHA-1. */
export function objectFormatOf(commit: string): ObjectFormat {
  return commit.length === 64 ? 'sha256' : 'sha1'
}

/**
 * The mirror's directory, created (or re-created when it is not a usable
 * bare repository). A fetch between repositories of different hash
 * algorithms fails (`mismatched algorithms`), so a mirror is created in
 * `format`, the remote's, and re-created when the remote's changes; with
 * `format` null (the remote's is unknown: `ls-remote` failed) an existing
 * mirror is kept as it is and a new one is SHA-1, git's default.
 */
export async function openMirror(repositoryId: string, format: ObjectFormat | null): Promise<string> {
  const dir = gitMirrorDir(repositoryId)
  if (existsSync(dir)) {
    try {
      const git = simpleGit(dir)
      if ((await git.raw(['rev-parse', '--is-bare-repository'])).trim() === 'true') {
        const current = (await git.raw(['rev-parse', '--show-object-format'])).trim()
        if (format === null || current === format) return dir
      }
    } catch {
      // Not a repository (an interrupted init): start it again.
    }
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(gitMirrorsRoot(), { recursive: true })
  await simpleGit().raw(['init', '--bare', '--quiet', `--object-format=${format ?? 'sha1'}`, dir])
  for (const [key, value] of MIRROR_CONFIG) await simpleGit(dir).raw(['config', key, value])
  return dir
}

/** A separate object store inside the owned mirror: a replaced source must never borrow the old source's objects. */
export async function openQueryMirror(repositoryId: string, source: string, format: ObjectFormat): Promise<string> {
  const parent = await openMirror(repositoryId, null)
  const dir = join(parent, 'elara-query.git')
  if (existsSync(dir)) {
    try {
      const git = simpleGit(dir)
      if ((await git.raw(['config', '--get', 'elara.source'])).trim() === source && (await git.raw(['rev-parse', '--show-object-format'])).trim() === format) return dir
    } catch {
      // Incomplete initialization is not evidence of the configured source.
    }
    await rm(dir, { recursive: true, force: true })
  }
  await simpleGit().raw(['init', '--bare', '--quiet', `--object-format=${format}`, dir])
  for (const [key, value] of MIRROR_CONFIG) await simpleGit(dir).raw(['config', key, value])
  await simpleGit(dir).raw(['config', 'elara.source', source])
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

/**
 * What a reader-chosen ref may cost the query mirror (ref-index.ts), as a best-effort cap and not a hard quota.
 * `fetchBytes`: a fetch is watched while git runs and killed once the mirror has grown by this much; the overshoot is bounded
 * by the poll interval times the link's bandwidth (about 12 MiB per 100 ms at 1 Gbit/s, 119 MiB at 10 Gbit/s) and by event-loop
 * stalls. Where the platform has a shell `ulimit -f` (Linux, macOS) the fetch also runs under it, so the pack file itself cannot
 * grow past `fetchBytes` (twice that in shells that count 1,024-byte blocks): that part is a hard limit.
 * `mirrorBytes`: the most a repository's query mirror may hold before it is discarded and started again, checked per request.
 * The query mirror is a cache of reader-chosen commits: dropping it loses nothing but time.
 */
export const QUERY_MIRROR_LIMITS = { fetchBytes: 256 * 1024 * 1024, mirrorBytes: 1024 * 1024 * 1024, timeoutMs: 120_000, pollMs: 100 }
/** The most bytes of a remote's `ls-remote` answer a ref lookup reads. */
export const LS_REMOTE_MAX_BYTES = 8 * 1024 * 1024

/** Bytes of regular files under `dir` (links not followed); a vanishing file counts as 0. */
export async function mirrorBytes(dir: string): Promise<number> {
  let total = 0
  const walk = async (path: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      const child = join(path, name)
      try {
        const info = await lstat(child)
        if (info.isDirectory()) await walk(child)
        else if (info.isFile()) total += info.size
      } catch {
        // Removed while counting.
      }
    }
  }
  await walk(dir)
  return total
}

/** Removes a query mirror whose content was rejected or outgrew its quota; `openQueryMirror` starts it again. */
export async function discardQueryMirror(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Kills git and the helpers it started (own process group). */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * The refs a remote advertises for `patterns`, as `ls-remote` rows, read through a byte-capped subprocess: output past
 * `maxBytes` (or `timeoutMs`) kills git's process group and refuses. Git's own messages are discarded, they carry the URL
 * and its credential. Protocol v2 is preferred so the server filters by the patterns; a v0 server's whole advertisement is
 * only bounded by the timeout (it is read by git, not buffered here).
 */
export async function listRemoteCapped(url: string, patterns: readonly string[], maxBytes = LS_REMOTE_MAX_BYTES, timeoutMs = 30_000): Promise<string> {
  const child = spawn('git', ['-c', 'protocol.version=2', 'ls-remote', url, ...patterns], {
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  })
  const chunks: Buffer[] = []
  let size = 0
  let over = false
  const timer = setTimeout(() => killGroup(child), timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > maxBytes) {
      over = true
      chunks.length = 0
      killGroup(child)
    } else if (!over) chunks.push(chunk)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  }).finally(() => clearTimeout(timer))
  if (over) throw new MirrorReadLimitError(`the remote advertises more than ${maxBytes / 1024 / 1024} MiB of refs for this lookup`)
  if (code !== 0) throw new Error(`git ls-remote exited with ${code}`)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * `git fetch --depth=1` of one commit into the query mirror. Best-effort size cap: the mirror is polled every
 * `limits.pollMs` and git is killed (with its helpers) once it has grown by `limits.fetchBytes`; a fetch that ends between two
 * polls is caught by a final check. Git has no transfer cap of its own for fetch (`receive.maxInputSize` only guards pushes)
 * and the whole commit tree crosses the wire before any tree limit can be read. Where `sh` has `ulimit -f` the fetch is also
 * run under it, a hard limit on the pack file (see `QUERY_MIRROR_LIMITS`). Output is discarded: git's messages carry the remote
 * URL and its credential. On any failure the caller discards the mirror, which removes the partial pack. Resolves with the
 * bytes the mirror grew by.
 */
export async function fetchQueryCommit(dir: string, url: string, commit: string, limits: { fetchBytes: number; timeoutMs: number; pollMs?: number } = QUERY_MIRROR_LIMITS): Promise<number> {
  const before = await mirrorBytes(dir)
  const fetchArgs = ['fetch', '--quiet', '--depth=1', '--no-tags', '--no-write-fetch-head', url, `+${commit}:refs/elara/query`]
  // `ulimit -f` counts 512-byte blocks (1,024 in some shells); failing to set it must not stop the fetch.
  const [command, args] = process.platform === 'win32' ? ['git', fetchArgs] : ['/bin/sh', ['-c', 'ulimit -f "$0" 2>/dev/null; exec "$@"', String(Math.ceil(limits.fetchBytes / 512)), 'git', ...fetchArgs]] as const
  const child = spawn(command, args, {
    cwd: dir,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: 'ignore',
    detached: true,
  })
  let over = false
  let timedOut = false
  let measuring = false
  const watch = setInterval(() => {
    if (measuring) return
    measuring = true
    void mirrorBytes(dir).then((size) => {
      if (size - before > limits.fetchBytes) {
        over = true
        killGroup(child)
      }
    }).finally(() => { measuring = false })
  }, limits.pollMs ?? 100)
  const timer = setTimeout(() => { timedOut = true; killGroup(child) }, limits.timeoutMs)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exit) => resolve(exit))
  }).finally(() => {
    clearInterval(watch)
    clearTimeout(timer)
  })
  const grown = await mirrorBytes(dir) - before
  // A fetch that finished between two polls, or one the file-size limit stopped at the budget, is over budget too.
  if (grown > limits.fetchBytes || (code !== 0 && grown >= limits.fetchBytes * 0.9)) over = true
  if (over) {
    await simpleGit(dir).raw(['update-ref', '-d', 'refs/elara/query']).catch(() => undefined)
    throw new MirrorReadLimitError(`commit exceeds the ref transfer budget (${limits.fetchBytes / 1024 / 1024} MiB); nothing was kept`)
  }
  if (timedOut) throw new Error('git fetch timed out')
  if (code !== 0) throw new Error(`git fetch exited with ${code}`)
  return grown
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

/**
 * Records `commit` as indexed (the next sync's diff base) and lets gc fold
 * old fetches. Best effort: the index is already written, so a failure is
 * logged and the sync stays a success. Without the ref the next sync still
 * diffs against `last_synced_commit` while the mirror holds it, and reads
 * every file once when it does not.
 */
export async function markMirrorSynced(dir: string, commit: string): Promise<void> {
  try {
    await simpleGit(dir).raw(['update-ref', SYNCED_REF, commit])
    await simpleGit(dir).raw(['gc', '--auto', '--quiet'])
  } catch (err) {
    console.warn(`[git-mirror] upkeep of ${dir} failed (the sync is recorded):`, err)
  }
}

export interface TreeEntry {
  mode: string
  type: string
  sha: string
  /** Null for a submodule (a commit entry). */
  size: number | null
  path: string
}

const execGit = promisify(execFile)
async function listTree(dir: string, commit: string, maxBytes = Infinity): Promise<TreeEntry[]> {
  let out: string
  if (Number.isFinite(maxBytes)) {
    try {
      const raw = (await execGit('git', ['--no-replace-objects', 'ls-tree', '-r', '-l', '-z', '--full-tree', commit], { cwd: dir, maxBuffer: maxBytes, timeout: 30_000, encoding: null })).stdout
      if (!isUtf8(raw)) throw new Error('Git ref contains non-UTF-8 paths')
      out = raw.toString('utf8')
    } catch (err) {
      if (typeof err === 'object' && err !== null && ('code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || 'killed' in err && err.killed)) throw new MirrorReadLimitError('Git tree listing exceeded the ref byte/time budget')
      throw err
    }
  } else out = await simpleGit(dir, { allowEnvironment: ['GIT_NO_REPLACE_OBJECTS'] }).env('GIT_NO_REPLACE_OBJECTS', '1').raw(['ls-tree', '-r', '-l', '-z', '--full-tree', commit])
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
    const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
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
export class MirrorReadLimitError extends Error {}

export async function scanMirrorTree(
  dir: string,
  commit: string,
  previous: string | null,
  indexedPaths: ReadonlySet<string>,
  maxFiles = MAX_INDEXED_FILES,
  maxReadBytes = Infinity,
): Promise<RepositoryScan & { read: number; blobsRead: number; entries: TreeEntry[] }> {
  const before = previous ? new Map((await listTree(dir, previous)).map((e) => [e.path, e.sha])) : null
  const listed: TreeEntry[] = []
  const skipped: SkippedFile[] = []
  const entries = await listTree(dir, commit, maxReadBytes)
  if (Number.isFinite(maxReadBytes) && entries.length > maxFiles) throw new MirrorReadLimitError('Git tree exceeds the ref file budget')
  for (const entry of entries) {
    // A clone checks a symlink out as a link and a submodule as an empty directory: the scan reads neither.
    if (entry.type !== 'blob' || entry.mode === '120000' || GIT_METADATA.test(entry.path)) continue
    if (BINARY_EXTENSIONS.test(entry.path)) skipped.push({ path: entry.path, reason: 'binary' })
    else listed.push(entry)
  }
  const inCap = listed.slice(0, maxFiles)
  const toRead = inCap.filter(
    (e) => e.size! <= MAX_FILE_BYTES && !(before?.get(e.path) === e.sha && indexedPaths.has(e.path)),
  )
  if (toRead.reduce((sum, e) => sum + e.size!, 0) > maxReadBytes) throw new MirrorReadLimitError('Git tree exceeds the ref byte budget')
  const blobs = await readBlobs(dir, [...new Set(toRead.map((e) => e.sha))])
  const readPaths = new Set(toRead.map((e) => e.path))
  const scan: RepositoryScan & { read: number; blobsRead: number; entries: TreeEntry[] } = { files: [], currentPaths: [], skipped, read: toRead.length, blobsRead: blobs.size, entries }
  for (const entry of inCap) {
    if (entry.size! > MAX_FILE_BYTES) {
      skipped.push({ path: entry.path, reason: 'too_large' })
      continue
    }
    if (readPaths.has(entry.path)) {
      const bytes = blobs.get(entry.sha)
      if (!bytes) throw new Error(`git mirror is missing blob ${entry.sha} (${entry.path})`)
      // A string answer must not silently replace invalid UTF-8 bytes from the named commit.
      if (bytes.includes(0) || !isUtf8(bytes)) {
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
