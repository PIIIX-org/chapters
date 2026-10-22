import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { runDoctor } from '../src/notes/doctor.js'
import { INSTANCE_LOCK_KEY, MaintenanceInProgressError, holdsExclusiveLock } from '../src/notes/maintenance-lock.js'
import { flushProjections } from '../src/notes/projector.js'
import { rowsFromFiles } from '../src/notes/rows-from-files.js'
import { withKeyLock } from '../src/notes/key-lock.js'
import { createNote, getLiveNote, noteFile, noteLock, trashFile, vaultDir } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 Q9 default (S6, #495): the last-resort import that rebuilds note
// rows from the .md files.

let app: FastifyInstance
let vaultId: string
let ownerEmail: string
const other = postgres(config.databaseUrl, { max: 1, onnotice: () => {} })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  ownerEmail = owner.email
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Rows-from-files vault' } })).json().id
  for (const name of ['kept', 'lost', 'edited']) {
    await createNote(vaultId, { path: `recover/${name}`, frontmatter: { status: 'draft', title: name }, body: `${name} body` })
  }
  await flushProjections()
})

afterEach(async () => {
  await other`SELECT pg_advisory_unlock_all()`
})

afterAll(async () => {
  await other.end()
  await app.close()
})

async function writeVaultFile(vault: string, rel: string, bytes: string): Promise<void> {
  await mkdir(join(vaultDir(vault), rel, '..'), { recursive: true })
  await writeFile(join(vaultDir(vault), rel), bytes)
}

/** Drops a note row as a lost database would, leaving its file. */
async function loseRow(path: string): Promise<void> {
  await db.execute(sql`DELETE FROM notes WHERE vault_id = ${vaultId} AND path = ${path}`)
}

