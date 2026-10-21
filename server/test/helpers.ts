import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config } from '../src/config.js'
import { db, sql } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { hashPassword } from '../src/auth/passwords.js'
import { serializeNote, type Frontmatter } from '../src/notes/okf.js'
import { getLiveNote, noteFile } from '../src/notes/store.js'
import { flushProjections } from '../src/notes/projector.js'
import * as Y from 'yjs'

let counter = 0
export function uniqueEmail(prefix = 'user'): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}@test.local`
}

export const TEST_PASSWORD = 'correct-horse-battery'

/** Inserts an active, verified user directly (skips signup/approval flow). */
export async function createActiveUser(
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<typeof users.$inferSelect> {
  const [user] = await db
    .insert(users)
    .values({
      email: uniqueEmail(),
      passwordHash: await hashPassword(TEST_PASSWORD),
      status: 'active',
      emailVerifiedAt: new Date(),
      ...overrides,
    })
    .returning()
  return user!
}

/** Logs in and returns the raw session token (for collab connections). */
export async function loginToken(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const cookie = await loginCookie(app, email, password)
  return cookie.split('=')[1]!
}

/** Logs in via the real endpoint and returns the session cookie header. */
export async function loginCookie(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    body: { email, password },
  })
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  }
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('no session cookie returned')
  return raw.split(';')[0]!
}

/**
 * Rewrites a live note's file from its row. For tests that break a note's
 * file on purpose: CI checks every note the suite leaves behind (#578).
 */
export async function rewriteNoteFileFromRow(vaultId: string, path: string): Promise<void> {
  const row = await getLiveNote(vaultId, path)
  if (!row) throw new Error(`no live note at ${path}`)
  const note = { frontmatter: row.frontmatter as Frontmatter, body: row.body }
  await writeFile(noteFile(vaultId, row.path), serializeNote(note), 'utf8')
}

/** The relay's document name of the live note at `path` (`<vault>/~<noteId>`, ADR-003 §5.4). */
export async function noteDocName(vaultId: string, path: string): Promise<string> {
  const row = await getLiveNote(vaultId, path)
  if (!row) throw new Error(`no live note at ${path}`)
  return `${vaultId}/~${row.id}`
}

/**
 * The live note's CRDT state in the database (`note_crdt` snapshot ⊕ the
 * non-rejected tail), read without a fold; an empty document when it has
 * none: what the relay loads next (ADR-003 §5.4).
 */
export async function storedCrdtDoc(vaultId: string, path: string): Promise<Y.Doc> {
  const row = await getLiveNote(vaultId, path)
  if (!row) throw new Error(`no live note at ${path}`)
  const [crdt] = await sql<Array<{ snapshot: Uint8Array; snapshot_through: string }>>`
    SELECT snapshot, snapshot_through FROM note_crdt WHERE note_id = ${row.id}`
  const doc = new Y.Doc()
  if (!crdt) return doc
  Y.applyUpdate(doc, crdt.snapshot)
  const tail = await sql<Array<{ update: Uint8Array }>>`
    SELECT update FROM note_updates WHERE note_id = ${row.id} AND id > ${crdt.snapshot_through} AND rejected_at IS NULL ORDER BY id`
  for (const { update } of tail) Y.applyUpdate(doc, update)
  return doc
}

/** The body text of storedCrdtDoc, or '' when the note has no CRDT state. */
export async function storedCrdtText(vaultId: string, path: string): Promise<string> {
  return (await storedCrdtDoc(vaultId, path)).getText('body').toString()
}

/**
 * Empties every table and DATA_DIR/vaults: for restore tests, which run only
 * on an empty instance. Other test files never depend on rows they did not
 * create, so wiping the shared test database between files is safe.
 */
export async function wipeInstance(): Promise<void> {
  // The projector may hold a transaction on vaults and notes in the background: let it finish first.
  await flushProjections()
  const tables = await sql<Array<{ tablename: string }>>`select tablename from pg_tables where schemaname = 'public'`
  await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} cascade`)
  await rm(join(config.dataDir, 'vaults'), { recursive: true, force: true })
}
