// #1007: migration 0046 queues the semantic-edge rebuild (search/semantic-edges.ts, kind `semantic_edges`) of
// every live note and repository file of an instance from before it, once, at catch-up priority. Builds an
// instance before 0046, then applies the real journal.
import { afterAll, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../src/config.js'
import { sql } from '../src/db/client.js'

const source = join(import.meta.dirname, '..', 'drizzle')
const name = `${new URL(config.databaseUrl).pathname.slice(1)}_migration_0046`
const url = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).toString()
let partial: string | undefined

afterAll(async () => {
  await sql.unsafe(`drop database if exists "${name}" with (force)`)
  if (partial) await rm(partial, { recursive: true, force: true })
})

describe('migration 0046 queues the semantic-edge rebuild of every node (#1007)', { timeout: 60_000 }, () => {
  it('one job per live note and per file, none for a trashed note', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ when: number; tag: string }> }
    const at0046 = journal.entries.find((e) => e.tag === '0046_semantic_edge_rebuild')
    expect(at0046).toBeDefined()
    partial = await mkdtemp(join(tmpdir(), 'migration-0046-'))
    const before = { ...journal, entries: journal.entries.filter((e) => e.when < at0046!.when) }
    await mkdir(join(partial, 'meta'))
    await writeFile(join(partial, 'meta', '_journal.json'), JSON.stringify(before))
    for (const e of before.entries) await copyFile(join(source, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
    const client = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: partial })
      const [user] = await client`insert into users (email, password_hash) values ('m0046@example.com', 'x') returning id`
      const [vault] = await client`insert into vaults (name, owner_id) values ('v', ${user!.id}) returning id`
      const [repo] = await client`insert into repositories (name, owner_id, ingestion_method) values ('r', ${user!.id}, 'agent_push') returning id`
      const note = async (path: string, deleted: boolean) =>
        (
          await client`insert into notes (vault_id, type, name, path, frontmatter, body, deleted_at)
            values (${vault!.id}, 'notes', ${path}, ${path}, '{"type":"notes"}'::jsonb, '', ${deleted ? new Date().toISOString() : null}) returning id`
        )[0]!.id as string
      const live = await note('live', false)
      await note('trashed', true)
      const [file] = await client`insert into repository_files (repository_id, path, content, content_hash, size) values (${repo!.id}, 'x.ts', '', 'x', 0) returning id`

      await migrate(drizzle(client), { migrationsFolder: source })

      const queued = await client`select payload, idempotency_key, priority, done_at from jobs where kind = 'semantic_edges' order by idempotency_key`
      expect(queued.map((j) => ({ ...j }))).toEqual(
        [
          { payload: { nodeType: 'code', nodeId: file!.id }, idempotency_key: `semantic_edges:code:${file!.id}`, priority: 1, done_at: null },
          { payload: { nodeType: 'note', nodeId: live }, idempotency_key: `semantic_edges:note:${live}`, priority: 1, done_at: null },
        ],
      )
    } finally {
      await client.end()
    }
  })
})
