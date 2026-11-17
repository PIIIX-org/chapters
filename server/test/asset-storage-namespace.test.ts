import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { createNote, readAsset, readNote, softDeleteNote, updateNote, vaultDir, writeAsset } from '../src/notes/store.js'
import { assetDirectory, runAssetStorage, storedAssetFile } from '../src/notes/asset-storage.js'
import { flushProjections, sweepOrphanFiles } from '../src/notes/projector.js'
import { vaultMarkdownFiles } from '../src/notes/integrity.js'
import { holdInstanceLock, MaintenanceInProgressError } from '../src/notes/maintenance-lock.js'
import { setFailpointHandler } from '../src/failpoints.js'
import { buildVaultZip } from '../src/export/archive.js'
import { createActiveUser, loginCookie } from './helpers.js'

const sh = promisify(execFile)
const loader = createRequire(import.meta.url).resolve('tsx')
let app: FastifyInstance
let cookie: string
let ownerId: string
const owned: string[] = []
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
async function vault(): Promise<string> {
  const [row] = await db.insert(vaults).values({ name: 'asset namespace proof', ownerId }).returning()
  owned.push(row!.id)
  return row!.id
}
async function legacy(id: string, entries: Record<string, string>): Promise<void> {
  await mkdir(join(vaultDir(id), 'assets'), { recursive: true })
  for (const [name, data] of Object.entries(entries)) await writeFile(join(vaultDir(id), 'assets', name), data)
  await rm(join(vaultDir(id), '.asset-storage.json'), { force: true })
  await rm(join(vaultDir(id), '.asset-storage-ready'), { force: true })
}
async function importZip(data: Buffer) {
  const boundary = '----asset-namespace-boundary'
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="vault.zip"\r\nContent-Type: application/zip\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)])
  return app.inject({ method: 'POST', url: '/api/import', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
}
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  ownerId = owner.id
  cookie = await loginCookie(app, owner.email)
})
afterEach(async () => {
  setFailpointHandler(null)
  for (const id of owned.splice(0)) {
    await db.delete(vaults).where(eq(vaults.id, id))
    await rm(vaultDir(id), { recursive: true, force: true })
  }
})
afterAll(async () => { await app?.close() })

