import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { runDoctor, type DoctorReport } from '../src/notes/doctor.js'
import { flushProjections } from '../src/notes/projector.js'
import { runStoreBackfill } from '../src/notes/store-reconcile.js'
import { createNote, noteFile, vaultDir } from '../src/notes/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #908: right after the step B upgrade the doctor must say what is wrong, not
// what the upgrade did by design. The S2a backfill keeps an unparseable file in
// `.migration/<date>/unparseable/` and the projector conflict-copies the same
// bytes to `.conflicts/` before rewriting it: information, not a problem.
// Link rows an older extractor wrote (before GRAPH-09 stripped code spans) are
// a real inconsistency that `--repair` fixes: "repair available" (exit 3), not
// "broken" (exit 1).

let app: FastifyInstance
let vaultId: string
const ids: Record<string, string> = {}
const GARBLED = '## no frontmatter fence, written by hand\n'

const doctor = () => runDoctor({ vaultId })
const cli = (...args: string[]) =>
  promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/doctor.ts', '--vault', vaultId, ...args], {
    cwd: join(import.meta.dirname, '..'),
    env: process.env,
  }).then(
    (out) => ({ code: 0, out: out.stdout + out.stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }),
  )

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Upgrade doctor vault' } })).json().id
  ids.garbled = (await createNote(vaultId, { path: 'upgrade/garbled', body: 'the row text\n' })).id
  ids.linked = (await createNote(vaultId, { path: 'upgrade/linked', body: 'see [[upgrade/garbled]] and `[[repo:chapters/server]]`\n' })).id
  await flushProjections()
  await flushEmbeddings()
  // The state step A found on production: an unparseable file the S2a backfill had not processed yet ...
  await writeFile(noteFile(vaultId, 'upgrade/garbled'), GARBLED)
  await db.execute(sql`DELETE FROM note_projections WHERE note_id = ${ids.garbled}`)
  await db.execute(sql`DELETE FROM projected_files WHERE vault_id = ${vaultId} AND path = 'upgrade/garbled.md'`)
  // ... and a link row the extractor before GRAPH-09 wrote for a wikilink inside backticks.
  await db.execute(sql`INSERT INTO note_links (source_note_id, target_path) VALUES (${ids.linked}, 'repo:chapters/server')`)
  // The S2a migration, as the step A boot runs it, then the projector rewriting the file.
  await runStoreBackfill()
  await flushProjections()
})

afterAll(async () => {
  await rm(join(vaultDir(vaultId), '.conflicts'), { recursive: true, force: true })
  await rm(join(vaultDir(vaultId), '.migration'), { recursive: true, force: true })
  await app.close()
})

describe('doctor right after the upgrade (#908)', () => {
  it("lists the S2a migration's own conflict copy as info and old link rows as repairable: exit 3, then 0 after --repair", async () => {
    const copies = await readdir(join(vaultDir(vaultId), '.conflicts', 'upgrade'))
    expect(copies).toEqual([expect.stringMatching(/^garbled\.\d{8}T\d{9}Z\.md$/)])
    expect(await readFile(join(vaultDir(vaultId), '.conflicts', 'upgrade', copies[0]!), 'utf8')).toBe(GARBLED)
    const copy = `.conflicts/upgrade/${copies[0]}`

    const report = await doctor()
    expect(report.problems.map((p) => [p.class, p.path, p.repairable])).toEqual([['links-differ', 'upgrade/linked', true]])
    expect(report.problems[0]!.detail).toBe('missing [], extra [repo:chapters/server]')
    expect(report.info).toEqual([
      expect.objectContaining({ kind: 'migration-copy', vaultId, path: copy, detail: expect.stringMatching(/\.migration\/\d{4}-\d{2}-\d{2}\/unparseable\/upgrade\/garbled\.md/) }),
    ])
    expect(report.status).toBe('repairable')

    const first = await cli()
    expect(first.out).toContain(`INFO migration-copy  Upgrade doctor vault (${vaultId})  ${copy}`)
    expect(first.out).toContain('PROBLEM links-differ')
    expect(first.code).toBe(3)
    const repair = await cli('--repair')
    expect(repair.out).toContain('[repair queued]')
    expect(repair.code).toBe(3)
    const after = await cli()
    expect(after.out).not.toContain('PROBLEM')
    expect(after.out).toContain('INFO migration-copy')
    expect(after.out).toMatch(/: 0 problem\(s\), 0 pending, 1 info$/m)
    expect(after.code).toBe(0)
    const clean = await doctor()
    expect([clean.ok, clean.status, clean.problems]).toEqual([true, 'ok', []])
    // Three CLI processes (tsx start-up each): slow on a loaded machine.
  }, 60_000)

  it('any other conflict copy is still a problem that needs a person: exit 1', async () => {
    const hand = '.conflicts/upgrade/garbled.20261021T000000000Z.md'
    await writeFile(join(vaultDir(vaultId), hand), 'bytes a hand edit left')
    // Only the conflict copies: this test does not depend on the links the first one repaired.
    const copies = (report: DoctorReport) => report.problems.filter((p) => p.path.startsWith('.conflicts/')).map((p) => [p.class, p.path, p.repairable])
    const report = await doctor()
    expect(copies(report)).toEqual([['conflict-copy', hand, false]])
    expect(report.info).toHaveLength(1)
    expect(report.status).toBe('broken')
    expect((await cli()).code).toBe(1)
    await rm(join(vaultDir(vaultId), hand))
    // Without the migration's own copy in `.migration/`, nothing says the projector's copy is the migration's.
    await rm(join(vaultDir(vaultId), '.migration'), { recursive: true })
    const unkept = await doctor()
    expect(copies(unkept).map(([cls]) => cls)).toEqual(['conflict-copy'])
    expect(unkept.info).toEqual([])
    expect(unkept.status).toBe('broken')
  }, 60_000)
})
