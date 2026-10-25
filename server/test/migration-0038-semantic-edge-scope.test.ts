// #461 (D10 on #930): migration 0038 deletes the stored semantic edges the scoped neighbour lookup
// (search/semantic-edges.ts) no longer makes: a note→note edge across vaults, a code→code edge across
// repositories, and a note↔code edge between two owners' resources. Builds an instance before 0038,
// stores both kinds of edge, then applies the real journal.
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
const name = `${new URL(config.databaseUrl).pathname.slice(1)}_migration_0038`
const url = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).toString()
let partial: string | undefined

afterAll(async () => {
  await sql.unsafe(`drop database if exists "${name}" with (force)`)
  if (partial) await rm(partial, { recursive: true, force: true })
})

describe('migration 0038 deletes cross-vault, cross-repository and cross-owner semantic edges (#461)', { timeout: 60_000 }, () => {
  it('keeps the edges within a vault, a repository or one owner; deletes the others', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ when: number; tag: string }> }
    const at0038 = journal.entries.find((e) => e.tag === '0038_semantic_edge_scope')
    partial = await mkdtemp(join(tmpdir(), 'migration-0038-'))
    const before = { ...journal, entries: journal.entries.filter((e) => e.when < (at0038?.when ?? Infinity)) }
    await mkdir(join(partial, 'meta'))
    await writeFile(join(partial, 'meta', '_journal.json'), JSON.stringify(before))
    for (const e of before.entries) await copyFile(join(source, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
    const client = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: partial })
      const user = async (email: string) => (await client`insert into users (email, password_hash) values (${email}, 'x') returning id`)[0]!.id as string
      const vault = async (owner: string) => (await client`insert into vaults (name, owner_id) values ('v', ${owner}) returning id`)[0]!.id as string
      const repository = async (owner: string) =>
        (await client`insert into repositories (name, owner_id, ingestion_method) values ('r', ${owner}, 'agent_push') returning id`)[0]!.id as string
      const note = async (vaultId: string, path: string) =>
        (await client`insert into notes (vault_id, type, name, path, frontmatter, body) values (${vaultId}, 'notes', ${path}, ${`notes/${path}`}, '{"type":"notes"}'::jsonb, '') returning id`)[0]!.id as string
      const file = async (repositoryId: string, path: string) =>
        (await client`insert into repository_files (repository_id, path, content, content_hash, size) values (${repositoryId}, ${path}, '', ${path}, 0) returning id`)[0]!.id as string

      const [a, b] = [await user('m0038a@example.com'), await user('m0038b@example.com')]
      const [a1, a2, b1] = [await vault(a), await vault(a), await vault(b)]
      const [ra1, ra2, rb1] = [await repository(a), await repository(a), await repository(b)]
      const n = { a1: await note(a1, 'x'), a1b: await note(a1, 'y'), a2: await note(a2, 'x'), b1: await note(b1, 'x') }
      const f = { a1: await file(ra1, 'x.ts'), a1b: await file(ra1, 'y.ts'), a2: await file(ra2, 'x.ts'), b1: await file(rb1, 'x.ts') }

      const edges: Array<[string, 'note' | 'code', string, 'note' | 'code', string]> = [
        ['keep: same vault', 'note', n.a1, 'note', n.a1b],
        ['keep: same repository', 'code', f.a1, 'code', f.a1b],
        ['keep: note→code of one owner', 'note', n.a1, 'code', f.a2],
        ['keep: code→note of one owner', 'code', f.a1, 'note', n.a2],
        ['drop: another vault of the same owner', 'note', n.a1, 'note', n.a2],
        ["drop: another account's vault", 'note', n.b1, 'note', n.a1],
        ['drop: another repository of the same owner', 'code', f.a2, 'code', f.a1],
        ["drop: another account's repository", 'code', f.a1, 'code', f.b1],
        ["drop: note→code of another account", 'note', n.a1, 'code', f.b1],
        ["drop: code→note of another account", 'code', f.b1, 'note', n.a2],
      ]
      for (const [, at, aid, bt, bid] of edges) {
        await client`insert into semantic_edges (node_a_type, node_a_id, node_b_type, node_b_id, similarity) values (${at}, ${aid}, ${bt}, ${bid}, 0.9)`
      }

      await migrate(drizzle(client), { migrationsFolder: source })

      const left = new Set((await client`select node_a_id || '>' || node_b_id as k from semantic_edges`).map((r) => r.k as string))
      expect(edges.filter(([, , aid, , bid]) => left.has(`${aid}>${bid}`)).map(([label]) => label)).toEqual(
        edges.filter(([label]) => label.startsWith('keep')).map(([label]) => label),
      )
    } finally {
      await client.end()
    }
  })
})
