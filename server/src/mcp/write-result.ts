/**
 * What every MCP write answers (#477, ADR-003 §5.2 step 9 and §5.6), and its
 * `idempotency_key`.
 *
 * - `rev`: the note's `seq` after the write (`null` when nothing was
 *   written: `retry`); a read returns the same `rev` for the same state, and
 *   edit_note takes it back as `base_rev`.
 * - `status`: `applied`; `merged` (an edit with `base_rev` onto a note that
 *   changed since, `concurrent_changes` says where); `conflicted` (nothing
 *   written, #475); `retry` (the store was busy: lock timeout or maintenance,
 *   nothing written, send it again).
 * - `diff_stats`: whole lines added and removed in the body, and the
 *   frontmatter keys whose values changed, from the state the write met (what
 *   the editors saw) to the state it left.
 * - `indexed`: whether the note's file, `index.md` and embedding already
 *   reflect `rev` (the projector and the embedding worker run after commit).
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, eq, getTableColumns, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, writeIdempotency } from '../db/schema.js'
import { withKeyLock } from '../notes/key-lock.js'
import { noteIndexed, type RecordKey, type WrittenNote } from '../notes/store.js'
import { StoreBusyError } from '../notes/store-tx.js'
import { diffLines } from '../sync/text-diff.js'

export type WriteStatus = 'applied' | 'merged' | 'conflicted' | 'retry'

export interface DiffStats {
  lines_added: number
  lines_removed: number
  frontmatter_keys: string[]
}

export interface NoteState {
  frontmatter: Record<string, unknown>
  body: string
}

/** Lines added and removed, and the frontmatter keys changed, from `before` to `after`. */
export function diffStats(before: NoteState, after: NoteState): DiffStats {
  let added = 0
  let removed = 0
  for (const hunk of diffLines(before.body, after.body).hunks) {
    removed += hunk.end - hunk.start
    added += hunk.lines.length
  }
  const keys = new Set([...Object.keys(before.frontmatter), ...Object.keys(after.frontmatter)])
  return {
    lines_added: added,
    lines_removed: removed,
    frontmatter_keys: [...keys].filter((key) => !isDeepStrictEqual(before.frontmatter[key], after.frontmatter[key])),
  }
}

/** The empty note a create starts from. */
export const NO_NOTE: NoteState = { frontmatter: {}, body: '' }

/** How a write went, for its answer. */
export interface WriteHow {
  status: WriteStatus
  before: NoteState | null
  after?: NoteState
  concurrent?: unknown
  dryRun?: boolean
}

/**
 * The note fields a write answers (#427): what an agent needs of the note it
 * wrote. The row's other columns (`embedding`, `deletedAt`, bookkeeping) stay
 * internal: the embedding alone was 93% of an edit_note answer.
 */
export const ANSWER_NOTE_FIELDS = ['id', 'vaultId', 'type', 'name', 'path', 'frontmatter', 'body', 'createdAt', 'updatedAt'] as const

/** Note columns a write never answers; a stored answer recorded before #427 may hold them. */
const INTERNAL_NOTE_FIELDS = [
  ...Object.keys(getTableColumns(notes)).filter((key) => !(ANSWER_NOTE_FIELDS as readonly string[]).includes(key)),
  'frontmatterSrc',
  'seq',
]

/** A stored answer without the internal note columns an answer recorded before #427 carried. */
function storedAnswer(result: unknown): Record<string, unknown> {
  const answer = { ...(result as Record<string, unknown>) }
  for (const key of INTERNAL_NOTE_FIELDS) delete answer[key]
  return answer
}

/**
 * The answer of a write to note `row` (#477): the note's ANSWER_NOTE_FIELDS,
 * then `rev` (the row's `seq`), `status`, `diff_stats`,
 * `concurrent_changes` and `indexed`. A dry run answers `dry_run: true` and
 * the `rev` the note still has. Synchronous, so the answer can be recorded
 * with an idempotency key inside the write's transaction (runWrite), where
 * `indexed` is false: nothing is projected before the commit.
 */
export function writeAnswer(row: { id: string; seq: number } & Record<string, unknown>, how: WriteHow, indexed: boolean): Record<string, unknown> {
  const fields = Object.fromEntries(ANSWER_NOTE_FIELDS.filter((key) => key in row).map((key) => [key, row[key]]))
  const after = how.after ?? { frontmatter: row.frontmatter as Record<string, unknown>, body: String(row.body ?? '') }
  return {
    ...fields,
    rev: row.seq,
    status: how.status,
    diff_stats: how.before ? diffStats(how.before, after) : null,
    concurrent_changes: how.concurrent ?? null,
    indexed,
    ...(how.dryRun ? { dry_run: true } : {}),
  }
}

