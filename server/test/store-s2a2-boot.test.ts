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
import { createNote, renameNote } from '../src/notes/store.js'
import { flushProjections, renderNoteFile, sweepOrphanFiles, verifyAllProjections } from '../src/notes/projector.js'
import { MaintenanceInProgressError, holdInstanceLock } from '../src/notes/maintenance-lock.js'
import { exportLegacyFiles } from '../src/notes/store-export.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 S2a-2: boot step 7 (verify every file projection after an unclean
// or unknown shutdown), boot step 9 (orphan sweep to .orphans/) and the
// stopped-server files-only export for a code-only rollback (§9).

let app: FastifyInstance
let vaultId: string
const other = postgres(config.databaseUrl, { max: 1, onnotice: () => {} })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2a-2 boot vault' } })).json().id
})

afterEach(async () => {
  await other`SELECT pg_advisory_unlock_all()`
  await flushProjections()
})

afterAll(async () => {
  await other.end()
  await app.close()
})

const file = (...parts: string[]) => join(config.dataDir, 'vaults', vaultId, ...parts)
const exists = (path: string) => stat(path).then(() => true, () => false)
const agent = () => ({ type: 'mcp' as const, id: randomUUID() })

async function rendered(noteId: string): Promise<string> {
  const [row] = (await db.execute(sql`SELECT frontmatter, frontmatter_src, body FROM notes WHERE id = ${noteId}`)) as unknown as Array<{
    frontmatter: unknown
    frontmatter_src: unknown
    body: string
  }>
  return renderNoteFile({ frontmatter: row!.frontmatter, frontmatterSrc: row!.frontmatter_src, body: row!.body })
}

async function conflictCopiesOf(name: string): Promise<string[]> {
  const entries = await readdir(file('.conflicts', 'docs')).catch(() => [] as string[])
  return entries.filter((entry) => entry.startsWith(`${name}.`))
}

describe('boot step 7: verify after an unclean shutdown (§7)', () => {
  it('a file a power loss truncated is conflict-copied and rewritten; intact files keep their bytes', async () => {
    const torn = await createNote(vaultId, { type: 'docs', name: 'torn', body: 'whole body' })
    const intact = await createNote(vaultId, { type: 'docs', name: 'intact', body: 'fine' })
    await flushProjections()
    await writeFile(file('docs/torn.md'), '')
    const before = await readFile(file('docs/intact.md'))
    expect(await verifyAllProjections()).toBeGreaterThanOrEqual(2)
    await flushProjections()
    expect(await readFile(file('docs/torn.md'), 'utf8')).toBe(await rendered(torn.id))
    expect(await conflictCopiesOf('torn')).toHaveLength(1)
    expect((await readFile(file('docs/intact.md'))).equals(before)).toBe(true)
    expect(await conflictCopiesOf('intact')).toHaveLength(0)
    expect(intact.id).toBeTruthy()
  })
})

describe('boot step 9: orphan sweep (§7)', () => {
  it('moves only *.md files without an owner to .orphans/, outside assets/ and dot-directories', async () => {
    await createNote(vaultId, { type: 'docs', name: 'owned', body: 'mine' })
    await flushProjections()
    // Owned by the live note even without a projected_files row (e.g. written by old code).
    await db.execute(sql`DELETE FROM projected_files WHERE vault_id = ${vaultId} AND path = 'docs/owned.md'`)
    await mkdir(file('stray'), { recursive: true })
    await mkdir(file('assets'), { recursive: true })
    await mkdir(file('.conflicts'), { recursive: true })
    await writeFile(file('stray.md'), 'no owner\n')
    await writeFile(file('stray/deep.md'), 'no owner either\n')
    await writeFile(file('stray/notes.txt'), 'not markdown\n')
    await writeFile(file('assets/readme.md'), 'an attachment\n')
    await writeFile(file('.conflicts/kept.md'), 'a conflict copy\n')
    const moved = (await sweepOrphanFiles()).filter((o) => o.vaultId === vaultId)
    expect(moved.map((o) => o.path).sort()).toEqual(['stray.md', 'stray/deep.md'])
    expect(await readFile(file('.orphans/stray.md'), 'utf8')).toBe('no owner\n')
    expect(await readFile(file('.orphans/stray/deep.md'), 'utf8')).toBe('no owner either\n')
    expect(await exists(file('stray.md'))).toBe(false)
    for (const kept of ['docs/owned.md', 'docs/index.md', 'stray/notes.txt', 'assets/readme.md', '.conflicts/kept.md']) {
      expect(await exists(file(kept)), kept).toBe(true)
    }
    // A second sweep finds nothing new and never re-sweeps .orphans/.
    expect((await sweepOrphanFiles()).filter((o) => o.vaultId === vaultId)).toEqual([])
    await rm(file('stray'), { recursive: true, force: true })
  })
})

describe('store-export-legacy (§9)', () => {
  it('is refused while a server or writing CLI holds the shared lock', async () => {
    const server = await holdInstanceLock('shared')
    try {
      await expect(exportLegacyFiles()).rejects.toBeInstanceOf(MaintenanceInProgressError)
    } finally {
      await server.release()
    }
  })

  it('renders every pending file, index.md and rename refactor from the rows, then reports ok', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'export-me', body: 'from the row' })
    await createNote(vaultId, { type: 'docs', name: 'export-ref', body: 'see [[docs/export-me]]' })
    await renameNote(vaultId, 'docs/export-me', 'export-moved', agent())
    // Rows changed around the store (manual SQL) and files left behind.
    await db.execute(sql`UPDATE notes SET body = 'changed by SQL' WHERE id = ${note.id}`)
    await rm(file('docs/export-moved.md'), { force: true })
    const report = await exportLegacyFiles()
    expect(report.ok).toBe(true)
    expect(report.pending).toEqual([])
    expect(report.pendingJobs).toEqual([])
    expect(await readFile(file('docs/export-moved.md'), 'utf8')).toBe(await rendered(note.id))
    expect(await readFile(file('docs/export-moved.md'), 'utf8')).toContain('changed by SQL')
    expect(await readFile(file('docs/export-ref.md'), 'utf8')).toContain('[[docs/export-moved]]')
    expect(await readFile(file('docs/index.md'), 'utf8')).toContain('export-moved')
    expect(JSON.parse(await readFile(report.reportFile, 'utf8')).kind).toBe('adr-003-store-export-legacy')
    // The lock is released: a server can start again.
    await (await holdInstanceLock('shared')).release()
  })
})
