import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { vaults } from '../db/schema.js'
import { failpoint } from '../failpoints.js'
import { atomicWrite, ensureDirectory, syncDirectory } from './atomic-write.js'
import { withKeyLock } from './key-lock.js'
import { holdInstanceLock, holdsExclusiveLock } from './maintenance-lock.js'

export const ASSET_DIRECTORY = '.assets'
const JOURNAL = '.asset-storage.json'
const safeName = (name: string) => /^[a-zA-Z0-9._-]+$/.test(name) && name !== '.' && !name.includes('..')
const root = (id: string) => join(config.dataDir, 'vaults', id)
export const assetDirectory = (id: string) => join(root(id), ASSET_DIRECTORY)
export const storedAssetFile = (id: string, name: string) => join(assetDirectory(id), name)

interface Fingerprint { size: number; sha256: string }
interface Entry extends Fingerprint { name: string; projected: boolean }
interface Journal {
  version: 2
  vaultId: string
  state: 'pending' | 'complete' | 'rolled-back'
  entries: Entry[]
  before: Summary
  after: Summary | null
}
interface Summary { files: number; bytes: number; sha256: string }
export interface AssetStorageReport {
  vaultId: string
  state: Journal['state']
  before: Summary
  ready: boolean
  migrated: Summary | null
  current: Summary
  baselineVerified: boolean
  changed: string[]
  added: string[]
  removed: string[]
  /** Rollback collisions stay in .assets, with an extra durable recovery copy. Never start the old image with conflicts. */
  conflicts: string[]
}

async function realDirectory(path: string, create = false): Promise<boolean> {
  if (create) await ensureDirectory(path, true)
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`asset storage is not a real directory: ${path}`)
  return true
}

async function fingerprint(file: string, durable = false): Promise<Fingerprint | null> {
  let handle
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`asset is not a regular file: ${file}`)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length }
    if (durable) await handle.sync()
    return { size, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}
const same = (a: Fingerprint | null, b: Fingerprint) => a?.size === b.size && a.sha256 === b.sha256
function summarize(entries: Array<Fingerprint & { name: string }>): Summary {
  const hash = createHash('sha256')
  let bytes = 0
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    hash.update(`${entry.name}\0${entry.size}\0${entry.sha256}\n`)
    bytes += entry.size
  }
  return { files: entries.length, bytes, sha256: hash.digest('hex') }
}
async function files(dir: string, legacy = false, durable = false): Promise<Array<Fingerprint & { name: string }>> {
  if (!(await realDirectory(dir))) return []
  const result: Array<Fingerprint & { name: string }> = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (legacy && entry.isDirectory()) continue // Valid nested legacy note projections, never basename attachments.
    if (!safeName(entry.name) || !entry.isFile()) throw new Error(`unsafe legacy asset: ${join(dir, entry.name)}`)
    const info = await fingerprint(join(dir, entry.name), durable)
    if (!info) throw new Error(`asset disappeared during inventory: ${entry.name}`)
    result.push({ name: entry.name, ...info })
  }
  return result
}
async function journal(id: string): Promise<Journal | null> {
  if (!(await realDirectory(root(id)))) return null
  const handle = await open(join(root(id), JOURNAL), constants.O_RDONLY | constants.O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!handle) return null
  let value: Journal
  try { value = JSON.parse(await handle.readFile('utf8')) as Journal } finally { await handle.close() }
  if (value.version !== 2 || value.vaultId !== id || !['pending', 'complete', 'rolled-back'].includes(value.state) || !Array.isArray(value.entries) ||
      value.entries.some(e => !safeName(e.name) || !Number.isSafeInteger(e.size) || e.size < 0 || !/^[0-9a-f]{64}$/.test(e.sha256) || typeof e.projected !== 'boolean') ||
      new Set(value.entries.map(e => e.name)).size !== value.entries.length || JSON.stringify(summarize(value.entries)) !== JSON.stringify(value.before)) throw new Error(`invalid asset migration journal for ${id}`)
  if (value.state === 'complete' && JSON.stringify(value.after) !== JSON.stringify(value.before)) throw new Error(`unverified asset migration journal for ${id}`)
  return value
}
async function save(value: Journal): Promise<void> {
  await realDirectory(assetDirectory(value.vaultId), true)
  await atomicWrite(join(root(value.vaultId), JOURNAL), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, durable: true })
  const ready = join(root(value.vaultId), '.asset-storage-ready')
  if (value.state === 'complete') {
    failpoint('assets.after-complete-journal')
    await atomicWrite(ready, '2\n', { mode: 0o600, durable: true })
  } else { await rm(ready, { force: true }); await syncDirectory(root(value.vaultId)) }
}

