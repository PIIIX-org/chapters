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
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { writeIdempotency } from '../db/schema.js'
import { withKeyLock } from '../notes/key-lock.js'
import { noteIndexed } from '../notes/store.js'
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

/**
 * The answer of a write to note `row` (#477): the row's fields (without
 * `seq`, which is `rev`), then `rev`, `status`, `diff_stats`,
 * `concurrent_changes` and `indexed`. A dry run answers `dry_run: true` and
 * the `rev` the note still has.
 */
export async function writeResult(
  row: { id: string; seq: number } & Record<string, unknown>,
  how: { status: WriteStatus; before: NoteState | null; after?: NoteState; concurrent?: unknown; dryRun?: boolean },
): Promise<Record<string, unknown>> {
  const { seq, ...fields } = row
  const after = how.after ?? { frontmatter: row.frontmatter as Record<string, unknown>, body: String(row.body ?? '') }
  return {
    ...fields,
    rev: seq,
    status: how.status,
    diff_stats: how.before ? diffStats(how.before, after) : null,
    concurrent_changes: how.concurrent ?? null,
    indexed: how.dryRun ? false : await noteIndexed(row.id, seq),
    ...(how.dryRun ? { dry_run: true } : {}),
  }
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
 * Runs one MCP write (#477): a write the store refuses as busy answers
 * `status: retry`. With `key` (not on a dry run), the first result of this
 * connection's key is kept for IDEMPOTENCY_WINDOW_HOURS: the same tool and
 * arguments again answer it with `replayed: true` and write nothing; other
 * arguments are refused. Calls with one key run one at a time. Errors and
 * `retry` answers are not kept, so the caller can send the same call again.
 */
export async function runWrite(
  call: { connectionId: string; tool: string; target: string; args: Record<string, unknown>; key?: string; dryRun?: boolean },
  write: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const attempt = async () => {
    try {
      return await write()
    } catch (err) {
      if (err instanceof StoreBusyError) return retryResult(err)
      throw err
    }
  }
  const { key } = call
  if (key === undefined || call.dryRun) return attempt()
  return withKeyLock(`idempotency:${call.connectionId}:${key}`, async () => {
    const hash = argsHash(call.tool, call.target, call.args)
    const [stored] = await db
      .select({ argsHash: writeIdempotency.argsHash, result: writeIdempotency.result })
      .from(writeIdempotency)
      .where(
        and(
          eq(writeIdempotency.connectionId, call.connectionId),
          eq(writeIdempotency.key, key),
          sql`${writeIdempotency.createdAt} > now() - make_interval(hours => ${IDEMPOTENCY_WINDOW_HOURS})`,
        ),
      )
    if (stored) {
      if (stored.argsHash !== hash) throw new IdempotencyKeyReusedError(key, call.tool)
      return { ...(stored.result as Record<string, unknown>), replayed: true }
    }
    const result = await attempt()
    if (result.status !== 'retry') {
      // An expired entry of the same key is replaced.
      await db
        .insert(writeIdempotency)
        .values({ connectionId: call.connectionId, key, tool: call.tool, argsHash: hash, result })
        .onConflictDoUpdate({
          target: [writeIdempotency.connectionId, writeIdempotency.key],
          set: { tool: call.tool, argsHash: hash, result, createdAt: sql`now()` },
        })
    }
    return result
  })
}
