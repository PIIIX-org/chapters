/**
 * A content export of a vault, shared only after live authorisation on every request.
 * Ordinary edits keep real Git history; explicit Purge removes server-managed content
 * from history/indexes/caches synchronously before further reads (#1087 owner decision).
 * A canonical export is a fast-forward child, never a virtual acknowledgement or force update.
 * The entire object database is invalidated under the same barrier before an explicit purge.
 * External already-downloaded clones/exports are not erasable by the server.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { chmod, opendir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, vaults } from '../db/schema.js'
import { renderNoteFile } from '../notes/projector.js'
import { assetBlobId, readAsset } from '../notes/store.js'
import { ensureDirectory, isShortAtomicTempName, syncDirectory } from '../notes/atomic-write.js'
import { assetDirectory, initializeAssetStorage } from '../notes/asset-storage.js'
import { admitSnapshot, loadManifest, loadPreparedSnapshot, saveManifest } from './metadata.js'
import { assetGitPath, type Manifest } from './tree.js'
import { boundedGit, GitPushError, gitTimeLimit, MAIN, PACK_LIMITS } from './pack.js'
import { vaultRemoteDir, vaultRemotesRoot, withVaultGit } from './lifecycle.js'

export { vaultRemoteDir, vaultRemotesRoot } from './lifecycle.js'
export const runGit = boundedGit

export interface VaultExport { dir: string; head: string; epochs: Record<string, string> }

/** UNDER withVaultGit; an override is a private server-created quarantine, never a client path. */
export async function ensureVaultRemote(vaultId: string, dir = vaultRemoteDir(vaultId)): Promise<VaultExport> {
  const deadline = performance.now() + gitTimeLimit(PACK_LIMITS.workMilliseconds)
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${`${Math.ceil(gitTimeLimit())}ms`}, true)`)
    const [source] = (await tx.execute(sql`
      SELECT count(*)::int AS files,
        coalesce(sum(octet_length(body) + octet_length(frontmatter::text) +
          coalesce(octet_length(frontmatter_src::text), 0) + octet_length(path)), 0)::float8 AS bytes
      FROM (SELECT body, frontmatter, frontmatter_src, path FROM notes
        WHERE vault_id = ${vaultId} AND deleted_at IS NULL LIMIT ${PACK_LIMITS.objects + 1}) live
    `)) as unknown as Array<{ files: number; bytes: number }>
    if (!source || source.files > PACK_LIMITS.objects || source.bytes > PACK_LIMITS.expanded) throw new GitPushError('vault source exceeds supported Git tree limits')
    return tx.select({ id: notes.id, rev: sql<number>`${notes}.seq`, path: notes.path, frontmatter: notes.frontmatter,
      purgeEpoch: sql<string>`${notes}.purge_epoch::text`,
      frontmatterSrc: sql<unknown>`${notes}.frontmatter_src`, body: notes.body, updatedAt: notes.updatedAt })
      .from(notes).where(and(eq(notes.vaultId, vaultId), isNull(notes.deletedAt)))
      .orderBy(asc(sql`${notes.path} COLLATE "C"`)).limit(PACK_LIMITS.objects)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  const files: Array<{ path: string; data: Buffer }> = []
  const manifest: Manifest = { notes: {}, assets: {} }
  const epochs: Record<string, string> = {}
  let bytes = 0
  let pathBytes = 0
  const add = (path: string, data: Buffer) => {
    bytes += data.length
    pathBytes += Buffer.byteLength(path) + 64
    if (files.length >= PACK_LIMITS.objects || data.length > PACK_LIMITS.object || bytes > PACK_LIMITS.expanded ||
        Buffer.byteLength(path) > 1024 || pathBytes > 1024 * 1024) throw new GitPushError('vault exceeds supported Git tree limits')
    files.push({ path, data })
  }
  for (const row of rows) {
    if (performance.now() > deadline) throw new GitPushError('Git export work limit exceeded')
    epochs[row.id] = row.purgeEpoch
    const path = `${row.path}.md`
    const text = renderNoteFile(row)
    const size = Buffer.byteLength(text)
    if (size > PACK_LIMITS.object || bytes + size > PACK_LIMITS.expanded) throw new GitPushError('vault note exceeds supported Git tree limits')
    const data = Buffer.from(text, 'utf8')
    add(path, data)
    manifest.notes[path] = { id: row.id, rev: Number(row.rev), blob: assetBlobId(data) }
  }
  await initializeAssetStorage(vaultId)
  for await (const asset of await opendir(assetDirectory(vaultId))) {
    if (performance.now() > deadline) throw new GitPushError('Git export work limit exceeded')
    if (isShortAtomicTempName(asset.name)) continue
    if (!asset.isFile() || files.length >= PACK_LIMITS.objects) throw new GitPushError('vault has unsafe or too many Git assets')
    const path = assetGitPath(asset.name)
    const read = await readAsset(vaultId, asset.name, Math.min(PACK_LIMITS.object, PACK_LIMITS.expanded - bytes))
    if (!read) throw new GitPushError('vault asset is unreadable, unsafe or exceeds Git limits')
    add(path, read.buffer)
    manifest.assets[path] = assetBlobId(read.buffer)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const fingerprint = createHash('sha256').update(files.map((f) => `${f.path}\0${assetBlobId(f.data)}\n`).join('')).update(JSON.stringify(manifest.notes)).digest('hex')
  if (!existsSync(join(dir, 'HEAD'))) {
    await ensureDirectory(dir, true)
    await runGit(['init', '--bare', '--quiet', '--object-format=sha1', '--initial-branch=main', dir], vaultRemotesRoot())
    await runGit(['config', 'core.fsync', 'all'], dir)
    await runGit(['config', 'uploadpack.allowAnySHA1InWant', 'false'], dir)
  }
  await chmod(dir, 0o700)
  const head = await remoteHead(dir)
  if (head) {
    // Incoming commit messages are untrusted. Only a previously verified
    // private mapping can establish that this ref still represents live state.
    const served = await loadManifest(vaultId, head)
    if (served && isDeepStrictEqual(served.notes, manifest.notes) && isDeepStrictEqual(served.assets, manifest.assets)) return { dir, head, epochs }
    if (!served) {
      // An exact imported tree keeps its real OID; a merge/normalisation
      // requires a real FF child. Never replace an existing identity mapping.
      const listed = (await runGit(['ls-tree', '-r', '-z', MAIN], dir, undefined, 1024 * 1024)).toString('utf8').split('\0').filter(Boolean)
      const actual = new Map(listed.map((line): [string, string] => {
        const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line)
        return match ? [match[2]!, match[1]!] : ['', '']
      }))
      if (actual.size === files.length && files.every(file => actual.get(file.path) === assetBlobId(file.data))) {
        await saveManifest(vaultId, head, manifest)
        return { dir, head, epochs }
      }
    }
  }
  const retained = head ? await loadPreparedSnapshot(vaultId, head, manifest) : null
  const when = retained?.when ?? Math.floor(rows.reduce((newest, r) => Math.max(newest, r.updatedAt.getTime()), Date.now()) / 1000)
  const journal: Manifest = head ? { ...manifest, prepared: { parent: head, when } } : manifest
  if (!retained) await admitSnapshot(vaultId, journal)
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
  for (const path of ['objects/pack', 'objects', 'refs/heads', 'refs', '.']) await syncDirectory(join(dir, path))
  const canonical = await remoteHead(dir)
  if (!canonical || (retained && canonical !== retained.commitId)) throw new GitPushError('canonical export differs from its durable recovery journal')
  await saveManifest(vaultId, canonical, journal)
  return { dir, head: canonical, epochs }
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