function requireExclusive(): void {
  if (!holdsExclusiveLock()) throw new Error('exclusive instance lock lost; migration stopped before publishing/removing bytes')
}

/** Tiny durable marker keeps routine reads independent of the potentially large audit inventory. */
export async function isAssetStorageReady(id: string): Promise<boolean> {
  const handle = await open(join(root(id), '.asset-storage-ready'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!handle) return false
  try {
    if (!(await handle.stat()).isFile() || await handle.readFile('utf8') !== '2\n') throw new Error(`invalid asset storage marker for ${id}`)
    return true
  } finally { await handle.close() }
}

/** An operator rolled this vault's attachment storage back (`rollback`): this release never migrates it again. */
export async function isAssetStorageRolledBack(id: string): Promise<boolean> {
  return (await journal(id))?.state === 'rolled-back'
}

async function cleanupWork(id: string): Promise<void> {
  const dir = join(root(id), '.asset-migration-work')
  if (!(await realDirectory(dir))) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^[0-9a-f-]{36}\.tmp$/.test(entry.name)) await rm(join(dir, entry.name))
  }
  if ((await readdir(dir)).length === 0) { await rmdir(dir); await syncDirectory(root(id)) }
}

/** No overwrite, even at the rename boundary. Keep the source until the linked destination is fsynced and re-verified. */
async function durableCopy(source: string, destination: string, expected: Fingerprint): Promise<void> {
  await realDirectory(dirname(destination), true)
  const existing = await fingerprint(destination)
  if (existing && !same(existing, expected)) throw new Error(`destination differs; preserved both versions: ${destination}`)
  if (!existing) {
    const work = join(dirname(dirname(destination)), '.asset-migration-work')
    await realDirectory(work, true)
    const temp = join(work, `${randomUUID()}.tmp`)
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await input.stat()).isFile()) throw new Error(`not a regular asset: ${source}`)
      const output = await open(temp, 'wx', 0o600)
      try {
        for await (const chunk of input.createReadStream({ autoClose: false })) await output.writeFile(chunk)
        await output.sync()
      } finally { await output.close() }
      if (!same(await fingerprint(temp), expected)) throw new Error(`source changed during copy: ${source}`)
      requireExclusive()
      try { await link(temp, destination) } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || !same(await fingerprint(destination), expected)) throw err
      }
    } finally { await input.close(); await rm(temp, { force: true }) }
  }
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
  await syncDirectory(dirname(destination))
  if (!same(await fingerprint(destination), expected)) throw new Error(`destination verification failed: ${destination}`)
}

/** New vaults initialize before any note projection. Existing legacy bytes require the offline migration, never lazy destructive migration. */
export async function initializeAssetStorage(id: string): Promise<void> {
  await withKeyLock(`asset-layout:${id}`, async () => {
    if (await isAssetStorageReady(id)) { await realDirectory(assetDirectory(id), true); return }
    const current = await journal(id)
    if (current?.state === 'complete') { await save(current); return }
    if (current || (await files(join(root(id), 'assets'), true)).length > 0) throw new Error(`asset storage migration required for ${id}; stop all app writers and run asset-storage migrate`)
    await save({ version: 2, vaultId: id, state: 'complete', entries: [], before: summarize([]), after: summarize([]) })
  })
}
async function report(value: Journal, conflicts: string[] = []): Promise<AssetStorageReport> {
  const current = await files(assetDirectory(value.vaultId))
  const byName = new Map(current.map(e => [e.name, e]))
  const original = new Map(value.entries.map(e => [e.name, e]))
  const changed = value.entries.filter(e => byName.has(e.name) && !same(byName.get(e.name)!, e)).map(e => e.name)
  const removed = value.entries.filter(e => !byName.has(e.name)).map(e => e.name)
  const added = current.filter(e => !original.has(e.name)).map(e => e.name)
  return { vaultId: value.vaultId, state: value.state, before: value.before, ready: await isAssetStorageReady(value.vaultId), migrated: value.after, current: summarize(current), baselineVerified: changed.length + removed.length + added.length === 0, changed, added, removed, conflicts }
}

