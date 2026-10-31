/**
 * Usage report latency (#678 review): how long `usageReport` takes over a
 * full 7-day window of raw calls, instance and account scope.
 *
 *   DATABASE_URL=<scratch database> pnpm -C server profile-usage-report [rows...]   # default 70000 500000
 *
 * Per size, seeds by SQL (no MCP calls): 20 accounts with one vault of 500
 * notes each (10,000 notes), 5 tokens each; `rows` calls spread over the
 * last 7 days, half of them by one heavy account, the rest across the other
 * 19. Mix: read_note 50 % (one of the account's notes), search 30 % (5 hit
 * ids, a fifth of them no_match with none; 3,000 distinct query hashes),
 * list_vaults 20 %, plus a client-reported `local_fallback` every 500th
 * call. Then times the report 3 times per scope (instance; the heavy
 * account; a light one) and prints the median and the slowest. Deletes
 * everything it seeded; point DATABASE_URL at a scratch database.
 */
import { performance } from 'node:perf_hooks'
import { config } from '../config.js'
import { sql } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { UsageReportTimeout, usageReport, type ReportScope } from '../usage/report.js'

if (config.isProd) throw new Error('refusing to seed against NODE_ENV=production')
const SIZES = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [70_000, 500_000]
const ACCOUNTS = 20
const NOTES_PER_VAULT = 500
const RUNS = 3

await runMigrations()

async function seedAccounts(): Promise<string[]> {
  const ids = await sql<Array<{ id: string }>>`
    INSERT INTO users (email, password_hash, status)
    SELECT 'profile-usage-report-' || g || '-' || gen_random_uuid() || '@test.local', 'x', 'active' FROM generate_series(1, ${ACCOUNTS}) g
    RETURNING id`
  for (const { id } of ids) {
    const [vault] = await sql<Array<{ id: string }>>`INSERT INTO vaults (name, owner_id) VALUES ('profile-usage-report', ${id}) RETURNING id`
    await sql`
      INSERT INTO notes (vault_id, type, name, path, frontmatter, body)
      SELECT ${vault!.id}, 'docs', 'n' || g, 'docs/n' || g, '{}'::jsonb, '' FROM generate_series(1, ${NOTES_PER_VAULT}) g`
  }
  return ids.map((r) => r.id)
}

/** `rows` calls: account 1 makes half, the rest are spread over accounts 2..ACCOUNTS. */
async function seedCalls(accounts: string[], rows: number): Promise<void> {
  await sql`
    WITH acc AS (
      SELECT a.id, a.ord, (SELECT array_agg(n.id) FROM vaults v JOIN notes n ON n.vault_id = v.id WHERE v.owner_id = a.id) AS notes,
        (SELECT v.id FROM vaults v WHERE v.owner_id = a.id LIMIT 1) AS vault
      FROM unnest(${accounts}::uuid[]) WITH ORDINALITY AS a(id, ord)
    ), calls AS (
      SELECT g, CASE WHEN g % 2 = 0 THEN 1 ELSE 2 + (g / 2) % ${ACCOUNTS - 1} END AS ord,
        now() - make_interval(secs => (7 * 86400 - 60) * (1 - g::float8 / ${rows})) AS at
      FROM generate_series(1, ${rows}) g
    )
    INSERT INTO usage_events (at, account_id, token, tool, profile, vault_id, outcome, response_tokens, latency_ms, retrieval_mode,
      query_hash, query_length, query_lang, filters, hit_ids, target_id)
    SELECT c.at, acc.id, md5(acc.id::text || (c.g % 5))::text,
      CASE WHEN c.g % 500 = 0 THEN 'client_event' WHEN c.g % 10 < 5 THEN 'read_note' WHEN c.g % 10 < 8 THEN 'search' ELSE 'list_vaults' END,
      'admin', acc.vault,
      CASE WHEN c.g % 500 = 0 THEN 'local_fallback' WHEN c.g % 10 = 5 THEN 'no_match' ELSE 'ok' END,
      400 + c.g % 2000, 5 + (c.g % 97), CASE WHEN c.g % 10 BETWEEN 5 AND 7 THEN 'hybrid' END,
      CASE WHEN c.g % 500 <> 0 AND c.g % 10 BETWEEN 5 AND 7 THEN substr(md5((c.g % 3000)::text), 1, 16) END,
      CASE WHEN c.g % 500 <> 0 AND c.g % 10 BETWEEN 5 AND 7 THEN 10 + c.g % 40 END,
      CASE WHEN c.g % 500 <> 0 AND c.g % 10 BETWEEN 5 AND 7 THEN 'latin' END,
      CASE WHEN c.g % 500 <> 0 AND c.g % 10 BETWEEN 5 AND 7 THEN '{}'::jsonb END,
      CASE WHEN c.g % 500 = 0 THEN NULL WHEN c.g % 10 = 5 THEN '{}'::uuid[] WHEN c.g % 10 IN (6, 7)
        THEN ARRAY[acc.notes[1 + c.g % 150], acc.notes[1 + (c.g + 1) % 150], acc.notes[1 + (c.g + 2) % 150], acc.notes[1 + (c.g + 3) % 150], acc.notes[1 + (c.g + 4) % 150]] END,
      CASE WHEN c.g % 500 <> 0 AND c.g % 10 < 5 THEN acc.notes[1 + c.g % 150] END
    FROM calls c JOIN acc ON acc.ord = c.ord`
  await sql`ANALYZE usage_events`
}

async function time(scope: ReportScope): Promise<{ median_ms: number; max_ms: number } | { timeout: string }> {
  const ms: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now()
    try {
      await usageReport(scope)
    } catch (err) {
      if (err instanceof UsageReportTimeout) return { timeout: err.message }
      throw err
    }
    ms.push(performance.now() - started)
  }
  ms.sort((a, b) => a - b)
  return { median_ms: Math.round(ms[Math.floor(RUNS / 2)]!), max_ms: Math.round(ms[RUNS - 1]!) }
}

const accounts = await seedAccounts()
try {
  for (const rows of SIZES) {
    await sql`DELETE FROM usage_events WHERE account_id = ANY(${accounts}::uuid[])`
    await seedCalls(accounts, rows)
    const [heavy] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM usage_events WHERE account_id = ${accounts[0]!}`
    console.log(
      JSON.stringify({
        rows,
        instance: await time({ kind: 'instance' }),
        heavy_account: { rows: heavy!.n, ...(await time({ kind: 'account', accountId: accounts[0]! })) },
        light_account: await time({ kind: 'account', accountId: accounts[1]! }),
      }),
    )
  }
} finally {
  // Notes, then vaults (no cascade from users), then the users; their usage rows go with them.
  await sql`DELETE FROM notes WHERE vault_id IN (SELECT id FROM vaults WHERE owner_id = ANY(${accounts}::uuid[]))`
  await sql`DELETE FROM vaults WHERE owner_id = ANY(${accounts}::uuid[])`
  await sql`DELETE FROM users WHERE id = ANY(${accounts}::uuid[])`
  await sql.end()
}
