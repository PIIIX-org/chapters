import type { Fragment } from 'postgres'
import { sql } from '../db/client.js'
import { CLIENT_EVENT, RAW_DAYS, ROLLUP_DAYS, ZERO_RESULT, flushUsage, pruneUsage, usageEnabled, usageNotRecorded } from './recorder.js'

/**
 * The usage report (#678, backend-reference.md §5.13): `account` covers the
 * calls of one account's tokens and the notes of the vaults it owns;
 * `instance` (instance admins) covers every account as aggregates, with no
 * account, token, session, note id or path in it.
 *
 * Totals per tool span the rollups and the raw calls (ROLLUP_DAYS); the
 * other sections need the calls themselves, so they cover RAW_DAYS:
 *
 * - `sessions`: calls and response tokens per tool per session. A session is
 *   the agent's `session_id` (#683) when it sent one, else its token; either
 *   way a gap of SESSION_GAP_MINUTES without a call starts a new one.
 * - `searches`: `zero_result` counts searches that answered no result
 *   (`no_match`, `index_building`, `unavailable`). `no_useful_hit` is a
 *   proxy: a search with hits none of which the same token read (read_note,
 *   read_file) within its next USEFUL_WITHIN_CALLS calls. It over-counts: a
 *   snippet can answer the question, and a read through another token is
 *   not seen. Queries are listed by salted hash with length, script and
 *   filters, never as text.
 * - `never_read`: live notes of the account's vaults that no token of the
 *   account read in the window (instance: their number only).
 * - `fallbacks`: events the client reported (`local_fallback`) and the notes
 *   and files read in the FALLBACK_LOOKBACK_CALLS calls before each. Only a
 *   client that sends `notifications/elara/client_event` fills it; none known
 *   does yet, so `populated` is false until one reports.
 */
export const USEFUL_WITHIN_CALLS = 5
export const FALLBACK_LOOKBACK_CALLS = 5
export const SESSION_GAP_MINUTES = 30
/** Rows each list shows at most. */
const LIST = 20
const NEVER_READ_LIST = 50

export type ReportScope = { kind: 'account'; accountId: string } | { kind: 'instance' }

interface ToolTotals {
  tool: string
  calls: number
  tokens: number
  errors: number
  zero_results: number
  latency_p50_ms: number | null
  latency_p95_ms: number | null
}