async function assertLegacyInventory(dir: string, planned: ReadonlySet<string>): Promise<void> {
  if (!(await realDirectory(dir))) return
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !planned.has(entry.name)) throw new Error(`new legacy asset outside the durable plan; preserved for review: ${entry.name}`)
  }
}

async function migrate(id: string, restoredNotePaths: readonly string[] = []): Promise<AssetStorageReport> {
  await cleanupWork(id)
  let value = await journal(id)
  if (value?.state === 'rolled-back') throw new Error(`vault ${id} was rolled back; preserve both trees and resolve/rehearse a fresh upgrade before restarting`)
  if (value?.state === 'complete') {
    if (!(await isAssetStorageReady(id))) { requireExclusive(); await save(value) }
    return report(value)
  }
  const legacy = join(root(id), 'assets')
  if (!value) {
    await realDirectory(root(id), true)
    const inventory = await files(legacy, true, true)
    if (await realDirectory(legacy)) await syncDirectory(legacy)
    await syncDirectory(root(id))
    const owned = await db.execute(sql`SELECT path FROM projected_files WHERE vault_id = ${id}
      UNION SELECT path || '.md' AS path FROM notes WHERE vault_id = ${id} AND deleted_at IS NULL`)
    const paths = new Set([...owned.map(row => String(row.path)), ...restoredNotePaths])
    const entries = inventory.map(e => ({ ...e, projected: paths.has(`assets/${e.name}`) }))
    value = { version: 2, vaultId: id, state: 'pending', entries, before: summarize(entries), after: null }
    await save(value) // Durable plan precedes every mutation; no recovery guesses from .conflicts.
    failpoint('assets.after-plan')
  }
  const planned = new Set(value.entries.map(entry => entry.name))
  await assertLegacyInventory(legacy, planned)
  for (const entry of value.entries) {
    const source = join(legacy, entry.name)
    const destination = storedAssetFile(id, entry.name)
    const sourceHash = await fingerprint(source)
    if (sourceHash && !same(sourceHash, entry)) throw new Error(`legacy source changed; preserved both versions: ${source}`)
    if (!sourceHash && !same(await fingerprint(destination), entry)) throw new Error(`migration source/durable destination missing: ${source}`)
    if (sourceHash) await durableCopy(source, destination, entry)
    else { // Crash after unlink but before completion: the durable destination is the receipt.
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
      await syncDirectory(assetDirectory(id))
    }
    failpoint('assets.after-copy')
    if (!entry.projected && sourceHash) {
      if (!same(await fingerprint(source), entry)) throw new Error(`legacy source changed before unlink: ${source}`)
      requireExclusive()
      await rm(source)
      await syncDirectory(legacy)
      failpoint('assets.after-unlink')
    }
  }
  await assertLegacyInventory(legacy, planned)
  // Known shared-path projections may currently hold attachment bytes. Reconcile
  // them from the DB only AFTER the attachment copy is durable, before boot drains.
  if (value.entries.some(entry => entry.projected)) await db.execute(sql`
    UPDATE note_projections p SET applied_seq = 0, attempts = 0, lease_until = NULL, updated_at = now()
    FROM notes n WHERE p.note_id = n.id AND n.vault_id = ${id}
      AND (n.path = 'assets' OR n.path LIKE 'assets/%') AND p.projection IN ('file', 'dir_index')`)
  const checked = await report(value)
  if (!checked.baselineVerified) throw new Error(`asset migration verification differs for ${id}`)
  requireExclusive()
  value.after = checked.current
  value.state = 'complete'
  await save(value)
  return report(value)
}
async function rollback(id: string): Promise<AssetStorageReport> {
  const value = await journal(id)
  if (!value) throw new Error(`no migration journal for ${id}`)
  const legacy = join(root(id), 'assets')
  const owned = await db.execute(sql`SELECT path FROM projected_files WHERE vault_id = ${id}
    UNION SELECT path || '.md' AS path FROM notes WHERE vault_id = ${id} AND deleted_at IS NULL`)
  const paths = new Set(owned.map(row => String(row.path)))
  await cleanupWork(id)
  const conflicts: string[] = []
  const current = new Map((await files(assetDirectory(id))).map(e => [e.name, { ...e, source: storedAssetFile(id, e.name) }]))
  if (value.state === 'pending') {
    for (const entry of value.entries) {
      const source = join(legacy, entry.name)
      if (!current.has(entry.name) && same(await fingerprint(source), entry)) current.set(entry.name, { ...entry, source })
    }
  }
  for (const entry of current.values()) {
    const destination = join(legacy, entry.name)
    const existing = await fingerprint(destination)
    if (paths.has(`assets/${entry.name}`) || (existing && !same(existing, entry))) {
      await durableCopy(entry.source, join(root(id), '.asset-rollback', `${entry.name}.${entry.sha256}`), entry)
      conflicts.push(entry.name)
    } else await durableCopy(entry.source, destination, entry)
    failpoint('assets.rollback-after-copy')
  }
  value.state = 'rolled-back'
  requireExclusive()
  await save(value)
  return report(value, conflicts)
}