describe('rows-from-files', () => {
  it('dry run: lists the rows it would create and writes nothing', async () => {
    await loseRow('recover/lost')
    const report = await rowsFromFiles({ dryRun: true, vaultId })
    expect(report.created).toEqual([{ vaultId, path: 'recover/lost' }])
    expect(report.unchanged).toBe(2)
    expect(report.skipped).toEqual([{ vaultId, path: 'recover/index.md', reason: 'generated index' }])
    expect(report.differs).toEqual([])
    expect(report.failed).toEqual([])
    expect(await getLiveNote(vaultId, 'recover/lost')).toBeNull()
  })

  it('refuses to run while a server or writing CLI holds the shared instance lock', async () => {
    await other`SELECT pg_advisory_lock_shared(${INSTANCE_LOCK_KEY.toString()}::bigint)`
    await expect(rowsFromFiles({ vaultId })).rejects.toBeInstanceOf(MaintenanceInProgressError)
    expect(await getLiveNote(vaultId, 'recover/lost')).toBeNull()
    // The dry run reads only: it takes no lock.
    expect((await rowsFromFiles({ dryRun: true, vaultId })).created).toHaveLength(1)
  })

  it('creates the missing row from the file, adopts the file as it is, and never overwrites a row that differs', async () => {
    const lostBytes = await readFile(noteFile(vaultId, 'recover/lost'), 'utf8')
    const editedFile = noteFile(vaultId, 'recover/edited')
    await writeFile(editedFile, (await readFile(editedFile, 'utf8')).replace('edited body', 'edited by hand'))
    const report = await rowsFromFiles({ vaultId })
    expect(report.created).toEqual([{ vaultId, path: 'recover/lost' }])
    expect(report.differs).toEqual([
      { vaultId, path: 'recover/edited.md', detail: expect.stringContaining('body-mismatch') },
    ])
    const lost = await getLiveNote(vaultId, 'recover/lost')
    expect(lost).toMatchObject({ body: 'lost body', frontmatter: expect.objectContaining({ title: 'lost', status: 'draft' }) })
    expect(await readFile(noteFile(vaultId, 'recover/lost'), 'utf8')).toBe(lostBytes)
    expect((await getLiveNote(vaultId, 'recover/edited'))!.body).toBe('edited body')
    // The rebuilt note is consistent everywhere but the hand-edited file the import left alone.
    const doctor = await runDoctor({ vaultId })
    expect(doctor.problems.map((p) => `${p.class} ${p.path}`)).toEqual(
      expect.arrayContaining(['file-differs recover/edited.md']),
    )
    expect(doctor.problems.filter((p) => p.path.startsWith('recover/lost'))).toEqual(
      doctor.problems.filter((p) => p.path.startsWith('recover/lost') && p.class === 'vector-missing'),
    )
    // Leave the vault intact for the CI check-notes gate.
    await writeFile(editedFile, (await readFile(editedFile, 'utf8')).replace('edited by hand', 'edited body'))
  })

  it('a vault directory without a vault row: skipped, or recreated for --owner', async () => {
    const lostVault = randomUUID()
    await mkdir(join(vaultDir(lostVault), 'notes'), { recursive: true })
    // No `timestamp`: legitimate (it is optional), and the import must not add one.
    const foundBytes = '---\ntype: notes\ntitle: found\n---\nfound body\n'
    await writeFile(join(vaultDir(lostVault), 'notes/found.md'), foundBytes)
    await writeVaultFile(lostVault, '.crdt/notes/found.bin', 'stale editor state')
    const skipped = await rowsFromFiles({ vaultId: lostVault })
    expect(skipped.vaultsSkipped).toEqual([{ vaultId: lostVault, reason: expect.stringContaining('--owner') }])
    expect(skipped.created).toEqual([])

    const report = await rowsFromFiles({ vaultId: lostVault, ownerEmail })
    expect(report.vaultsCreated).toEqual([lostVault])
    expect(report.created).toEqual([{ vaultId: lostVault, path: 'notes/found' }])
    const found = (await getLiveNote(lostVault, 'notes/found'))!
    expect(found.body).toBe('found body\n')
    expect(found.frontmatter).toEqual({ type: 'notes', title: 'found' })
    // Adopted byte for byte: no conflict copy, no rewrite.
    expect(await readFile(join(vaultDir(lostVault), 'notes/found.md'), 'utf8')).toBe(foundBytes)
    expect(await stat(join(vaultDir(lostVault), '.conflicts')).then(() => true, () => false)).toBe(false)
    // The bin beside the recreated row is listed.
    expect(report.crdtBins).toEqual([{ vaultId: lostVault, path: '.crdt/notes/found.bin' }])
    const [vault] = (await db.execute(sql`SELECT name FROM vaults WHERE id = ${lostVault}`)) as unknown as Array<{ name: string }>
    expect(vault!.name).toBe(`Restored ${lostVault.slice(0, 8)}`)
    await db.execute(sql`DELETE FROM vaults WHERE id = ${lostVault}`)
    await rm(vaultDir(lostVault), { recursive: true, force: true })
  })

  it('never resurrects a note whose rename or trash move was committed but not yet projected', async () => {
    const moved = await createNote(vaultId, { path: 'moving/old', frontmatter: { title: 'old' }, body: 'renamed' })
    const trashed = await createNote(vaultId, { path: 'moving/gone', frontmatter: { title: 'gone' }, body: 'trashed' })
    await flushProjections()
    // The server stopped after these commits, before the projector moved the files.
    await db.execute(sql`UPDATE notes SET path = 'moving/new', name = 'new' WHERE id = ${moved.id}`)
    await db.execute(sql`UPDATE notes SET deleted_at = now() WHERE id = ${trashed.id}`)
    await db.execute(sql`
      UPDATE note_projections p SET target_seq = n.seq FROM notes n
      WHERE p.note_id = n.id AND n.id IN (${moved.id}, ${trashed.id}) AND p.projection IN ('file', 'dir_index')`)

    const dry = await rowsFromFiles({ dryRun: true, vaultId })
    expect(dry.created).toEqual([])

    const report = await rowsFromFiles({ vaultId })
    expect(report.created).toEqual([])
    expect(await getLiveNote(vaultId, 'moving/old')).toBeNull()
    expect(await getLiveNote(vaultId, 'moving/gone')).toBeNull()
    const [count] = (await db.execute(sql`
      SELECT count(*)::int AS live FROM notes WHERE vault_id = ${vaultId} AND path LIKE 'moving/%' AND deleted_at IS NULL`)) as unknown as Array<{
      live: number
    }>
    expect(count!.live).toBe(1)
    // The drain moved the files where the rows say.
    expect((await readdir(join(vaultDir(vaultId), 'moving'))).sort()).toEqual(['index.md', 'new.md'])
    expect(await stat(trashFile(vaultId, trashed.id)).then(() => true, () => false)).toBe(true)
  })

  it('stops with an error when its exclusive lock is lost during the run, even within one vault', async () => {
    await loseRow('recover/lost')
    // Hold the import inside its createNote, then cut the lock's connection.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const blocking = new Promise<void>((resolve) => (entered = resolve))
    const blocker = withKeyLock(noteLock(vaultId, 'recover/lost'), async () => {
      entered()
      await held
    })
    await blocking
    const run = rowsFromFiles({ vaultId })
    run.catch(() => {})
    const lockPids = () => other<Array<{ pid: number }>>`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ExclusiveLock'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND ((classid::bigint << 32) | objid::bigint) = ${INSTANCE_LOCK_KEY.toString()}::bigint`
    let pids = await lockPids()
    while (pids.length === 0) pids = await lockPids()
    await other`SELECT pg_terminate_backend(${pids[0]!.pid})`
    // The import sees the loss once the lock module has (it clears the exclusive flag before onLost).
    while (holdsExclusiveLock()) await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await blocker
    await expect(run).rejects.toThrow(/lock was lost/)
    await flushProjections()
  })
})
