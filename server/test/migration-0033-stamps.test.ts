// #453 review: migration 0033 gives the vectors an instance already has the
// EMBEDDER_ID that made them, so the upgrade does not re-embed every note,
// and does it without rewriting rows (a column default kept in the catalog;
// a rewrite of every row held the boot for minutes). Only a note whose job
// for its current `seq` is pending or failed is updated, to no id, for the
// catch-up. Builds an instance at 0032, then applies the real journal.
import { afterAll, describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { config } from '../src/config.js'
import { sql } from '../src/db/client.js'
import { LOCAL_EMBEDDING_MODEL } from '../src/search/embeddings.js'

interface Entry {
  idx: number
  when: number
  tag: string
}

const source = join(import.meta.dirname, '..', 'drizzle')
const name = `${new URL(config.databaseUrl).pathname.slice(1)}_migration_0033`
const url = Object.assign(new URL(config.databaseUrl), { pathname: `/${name}` }).toString()
let partial: string | undefined

afterAll(async () => {
  await sql.unsafe(`drop database if exists "${name}" with (force)`)
  if (partial) await rm(partial, { recursive: true, force: true })
})

const vector = `[${new Array(384).fill(0.1).join(',')}]`

describe('migration 0033 stamps existing vectors (#453)', { timeout: 60_000 }, () => {
  it('existing rows get the embedder id without a rewrite; notes with a pending or failed job get none; new rows get none', async () => {
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] }
    const at0033 = journal.entries.find((e) => e.tag === '0033_derived_versions')!
    partial = await mkdtemp(join(tmpdir(), 'migration-0033-'))
    const before = { ...journal, entries: journal.entries.filter((e) => e.when < at0033.when) }
    await mkdir(join(partial, 'meta'))
    await writeFile(join(partial, 'meta', '_journal.json'), JSON.stringify(before))
    for (const e of before.entries) await copyFile(join(source, `${e.tag}.sql`), join(partial, `${e.tag}.sql`))

    await sql.unsafe(`drop database if exists "${name}" with (force)`)
    await sql.unsafe(`create database "${name}"`)
    const client = postgres(url, { max: 1, onnotice: () => {} })
    try {
      await migrate(drizzle(client), { migrationsFolder: partial })
      const [user] = await client`insert into users (email, password_hash) values ('m0033@example.com', 'x') returning id`
      const [vault] = await client`insert into vaults (name, owner_id) values ('v', ${user!.id}) returning id`
      const note = async (path: string, embedded: boolean) => {
        const [row] = await client`
          insert into notes (vault_id, type, name, path, frontmatter, body, embedding)
          values (${vault!.id}, 'note', ${path}, ${path}, '{}'::jsonb, 'body', ${embedded ? vector : null}::vector)
          returning id, seq`
        return row!
      }
      const current = await note('current.md', true)
      const unembedded = await note('unembedded.md', false)
      const failed = await note('failed.md', true)
      const pending = await note('pending.md', true)
      await client`insert into jobs (kind, payload, idempotency_key, done_at, last_error, attempts)
        values ('embed_note', '{}'::jsonb, ${`embed_note:${failed.id}:${failed.seq}`}, now(), 'Error: model download failed', 3)`
      await client`insert into jobs (kind, payload, idempotency_key)
        values ('embed_note', '{}'::jsonb, ${`embed_note:${pending.id}:${pending.seq}`})`

      const [repo] = await client`insert into repositories (name, owner_id, ingestion_method) values ('r', ${user!.id}, 'agent_push') returning id`
      const file = async (path: string, embedded: boolean) => {
        const [row] = await client`
          insert into repository_files (repository_id, path, content, content_hash, size, embedding)
          values (${repo!.id}, ${path}, ${path}, ${`hash-${path}`}, 1, ${embedded ? vector : null}::vector)
          returning id, content_hash`
        return row!
      }
      const fileCurrent = await file('current.ts', true)
      const fileUnembedded = await file('unembedded.ts', false)
      const fileFailed = await file('failed.ts', true)
      await client`insert into jobs (kind, payload, idempotency_key, done_at, last_error, attempts)
        values ('extract', '{}'::jsonb, ${`extract:${fileFailed.id}:${fileFailed.content_hash}`}, now(), 'Error: outage', 3)`

      const ctids = async () =>
        Object.fromEntries([
          ...(await client`select path, ctid::text from notes`).map((r) => [r.path, r.ctid]),
          ...(await client`select path, ctid::text from repository_files`).map((r) => [r.path, r.ctid]),
        ]) as Record<string, string>
      const before = await ctids()

      await migrate(drizzle(client), { migrationsFolder: source })

      // Rows are where they were (no new tuple), except the two notes updated on purpose.
      const after = await ctids()
      const moved = Object.keys(before).filter((path) => before[path] !== after[path])
      expect(moved.sort()).toEqual(['failed.md', 'pending.md'])

      const id = `${LOCAL_EMBEDDING_MODEL}+text1`
      const notes = Object.fromEntries(
        (await client`select path, embedder_id, seq from notes`).map((r) => [r.path, { embedderId: r.embedder_id, seq: String(r.seq) }]),
      )
      expect(notes).toEqual({
        'current.md': { embedderId: id, seq: String(current.seq) },
        // The id stands for a vector only where there is one; catch-up embeds this note for its null embedding.
        'unembedded.md': { embedderId: id, seq: String(unembedded.seq) },
        'failed.md': { embedderId: null, seq: String(failed.seq) },
        'pending.md': { embedderId: null, seq: String(pending.seq) },
      })
      const files = Object.fromEntries(
        (await client`select path, embedder_id, extracted_hash, extractor_version from repository_files`).map((r) => [
          r.path,
          { embedderId: r.embedder_id, extractedHash: r.extracted_hash, extractorVersion: r.extractor_version },
        ]),
      )
      // Every file is re-extracted once (extractor_version 0); extraction-queue.ts decides there whether its vector is current.
      expect(files).toEqual({
        'current.ts': { embedderId: id, extractedHash: null, extractorVersion: 0 },
        'unembedded.ts': { embedderId: id, extractedHash: null, extractorVersion: 0 },
        'failed.ts': { embedderId: id, extractedHash: null, extractorVersion: 0 },
      })
      expect([fileCurrent.content_hash, fileUnembedded.content_hash]).toEqual(['hash-current.ts', 'hash-unembedded.ts'])

      // The defaults are gone: rows written from now on start with no id.
      const [later] = await client`
        insert into notes (vault_id, type, name, path, frontmatter, body) values (${vault!.id}, 'note', 'later', 'later.md', '{}'::jsonb, 'x')
        returning embedder_id`
      expect(later!.embedder_id).toBeNull()
      const [laterFile] = await client`
        insert into repository_files (repository_id, path, content, content_hash, size) values (${repo!.id}, 'later.ts', 'x', 'h', 1)
        returning embedder_id`
      expect(laterFile!.embedder_id).toBeNull()
      const [job] = await client`select priority from jobs limit 1`
      expect(job!.priority).toBe(0)
    } finally {
      await client.end()
    }
  })
})
