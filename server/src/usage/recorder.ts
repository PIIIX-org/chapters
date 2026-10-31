import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { sql } from '../db/client.js'
import { approxTokens } from '../mcp/response.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'

/**
 * The opt-in usage report's recorder (#678, backend-reference.md §5.12).
 *
 * Off by default (`instance_state.usage_report_enabled`, set by the instance
 * owner): then `withUsage` calls the tool and nothing else, and no row is
 * written. On: each MCP tool call is queued in memory as ids and numbers and
 * written in batches, after the answer is sent: every FLUSH_MS, or at once
 * past FLUSH_AT queued calls, one INSERT per batch. No call waits on it; a
 * full queue (MAX_QUEUED) drops calls, and a failed write drops its batch:
 * both are counted (`recorderStats`, shown in the report).
 *
 * Never stored: note or file text, paths, a search query's text, tool
 * arguments. A search keeps a salted hash of its normalised query, the
 * query's length in code points, a guess of its script and its non-text
 * filters. Hits and reads are note / repository file ids; a read's path is
 * resolved to its id in the INSERT and is not kept. The token (connection)
 * id and an agent's `session_id` (#683) are kept as salted hashes. The salt
 * (`instance_state.usage_salt`) never leaves the database and the process.
 */

/** Days a call is kept as it was recorded; then it is rolled up per day. */
export const RAW_DAYS = 7
/** Days the per-day rollups are kept. */
export const ROLLUP_DAYS = 30
/** Search statuses that answer no result (search.ts `SearchStatus`). */
export const ZERO_RESULT = ['no_match', 'index_building', 'unavailable'] as const
/** The `tool` of a client-reported event (`recordClientEvent`). */
export const CLIENT_EVENT = 'client_event'

const FLUSH_MS = 1_000
const FLUSH_AT = 200
const MAX_QUEUED = 10_000
/** The ranked hits a search row keeps (its first ones). */
const MAX_HITS = 20
const PRUNE_EVERY_MS = 60 * 60 * 1_000
/** The tools whose `query` is hashed, and their arguments kept as filters (numbers, booleans, enums only). */
const SEARCH_FILTERS: Record<string, readonly string[]> = {
  search: ['everywhere', 'symbols', 'limit'],
  find_symbols: ['kind', 'everywhere', 'limit'],
}
/** The tools that read one note or one repository file. */
const READS: Record<string, 'note' | 'file'> = { read_note: 'note', read_file: 'file' }

// ponytail: per-process flag (read at boot, set by the toggle route); LISTEN/NOTIFY if multi-process (backend-reference.md §9).
let enabled = false
let salt: string | null = null
let queue: QueuedCall[] = []
let timer: NodeJS.Timeout | null = null
let writing: Promise<void> = Promise.resolve()
let lastPrune = 0

/** The recorder since boot: calls written, the INSERTs that wrote them and their time, calls dropped (queue full, failed write). */
export interface RecorderStats {
  written: number
  batches: number
  write_ms: number
  not_recorded: number
}
const stats: RecorderStats = { written: 0, batches: 0, write_ms: 0, not_recorded: 0 }

/** What tool() hands the recorder: the targets its scope resolved and the handler's answer, as far as the call got. */
export interface UsageProbe {
  scoped?: unknown
  answer?: unknown
}

/** One call as the INSERT takes it (jsonb_to_recordset): ids, hashes and numbers; `read_path` only to find the read's id. */
interface QueuedCall {
  at: string
  account_id: string
  token: string
  session: string | null
  tool: string
  profile: McpAuth['connection']['profile']
  vault_id: string | null
  repository_id: string | null
  outcome: string
  response_tokens: number
  latency_ms: number
  retrieval_mode: string | null
  degraded: string | null
  query_hash: string | null
  query_length: number | null
  query_lang: string | null
  filters: Record<string, unknown> | null
  hits: Array<{ id: string; symbol: boolean }> | null
  read_kind: 'note' | 'file' | null
  read_container: string | null
  read_path: string | null
}

export function usageEnabled(): boolean {
  return enabled
}

export function recorderStats(): RecorderStats {
  return { ...stats, write_ms: Math.round(stats.write_ms * 10) / 10 }
}

/** Reads the setting (at boot, `usageRoutes`). */
export async function loadUsageSetting(): Promise<void> {
  const [row] = await sql<Array<{ enabled: boolean; salt: string | null }>>`
    SELECT usage_report_enabled AS enabled, usage_salt AS salt FROM instance_state WHERE id = 'singleton'`
  enabled = row?.enabled ?? false
  salt = row?.salt ?? null
}

