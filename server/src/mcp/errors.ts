import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DATABASE_FAILED, databaseFailure } from '../db/errors.js'
import type { z } from 'zod'
import { OkfValidationError, type OkfRefusal } from '../notes/okf.js'
import { NoteTooLargeError } from '../notes/size-cap.js'
import { StoreBusyError } from '../notes/store-tx.js'
import { MaintenanceInProgressError } from '../notes/maintenance-lock.js'
import { NoteWriteQuarantinedError, NoteWriteWouldQuarantineError } from '../notes/growth-guard.js'
import { NoteEditError } from '../sync/edit-ops.js'
import { NoteEditConflictError } from '../sync/crdt-write.js'
import { CursorError } from './response.js'
import { editDistance, suggestion } from './strict-input.js'
import { IdempotencyKeyReusedError } from './write-result.js'

/**
 * The code of a failed MCP tool call (#439, ADR-004 §2.7). One code per
 * kind of failure, whatever the wording:
 * - INVALID_ARGUMENT: the arguments (the SDK's schema check, strict keys
 *   #437, contradictory arguments, an edit op that cannot apply).
 * - NOT_FOUND: every not-found, including an id the caller cannot reach.
 * - PERMISSION_REQUIRED: the resource is visible, the action needs more (owner).
 * - TOOL_NOT_ALLOWED: the token's allow-list, access level, profile or scope.
 * - ALREADY_EXISTS, OKF_INVALID (`rule`: the rule broken), TOO_LARGE
 *   (`rule`: the limit).
 * - CURSOR_INVALID, CURSOR_STALE: a `cursor` this call cannot resume.
 * - AMBIGUOUS: a reference that names several things (`suggestions`: them).
 * - CONFLICT: the target's state refuses the call (not trashed, an
 *   idempotency key used for another call, an agent-push repository).
 * - BUSY: the store or the resource is busy now; retryable.
 * - QUARANTINED: a suspicious write kept out of the note (`rule`: growth or
 *   repeated-block); send it again with allowGrowth if intended.
 * - RATE_LIMITED: retryable after `retryAfterMs` (#440 answers it on HTTP 429).
 * - INTERNAL: a server fault.
 * CONFLICT, BUSY and QUARANTINED are not in ADR-004's list; the throw sites
 * needed them (plan note fixes/439-structured-errors).
 */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'PERMISSION_REQUIRED'
  | 'TOOL_NOT_ALLOWED'
  | 'ALREADY_EXISTS'
  | 'OKF_INVALID'
  | 'TOO_LARGE'
  | 'CURSOR_INVALID'
  | 'CURSOR_STALE'
  | 'AMBIGUOUS'
  | 'CONFLICT'
  | 'BUSY'
  | 'QUARANTINED'
  | 'RATE_LIMITED'
  | 'INTERNAL'

/** Whether the same call may succeed later unchanged; a code's default, which an error may override. */
const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  NOT_FOUND: false,
  PERMISSION_REQUIRED: false,
  TOOL_NOT_ALLOWED: false,
  ALREADY_EXISTS: false,
  OKF_INVALID: false,
  TOO_LARGE: false,
  CURSOR_INVALID: false,
  CURSOR_STALE: false,
  AMBIGUOUS: false,
  CONFLICT: false,
  BUSY: true,
  QUARANTINED: false,
  RATE_LIMITED: true,
  INTERNAL: false,
}

/** The `error` object of a failed call, keys in this order. */
export interface ErrorEnvelope {
  code: ErrorCode
  /** The human text, as before #439. */
  message: string
  retryable: boolean
  retryAfterMs?: number
  /** The rule the call broke: the slug regex, the size limit, the quarantine rule. */
  rule?: string
  /** The argument at fault, as a dotted path (`ops.0.text`). */
  field?: string
  /**
   * What the caller probably meant, taken only from what it can read: the
   * tool's parameters, an enum's values, note paths of a vault it reads,
   * the tools it lists. Left out when there are none (never `[]`).
   */
  suggestions?: string[]
}