/** The existing exclusive instance lock excludes live apps, CLIs and the projector throughout filesystem effects. */
export async function runAssetStorage(mode: 'migrate' | 'verify' | 'rollback', vaultId?: string): Promise<AssetStorageReport[]> {
  const lock = holdsExclusiveLock() ? null : await holdInstanceLock('exclusive')
  try {
    const rows = await db.select({ id: vaults.id }).from(vaults).where(vaultId ? eq(vaults.id, vaultId) : undefined)
    if (vaultId && rows.length === 0) throw new Error(`unknown vault ${vaultId}`)
    const reports: AssetStorageReport[] = []
    for (const row of rows) {
      try {
        if (mode === 'migrate') reports.push(await migrate(row.id))
        else if (mode === 'rollback') reports.push(await rollback(row.id))
        else {
          const value = await journal(row.id)
          if (!value) throw new Error(`no migration journal for ${row.id}`)
          reports.push(await report(value))
        }
      } finally { if (mode !== 'verify') await cleanupWork(row.id) }
    }
    return reports
  } finally { await lock?.release() }
}

/** A validated backup has disjoint logical note/asset entries. Prepare BEFORE
 * publishing any note file, preserving existing-volume legacy bytes by the same
 * verified migration. Caller holds the exclusive restore fence; no vault row is needed yet. */
export async function prepareRestoredAssetStorage(id: string, notePaths: readonly string[]): Promise<boolean> {
  requireExclusive()
  const existed = await journal(id)
  const result = await migrate(id, notePaths)
  return !existed && result.before.files === 0 && result.current.files === 0
}

/** Undo only a newly prepared EMPTY namespace after the restore transaction failed.
 * Never remove pre-existing audit files, migrated legacy bytes, or later/new data. */
export async function discardEmptyRestoredAssetStorage(id: string): Promise<void> {
  requireExclusive()
  // The SQL commit can precede a failed derived projection. Its namespace is
  // already durable state, not scratch to undo when that later stage fails.
  if ((await db.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, id)).limit(1)).length) return
  const value = await journal(id)
  if (!value || value.state !== 'complete' || value.entries.length || (await files(assetDirectory(id))).length) return
  await rm(join(root(id), '.asset-storage-ready'), { force: true })
  await rm(join(root(id), JOURNAL), { force: true })
  await rmdir(assetDirectory(id))
  await syncDirectory(root(id))
}
