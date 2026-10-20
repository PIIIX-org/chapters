import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { sql } from '../src/db/client.js'
import { createActiveUser, loginCookie } from './helpers.js'

// ADR-003 §4: migration 0021 is additive, so code written before it (every
// code path in this release) keeps working on it; the rest of the suite runs
// on the migrated schema. These tests pin the schema itself.

let app: FastifyInstance
let cookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Store schema vault' } })
  ).json().id
})

afterAll(async () => {
  await app.close()
})

async function createNote(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie },
    body: { type: 'guides', name, body: `${name} body`, frontmatter: { status: 'draft' } },
  })
  expect(res.statusCode).toBe(200)
  return res.json().id
}

const seqOf = async (id: string) => Number((await sql`select seq from notes where id = ${id}`)[0]!.seq)

describe('migration 0021 (ADR-003 store schema)', () => {
  it('adds every table, column and marker the ADR defines, with the old defaults', async () => {
    const columns = await sql<Array<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>>`
      select table_name, column_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'notes' and column_name in ('seq', 'frontmatter_src'))
        or (table_name = 'note_revisions' and column_name in ('seq', 'idempotency_key', 'actor_detail'))
        or (table_name = 'instance_state' and column_name in ('store_migrated_at', 'collab_migrated_at')))
      order by table_name, column_name`
    expect(columns.map((c) => `${c.table_name}.${c.column_name} ${c.is_nullable} ${c.column_default}`)).toEqual([
      'instance_state.collab_migrated_at YES null',
      'instance_state.store_migrated_at YES null',
      'note_revisions.actor_detail YES null',
      'note_revisions.idempotency_key YES null',
      'note_revisions.seq YES null',
      'notes.frontmatter_src YES null',
      'notes.seq NO 1',
    ])
    const tables = await sql<Array<{ t: string }>>`
      select table_name as t from information_schema.tables
      where table_schema = 'public' and table_name in ('note_crdt', 'note_updates', 'note_projections', 'projected_files', 'jobs')
      order by 1`
    expect(tables.map((r) => r.t)).toEqual(['jobs', 'note_crdt', 'note_projections', 'note_updates', 'projected_files'])
    const indexes = await sql<Array<{ i: string }>>`
      select indexname as i from pg_indexes where schemaname = 'public' and indexname in (
        'note_revisions_note_seq', 'note_revisions_note_idem', 'note_updates_note_idx',
        'note_projections_pending', 'projected_files_owner_idx', 'jobs_pending') order by 1`
    expect(indexes).toHaveLength(6)
  })

  it('gives notes created by current code seq 1 and bumps seq only for body, frontmatter, path or deleted_at', async () => {
    const id = await createNote('seq-trigger')
    expect(await seqOf(id)).toBe(1)
    await sql`update notes set updated_at = now(), name = name where id = ${id}`
    expect(await seqOf(id)).toBe(1)
    await sql`update notes set body = 'changed' where id = ${id}`
    expect(await seqOf(id)).toBe(2)
    await sql`update notes set body = 'changed' where id = ${id}`
    expect(await seqOf(id)).toBe(2)
    await sql`update notes set frontmatter = frontmatter || '{"status":"active"}'::jsonb where id = ${id}`
    expect(await seqOf(id)).toBe(3)
    await sql`update notes set path = 'guides/seq-trigger-moved' where id = ${id}`
    expect(await seqOf(id)).toBe(4)
    await sql`update notes set deleted_at = now() where id = ${id}`
    expect(await seqOf(id)).toBe(5)
    // Old-code writes leave the new revision columns null, which the partial unique indexes allow.
    const revisions = await sql`select seq, idempotency_key from note_revisions where note_id = ${id}`
    expect(revisions.length).toBeGreaterThan(0)
    expect(revisions.every((r) => r.seq === null && r.idempotency_key === null)).toBe(true)
  })

  it('bumps seq through the current REST write paths (trash, restore)', async () => {
    const id = await createNote('seq-rest')
    expect((await app.inject({ method: 'DELETE', url: `/api/vaults/${vaultId}/notes/guides/seq-rest`, headers: { cookie } })).statusCode).toBe(200)
    expect(await seqOf(id)).toBe(2)
    expect((await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/trash/${id}/restore`, headers: { cookie } })).statusCode).toBe(200)
    expect(await seqOf(id)).toBe(3)
  })

  it('enforces one revision per seq and per idempotency key, and cascades note and vault removal', async () => {
    const id = await createNote('cascade')
    const [rev] = await sql`select id from note_revisions where note_id = ${id} limit 1`
    await sql`update note_revisions set seq = 1, idempotency_key = 'k1' where id = ${rev!.id}`
    await expect(
      sql`insert into note_revisions (note_id, actor_type, action, frontmatter, body, seq)
          values (${id}, 'user', 'update', '{}'::jsonb, '', 1)`,
    ).rejects.toThrow(/note_revisions_note_seq/)
    await expect(
      sql`insert into note_revisions (note_id, actor_type, action, frontmatter, body, idempotency_key)
          values (${id}, 'user', 'update', '{}'::jsonb, '', 'k1')`,
    ).rejects.toThrow(/note_revisions_note_idem/)

    await sql`insert into note_crdt (note_id, snapshot, folded_seq) values (${id}, '\\x00'::bytea, 1)`
    await sql`insert into note_updates (note_id, update, actor_type) values (${id}, '\\x00'::bytea, 'collab')`
    await sql`insert into note_projections (note_id, projection, target_seq) values (${id}, 'file', 1)`
    await sql`insert into projected_files (vault_id, path, owner_kind, owner_id, applied_hash, applied_seq)
              values (${vaultId}, 'guides/cascade.md', 'note', ${id}, 'h', 1)`
    // A purge by old code (plain DELETE) leaves nothing behind.
    await sql`delete from notes where id = ${id}`
    for (const table of ['note_crdt', 'note_updates', 'note_projections']) {
      expect((await sql.unsafe(`select count(*)::int as n from ${table} where note_id = $1`, [id]))[0]!.n).toBe(0)
    }
    const [vault] = await sql`insert into vaults (name, owner_id) select 'cascade vault', owner_id from vaults where id = ${vaultId} returning id`
    await sql`insert into projected_files (vault_id, path, owner_kind, applied_hash) values (${vault!.id}, 'x/index.md', 'dir_index', 'h')`
    await sql`delete from vaults where id = ${vault!.id}`
    expect((await sql`select count(*)::int as n from projected_files where vault_id = ${vault!.id}`)[0]!.n).toBe(0)
  })
})