export interface ErrorExtra {
  retryable?: boolean
  retryAfterMs?: number
  rule?: string
  field?: string
  suggestions?: readonly string[]
}

/** A refusal a tool handler throws: its code, its message and the envelope's other fields. */
export class McpToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message)
  }
}

/**
 * The envelope of `code`. The keys come in one order and an absent field
 * is left out, so the same refusal is the same bytes: the not-found for an
 * id the caller cannot reach equals the one for an id that does not exist.
 */
export function envelope(code: ErrorCode, message: string, extra: ErrorExtra = {}): ErrorEnvelope {
  return {
    code,
    message,
    retryable: extra.retryable ?? RETRYABLE[code],
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
    ...(extra.rule === undefined ? {} : { rule: extra.rule }),
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.suggestions && extra.suggestions.length > 0 ? { suggestions: [...extra.suggestions] } : {}),
  }
}

const OKF_CODES: Record<OkfRefusal, ErrorCode> = { invalid: 'OKF_INVALID', exists: 'ALREADY_EXISTS' }

/**
 * The envelope of an error a tool call threw. A failed query (drizzle's
 * wrapper names the SQL and every parameter, the note body included) is
 * INTERNAL with a fixed message and the SQLSTATE (#443). A Node system
 * error (fs, net) names the absolute server paths it touched, e.g.
 * `ENOENT: no such file or directory, rename '/data/vaults/…'`; the caller
 * gets only its code. Both go to the server log in full. Any other unknown
 * error is INTERNAL with its message.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof McpToolError) return envelope(err.code, err.message, err.extra)
  if (err instanceof CursorError) return envelope(err.code, err.message)
  if (err instanceof NoteTooLargeError) return envelope('TOO_LARGE', err.message, { rule: err.rule })
  if (err instanceof OkfValidationError) return envelope(OKF_CODES[err.refusal], err.message, { rule: err.rule })
  // Every StoreBusyError (lock timeout, a note waiting for the store migration) is BUSY and retryable, as a write's `status: retry`.
  if (err instanceof StoreBusyError || err instanceof MaintenanceInProgressError) return envelope('BUSY', err.message)
  if (err instanceof NoteWriteQuarantinedError || err instanceof NoteWriteWouldQuarantineError) {
    return envelope('QUARANTINED', err.message, { rule: err.code })
  }
  if (err instanceof NoteEditError) return envelope('INVALID_ARGUMENT', err.message)
  if (err instanceof NoteEditConflictError || err instanceof IdempotencyKeyReusedError) return envelope('CONFLICT', err.message)
  const failure = databaseFailure(err)
  if (failure) {
    console.error('[mcp] tool failed:', failure.logged, { query: failure.query })
    return envelope('INTERNAL', `${DATABASE_FAILED}${failure.code ? ` (${failure.code})` : ''}`)
  }
  if (err instanceof Error && 'syscall' in err && typeof err.syscall === 'string') {
    console.error('[mcp] tool failed:', err)
    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'unknown'
    return envelope('INTERNAL', `internal storage error (${code})`)
  }
  return envelope('INTERNAL', err instanceof Error ? err.message : String(err))
}

/** A failed call's result: the envelope as `content[0].text`, `isError`, and no `structuredContent` (the client would check it against a write tool's outputSchema). */
export function errorResult(error: ErrorEnvelope): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true }
}

/** The envelope of a refused request over the connection's rate limit, for #440 (HTTP 429 as JSON-RPC `error.data`). */
export function rateLimitedError(retryAfterMs: number): ErrorEnvelope {
  return envelope('RATE_LIMITED', 'rate limit exceeded for this connection', { retryAfterMs })
}

/** At most this many suggestions of paths or names. */
const MAX_SUGGESTIONS = 3

/**
 * The candidates closest to `wanted`, nearest first (then in code-unit
 * order): those with the same last path segment, and those within a few
 * edits of it (1 for up to 8 characters, 2 up to 16, else 3).
 */