/** writeAnswer with `indexed` read now (false for a dry run). */
export async function writeResult(row: { id: string; seq: number } & Record<string, unknown>, how: WriteHow): Promise<Record<string, unknown>> {
  return writeAnswer(row, how, how.dryRun ? false : await noteIndexed(row.id, row.seq))
}

/** The answer of a write the store refused as busy (#477 `status: retry`): nothing was written. */
export function retryResult(err: StoreBusyError): Record<string, unknown> {
  return { rev: null, status: 'retry', diff_stats: null, concurrent_changes: null, indexed: false, message: err.message }
}

/** How long a stored first result answers a repeat of its key. */
export const IDEMPOTENCY_WINDOW_HOURS = 24

/** A key sent again with other arguments: refused, nothing written. */
export class IdempotencyKeyReusedError extends Error {
  constructor(key: string, tool: string) {
    super(
      `idempotency_key ${JSON.stringify(key)} was already used by this connection within ${IDEMPOTENCY_WINDOW_HOURS} h ` +
        `for a different call (${tool} or other arguments); nothing was written. Use a new key for a new write.`,
    )
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** `args`: the call's arguments without `idempotency_key`. */
function argsHash(tool: string, target: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical({ tool, target, args }))).digest('hex')
}

/**
 * Given how to answer from the row a write commits, the hook that records
 * the call's key and that answer in the write's transaction (store
 * RecordKey); undefined when the call has no key or is a dry run.
 */
export type KeyedAnswer = (answer: (row: WrittenNote) => Record<string, unknown>) => RecordKey | undefined

/**
 * Runs one MCP write (#477): a write the store refuses as busy answers
 * `status: retry`. With `key` (not on a dry run), the first answer of this
 * connection's key is kept for IDEMPOTENCY_WINDOW_HOURS: the same tool and
 * arguments again answer it with `replayed: true` and write nothing; other
 * arguments are refused. Calls with one key run one at a time.
 *
 * A write that commits records its key and answer inside its own
 * transaction (`write` passes `keyed(answer)` to the store as
 * `recordKey`), so a process that dies after COMMIT but before answering
 * still has the key, and the caller's retry replays instead of writing
 * again (ADR-003 §4, §10). Outcomes that commit nothing but are answers
 * (a `conflicted` edit) are recorded after; errors and `retry` answers are
 * not, so the caller can send the same call again. A `retry` whose write
 * did commit (a rename whose link rewrites hit a busy note afterwards)
 * answers the committed write. Keys older than the window are pruned on
 * every keyed call.
 */
export async function runWrite(
  call: { connectionId: string; tool: string; target: string; args: Record<string, unknown>; key?: string; dryRun?: boolean },
  write: (keyed: KeyedAnswer) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const attempt = async (keyed: KeyedAnswer) => {
    try {
      return await write(keyed)
    } catch (err) {
      if (err instanceof StoreBusyError) return retryResult(err)
      throw err
    }
  }
  const { key, connectionId } = call
  if (key === undefined || call.dryRun) return attempt(() => undefined)
  return withKeyLock(`idempotency:${connectionId}:${key}`, async () => {
    await db.delete(writeIdempotency).where(sql`${writeIdempotency.createdAt} < now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`)
    const hash = argsHash(call.tool, call.target, call.args)
    const thisKey = and(eq(writeIdempotency.connectionId, connectionId), eq(writeIdempotency.key, key))
    const recorded = async () =>
      (await db.select({ argsHash: writeIdempotency.argsHash, result: writeIdempotency.result }).from(writeIdempotency).where(thisKey))[0]
    const stored = await recorded()
    if (stored) {
      if (stored.argsHash !== hash) throw new IdempotencyKeyReusedError(key, call.tool)
      return { ...storedAnswer(stored.result), replayed: true }
    }
    const entry = { connectionId, key, tool: call.tool, argsHash: hash }
    const keyed: KeyedAnswer = (answer) => async (tx, row) => {
      const result = answer(row)
      await tx
        .insert(writeIdempotency)
        .values({ ...entry, noteId: row.id, result })
        .onConflictDoUpdate({ target: [writeIdempotency.connectionId, writeIdempotency.key], set: { ...entry, noteId: row.id, result, createdAt: sql`now()` } })
    }
    const result = await attempt(keyed)
    const committed = await recorded()
    if (committed) return result.status === 'retry' ? storedAnswer(committed.result) : result
    if (result.status !== 'retry') await db.insert(writeIdempotency).values({ ...entry, result }).onConflictDoNothing()
    return result
  })
}
