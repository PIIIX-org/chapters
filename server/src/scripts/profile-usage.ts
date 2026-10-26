/**
 * Usage report cost (#678): what recording adds to an MCP call, what its
 * writes cost, and how fast its table grows.
 *
 *   DATABASE_URL=<scratch database> pnpm -C server profile-usage [calls]   # default 1000
 *
 * Through the app's HTTP stack in process (`app.inject`, one stateless
 * JSON-RPC `tools/call` per call, as an agent sends it; each from its own
 * client address, so the per-IP request limit does not stop the run):
 * `calls` calls with the report off and `calls` with it on, interleaved in
 * blocks of 100 so drift hits both alike, each a mix of read_note (50 %),
 * search (30 %) and list_vaults (20 %); p50 / p95 of the latency per mode.
 * Then the recorder alone on the call path: `withUsage` around a handler
 * that answers at once with a 20-hit search answer, 5,000 calls off and 5,000
 * on (µs per call). Then 10,000 more calls with it on: the recorder's own
 * write time per call (`recorderStats`) and `usage_events` growth (table,
 * indexes and TOAST) per 10,000 calls. Seeds one user, vault, 20 notes and
 * token, and deletes the user's usage rows afterwards; point DATABASE_URL at
 * a scratch database.
 */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { buildApp } from '../app.js'
import { hashPassword } from '../auth/passwords.js'
import { config } from '../config.js'
import { db, sql } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { users } from '../db/schema.js'
import { resetRateLimits } from '../mcp/rate-limit.js'
import { flushEmbeddings } from '../search/embedding-queue.js'
import { flushUsage, recorderStats, setUsageEnabled, withUsage } from '../usage/recorder.js'
import { resolveMcpToken } from '../vaults/mcp-connection-routes.js'

if (config.isProd) throw new Error('refusing to seed against NODE_ENV=production')
const CALLS = Number(process.argv[2] ?? 1000)
const GROWTH_CALLS = 10_000
const BLOCK = 100
const PASSWORD = 'profile-usage-password'

await runMigrations()
const app = await buildApp({ logger: false })
await app.ready()

const [user] = await db
  .insert(users)
  .values({ email: `profile-usage-${Date.now()}@test.local`, passwordHash: await hashPassword(PASSWORD), status: 'active', emailVerifiedAt: new Date(), role: 'owner' })
  .returning()