export function closest(wanted: string, candidates: readonly string[]): string[] {
  const limit = wanted.length <= 8 ? 1 : wanted.length <= 16 ? 2 : 3
  const name = wanted.slice(wanted.lastIndexOf('/') + 1)
  const near: Array<{ value: string; distance: number }> = []
  for (const value of new Set(candidates)) {
    if (value === wanted) continue
    const sameName = value.slice(value.lastIndexOf('/') + 1) === name
    if (!sameName && Math.abs(value.length - wanted.length) > limit) continue
    const distance = editDistance(wanted, value)
    if (sameName || distance <= limit) near.push({ value, distance })
  }
  near.sort((a, b) => a.distance - b.distance || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
  return near.slice(0, MAX_SUGGESTIONS).map((n) => n.value)
}

/** The parts of a zod schema the argument walk reads (zod 4 `_zod.def`). */
interface SchemaDef {
  type: string
  innerType?: z.ZodType
  shape?: Record<string, z.ZodType>
  element?: z.ZodType
  options?: z.ZodType[]
  discriminator?: string
  values?: unknown[]
}
const defOf = (schema: z.ZodType): SchemaDef => schema._zod.def as unknown as SchemaDef

/** The keys the object schema at `path` declares (through optional, default, array and discriminated union), if it is one. */
function declaredAt(schema: z.ZodType, path: readonly PropertyKey[], input: unknown): string[] | undefined {
  let node: z.ZodType | undefined = schema
  let value = input
  let at = 0
  while (node) {
    const def = defOf(node)
    if (def.innerType && (def.type === 'optional' || def.type === 'nullable' || def.type === 'default')) {
      node = def.innerType
    } else if (def.type === 'union' && def.discriminator !== undefined) {
      const tag = value && typeof value === 'object' ? Reflect.get(value, def.discriminator) : undefined
      node = def.options?.find((option) => defOf(defOf(option).shape?.[def.discriminator!] ?? option).values?.includes(tag))
    } else if (at === path.length) {
      return def.type === 'object' && def.shape ? Object.keys(def.shape) : undefined
    } else {
      const key = path[at++]!
      value = value && typeof value === 'object' ? Reflect.get(value, key) : undefined
      node = def.type === 'object' ? def.shape?.[String(key)] : def.type === 'array' ? def.element : undefined
    }
  }
  return undefined
}

/**
 * The envelope of arguments the SDK refused before the tool ran (its
 * `Input validation error`). `issues` are the tool's schema's own on the
 * same arguments. An unknown key comes first, since it often explains a
 * missing one: `field` is the key, `suggestions` the parameters it may
 * have meant (all of that object's parameters when none is close). An
 * enum, and the tag of a discriminated union (an `ops[]` entry's `op`),
 * suggests its values. `message` is the SDK's, without its
 * `MCP error -32602: Input validation error: ` prefix.
 */
export function argumentRefusal(message: string, issues: readonly z.core.$ZodIssue[], schema: z.ZodType, args: unknown): ErrorEnvelope {
  const issue = issues.find((i) => i.code === 'unrecognized_keys') ?? issues[0]
  if (!issue) return envelope('INVALID_ARGUMENT', message)
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') {
    const names = declaredAt(schema, issue.path, args) ?? []
    const meant = issue.keys.map((key) => suggestion(key, names)).filter((name): name is string => name !== undefined)
    return envelope('INVALID_ARGUMENT', message, { field: [...path, issue.keys[0]!].join('.'), suggestions: meant.length > 0 ? [...new Set(meant)] : names })
  }
  // zod's discriminated union reports a bad or missing tag with its `options` (not in the issue's type).
  const values =
    issue.code === 'invalid_value'
      ? issue.values.map(String)
      : issue.code === 'invalid_union' && 'options' in issue && Array.isArray(issue.options)
        ? issue.options.map(String)
        : []
  return envelope('INVALID_ARGUMENT', message, { ...(path.length > 0 ? { field: path.join('.') } : {}), suggestions: values })
}