/** Turns recording on or off (the instance owner, `PUT /api/usage/settings`); off drops what is still queued. */
export async function setUsageEnabled(on: boolean): Promise<void> {
  const [row] = await sql<Array<{ salt: string }>>`
    INSERT INTO instance_state (id, usage_report_enabled, usage_salt) VALUES ('singleton', ${on}, ${randomBytes(32).toString('hex')})
    ON CONFLICT (id) DO UPDATE SET usage_report_enabled = EXCLUDED.usage_report_enabled,
      usage_salt = coalesce(instance_state.usage_salt, EXCLUDED.usage_salt)
    RETURNING usage_salt AS salt`
  salt = row!.salt
  enabled = on
  if (!on) queue = []
}

/** 64 bits of sha256 over the salt, a kind and a value: equal for equal values on this instance only. */
function saltedHash(kind: string, value: string): string {
  return createHash('sha256').update(salt!).update(`\0${kind}\0`).update(value).digest('hex').slice(0, 16)
}

/** A query as it is hashed: NFKC, lower case, white space collapsed and trimmed. */
function normalisedQuery(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['latin', /\p{Script=Latin}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['greek', /\p{Script=Greek}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['hebrew', /\p{Script=Hebrew}/gu],
  ['devanagari', /\p{Script=Devanagari}/gu],
  ['han', /\p{Script=Han}/gu],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['hangul', /\p{Script=Hangul}/gu],
  ['thai', /\p{Script=Thai}/gu],
]

/**
 * A guess of a query's language, by its writing system: `code` for one
 * token that looks like an identifier or a path (`_ . : / # ( )` or a
 * camelCase hump), else the script most of its letters are in (`latin`,
 * `cyrillic`, `han`, ...), `other` for a script not listed, `none` without
 * letters. Says nothing about the words.
 */
export function queryLanguage(query: string): string {
  const trimmed = query.trim()
  if (!/\s/u.test(trimmed) && /[_.:/#()]|\p{Ll}\p{Lu}/u.test(trimmed)) return 'code'
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) return 'none'
  let best = 'other'
  let most = 0
  for (const [name, pattern] of SCRIPTS) {
    const count = trimmed.match(pattern)?.length ?? 0
    if (count > most) [best, most] = [name, count]
  }
  return best
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The error envelope's code of an error result (errors.ts `errorResult`: `{"error": {"code": ...}}`). */
function errorCode(result: CallToolResult): string {
  const first = result.content[0]
  try {
    const parsed: unknown = first?.type === 'text' ? JSON.parse(first.text) : null
    const code = isObject(parsed) && isObject(parsed.error) ? parsed.error.code : null
    return typeof code === 'string' ? code : 'INTERNAL'
  } catch {
    return 'INTERNAL'
  }
}

/** The ids a ranked `results` section listed first: a note's or file's own id, a symbol's file (find_symbols names it, search's symbol hits are resolved in the INSERT). */
function hitsOf(answer: Record<string, unknown>): Array<{ id: string; symbol: boolean }> {
  const sections = Array.isArray(answer.sections) ? (answer.sections as unknown[]) : []
  const results = sections.find((s) => isObject(s) && s.kind === 'ranked' && s.name === 'results')
  if (!isObject(results) || !Array.isArray(results.items)) return []
  const shown = typeof results.limit === 'number' ? Math.min(results.limit, MAX_HITS) : MAX_HITS
  const hits: Array<{ id: string; symbol: boolean }> = []
  for (const item of (results.items as unknown[]).slice(0, shown)) {
    if (!isObject(item)) continue
    if (typeof item.fileId === 'string') hits.push({ id: item.fileId, symbol: false })
    else if (typeof item.id === 'string') hits.push({ id: item.id, symbol: item.resourceType === 'symbol' })
  }
  return hits
}

/** The vault and repository a call resolved to (tool()'s scope targets): one of each at most; an account-wide call has neither. */
function scopeIds(scoped: unknown): { vault_id: string | null; repository_id: string | null } {
  if (!isObject(scoped)) return { vault_id: null, repository_id: null }
  const resources = isObject(scoped.resources) ? scoped.resources : null
  const only = (ids: unknown): string | null => (Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' ? ids[0] : null)
  return {
    vault_id: resources ? only(resources.vaultIds) : stringOrNull(scoped.vaultId),
    repository_id: resources ? only(resources.repositoryIds) : stringOrNull(scoped.repositoryId),
  }
}

/**
 * Wraps a tool's handler (mcp/server.ts tool()): while the report is off it
 * only calls `run`. On, it times the call and queues its record after the
 * answer is made; recording never fails or delays the call.
 */
export function withUsage(
  auth: McpAuth,
  tool: string,
  run: (raw: unknown, probe: UsageProbe) => Promise<CallToolResult>,
): (raw: unknown) => Promise<CallToolResult> {
  return async (raw) => {
    const probe: UsageProbe = {}
    if (!enabled) return run(raw, probe)
    const started = performance.now()
    const result = await run(raw, probe)
    recordCall(auth, tool, raw, probe, result, performance.now() - started)
    return result
  }
}

function recordCall(auth: McpAuth, tool: string, raw: unknown, probe: UsageProbe, result: CallToolResult, latencyMs: number): void {
  if (!enabled || !salt) return
  try {
    const args = isObject(raw) ? raw : {}
    const answer = isObject(probe.answer) ? probe.answer : {}
    const head = isObject(answer.head) ? answer.head : answer
    const status = stringOrNull(head.status)
    const outcome = result.isError ? errorCode(result) : status !== null && (ZERO_RESULT as readonly string[]).includes(status) ? status : 'ok'
    const filterKeys = SEARCH_FILTERS[tool]
    const query = filterKeys && typeof args.query === 'string' ? normalisedQuery(args.query) : null
    const filters = filterKeys ? Object.fromEntries(filterKeys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]])) : null
    const readKind = READS[tool] && !result.isError ? READS[tool] : null
    const ids = scopeIds(probe.scoped)
    const degraded = isObject(head.degraded) ? stringOrNull(head.degraded.reason) : null
    enqueue({
      at: new Date().toISOString(),
      account_id: auth.user.id,
      token: saltedHash('token', auth.connection.id),
      session: typeof args.session_id === 'string' ? saltedHash('session', args.session_id) : null,
      tool,
      profile: auth.connection.profile,
      ...ids,
      outcome,
      response_tokens: result.content.reduce((sum, c) => sum + (c.type === 'text' ? approxTokens(c.text) : 0), 0),
      latency_ms: latencyMs,
      retrieval_mode: stringOrNull(head.retrieval_mode),
      degraded,
      query_hash: query === null ? null : saltedHash('query', query),
      query_length: query === null ? null : [...query].length,
      query_lang: query === null ? null : queryLanguage(args.query as string),
      filters,
      hits: query === null || result.isError ? null : hitsOf(answer),
      read_kind: readKind,
      read_container: readKind === 'note' ? ids.vault_id : readKind === 'file' ? ids.repository_id : null,
      // The path the answer names (the stored one), else the argument: only to find the id.
      read_path: readKind ? (stringOrNull(head.path) ?? stringOrNull(args.path)) : null,
    })
  } catch (err) {
    stats.not_recorded++
    console.error('[usage] call not recorded:', err instanceof Error ? err.name : typeof err)
  }
}

/**
 * An event the client reported (`notifications/elara/client_event`, mcp/routes.ts):
 * today only `local_fallback`, the agent turned to its local tools. Kept as
 * the event's name, the token and the session hash; nothing else of it.
 */
export function recordClientEvent(auth: McpAuth, event: 'local_fallback', sessionId: string | null): void {
  if (!enabled || !salt) return
  enqueue({
    at: new Date().toISOString(),
    account_id: auth.user.id,
    token: saltedHash('token', auth.connection.id),
    session: sessionId === null ? null : saltedHash('session', sessionId),
    tool: CLIENT_EVENT,
    profile: auth.connection.profile,
    vault_id: auth.connection.vaultId,
    repository_id: auth.connection.repositoryId,
    outcome: event,
    response_tokens: 0,
    latency_ms: 0,
    retrieval_mode: null,
    degraded: null,
    query_hash: null,
    query_length: null,
    query_lang: null,
    filters: null,
    hits: null,
    read_kind: null,
    read_container: null,
    read_path: null,
  })
}

function enqueue(call: QueuedCall): void {
  if (queue.length >= MAX_QUEUED) {
    stats.not_recorded++
    return
  }
  queue.push(call)
  if (queue.length === FLUSH_AT) {
    void flushUsage()
    return
  }
  timer ??= setTimeout(() => {
    timer = null
    void flushUsage()
  }, FLUSH_MS).unref()
}

/**
 * Writes every call queued when its turn comes (the report, shutdown and
 * tests await it), in one INSERT; one write at a time. Calls queued while
 * it writes wait for the next timer, so a steady stream is written about
 * once per FLUSH_MS, not one small INSERT after another.
 */
export function flushUsage(): Promise<void> {
  writing = writing.then(writeQueued)
  return writing
}

async function writeQueued(): Promise<void> {
  if (queue.length > 0) {
    const batch = queue
    queue = []
    const started = performance.now()
    try {
      await insertCalls(batch)
      stats.written += batch.length
      stats.batches++
    } catch (err) {
      stats.not_recorded += batch.length
      console.error('[usage] write failed, calls dropped:', batch.length, err instanceof Error ? err.name : typeof err)
    }
    stats.write_ms += performance.now() - started
  }
  if (enabled && Date.now() - lastPrune > PRUNE_EVERY_MS) await pruneUsage().catch(() => {})
}

/**
 * One statement per batch: a read's path becomes its live note's or file's
 * id (none when nothing is there), a search's symbol hit its file's id, and
 * the rows keep the calls' order.
 */
async function insertCalls(batch: QueuedCall[]): Promise<void> {
  await sql`
    INSERT INTO usage_events (at, account_id, token, session, tool, profile, vault_id, repository_id, outcome, response_tokens,
      latency_ms, retrieval_mode, degraded, query_hash, query_length, query_lang, filters, hit_ids, target_id)
    SELECT e.at, e.account_id, e.token, e.session, e.tool, e.profile, e.vault_id, e.repository_id, e.outcome, e.response_tokens,
      e.latency_ms, e.retrieval_mode, e.degraded, e.query_hash, e.query_length, e.query_lang, e.filters,
      CASE WHEN e.hits IS NULL THEN NULL ELSE ARRAY(
        SELECT coalesce(b.owner_id, (h.hit->>'id')::uuid)
        FROM jsonb_array_elements(e.hits) WITH ORDINALITY AS h(hit, i)
        LEFT JOIN blocks b ON (h.hit->>'symbol')::boolean AND b.id = (h.hit->>'id')::uuid
        ORDER BY h.i) END,
      coalesce(n.id, f.id)
    FROM jsonb_to_recordset(${JSON.stringify(batch.map((call, ord) => ({ ...call, ord })))}::jsonb) AS e(at timestamptz, account_id uuid, token text,
      session text, tool text, profile mcp_profile, vault_id uuid, repository_id uuid, outcome text, response_tokens int,
      latency_ms real, retrieval_mode text, degraded text, query_hash text, query_length int, query_lang text, filters jsonb,
      hits jsonb, read_kind text, read_container uuid, read_path text, ord int)
    LEFT JOIN notes n ON e.read_kind = 'note' AND n.vault_id = e.read_container AND n.path = e.read_path AND n.deleted_at IS NULL
    LEFT JOIN repository_files f ON e.read_kind = 'file' AND f.repository_id = e.read_container AND f.path = e.read_path
    ORDER BY e.ord`
}

/**
 * Retention: calls past RAW_DAYS are added to their day's rollup (client
 * events are not: they only mean something next to the calls around them)
 * and deleted; rollups past ROLLUP_DAYS are deleted. One statement; runs at
 * boot, hourly while recording, and before every report.
 */
export async function pruneUsage(): Promise<void> {
  lastPrune = Date.now()
  await sql`
    WITH moved AS (
      DELETE FROM usage_events WHERE at < now() - make_interval(days => ${RAW_DAYS})
      RETURNING at, account_id, tool, profile, outcome, response_tokens, latency_ms
    ), rolled AS (
      INSERT INTO usage_daily AS d (day, account_id, tool, profile, calls, response_tokens, latency_ms, errors, zero_results)
      SELECT (at AT TIME ZONE 'UTC')::date, account_id, tool, profile, count(*), sum(response_tokens), sum(latency_ms),
        count(*) FILTER (WHERE outcome ~ '^[A-Z]'), count(*) FILTER (WHERE outcome = ANY(${ZERO_RESULT as unknown as string[]}))
      FROM moved WHERE tool <> ${CLIENT_EVENT} AND at >= now() - make_interval(days => ${ROLLUP_DAYS})
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (day, account_id, tool, profile) DO UPDATE SET calls = d.calls + EXCLUDED.calls,
        response_tokens = d.response_tokens + EXCLUDED.response_tokens, latency_ms = d.latency_ms + EXCLUDED.latency_ms,
        errors = d.errors + EXCLUDED.errors, zero_results = d.zero_results + EXCLUDED.zero_results
    )
    DELETE FROM usage_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - ${ROLLUP_DAYS}::int`
}
