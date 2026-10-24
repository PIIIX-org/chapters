import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { config } from '../src/config.js'
import { db, sql } from '../src/db/client.js'
import { and, asc, eq } from 'drizzle-orm'
import { blocks, users } from '../src/db/schema.js'
import { hashPassword } from '../src/auth/passwords.js'
import { serializeNote, type Frontmatter } from '../src/notes/okf.js'
import { getLiveNote, noteFile } from '../src/notes/store.js'
import { flushProjections } from '../src/notes/projector.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
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
 * A tool answer's content as one JSON text: `content[0]` with each
 * `{"in": "content[n]"}` marker replaced by that block's text (read_note's
 * body, #445), or the content joined when there are no blocks after the JSON.
 * For tests that parse a read_note answer as one object.
 */
export function toolText(content: readonly unknown[]): string {
  const texts = content.map((c) => (c !== null && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
  if (texts.length < 2) return texts.join('')
  const json = JSON.parse(texts[0]!) as Record<string, unknown>
  for (const [key, value] of Object.entries(json)) {
    const marker = value !== null && typeof value === 'object' && 'in' in value ? value.in : undefined
    const at = typeof marker === 'string' ? /^content\[(\d+)\]$/.exec(marker) : null
    if (!at) continue
    const text = texts[Number(at[1])]
    if (text === undefined) throw new Error(`${key} is in ${marker}, but the answer has ${texts.length} content blocks`)
    json[key] = text
  }
  return JSON.stringify(json)
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
  // The projector and the embedding queue may hold a transaction on notes and
  // other tables in the background: the truncate locks every table, one by one,
  // so it deadlocks with them (#862: the semantic-edge kNN of an embedding job,
  // the projector's reads). Let both finish first. No caller syncs repository
  // files, so the extraction queue has nothing running here.
  await Promise.all([flushProjections(), flushEmbeddings()])
  const tables = await sql<Array<{ tablename: string }>>`select tablename from pg_tables where schemaname = 'public'`
  await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} cascade`)
  await rm(join(config.dataDir, 'vaults'), { recursive: true, force: true })
}

/** A repository file's symbol blocks in line order (#413): what `repository_file_symbols` held before 0035. */
export async function symbolBlocks(fileId: string) {
  const rows = await db
    .select()
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'code'), eq(blocks.ownerId, fileId), eq(blocks.kind, 'symbol')))
    .orderBy(asc(blocks.startLine), asc(blocks.blockId))
  return rows.map((b) => ({
    name: b.symbolParent === null ? b.innerPath : b.innerPath.slice(b.symbolParent.length + 1),
    kind: b.symbolKind!,
    parent: b.symbolParent,
    startLine: b.startLine,
    endLine: b.endLine,
    blockId: b.blockId,
    embedding: b.embedding,
  }))
}

/** The vector of a repository file's `file` block, or null (#452). */
export async function fileEmbedding(fileId: string): Promise<number[] | null> {
  const [row] = await db
    .select({ embedding: blocks.embedding })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'code'), eq(blocks.ownerId, fileId), eq(blocks.kind, 'file')))
  return row?.embedding ?? null
}

/** The vectors of a note's blocks in body order; empty when it has none (#452: `notes.embedding` moved to `blocks`). */
export async function noteVectors(noteId: string): Promise<number[][]> {
  const rows = await db
    .select({ embedding: blocks.embedding })
    .from(blocks)
    .where(and(eq(blocks.ownerType, 'note'), eq(blocks.ownerId, noteId)))
    .orderBy(blocks.startLine, blocks.innerPath)
  return rows.flatMap((r) => (r.embedding ? [r.embedding] : []))
}