export async function usageReport(scope: ReportScope): Promise<Record<string, unknown>> {
  await flushUsage()
  await pruneUsage()
  const account = scope.kind === 'account' ? scope.accountId : null
  // Every query filters on the account first (usage_events_account_at, usage_daily_account_day).
  const mine = account === null ? sql`` : sql`AND account_id = ${account}`
  const recent = sql`at >= now() - make_interval(days => ${RAW_DAYS})`

  const [tools, sessions, searches, neverRead, fallbacks, since] = await Promise.all([
    sql<ToolTotals[]>`
      WITH raw AS (
        SELECT tool, count(*)::int AS calls, sum(response_tokens)::float8 AS tokens,
          count(*) FILTER (WHERE outcome ~ '^[A-Z]')::int AS errors,
          count(*) FILTER (WHERE outcome = ANY(${ZERO_RESULT as unknown as string[]}))::int AS zero_results,
          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::numeric, 1)::float8 AS p50,
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 1)::float8 AS p95
        FROM usage_events WHERE tool <> ${CLIENT_EVENT} ${mine} GROUP BY tool
      ), daily AS (
        SELECT tool, sum(calls)::int AS calls, sum(response_tokens)::float8 AS tokens, sum(errors)::int AS errors,
          sum(zero_results)::int AS zero_results
        FROM usage_daily WHERE true ${mine} GROUP BY tool
      )
      SELECT tool, coalesce(r.calls, 0) + coalesce(d.calls, 0) AS calls, coalesce(r.tokens, 0) + coalesce(d.tokens, 0) AS tokens,
        coalesce(r.errors, 0) + coalesce(d.errors, 0) AS errors, coalesce(r.zero_results, 0) + coalesce(d.zero_results, 0) AS zero_results,
        r.p50 AS latency_p50_ms, r.p95 AS latency_p95_ms
      FROM raw r FULL JOIN daily d USING (tool)
      ORDER BY tokens DESC, tool`,
    sql<Array<{ token: string; session: string | null; started: Date; ended: Date; calls: number; tokens: number; tools: unknown; total: number }>>`
      WITH ev AS (
        SELECT id, token, session, tool, response_tokens, at,
          CASE WHEN at - lag(at) OVER w <= make_interval(mins => ${SESSION_GAP_MINUTES}) THEN 0 ELSE 1 END AS starts
        FROM usage_events WHERE ${recent} AND tool <> ${CLIENT_EVENT} ${mine}
        WINDOW w AS (PARTITION BY token, session ORDER BY id)
      ), numbered AS (
        SELECT *, sum(starts) OVER (PARTITION BY token, session ORDER BY id) AS n FROM ev
      ), per_tool AS (
        SELECT token, session, n, tool, count(*)::int AS calls, sum(response_tokens)::float8 AS tokens, min(at) AS started, max(at) AS ended
        FROM numbered GROUP BY token, session, n, tool
      )
      SELECT token, session, min(started) AS started, max(ended) AS ended, sum(calls)::int AS calls, sum(tokens)::float8 AS tokens,
        jsonb_object_agg(tool, jsonb_build_object('calls', calls, 'tokens', tokens)) AS tools, (count(*) OVER ())::int AS total
      FROM per_tool GROUP BY token, session, n
      ORDER BY ended DESC LIMIT ${LIST}`,
    searchSection(mine, recent),
    neverReadSection(account),
    fallbackSection(mine, recent, account),
    sql<Array<{ since: Date | null }>>`
      SELECT least((SELECT min(at) FROM usage_events WHERE true ${mine}), (SELECT min(day)::timestamptz FROM usage_daily WHERE true ${mine})) AS since`,
  ])

  const totals = { calls: 0, tokens: 0, errors: 0, zero_results: 0 }
  for (const t of tools) {
    totals.calls += t.calls
    totals.tokens += t.tokens
    totals.errors += t.errors
    totals.zero_results += t.zero_results
  }
  return {
    enabled: usageEnabled(),
    scope: scope.kind,
    window: { totals_days: ROLLUP_DAYS, detail_days: RAW_DAYS, since: since[0]?.since ?? null },
    totals,
    tools: [...tools],
    sessions: {
      count: sessions[0]?.total ?? 0,
      gap_minutes: SESSION_GAP_MINUTES,
      latest: sessions.map(({ token, session, started, ended, calls, tokens, tools: byTool }) => ({
        ...(account === null ? {} : { token, session }),
        started,
        ended,
        calls,
        tokens,
        tools: byTool,
      })),
    },
    searches,
    never_read: neverRead,
    fallbacks,
    not_recorded_since_boot: usageNotRecorded(),
  }
}

