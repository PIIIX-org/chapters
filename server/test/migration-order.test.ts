// Drizzle's migrator applies a journal entry only when its `when` is above
// the newest `created_at` already recorded in `drizzle.__drizzle_migrations`.
// A migration merged after a later-numbered one (0026 after 0027, #501)
// must therefore carry a larger `when`, or an instance that already applied
// the later one skips it for good. This builds that instance (every
// migration except 0026), runs the real journal on it, and checks 0026 ran.
import { afterAll, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../src/config.js'
import { sql } from '../src/db/client.js'

interface Entry {
  idx: number
  when: number
  tag: string
}

const source = join(import.meta.dirname, '..', 'drizzle')
const name = `${new URL(config.databaseUrl).pathname.slice(1)}_migration_order`
const url = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).toString()
let partial: string | undefined

afterAll(async () => {
  await sql.unsafe(`drop database if exists "${name}" with (force)`)
  if (partial) await rm(partial, { recursive: true, force: true })
})

describe('migration order (journal `when`)', { timeout: 60_000 }, () => {
  it('every journal entry has a .sql file, and tags are unique', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] }
    const files = new Set(await readdir(source))
    for (const e of journal.entries) expect(files.has(`${e.tag}.sql`), e.tag).toBe(true)
    expect(new Set(journal.entries.map((e) => e.tag)).size).toBe(journal.entries.length)
  })

  it('an instance that applied 0027 before 0026 existed applies 0026 at its next start', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] }
    const compaction = journal.entries.find((e) => e.tag === '0026_revision_compaction')!
    // The release before #501: the same journal without 0026.
    partial = await mkdtemp(join(tmpdir(), 'migration-order-'))
    const before = { ...journal, entries: journal.entries.filter((e) => e !== compaction) }
    expect(before.entries.some((e) => e.tag === '0027_security_event_order')).toBe(true)
    await mkdir(join(partial, 'meta'))
    await writeFile(join(partial, 'meta', '_journal.json'), JSON.stringify(before))
    for (const e of before.entries) await copyFile(join(source, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
    const client = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: partial })
      const has = async () =>
        (await client`select 1 from information_schema.columns where table_name = 'note_revisions' and column_name = 'body_delta'`).length > 0
      expect(await has()).toBe(false)
      // The next release starts with the real journal.
      await migrate(drizzle(client), { migrationsFolder: source })
      expect(await has()).toBe(true)
      const [fn] = await client`select to_regproc('note_revision_patch') is not null as ok`
      expect(fn!.ok).toBe(true)
    } finally {
      await client.end()
    }
  })
})