const login = await app.inject({ method: 'POST', url: '/api/login', body: { email: user!.email, password: PASSWORD } })
const cookie = String(login.headers['set-cookie']).split(';')[0]!
const post = async (url: string, body: Record<string, unknown>) => (await app.inject({ method: 'POST', url, headers: { cookie }, body })).json<Record<string, string>>()
const vaultId = (await post('/api/vaults', { name: 'profile-usage' })).id!
const token = (await post('/api/mcp-connections', { name: 'profile-usage', scope: 'account', access: 'admin', profile: 'admin' })).token!
let rpcId = 0
/** One MCP tool call; throws unless it answered a result. */
async function tool(name: string, args: Record<string, unknown>): Promise<void> {
  rpcId++
  if (rpcId % 50 === 0) resetRateLimits()
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: `10.${(rpcId >> 16) & 255}.${(rpcId >> 8) & 255}.${rpcId & 255}`,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    payload: { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } },
  })
  if (res.statusCode !== 200 || !res.body.includes('"result"')) throw new Error(`${name}: ${res.statusCode} ${res.body.slice(0, 200)}`)
}
const words = ['alpha', 'beacon', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper']
for (let i = 0; i < 20; i++) {
  await tool('create_note', { vaultId, type: 'docs', name: `note-${i}`, body: `${words[i % 10]} ${words[(i * 3) % 10]} paragraph ${i}.\n`.repeat(20) })
}
await flushEmbeddings()

/** The i-th call of the mix: read_note 50 %, search 30 %, list_vaults 20 %. */
async function call(i: number): Promise<number> {
  const kind = i % 10
  const started = performance.now()
  if (kind < 5) await tool('read_note', { vaultId, path: `docs/note-${i % 20}` })
  else if (kind < 8) await tool('search', { vaultId, query: `${words[i % 10]}${i % 7 === 0 ? ' zzzmissing' : ''}` })
  else await tool('list_vaults', {})
  return performance.now() - started
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
const summary = (ms: number[]) => {
  const sorted = [...ms].sort((a, b) => a - b)
  return { calls: ms.length, p50_ms: +quantile(sorted, 0.5).toFixed(2), p95_ms: +quantile(sorted, 0.95).toFixed(2) }
}

// Warm-up, off.
for (let i = 0; i < 200; i++) await call(i)
const off: number[] = []
const on: number[] = []
for (let block = 0; block < (2 * CALLS) / BLOCK; block++) {
  const enabled = block % 2 === 1
  await setUsageEnabled(enabled)
  for (let i = 0; i < BLOCK; i++) (enabled ? on : off).push(await call(block * BLOCK + i))
}
await flushUsage()
console.log(JSON.stringify({ latency: { off: summary(off), on: summary(on) } }))

// The recorder alone: withUsage around a handler that answers at once (what recording adds on the call path).
const auth = (await resolveMcpToken(token))!
const hits = Array.from({ length: 21 }, (_, i) => ({ resourceType: 'note', id: randomUUID(), path: `docs/note-${i}`, snippet: 'x'.repeat(200), score: 1 }))
const answer = { head: { status: 'ok', retrieval_mode: 'hybrid', degraded: false }, sections: [{ kind: 'ranked', name: 'results', items: hits, limit: 20 }] }
const answered = { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', results: hits.slice(0, 20) }) }] }
const scoped = { resources: { vaultIds: [vaultId], repositoryIds: [] } }
const wrapped = withUsage(auth, 'search', async (_raw, probe) => {
  probe.scoped = scoped
  probe.answer = answer
  return answered
})
const recorderCost = async (enabled: boolean) => {
  await setUsageEnabled(enabled)
  const us: number[] = []
  for (let i = 0; i < 5_000; i++) {
    const started = performance.now()
    await wrapped({ query: `alpha beacon ${i}`, vaultId, limit: 20 })
    us.push((performance.now() - started) * 1_000)
  }
  await flushUsage()
  const sorted = us.sort((a, b) => a - b)
  return { calls: us.length, mean_us: +(us.reduce((s, v) => s + v, 0) / us.length).toFixed(2), p50_us: +quantile(sorted, 0.5).toFixed(2), p95_us: +quantile(sorted, 0.95).toFixed(2) }
}
await recorderCost(false)
console.log(JSON.stringify({ recorder_on_call_path: { off: await recorderCost(false), on: await recorderCost(true) } }))
const size = async () => {
  const [row] = await sql<Array<{ bytes: number; rows: number }>>`
    SELECT pg_total_relation_size('usage_events')::float8 AS bytes, (SELECT count(*) FROM usage_events)::int AS rows`
  return row!
}
await sql`DELETE FROM usage_events WHERE account_id = ${user!.id}`
await sql`VACUUM FULL usage_events`
const before = await size()
const statsBefore = recorderStats()
await setUsageEnabled(true)
for (let i = 0; i < GROWTH_CALLS; i++) await call(i)
await flushUsage()
const after = await size()
const stats = recorderStats()
const written = stats.written - statsBefore.written
console.log(
  JSON.stringify({
    growth: { calls: GROWTH_CALLS, rows: after.rows - before.rows, bytes: after.bytes - before.bytes, bytes_per_row: Math.round((after.bytes - before.bytes) / (after.rows - before.rows)) },
    writes: { calls: written, batches: stats.batches - statsBefore.batches, ms: +(stats.write_ms - statsBefore.write_ms).toFixed(1), ms_per_call: +((stats.write_ms - statsBefore.write_ms) / written).toFixed(4), not_recorded: stats.not_recorded },
  }),
)

await setUsageEnabled(false)
await sql`DELETE FROM usage_events WHERE account_id = ${user!.id}`
await app.close()
await sql.end()
