/**
 * A content export of a vault, shared only after live authorisation on every request.
 * Ordinary edits keep real Git history; explicit Purge removes server-managed content
 * from history/indexes/caches synchronously before further reads (#1087 owner decision).
 * A canonical export is a fast-forward child, never a virtual acknowledgement or force update.
 * The entire object database is invalidated under the same barrier before an explicit purge.
 * External already-downloaded clones/exports are not erasable by the server.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, vaults } from '../db/schema.js'
import { renderNoteFile } from '../notes/projector.js'
import { assetBlobId, listAssets, readAsset } from '../notes/store.js'
import { saveManifest } from './metadata.js'
import type { Manifest } from './tree.js'
import { boundedGit, GitPushError, MAIN, PACK_LIMITS } from './pack.js'
import { vaultRemoteDir, vaultRemotesRoot, withVaultGit } from './lifecycle.js'

export { vaultRemoteDir, vaultRemotesRoot } from './lifecycle.js'
export const runGit = boundedGit
const FINGERPRINT = /^elara-vault-fingerprint: ([0-9a-f]{64})$/m

/** Must run under withVaultGit through the entire advertisement/upload/import, not just the export build. */
export async function ensureVaultRemote(vaultId: string): Promise<string> {
  const rows = await db.select({ id: notes.id, rev: sql<number>`${notes}.seq`, path: notes.path, frontmatter: notes.frontmatter,
    frontmatterSrc: sql<unknown>`${notes}.frontmatter_src`, body: notes.body, updatedAt: notes.updatedAt })
    .from(notes).where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt))).orderBy(asc(sql`${notes.path} COLLATE "C"`))
  const files: Array<{ path: string; data: Buffer }> = rows.map((r) => ({ path: `${r.path}.md`, data: Buffer.from(renderNoteFile(r), 'utf8') }))
  const manifest: Manifest = { notes: {}, assets: {} }
  rows.forEach((r, i) => { manifest.notes[`${r.path}.md`] = { id: r.id, rev: Number(r.rev), blob: assetBlobId(files[i]!.data) } })
  for (const asset of await listAssets(vaultId)) {
    if (asset.size > PACK_LIMITS.object) throw new GitPushError('vault asset exceeds supported Git object size')
    const read = await readAsset(vaultId, asset.fileName)
    if (!read) throw new GitPushError('vault asset is unreadable or unsafe')
    manifest.assets[`assets/${asset.fileName}`] = assetBlobId(read.buffer)
    files.push({ path: `assets/${asset.fileName}`, data: read.buffer })
  }
  if (files.length > PACK_LIMITS.objects || files.some((f) => f.data.length > PACK_LIMITS.object) || files.reduce((n, f) => n + f.data.length, 0) > PACK_LIMITS.expanded) throw new GitPushError('vault exceeds supported Git tree limits')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const fingerprint = createHash('sha256').update(files.map((f) => `${f.path}\0${assetBlobId(f.data)}\n`).join('')).update(JSON.stringify(manifest.notes)).digest('hex')
  const dir = vaultRemoteDir(vaultId)
  if (!existsSync(join(dir, 'HEAD'))) {
    await mkdir(dir, { recursive: true })
    await runGit(['init', '--bare', '--quiet', '--initial-branch=main', dir], vaultRemotesRoot())
    await runGit(['config', 'core.fsync', 'committed'], dir)
    await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'false'], dir)
  }
  const head = await remoteHead(dir)
  if (head) {
    const message = (await runGit(['log', '-1', '--format=%B', MAIN], dir)).toString('utf8')
    if (FINGERPRINT.exec(message)?.[1] === fingerprint) {
      await saveManifest(vaultId, head, manifest)
      return dir
    }
    // An exact imported tree keeps its REAL incoming OID. Only a live merge/normalisation needs an export child.
    const listed = (await runGit(['ls-tree', '-r', '-z', MAIN], dir)).toString('utf8').split('\0').filter(Boolean)
    const actual = new Map(listed.map((line): [string, string] => {
      const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line)
      return match ? [match[2]!, match[1]!] : ['', '']
    }))
    if (actual.size === files.length && files.every((file) => actual.get(file.path) === assetBlobId(file.data))) {
      await saveManifest(vaultId, head, manifest)
      return dir
    }
  }
  const when = Math.floor(rows.reduce((newest, r) => Math.max(newest, r.updatedAt.getTime()), Date.now()) / 1000)
  const message = `Vault notes\n\nelara-vault-fingerprint: ${fingerprint}\n`
  const lines: Buffer[] = []
  files.forEach((f, i) => lines.push(Buffer.from(`blob\nmark :${i + 1}\ndata ${f.data.length}\n`), f.data, Buffer.from('\n')))
  if (!head) {
    const rootMessage = 'Elara vault remote\n'
    lines.push(Buffer.from(`commit ${MAIN}\nmark :${files.length + 1}\ncommitter Elara <elara@localhost> 0 +0000\ndata ${rootMessage.length}\n${rootMessage}\n`))
  }
  lines.push(Buffer.from(`commit ${MAIN}\ncommitter Elara <elara@localhost> ${when} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${head ?? `:${files.length + 1}`}\n`))
  lines.push(Buffer.from('deleteall\n'))
  files.forEach((f, i) => lines.push(Buffer.from(`M 100644 :${i + 1} ${quotePath(f.path)}\n`)))
  lines.push(Buffer.from('\ndone\n'))
  await runGit(['fast-import', '--quiet', '--done'], dir, Buffer.concat(lines))
  await saveManifest(vaultId, (await remoteHead(dir))!, manifest)
  return dir
}

export async function remoteHead(dir: string): Promise<string | null> {
  return runGit(['rev-parse', '--verify', '--quiet', MAIN], dir).then((b) => b.toString('utf8').trim(), () => null)
}

function quotePath(path: string): string {
  return /["\\\n]/.test(path) ? `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : path
}

/** Also serialised with a deleted vault's in-flight Git operations. */
export async function sweepVaultRemotes(): Promise<number> {
  if (!existsSync(vaultRemotesRoot())) return 0
  const keep = new Set((await db.select({ id: vaults.id }).from(vaults)).map((v) => `${v.id}.git`))
  let removed = 0
  for (const name of await readdir(vaultRemotesRoot())) {
    if (keep.has(name)) continue
    const match = /^([0-9a-f-]{36})\.git$/.exec(name)
    if (match) await withVaultGit(match[1]!, () => rm(join(vaultRemotesRoot(), name), { recursive: true, force: true }))
    else await rm(join(vaultRemotesRoot(), name), { recursive: true, force: true })
    removed++
  }
  return removed
}