it('keeps valid assets/ notes, nested notes and same-named attachments independent through projection, HTTP and v2 ZIP import/export', async () => {
  const id = await vault()
  await createNote(id, { path: 'assets/design', body: 'Original design note.\n' })
  await createNote(id, { path: 'assets/design/overview', body: 'Nested overview.\n' })
  await writeAsset(id, 'design.md', Buffer.from('Independent attachment bytes'))
  await writeAsset(id, '.asset-storage.json', Buffer.from('A valid user attachment, not the migration journal'))
  await flushProjections()
  expect(await readFile(join(vaultDir(id), 'assets/design.md'), 'utf8')).toContain('Original design note.')
  expect((await readAsset(id, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
  const response = await app.inject({ method: 'GET', url: `/api/vaults/${id}/assets/design.md`, headers: { cookie } })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.body).toBe('Independent attachment bytes')
  expect((await readAsset(id, '.asset-storage.json'))!.buffer.toString()).toContain('valid user attachment')
  expect(await vaultMarkdownFiles(id)).toContain('assets/design.md')
  expect(await sweepOrphanFiles()).not.toContainEqual(expect.objectContaining({ vaultId: id, path: 'assets/design.md' }))
  const bytes = await buildVaultZip(id)
  const zip = new AdmZip(bytes)
  expect(JSON.parse(zip.getEntry('manifest.json')!.getData().toString()).formatVersion).toBe(2)
  expect(zip.getEntry('assets/design.md')!.getData().toString()).toContain('Original design note.')
  expect(zip.getEntry('.assets/design.md')!.getData().toString()).toBe('Independent attachment bytes')
  const imported = await importZip(bytes)
  expect(imported.statusCode, imported.body).toBe(200)
  const target = imported.json<{ vaultId: string }>().vaultId
  owned.push(target)
  await flushProjections()
  expect((await readNote(target, 'assets/design/overview'))!.body).toBe('Nested overview.\n')
  expect((await readAsset(target, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
  await updateNote(id, 'assets/design', { body: 'Changed note.\n' })
  await flushProjections()
  expect((await readAsset(id, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
  await softDeleteNote(id, 'assets/design')
  await flushProjections()
  expect((await readAsset(id, 'design.md'))!.buffer.toString()).toBe('Independent attachment bytes')
})

it('copies known projected files, moves other verified legacy assets and durably records independently verifiable counts/checksums BEFORE the real projector drains', async () => {
  const id = await vault()
  await createNote(id, { path: 'assets/design', body: 'DB design note is authoritative.\n' })
  await createNote(id, { path: 'assets/design/overview', body: 'Nested DB note.\n' })
  await flushProjections()
  await legacy(id, { 'design.md': 'Legacy attachment occupying the note projection', 'image.png': 'Legacy binary bytes', '.hidden': 'Legacy hidden attachment' })
  const names = (await readdir(join(vaultDir(id), 'assets'), { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort()
  const before = new Map(await Promise.all(names.map(async name => [name, await readFile(join(vaultDir(id), 'assets', name))] as const)))
  const [report] = await runAssetStorage('migrate', id)
  expect(report!.state).toBe('complete')
  expect(report!.before.files).toBe(before.size)
  expect(report!.before.bytes).toBe([...before.values()].reduce((sum, data) => sum + data.length, 0))
  const expected = hash(names.map(name => `${name}\0${before.get(name)!.length}\0${hash(before.get(name)!)}\n`).join(''))
  expect(report!.before.sha256).toBe(expected)
  expect(report!.migrated).toEqual(report!.before)
  expect(report!.current).toEqual(report!.before)
  for (const [name, data] of before) expect(await readFile(storedAssetFile(id, name))).toEqual(data)
  expect(await readFile(join(vaultDir(id), 'assets/design.md'), 'utf8')).toContain('Legacy attachment') // COPY, not steal.
  await expect(readFile(join(vaultDir(id), 'assets/image.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  await flushProjections()
  expect(await readFile(join(vaultDir(id), 'assets/design.md'), 'utf8')).toContain('DB design note is authoritative.')
  expect((await readAsset(id, 'design.md'))!.buffer.toString()).toBe('Legacy attachment occupying the note projection')
  expect((await runAssetStorage('verify', id))[0]!.baselineVerified).toBe(true)
  expect((await runAssetStorage('migrate', id))[0]!.before).toEqual(report!.before)
})

it.each(['assets.after-plan', 'assets.after-copy', 'assets.after-unlink'])('resumes a real SIGKILL at %s without losing originals, acknowledging an incomplete migration, or clobbering bytes', async point => {
  const id = await vault()
  await legacy(id, { 'one.txt': 'First original', 'two.txt': 'Second original' })
  let killed: unknown
  try { await sh(process.execPath, ['--import', loader, 'src/scripts/asset-storage.ts', 'migrate', id], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: config.databaseUrl, DATA_DIR: config.dataDir, ELARA_FAILPOINTS: point }, timeout: 20_000 }) } catch (err) { killed = err }
  expect(killed).toMatchObject({ signal: 'SIGKILL' })
  const pending = JSON.parse(await readFile(join(vaultDir(id), '.asset-storage.json'), 'utf8'))
  expect(pending.state).toBe('pending')
  await expect(readFile(join(vaultDir(id), '.asset-storage-ready'))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const [name, text] of Object.entries({ 'one.txt': 'First original', 'two.txt': 'Second original' })) {
    const source = await readFile(join(vaultDir(id), 'assets', name)).catch(() => null)
    const dest = await readFile(storedAssetFile(id, name)).catch(() => null)
    expect(source?.toString() === text || dest?.toString() === text).toBe(true)
  }
  const [resumed] = await runAssetStorage('migrate', id)
  expect(resumed!.baselineVerified).toBe(true)
  expect(resumed!.migrated).toEqual(resumed!.before)
  expect((await readAsset(id, 'one.txt'))!.buffer.toString()).toBe('First original')
  await expect(readFile(join(vaultDir(id), '.asset-migration-work'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)

it('refuses differing destination bytes on resume and preserves both versions until an operator separates them', async () => {
  const id = await vault()
  await legacy(id, { 'proof.txt': 'Original legacy bytes' })
  await mkdir(assetDirectory(id), { recursive: true })
  await writeFile(storedAssetFile(id, 'proof.txt'), 'Unrelated destination bytes')
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('destination differs')
  expect(await readFile(join(vaultDir(id), 'assets/proof.txt'), 'utf8')).toBe('Original legacy bytes')
  expect(await readFile(storedAssetFile(id, 'proof.txt'), 'utf8')).toBe('Unrelated destination bytes')
  await rename(storedAssetFile(id, 'proof.txt'), join(vaultDir(id), '.owner-kept-destination'))
  expect((await runAssetStorage('migrate', id))[0]!.baselineVerified).toBe(true)
  expect(await readFile(join(vaultDir(id), '.owner-kept-destination'), 'utf8')).toBe('Unrelated destination bytes')
})

it('rolls back without clobbering projected notes or new/changed bytes, and resumes an interrupted rollback with reviewable preserved collisions', async () => {
  const id = await vault()
  await createNote(id, { path: 'assets/design', body: 'Keep this DB note.\n' })
  await flushProjections()
  await legacy(id, { 'design.md': 'Old attachment', 'ordinary.txt': 'Old ordinary' })
  await runAssetStorage('migrate', id)
  await flushProjections()
  await writeAsset(id, 'design.md', Buffer.from('Changed attachment after upgrade'))
  await writeAsset(id, 'new.txt', Buffer.from('New attachment after upgrade'))
  await writeFile(join(vaultDir(id), 'assets/ordinary.txt'), 'Do not overwrite these unrelated new legacy bytes')
  setFailpointHandler(name => { if (name === 'assets.rollback-after-copy') throw new Error('interrupted rollback') })
  await expect(runAssetStorage('rollback', id)).rejects.toThrow('interrupted rollback')
  setFailpointHandler(null)
  const [result] = await runAssetStorage('rollback', id)
  expect(result!.conflicts).toEqual(expect.arrayContaining(['design.md', 'ordinary.txt']))
  let refused: unknown
  try { await sh(process.execPath, ['--import', loader, 'src/scripts/asset-storage.ts', 'rollback', id], { env: { ...process.env, DATABASE_URL: config.databaseUrl, DATA_DIR: config.dataDir, ELARA_FAILPOINTS: '' }, timeout: 20_000 }) } catch (err) { refused = err }
  expect(refused).toMatchObject({ code: 2 })
  expect(await readFile(join(vaultDir(id), 'assets/design.md'), 'utf8')).toContain('Keep this DB note.')
  expect(await readFile(join(vaultDir(id), 'assets/ordinary.txt'), 'utf8')).toContain('unrelated new legacy')
  expect(await readFile(join(vaultDir(id), 'assets/new.txt'), 'utf8')).toBe('New attachment after upgrade')
  expect(await readFile(storedAssetFile(id, 'design.md'), 'utf8')).toBe('Changed attachment after upgrade')
  const recovery = await readdir(join(vaultDir(id), '.asset-rollback'))
  expect(await readFile(join(vaultDir(id), '.asset-rollback', recovery.find(name => name.startsWith('design.md.'))!), 'utf8')).toBe('Changed attachment after upgrade')
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('was rolled back')
})

it('refuses legacy symlinks and a symlinked destination before retiring any original bytes', async () => {
  const id = await vault()
  await legacy(id, { 'safe.txt': 'Original' })
  await symlink(join(vaultDir(id), 'assets/safe.txt'), join(vaultDir(id), 'assets/evil.txt'))
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('unsafe legacy asset')
  await rm(join(vaultDir(id), 'assets/evil.txt'))
  await symlink(join(vaultDir(id), 'assets'), assetDirectory(id))
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('not a real directory')
  expect(await readFile(join(vaultDir(id), 'assets/safe.txt'), 'utf8')).toBe('Original')
})

it('uses the real exclusive maintenance fence to refuse migration while another app/writer holds the shared fence', async () => {
  const id = await vault()
  await legacy(id, { 'proof.txt': 'Original' })
  const lock = await holdInstanceLock('shared')
  try { await expect(runAssetStorage('migrate', id)).rejects.toBeInstanceOf(MaintenanceInProgressError) } finally { await lock.release() }
  expect(await readFile(join(vaultDir(id), 'assets/proof.txt'), 'utf8')).toBe('Original')
  expect((await runAssetStorage('migrate', id))[0]!.baselineVerified).toBe(true)
})

it('imports safe legacy ZIP attachments, but rejects ambiguous legacy note/asset claims and actual duplicate ZIP paths before creating a vault', async () => {
  const old = new AdmZip()
  old.addFile('manifest.json', Buffer.from(JSON.stringify({ formatVersion: 1, name: 'legacy' })))
  old.addFile('docs/guide.md', Buffer.from('---\ntype: docs\n---\nLegacy guide\n'))
  old.addFile('assets/readme.md', Buffer.from('Plain attachment, not an OKF note'))
  const imported = await importZip(old.toBuffer())
  expect(imported.statusCode, imported.body).toBe(200)
  const oldId = imported.json<{ vaultId: string }>().vaultId
  owned.push(oldId)
  expect((await readAsset(oldId, 'readme.md'))!.buffer.toString()).toContain('Plain attachment')
  const id = await vault()
  await createNote(id, { path: 'assets/design', body: 'Actual note' })
  await writeAsset(id, 'design.md', Buffer.from('Attachment'))
  const zip = new AdmZip(await buildVaultZip(id))
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify({ formatVersion: 1 })))
  zip.deleteFile('.assets/design.md')
  const before = (await db.select({ id: vaults.id }).from(vaults)).length
  const refused = await importZip(zip.toBuffer())
  expect(refused.statusCode, refused.body).toBe(400)
  expect(refused.body).toContain('ambiguous legacy')
  const duplicate = new AdmZip()
  duplicate.addFile('manifest.json', Buffer.from('{"formatVersion":2}'))
  duplicate.addFile('docs/one.md', Buffer.from('one'))
  duplicate.addFile('docs/two.md', Buffer.from('two'))
  const crafted = Buffer.from(duplicate.toBuffer().toString('latin1').replaceAll('docs/two.md', 'docs/one.md'), 'latin1')
  expect(() => new AdmZip(crafted).getEntries()).toThrow('Duplicate entry name')
  expect((await importZip(crafted)).statusCode).toBe(400)
  expect((await db.select({ id: vaults.id }).from(vaults)).length).toBe(before)
})

it('refuses new or changed legacy bytes outside a pending durable plan without deleting either version', async () => {
  const id = await vault()
  await legacy(id, { 'proof.txt': 'Verified backup original' })
  setFailpointHandler(name => { if (name === 'assets.after-plan') throw new Error('planned interruption') })
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('planned interruption')
  setFailpointHandler(null)
  await writeFile(join(vaultDir(id), 'assets/new.txt'), 'Keep newly arrived bytes')
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('outside the durable plan')
  expect(await readFile(join(vaultDir(id), 'assets/new.txt'), 'utf8')).toBe('Keep newly arrived bytes')
  await rename(join(vaultDir(id), 'assets/new.txt'), join(vaultDir(id), '.owner-kept-new'))
  await writeFile(join(vaultDir(id), 'assets/proof.txt'), 'Keep changed source bytes')
  await expect(runAssetStorage('migrate', id)).rejects.toThrow('legacy source changed')
  await rename(join(vaultDir(id), 'assets/proof.txt'), join(vaultDir(id), '.owner-kept-changed'))
  await writeFile(join(vaultDir(id), 'assets/proof.txt'), 'Verified backup original')
  expect((await runAssetStorage('migrate', id))[0]!.baselineVerified).toBe(true)
  expect(await readFile(join(vaultDir(id), '.owner-kept-new'), 'utf8')).toBe('Keep newly arrived bytes')
  expect(await readFile(join(vaultDir(id), '.owner-kept-changed'), 'utf8')).toBe('Keep changed source bytes')
})

it('the real offline rollback CLI restores unambiguous new/changed attachment bytes, keeps hidden copies and safely repeats', async () => {
  const id = await vault()
  await legacy(id, { 'proof.txt': 'Before upgrade' })
  await runAssetStorage('migrate', id)
  await writeAsset(id, 'proof.txt', Buffer.from('Changed after upgrade'))
  await writeAsset(id, 'new.txt', Buffer.from('New after upgrade'))
  const result = await sh(process.execPath, ['--import', loader, 'src/scripts/asset-storage.ts', 'rollback', id], { env: { ...process.env, DATABASE_URL: config.databaseUrl, DATA_DIR: config.dataDir, ELARA_FAILPOINTS: '' }, timeout: 20_000 })
  expect(JSON.parse(result.stdout)[0]).toMatchObject({ state: 'rolled-back', conflicts: [], changed: ['proof.txt'], added: ['new.txt'] })
  expect(await readFile(join(vaultDir(id), 'assets/proof.txt'), 'utf8')).toBe('Changed after upgrade')
  expect(await readFile(join(vaultDir(id), 'assets/new.txt'), 'utf8')).toBe('New after upgrade')
  expect(await readFile(storedAssetFile(id, 'proof.txt'), 'utf8')).toBe('Changed after upgrade')
  expect((await runAssetStorage('rollback', id))[0]!.conflicts).toEqual([])
})

it('republishes readiness after a real SIGKILL between complete-journal fsync and marker publication, restoring assets/ note classification', async () => {
  const id = await vault()
  await createNote(id, { path: 'assets/design', body: 'A valid note after recovery.\n' })
  await flushProjections()
  await legacy(id, { 'image.png': 'Durable attachment at completion' })
  let killed: unknown
  try { await sh(process.execPath, ['--import', loader, 'src/scripts/asset-storage.ts', 'migrate', id], { env: { ...process.env, DATABASE_URL: config.databaseUrl, DATA_DIR: config.dataDir, ELARA_FAILPOINTS: 'assets.after-complete-journal' }, timeout: 20_000 }) } catch (err) { killed = err }
  expect(killed).toMatchObject({ signal: 'SIGKILL' })
  expect(JSON.parse(await readFile(join(vaultDir(id), '.asset-storage.json'), 'utf8')).state).toBe('complete')
  await expect(readFile(join(vaultDir(id), '.asset-storage-ready'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await vaultMarkdownFiles(id)).not.toContain('assets/design.md')
  const [unready] = await runAssetStorage('verify', id)
  expect(unready).toMatchObject({ state: 'complete', baselineVerified: true, ready: false })
  let refused: unknown
  try { await sh(process.execPath, ['--import', loader, 'src/scripts/asset-storage.ts', 'verify', id], { env: { ...process.env, DATABASE_URL: config.databaseUrl, DATA_DIR: config.dataDir, ELARA_FAILPOINTS: '' }, timeout: 20_000 }) } catch (err) { refused = err }
  expect(refused).toMatchObject({ code: 2 })
  expect((await runAssetStorage('migrate', id))[0]).toMatchObject({ state: 'complete', baselineVerified: true, ready: true })
  expect(await vaultMarkdownFiles(id)).toContain('assets/design.md')
  await flushProjections()
  expect(await readFile(join(vaultDir(id), 'assets/design.md'), 'utf8')).toContain('A valid note after recovery.')
  await writeFile(join(vaultDir(id), 'assets/stray.md'), 'Unowned modern note bytes.\n')
  expect((await sweepOrphanFiles()).filter(item => item.vaultId === id)).toContainEqual(expect.objectContaining({ path: 'assets/stray.md' }))
  expect(await readFile(join(vaultDir(id), '.orphans/assets/stray.md'), 'utf8')).toBe('Unowned modern note bytes.\n')
  expect((await readAsset(id, 'image.png'))!.buffer.toString()).toBe('Durable attachment at completion')
}, 30_000)
