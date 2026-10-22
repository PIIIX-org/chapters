// Ground-truth helpers for the data-path tests (crash-write, big-notes,
// collab-duplication): what is on disk inside the app container, what is in
// Postgres, how much memory the app container uses, and raw MCP calls that
// report the exact HTTP response size.
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import * as Y from 'yjs'
import type { LabContext } from './context.ts'
import { appContainerId, appExec, compose, COMPOSE, exec, psqlRows, waitHealthy } from './docker.ts'

export const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Occurrences of `needle` in `hay` (non-overlapping). */
export function count(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** Deterministic markdown-ish ASCII text of exactly `bytes` bytes (no wikilinks, no fences). */
export function genBody(bytes: number, seed: number, header = ''): string {
  const words = [
    'vault', 'note', 'graph', 'index', 'revision', 'collab', 'crash', 'durable', 'atomic', 'rename',
    'fsync', 'debounce', 'yjs', 'document', 'history', 'embedding', 'search', 'latency', 'memory', 'agent',
  ]
  let s = seed >>> 0 || 1
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const parts: string[] = [header ? `${header}\n\n` : '']
  let len = parts[0]!.length
  let line = 0
  while (len < bytes) {
    let l = line % 12 === 0 ? `## Section ${line / 12}\n` : ''
    const n = 8 + Math.floor(rnd() * 8)
    const ws: string[] = []
    for (let i = 0; i < n; i++) ws.push(words[Math.floor(rnd() * words.length)]!)
    l += `${ws.join(' ')}.\n`
    parts.push(l)
    len += l.length
    line++
  }
  return parts.join('').slice(0, bytes)
}

// ---------------------------------------------------------------- disk dump

/** Runs inside the app container (node --import tsx), parses with the app's own parseNote. */
const DUMP_SCRIPT = String.raw`
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { parseNote } from './src/notes/okf.ts'
const [vaultId, bodiesArg] = process.argv.slice(2)
const root = join(process.env.DATA_DIR ?? '/data/elara', 'vaults', vaultId)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const want = new Set((bodiesArg ?? '').split(',').filter(Boolean))
const out = { root, exists: true, notes: [], crdt: [], crdtBins: [], tmp: [], trash: 0, other: [] }
async function walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) { if (dir === root) { out.exists = false; return } throw e }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { await walk(full); continue }
    const rel = relative(root, full).split('\\').join('/')
    if (rel.endsWith('.tmp')) { const s = await stat(full); out.tmp.push({ file: rel, bytes: s.size, mtime: s.mtime.toISOString() }); continue }
    if (rel.startsWith('.trash/')) { out.trash++; continue }
    if (rel.startsWith('.crdt/') && rel.endsWith('.bin')) { out.crdtBins.push(rel); continue }
    if (rel.endsWith('.md')) {
      const raw = await readFile(full, 'utf8')
      const path = rel.slice(0, -3)
      const rec = { path, rawBytes: Buffer.byteLength(raw), rawSha: sha(raw) }
      try {
        const p = parseNote(raw)
        rec.parseOk = true; rec.bodySha = sha(p.body); rec.bodyLen = p.body.length
        if (want.has(path)) rec.body = p.body
      } catch (err) { rec.parseOk = false; rec.parseError = String(err).slice(0, 300) }
      out.notes.push(rec)
      continue
    }
    out.other.push(rel)
  }
}
await walk(root)
process.stdout.write(JSON.stringify(out))
process.exit(0)
`

export interface DiskNote {
  path: string
  rawBytes: number
  rawSha: string
  parseOk: boolean
  parseError?: string
  bodySha?: string
  bodyLen?: number
  body?: string
}
/** A note's CRDT state as the relay would load it: `note_crdt.snapshot` plus the non-rejected `note_updates` tail (ADR-003 S2b). */
export interface CrdtState {
  /** The note's path (the row's), so it lines up with the disk dump. */
  path: string
  noteId: string
  bytes: number
  bodySha?: string
  bodyLen?: number
  decodeError?: string
  body?: string
}
export interface VaultDump {
  root: string
  exists: boolean
  notes: DiskNote[]
  /** From Postgres; a note without a `note_crdt` row has no entry. */
  crdt: CrdtState[]
  /** Leftover `.crdt/*.bin` files (none expected after S2b's backfill). */
  crdtBins: string[]
  tmp: { file: string; bytes: number; mtime: string }[]
  trash: number
  other: string[]
}

/** Every live note's CRDT state in `vaultId`, materialised like server/src/sync/note-crdt.ts readNoteCrdt. */
export async function dbCrdt(vaultId: string, bodies: string[] = []): Promise<CrdtState[]> {
  if (!UUID.test(vaultId)) throw new Error(`bad vault id ${vaultId}`)
  const rows = await psqlRows<{ note_id: string; path: string; snapshot: string; updates: string[] | null }>(`
    select c.note_id, n.path, encode(c.snapshot, 'hex') as snapshot,
      (select array_agg(encode(u.update, 'hex') order by u.id) from note_updates u
        where u.note_id = c.note_id and u.id > c.snapshot_through and u.rejected_at is null) as updates
    from note_crdt c join notes n on n.id = c.note_id
    where n.vault_id = '${vaultId}' and n.deleted_at is null order by n.path`)
  const want = new Set(bodies)
  return rows.map((r) => {
    const parts = [r.snapshot, ...(r.updates ?? [])].map((h) => Uint8Array.from(Buffer.from(h, 'hex')))
    const rec: CrdtState = { path: r.path, noteId: r.note_id, bytes: parts.reduce((s, p) => s + p.byteLength, 0) }
    try {
      const d = new Y.Doc()
      for (const p of parts) Y.applyUpdate(d, p)
      const body = d.getText('body').toString()
      rec.bodySha = sha(body)
      rec.bodyLen = body.length
      if (want.has(r.path)) rec.body = body
    } catch (err) {
      rec.decodeError = String(err).slice(0, 300)
    }
    return rec
  })
}

let dumpInstalledFor = ''

/** Walks /data/elara/vaults/<vaultId> inside the app container. `bodies` = note paths whose full text to return. */
export async function dumpVault(vaultId: string, bodies: string[] = []): Promise<VaultDump> {
  const cid = await appContainerId()
  if (dumpInstalledFor !== cid) {
    const w = await appExec(['sh', '-c', 'cat > /app/server/.lab-dump.mts'], DUMP_SCRIPT)
    if (w.code !== 0) throw new Error(`installing dump script failed: ${w.stderr}`)
    dumpInstalledFor = cid
  }
  const r = await appExec(['node', '--import', 'tsx', '/app/server/.lab-dump.mts', vaultId, bodies.join(',')])
  if (r.code !== 0) throw new Error(`dump failed (${r.code}): ${r.stderr.slice(0, 1000)}`)
  const dump = JSON.parse(r.stdout) as VaultDump
  dump.crdt = await dbCrdt(vaultId, bodies)
  return dump
}

/** `pnpm check-notes -- --vault <id>` equivalent, run inside the container. */
export async function checkNotes(vaultId?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await appExec(['node', '--import', 'tsx', 'src/scripts/check-notes.ts', ...(vaultId ? ['--vault', vaultId] : [])])
  return { code: r.code, stdout: r.stdout.trim().slice(0, 20_000), stderr: r.stderr.trim().slice(0, 4000) }
}

export async function containerLs(path: string) {
  return (await appExec(['sh', '-c', `ls -la ${path} 2>&1 || true`])).stdout
}

// ---------------------------------------------------------------- database

export interface DbNote {
  id: string
  path: string
  deleted: boolean
  body_len: number
  body_sha: string
  revs: number
  last_rev_sha: string | null
  last_rev_action: string | null
  /** actor_type of the newest revision: 'user' | 'mcp' | 'collab'. */
  last_rev_actor: string | null
  embedded: boolean
}

const UUID = /^[0-9a-f-]{36}$/

export async function dbNotes(ctx: LabContext, vaultId: string): Promise<DbNote[]> {
  if (!UUID.test(vaultId)) throw new Error(`bad vault id ${vaultId}`)
  return ctx.docker.psqlRows<DbNote>(`
    select n.id, n.path, n.deleted_at is not null as deleted, length(n.body) as body_len,
      encode(sha256(convert_to(n.body, 'UTF8')), 'hex') as body_sha,
      (select count(*)::int from note_revisions r where r.note_id = n.id) as revs,
      (select encode(sha256(convert_to(r.body, 'UTF8')), 'hex') from note_revisions r
        where r.note_id = n.id order by r.ord desc limit 1) as last_rev_sha,
      (select r.action from note_revisions r where r.note_id = n.id order by r.ord desc limit 1) as last_rev_action,
      (select r.actor_type::text from note_revisions r where r.note_id = n.id order by r.ord desc limit 1) as last_rev_actor,
      n.embedding is not null as embedded
    from notes n where n.vault_id = '${vaultId}' order by n.path`)
}

export async function dbBody(ctx: LabContext, noteId: string): Promise<string> {
  if (!UUID.test(noteId)) throw new Error(`bad note id ${noteId}`)
  const rows = await ctx.docker.psqlRows<{ body: string }>(`select body from notes where id = '${noteId}'`)
  return rows[0]?.body ?? ''
}

/** The live note at `path` in `vaultId` (its collab document is `<vaultId>/~<id>`). */
export async function dbNoteId(ctx: LabContext, vaultId: string, path: string): Promise<string> {
  if (!UUID.test(vaultId)) throw new Error(`bad vault id ${vaultId}`)
  const rows = await ctx.docker.psqlRows<{ id: string }>(
    `select id from notes where vault_id = '${vaultId}' and path = '${path.replace(/'/g, "''")}' and deleted_at is null`,
  )
  if (!rows[0]) throw new Error(`no live note ${path} in ${vaultId}`)
  return rows[0].id
}

/**
 * Saves note `noteId`'s CRDT state (its `note_crdt` row and every
 * `note_updates` row) into lab tables; `restoreCrdtState` puts exactly that
 * back by SQL. Together they plant a stale CRDT state behind a newer row.
 * Before ADR-003 S2b a crash between the row and the CRDT write left that
 * state (a stale `.crdt` bin); since S2b they share a transaction, so only a
 * manual change of those two tables does (#891). A real restore brings the
 * row back with them: `backupInstance` / `restoreInstance`.
 */
export async function saveCrdtState(ctx: LabContext, noteId: string): Promise<void> {
  if (!UUID.test(noteId)) throw new Error(`bad note id ${noteId}`)
  const t = noteId.replace(/-/g, '')
  await ctx.docker.psql(`
    drop table if exists lab_bak_crdt_${t}; drop table if exists lab_bak_upd_${t};
    create table lab_bak_crdt_${t} as select * from note_crdt where note_id = '${noteId}';
    create table lab_bak_upd_${t} as select * from note_updates where note_id = '${noteId}';`)
}

export async function restoreCrdtState(ctx: LabContext, noteId: string): Promise<void> {
  if (!UUID.test(noteId)) throw new Error(`bad note id ${noteId}`)
  const t = noteId.replace(/-/g, '')
  await ctx.docker.psql(`
    begin;
    delete from note_updates where note_id = '${noteId}';
    insert into note_updates select * from lab_bak_upd_${t};
    update note_crdt c set snapshot = b.snapshot, snapshot_through = b.snapshot_through,
      folded_through = b.folded_through, folded_seq = b.folded_seq, fold_error = b.fold_error
      from lab_bak_crdt_${t} b where c.note_id = b.note_id;
    drop table lab_bak_crdt_${t}; drop table lab_bak_upd_${t};
    commit;`)
}

/** The database dump `backupInstance` keeps in the db container, and its copy of a vault's files in the data volume (outside DATA_DIR). */
const BACKUP_DUMP = '/tmp/lab-instance-backup.sql'
const backupFiles = (vaultId: string) => `/data/lab-backup/${vaultId}.tgz`

export interface InstanceBackup {
  dumpBytes: number
  dumpMs: number
  tarMs: number
}

/**
 * The infrastructure backup of docs/self-hosting/backup.md §1, taken while
 * the app runs: `pg_dump` of the whole database (one snapshot, so rows,
 * revisions, CRDT state and sessions come from the same moment) and a tar of
 * the files of vault `vaultId` (the volume archive, narrowed to the vault
 * under test). Both stay on the instance for `restoreInstance`.
 */
export async function backupInstance(vaultId: string): Promise<InstanceBackup> {
  if (!UUID.test(vaultId)) throw new Error(`bad vault id ${vaultId}`)
  const dump = await exec([
    ...COMPOSE, 'exec', '-T', 'db', 'sh', '-c',
    `pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f ${BACKUP_DUMP} && stat -c %s ${BACKUP_DUMP}`,
  ])
  if (dump.code !== 0) throw new Error(`pg_dump failed (${dump.code}): ${dump.stderr.slice(0, 1000)}`)
  const tar = await exec([
    ...COMPOSE, 'exec', '-T', '-u', 'root', 'app', 'sh', '-c',
    `mkdir -p /data/lab-backup && tar czf ${backupFiles(vaultId)} -C /data/elara/vaults ${vaultId}`,
  ])
  if (tar.code !== 0) throw new Error(`archiving the vault's files failed (${tar.code}): ${tar.stderr.slice(0, 1000)}`)
  return { dumpBytes: Number(dump.stdout.trim()), dumpMs: Math.round(dump.ms), tarMs: Math.round(tar.ms) }
}

export interface InstanceRestore {
  stopMs: number
  databaseMs: number
  filesMs: number
  healthyMs: number
}

/**
 * The infrastructure restore of backup.md §2 from `backupInstance`, with
 * downtime: the app stopped, the database dropped, created empty and loaded
 * from the dump, the vault's files replaced by the tar's, the app started.
 * Nobody tells open tabs: they reconnect afterwards with their own Y.Doc.
 * Everything written since the backup is gone from the database, so call it
 * only around steps of the calling test.
 *
 * If a step fails it throws and leaves the app stopped: an app started on a
 * partly loaded database would fail every later test for this test's
 * reason. run.ts then finds the instance down before the next test and runs
 * no more (#658).
 */
export async function restoreInstance(baseUrl: string, vaultId: string): Promise<InstanceRestore> {
  if (!UUID.test(vaultId)) throw new Error(`bad vault id ${vaultId}`)
  const stop = await compose('stop', 'app')
  const db = await exec([
    ...COMPOSE, 'exec', '-T', 'db', 'sh', '-c',
    String.raw`psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d postgres -c "drop database \"$POSTGRES_DB\" with (force)" -c "create database \"$POSTGRES_DB\"" && ` +
      `psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f ${BACKUP_DUMP} && rm -f ${BACKUP_DUMP}`,
  ])
  if (db.code !== 0) throw new Error(`restoring the database failed (${db.code}), app left stopped: ${db.stderr.slice(0, 1000)}`)
  const tar = await exec([
    ...COMPOSE, 'run', '--rm', '--no-deps', '-T', '-u', 'root', '--entrypoint', 'sh', 'app', '-c',
    `rm -rf /data/elara/vaults/${vaultId} && tar xzf ${backupFiles(vaultId)} -C /data/elara/vaults && rm -f ${backupFiles(vaultId)}`,
  ])
  if (tar.code !== 0) throw new Error(`restoring the vault's files failed (${tar.code}), app left stopped: ${tar.stderr.slice(0, 1000)}`)
  await compose('start', 'app')
  const healthyMs = await waitHealthy(baseUrl)
  return { stopMs: Math.round(stop.ms), databaseMs: Math.round(db.ms), filesMs: Math.round(tar.ms), healthyMs: Math.round(healthyMs) }
}

// ---------------------------------------------------------------- container

/** App log lines since an ISO timestamp (or last n). */
export async function appLogsSince(sinceIso: string, n = 400): Promise<string> {
  const r = await exec([...COMPOSE, 'logs', '--no-color', '--since', sinceIso, '--tail', String(n), 'app'])
  return r.stdout
}

// ---------------------------------------------------------------- memory

function parseSize(s: string): number {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(s.trim())
  if (!m) return NaN
  const v = Number(m[1])
  const u = m[2]!.toLowerCase()
  const mult: Record<string, number> = {
    b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  }
  return v * (mult[u] ?? NaN)
}

export interface MemReport {
  source: string
  samples: number
  /** cgroup memory.current peak (includes page cache). */
  peakCurrent: number | null
  /** cgroup memory.stat `anon` peak (process heap/RSS, excludes page cache). */
  peakAnon: number | null
  baseCurrent: number | null
  baseAnon: number | null
  /** `docker stats` MemUsage peak. */
  dockerStatsPeak: number | null
  dockerStatsSamples: number
}

async function cgroupReader(cid: string): Promise<{ source: string; read: () => Promise<{ current: number; anon: number } | null> }> {
  for (const dir of [`/sys/fs/cgroup/system.slice/docker-${cid}.scope`, `/sys/fs/cgroup/docker/${cid}`]) {
    if (await Bun.file(`${dir}/memory.current`).exists()) {
      return {
        source: `host:${dir}`,
        read: async () => {
          try {
            const current = Number((await Bun.file(`${dir}/memory.current`).text()).trim())
            const stat = await Bun.file(`${dir}/memory.stat`).text()
            const anon = Number(/^anon (\d+)/m.exec(stat)?.[1] ?? NaN)
            return { current, anon }
          } catch {
            return null
          }
        },
      }
    }
  }
  return {
    source: 'docker-exec:/sys/fs/cgroup',
    read: async () => {
      const r = await exec(['docker', 'exec', cid, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current; grep "^anon " /sys/fs/cgroup/memory.stat'])
      if (r.code !== 0) return null
      const [cur, anonLine] = r.stdout.trim().split('\n')
      return { current: Number(cur), anon: Number(anonLine?.split(' ')[1] ?? NaN) }
    },
  }
}

/** Samples app container memory until stop(). */
export async function startMemSampler(intervalMs = 200) {
  const cid = await appContainerId()
  const reader = await cgroupReader(cid)
  const first = await reader.read()
  const rep: MemReport = {
    source: reader.source,
    samples: 0,
    peakCurrent: first?.current ?? null,
    peakAnon: first?.anon ?? null,
    baseCurrent: first?.current ?? null,
    baseAnon: first?.anon ?? null,
    dockerStatsPeak: null,
    dockerStatsSamples: 0,
  }
  let running = true
  const fast = (async () => {
    while (running) {
      const v = await reader.read()
      if (v) {
        rep.samples++
        if (Number.isFinite(v.current)) rep.peakCurrent = Math.max(rep.peakCurrent ?? 0, v.current)
        if (Number.isFinite(v.anon)) rep.peakAnon = Math.max(rep.peakAnon ?? 0, v.anon)
      }
      await Bun.sleep(intervalMs)
    }
  })()
  const stats = (async () => {
    while (running) {
      const r = await exec(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', cid])
      if (r.code === 0) {
        const v = parseSize(r.stdout.split('/')[0] ?? '')
        if (Number.isFinite(v)) {
          rep.dockerStatsSamples++
          rep.dockerStatsPeak = Math.max(rep.dockerStatsPeak ?? 0, v)
        }
      }
    }
  })()
  return {
    async stop(): Promise<MemReport> {
      running = false
      await Promise.all([fast, stats])
      return rep
    },
  }
}

export interface HealthReport {
  samples: number
  /** Slowest /health answer while sampling (an event-loop stall shows here). */
  maxMs: number
  failures: number
  over1s: number
}

/** Polls /health while running; reports the slowest answer and failures (event-loop stalls). */
export function startHealthSampler(baseUrl: string, intervalMs = 500): { stop(): Promise<HealthReport> } {
  let running = true
  const rep: HealthReport = { samples: 0, maxMs: 0, failures: 0, over1s: 0 }
  const loop = (async () => {
    while (running) {
      const t0 = performance.now()
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(60_000) })
        await res.text()
        if (!res.ok) rep.failures++
      } catch {
        rep.failures++
      }
      const ms = performance.now() - t0
      rep.samples++
      rep.maxMs = Math.max(rep.maxMs, Math.round(ms))
      if (ms > 1000) rep.over1s++
      await Bun.sleep(intervalMs)
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      return rep
    },
  }
}

// ---------------------------------------------------------------- raw MCP

export interface RawCall {
  httpStatus: number
  /** HTTP response body size in bytes. */
  bytes: number
  ms: number
  ttfbMs: number
  ok: boolean
  isError: boolean
  /** Inner tool text (first 500 chars when not requested in full). */
  textHead: string
  textLen: number
  json?: unknown
  error?: string
}

/** Responses above this are counted, not kept (see rawMcp). */
const FULL_BODY_LIMIT = 8 * 1024 * 1024

/** One MCP tools/call with exact response byte size; parses the inner JSON when `parse` is set. */
export async function rawMcp(
  baseUrl: string,
  token: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; parse?: boolean } = {},
): Promise<RawCall> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now()
    let res: Response
    try {
      res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
      })
    } catch (err) {
      const ms = performance.now() - t0
      return { httpStatus: 0, bytes: 0, ms, ttfbMs: ms, ok: false, isError: false, textHead: '', textLen: 0, error: String(err) }
    }
    const ttfbMs = performance.now() - t0
    // Stream the body: count every byte, keep it whole only up to FULL_BODY_LIMIT
    // (or when the caller parses it). Bigger bodies keep head + tail only, so
    // parallel 300 MB note_history answers do not exhaust the runner's memory.
    const keepAll = opts.parse === true
    const chunks: Uint8Array[] = []
    let bytes = 0
    let head = new Uint8Array(0)
    let tail = new Uint8Array(0)
    let truncated = false
    try {
      const reader = res.body?.getReader()
      for (;;) {
        if (!reader) break
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (!truncated) {
          chunks.push(value)
          if (!keepAll && bytes > FULL_BODY_LIMIT) {
            const all = Buffer.concat(chunks)
            head = all.subarray(0, 4096)
            tail = all.subarray(all.byteLength - 4096)
            chunks.length = 0
            truncated = true
          }
        } else {
          const joined = Buffer.concat([tail, value])
          tail = joined.subarray(Math.max(0, joined.byteLength - 4096))
        }
      }
    } catch (err) {
      const ms = performance.now() - t0
      return { httpStatus: res.status, bytes, ms, ttfbMs, ok: false, isError: false, textHead: '', textLen: 0, error: `body read after ${bytes} B: ${String(err)}` }
    }
    const ms = performance.now() - t0
    if (res.status === 429 && attempt < 8) {
      await Bun.sleep(Math.min(30_000, 1000 * 2 ** (attempt + 1)))
      continue
    }
    const out: RawCall = { httpStatus: res.status, bytes, ms, ttfbMs, ok: false, isError: false, textHead: '', textLen: 0 }
    if (truncated) {
      // Only successful tool results get this big; an error result is a short `Error: ...` text.
      const h = new TextDecoder().decode(head)
      const t = new TextDecoder().decode(tail)
      out.textHead = h.slice(0, 500)
      out.textLen = -1
      out.isError = /"isError"\s*:\s*true/.test(t)
      out.ok = res.status === 200 && h.startsWith('{"result"') && !out.isError
      if (!out.ok) out.error = `truncated body: head ${h.slice(0, 200)} tail ${t.slice(-200)}`
      return out
    }
    const raw = new TextDecoder().decode(Buffer.concat(chunks))
    if (res.status !== 200) {
      out.textHead = raw.slice(0, 500)
      out.textLen = raw.length
      return out
    }
    let rpc: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: unknown }
    try {
      rpc = JSON.parse(raw)
    } catch (err) {
      out.error = `rpc parse: ${String(err)}`
      out.textHead = raw.slice(0, 500)
      return out
    }
    if (!rpc.result) {
      out.error = `rpc error: ${JSON.stringify(rpc.error).slice(0, 500)}`
      return out
    }
    const text = (rpc.result.content ?? []).map((c) => c.text ?? '').join('\n')
    out.isError = Boolean(rpc.result.isError)
    out.ok = !out.isError
    out.textHead = text.slice(0, 500)
    out.textLen = text.length
    if (opts.parse && out.ok) {
      try {
        out.json = JSON.parse(text)
      } catch {
        /* not JSON */
      }
    }
    return out
  }
}

export const MB = 1024 * 1024
export const fmtMB = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '-' : `${(n / MB).toFixed(1)} MiB`)
