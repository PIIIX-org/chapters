/**
 * A vault as a git repository (#677, read-only): one bare repository per vault at `DATA_DIR/git-remotes/<vaultId>.git`,
 * built from the vault's live notes as `<path>.md` files in the projector's file form (`renderNoteFile`), so a clone can be
 * grepped locally. It holds content only and is the same for everyone who may read the vault: access is checked on every
 * request by routes.ts, never by this repository.
 *
 * It is a SNAPSHOT of the live notes and never a history: a purged or replaced note's text must not stay readable
 * through an old commit, and no purge hook reaches this repository. It is built lazily, on a request, and only when the
 * content changed: the one commit's message carries the fingerprint of what it holds (sha256 over each path and the
 * hash of its file, in path order), so a request for an unchanged vault costs one query and one `git log`. A change
 * writes the snapshot commit anew (`git fast-import --force`, a fixed author and the newest note's `updated_at` as date, so
 * the same content is the same commit), then drops the old snapshot and every object only it held (`reflog expire`,
 * `gc --prune=now`). History is two commits: an EMPTY root (fixed author, date and message: the same id in every
 * rebuild) and the snapshot, its only child, replaced on each change. A client's `git pull` after a change is a
 * forced non-fast-forward of that one commit: `git pull --rebase` (no local commits) or
 * `git fetch && git reset --hard origin/main` update it, and no purged text survives on the server.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { notes, vaults } from '../db/schema.js'
import { renderNoteFile } from '../notes/projector.js'

const BRANCH = 'refs/heads/main'
const FINGERPRINT = /^elara-vault-fingerprint: ([0-9a-f]{64})$/m

export const vaultRemotesRoot = (): string => join(config.dataDir, 'git-remotes')
export const vaultRemoteDir = (vaultId: string): string => join(vaultRemotesRoot(), `${vaultId}.git`)

/** Runs git in `cwd` with `input` on stdin; resolves with stdout, rejects with stderr on a non-zero exit. */
export function runGit(args: string[], cwd: string, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`git ${args[0]} failed: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`))))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const builds = new Map<string, Promise<string>>()

/** The vault's bare repository, brought up to date with its notes; builds of one vault never overlap in this process. */
export function ensureVaultRemote(vaultId: string): Promise<string> {
  const running = builds.get(vaultId) ?? Promise.resolve('')
  const next = running.catch(() => '').then(() => build(vaultId))
  builds.set(vaultId, next)
  void next.finally(() => {
    if (builds.get(vaultId) === next) builds.delete(vaultId)
  }).catch(() => {})
  return next
}

async function build(vaultId: string): Promise<string> {
  const rows = await db
    .select({ path: notes.path, frontmatter: notes.frontmatter, frontmatterSrc: sql<unknown>`${notes}.frontmatter_src`, body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
    .orderBy(asc(sql`${notes.path} COLLATE "C"`))
  const files = rows.map((r) => ({ path: `${r.path}.md`, data: Buffer.from(renderNoteFile(r), 'utf8') }))
  const fingerprint = createHash('sha256')
    .update(files.map((f) => `${f.path}\0${createHash('sha256').update(f.data).digest('hex')}\n`).join(''))
    .digest('hex')
  const dir = vaultRemoteDir(vaultId)
  if (!existsSync(join(dir, 'HEAD'))) {
    await mkdir(dir, { recursive: true })
    await runGit(['init', '--bare', '--quiet', '--initial-branch=main', dir], vaultRemotesRoot())
  }
  const head = await runGit(['rev-parse', '--verify', '--quiet', BRANCH], dir).then((b) => b.toString('utf8').trim(), () => null)
  if (head) {
    const message = (await runGit(['log', '-1', '--format=%B', BRANCH], dir)).toString('utf8')
    if (FINGERPRINT.exec(message)?.[1] === fingerprint) return dir
  }
  // A reduce: spreading a large vault's rows into Math.max overflows the call stack.
  const when = Math.floor(rows.reduce((newest, r) => Math.max(newest, r.updatedAt.getTime()), 0) / 1000)
  const message = `Vault notes\n\nelara-vault-fingerprint: ${fingerprint}\n`
  const lines: Buffer[] = []
  files.forEach((f, i) => {
    lines.push(Buffer.from(`blob\nmark :${i + 1}\ndata ${f.data.length}\n`), f.data, Buffer.from('\n'))
  })
  const who = `Elara <elara@localhost> ${when} +0000`
  // The stable root: an empty commit with a fixed author, date and message, so its id is the same in every rebuild and
  // in every vault, and a client's `git pull --rebase` has a common base. The snapshot is its only child.
  const rootMessage = 'Elara vault remote\n'
  lines.push(Buffer.from(`commit ${BRANCH}\nmark :${files.length + 1}\ncommitter Elara <elara@localhost> 0 +0000\ndata ${rootMessage.length}\n${rootMessage}\n`))
  lines.push(Buffer.from(`commit ${BRANCH}\ncommitter ${who}\ndata ${Buffer.byteLength(message)}\n${message}from :${files.length + 1}\n`))
  lines.push(Buffer.from('deleteall\n'))
  files.forEach((f, i) => lines.push(Buffer.from(`M 100644 :${i + 1} ${quotePath(f.path)}\n`)))
  lines.push(Buffer.from('\ndone\n'))
  await runGit(['fast-import', '--quiet', '--force', '--done'], dir, Buffer.concat(lines))
  // Nothing of the previous snapshot stays: not its commit, not a reflog entry, not an object only it referenced.
  await runGit(['reflog', 'expire', '--expire=now', '--all'], dir)
  await runGit(['gc', '--prune=now', '--quiet'], dir)
  return dir
}

/** A path as fast-import reads it: C-quoted when it holds a quote, backslash, newline or a leading quote. */
function quotePath(path: string): string {
  return /["\\\n]/.test(path) ? `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : path
}

/** Removes the repositories of vaults that no longer exist (a delete, a crash); returns how many. */
export async function sweepVaultRemotes(): Promise<number> {
  if (!existsSync(vaultRemotesRoot())) return 0
  const keep = new Set((await db.select({ id: vaults.id }).from(vaults)).map((v) => `${v.id}.git`))
  let removed = 0
  for (const name of await readdir(vaultRemotesRoot())) {
    if (keep.has(name)) continue
    await rm(join(vaultRemotesRoot(), name), { recursive: true, force: true })
    removed++
  }
  return removed
}
