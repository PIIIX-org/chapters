// #452a: migration 0035 carries an instance's symbols and file vectors into
// `blocks` (search keeps answering until the boot re-extraction), gives a
// file vector made from the current content the embed key of its text (so
// that re-extraction reuses it), drops `repository_file_symbols` and
// `repository_files.embedding`, and deletes a file's blocks with the file.
// Builds an instance at 0034, then applies the real journal.
import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../src/config.js'
import { sql } from '../src/db/client.js'

const source = join(import.meta.dirname, '..', 'drizzle')
const name = `${new URL(config.databaseUrl).pathname.slice(1)}_migration_0035`
const url = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).toString()
let partial: string | undefined

afterAll(async () => {
  await sql.unsafe(`drop database if exists "${name}" with (force)`)
  if (partial) await rm(partial, { recursive: true, force: true })
})

const vector = `[${new Array(384).fill(0.1).join(',')}]`

describe('migration 0035 carries vectors and symbols into blocks (#452a)', { timeout: 60_000 }, () => {
  it('legacy blocks keep the vectors; a current file vector gets its text key; the old table and column are gone', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ when: number; tag: string }> }
    const at0035 = journal.entries.find((e) => e.tag === '0035_blocks')!
    partial = await mkdtemp(join(tmpdir(), 'migration-0035-'))
    const before = { ...journal, entries: journal.entries.filter((e) => e.when < at0035.when) }
    await mkdir(join(partial, 'meta'))
    await writeFile(join(partial, 'meta', '_journal.json'), JSON.stringify(before))
    for (const e of before.entries) await copyFile(join(source, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
    const client = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: partial })
      const [user] = await client`insert into users (email, password_hash) values ('m0035@example.com', 'x') returning id`
      const [repo] = await client`insert into repositories (name, owner_id, ingestion_method) values ('r', ${user!.id}, 'agent_push') returning id`
      const content = 'export class Store {\n  save() {}\n}\n'
      const hash = createHash('sha256').update(content).digest('hex')
      const [current] = await client`
        insert into repository_files (repository_id, path, content, content_hash, size, embedding, embedder_id, extracted_hash)
        values (${repo!.id}, 'src/store.ts', ${content}, ${hash}, ${content.length}, ${vector}::vector, 'fake+text1', ${hash})
        returning id`
      const [stale] = await client`
        insert into repository_files (repository_id, path, content, content_hash, size, embedding, embedder_id, extracted_hash)
        values (${repo!.id}, 'src/stale.ts', 'new', 'hash-new', 3, ${vector}::vector, 'fake+text1', 'hash-old')
        returning id`
      await client`insert into repository_file_symbols (file_id, name, kind, parent, start_line, end_line, snippet, embedding)
        values (${current!.id}, 'Store', 'class', null, 1, 3, 'export class Store {', ${vector}::vector),
               (${current!.id}, 'save', 'method', 'Store', 2, 2, '  save() {}', null)`

      await migrate(drizzle(client), { migrationsFolder: source })

      const rows = await client`select owner_id, block_id, kind, inner_path, symbol_kind, symbol_parent, snippet, start_line, end_line,
        owner_version, embed_key, embedding is not null as embedded from blocks order by owner_id, kind, start_line`
      const textKey = createHash('sha256').update(`fake+text1\nsrc/store.ts\n${content}`).digest('hex').slice(0, 16)
      expect(rows.filter((r) => r.owner_id === current!.id).map((r) => [r.kind, r.inner_path, r.symbol_kind, r.symbol_parent, r.snippet, r.start_line, r.end_line, r.embed_key, r.embedded])).toEqual([
        ['file', '', null, null, null, 1, 3, textKey, true],
        ['symbol', 'Store', 'class', null, 'export class Store {', 1, 3, 'legacy', true],
        ['symbol', 'Store.save', 'method', 'Store', '  save() {}', 2, 2, null, false],
      ])
      // A vector of an earlier content is carried but never reused.
      expect(rows.filter((r) => r.owner_id === stale!.id).map((r) => [r.kind, r.embed_key])).toEqual([['file', 'legacy']])
      expect(rows.every((r) => r.owner_version === 'legacy' && String(r.block_id).startsWith('legacy:'))).toBe(true)

      const [gone] = await client`select to_regclass('public.repository_file_symbols') as t,
        (select count(*)::int from information_schema.columns where table_name = 'repository_files' and column_name = 'embedding') as c,
        (select chunk_version from repository_files where id = ${current!.id}) as v`
      expect([gone!.t, gone!.c, gone!.v]).toEqual([null, 0, 0])

      // The trigger: a deleted file takes its blocks with it.
      await client`delete from repository_files where id = ${current!.id}`
      const [left] = await client`select count(*)::int as n from blocks where owner_id = ${current!.id}`
      expect(left!.n).toBe(0)
    } finally {
      await client.end()
    }
  })
})