async function searchSection(mine: Fragment, recent: Fragment): Promise<Record<string, unknown>> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    WITH ev AS (
      SELECT id, token, tool, outcome, hit_ids, target_id, query_hash, query_length, query_lang, filters,
        row_number() OVER (PARTITION BY token ORDER BY id) AS n
      FROM usage_events WHERE ${recent} AND tool <> ${CLIENT_EVENT} ${mine}
    ), s AS (
      SELECT s.*, s.outcome = ANY(${ZERO_RESULT as unknown as string[]}) AS zero, coalesce(cardinality(s.hit_ids), 0) > 0 AS hit,
        EXISTS (
          SELECT 1 FROM ev r
          WHERE r.token = s.token AND r.n > s.n AND r.n <= s.n + ${USEFUL_WITHIN_CALLS} AND r.target_id = ANY(s.hit_ids)
        ) AS useful
      FROM ev s WHERE s.query_hash IS NOT NULL
    ), grouped AS (
      SELECT zero, tool, query_hash, query_length AS length, query_lang AS language, filters, count(*)::int AS count
      FROM s WHERE zero OR (hit AND NOT useful)
      GROUP BY zero, tool, query_hash, query_length, query_lang, filters
    )
    SELECT (SELECT count(*) FROM s)::int AS total,
      (SELECT count(*) FROM s WHERE zero)::int AS zero_result,
      (SELECT count(*) FROM s WHERE hit)::int AS with_hits,
      (SELECT count(*) FROM s WHERE hit AND NOT useful)::int AS no_useful_hit,
      ${USEFUL_WITHIN_CALLS}::int AS useful_within_calls,
      (SELECT coalesce(jsonb_agg(to_jsonb(g) - 'zero' ORDER BY g.count DESC, g.query_hash), '[]'::jsonb)
       FROM (SELECT * FROM grouped WHERE zero ORDER BY count DESC, query_hash LIMIT ${LIST}) g) AS zero_result_queries,
      (SELECT coalesce(jsonb_agg(to_jsonb(g) - 'zero' ORDER BY g.count DESC, g.query_hash), '[]'::jsonb)
       FROM (SELECT * FROM grouped WHERE NOT zero ORDER BY count DESC, query_hash LIMIT ${LIST}) g) AS no_useful_hit_queries`
  return row!
}

async function neverReadSection(account: string | null): Promise<Record<string, unknown>> {
  if (account === null) {
    const [row] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM notes n JOIN vaults v ON v.id = n.vault_id
      WHERE v.deleted_at IS NULL AND n.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.target_id = n.id)`
    return { count: row!.count }
  }
  const rows = await sql<Array<{ id: string; vault_id: string; path: string; total: number }>>`
    SELECT n.id, n.vault_id, n.path, (count(*) OVER ())::int AS total
    FROM vaults v JOIN notes n ON n.vault_id = v.id AND n.deleted_at IS NULL
    WHERE v.owner_id = ${account} AND v.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.target_id = n.id AND e.account_id = ${account})
    ORDER BY n.vault_id, n.path COLLATE "C" LIMIT ${NEVER_READ_LIST}`
  return { count: rows[0]?.total ?? 0, notes: rows.map(({ id, vault_id, path }) => ({ id, vault_id, path })) }
}

async function fallbackSection(mine: Fragment, recent: Fragment, account: string | null): Promise<Record<string, unknown>> {
  const [row] = await sql<Array<{ reported: number; reads_before: number; notes_read_before: unknown }>>`
    WITH ev AS (
      SELECT id, token, tool, outcome, target_id, row_number() OVER (PARTITION BY token ORDER BY id) AS n
      FROM usage_events WHERE ${recent} ${mine}
    ), f AS (
      SELECT token, n FROM ev WHERE tool = ${CLIENT_EVENT} AND outcome = 'local_fallback'
    ), reads AS (
      SELECT r.target_id AS id, count(*)::int AS count
      FROM f JOIN ev r ON r.token = f.token AND r.n < f.n AND r.n >= f.n - ${FALLBACK_LOOKBACK_CALLS} AND r.target_id IS NOT NULL
      GROUP BY r.target_id
    )
    SELECT (SELECT count(*) FROM f)::int AS reported, (SELECT coalesce(sum(count), 0) FROM reads)::int AS reads_before,
      CASE WHEN ${account !== null} THEN (
        SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(x)) ORDER BY x.count DESC, x.path), '[]'::jsonb) FROM (
          SELECT n.id, n.vault_id, NULL::uuid AS repository_id, n.path, r.count FROM reads r JOIN notes n ON n.id = r.id AND n.deleted_at IS NULL
          UNION ALL
          SELECT fl.id, NULL, fl.repository_id, fl.path, r.count FROM reads r JOIN repository_files fl ON fl.id = r.id
          ORDER BY count DESC, path LIMIT ${LIST}) x
      ) END AS notes_read_before`
  const { reported, reads_before, notes_read_before } = row!
  const section = { reported, populated: reported > 0, lookback_calls: FALLBACK_LOOKBACK_CALLS, reads_before }
  return account === null ? section : { ...section, notes_read_before }
}
