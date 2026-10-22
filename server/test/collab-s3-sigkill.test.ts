// ADR-003 S3 (#487), end to end with a real SIGKILL: the server (src/index.ts)
// runs on its own database and data directory with the lab failpoint
// `collab.after-log-before-ack` armed, so it kills itself after an editor's
// update is committed to note_updates and before the ack. The editor still
// holds the update as unsynced; after the restart it resends it, and the
// note holds the text exactly once.
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider } from '@hocuspocus/provider'
import postgres from 'postgres'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://elara:elara@localhost:5432/elara_test'
const DB_NAME = `${new URL(BASE_URL).pathname.slice(1) || 'elara_test'}_s3_sigkill`
const dbUrl = new URL(BASE_URL)
dbUrl.pathname = `/${DB_NAME}`
const DB_URL = dbUrl.toString()
const SETUP_TOKEN = 's3-sigkill-setup-token-0123456789abcdef'

interface Running {
  child: ChildProcess
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

let dataDir: string
let port: number
const runs: Running[] = []
let provider: HocuspocusProvider | null = null

async function freePort(): Promise<number> {
  const srv = createServer().listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const { port } = srv.address() as AddressInfo
  srv.close()
  await once(srv, 'close')
  return port
}

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(BASE_URL, { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

function start(failpoints: string): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ELARA_DATABASE_URL: DB_URL,
      ELARA_DATA_DIR: dataDir,
      ELARA_LOCAL_REPOS_ROOT: join(dataDir, 'local-repos'),
      ELARA_PORT: String(port),
      ELARA_SETUP_TOKEN: SETUP_TOKEN,
      ELARA_FAILPOINTS: failpoints,
      COLLAB_DEBOUNCE_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d) => (out += String(d)))
  child.stderr?.on('data', (d) => (out += String(d)))
  const exited = once(child, 'exit').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }))
  const run = { child, output: () => out, exited }
  runs.push(run)
  return run
}

async function healthy(run: Running, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now()
  let exited = false
  void run.exited.then(() => (exited = true))
  for (;;) {
    if (exited) throw new Error(`server exited before it was healthy:\n${run.output().slice(-3000)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return
    } catch {
      /* not listening yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server not healthy after ${timeoutMs} ms:\n${run.output().slice(-3000)}`)
    // Polling another process over HTTP: there is no event to await.
    await sleep(250)
  }
}

async function api<T>(method: string, path: string, session: string | null, body?: unknown): Promise<{ status: number; json: T; cookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: `elara_session=${session}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, json: (await res.json()) as T, cookie: res.headers.get('set-cookie') }
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elara-s3-sigkill-'))
  port = await freePort()
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`)
    await sql.unsafe(`CREATE DATABASE "${DB_NAME}"`)
  })
})

afterAll(async () => {
  provider?.destroy()
  for (const r of runs) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL')
  await Promise.all(runs.map((r) => r.exited))
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`))
  rmSync(dataDir, { recursive: true, force: true })
})

describe('a real SIGKILL after the log commit, before the ack (S3, #487)', () => {
  it('the editor resends the unacked update after the restart and the note holds it once', async () => {
    const first = start('collab.after-log-before-ack')
    await healthy(first)
    const setup = await api<{ id: string }>('POST', '/api/setup', null, { token: SETUP_TOKEN, email: 'owner@example.org', password: 'correct horse battery staple 42' })
    expect(setup.status).toBe(200)
    const session = /elara_session=([^;]+)/.exec(setup.cookie ?? '')![1]!
    const vault = await api<{ id: string }>('POST', '/api/vaults', session, { name: 'S3 sigkill' })
    const note = await api<{ id: string }>('POST', `/api/vaults/${vault.json.id}/notes`, session, { type: 'docs', name: 'killed', body: 'Before the kill.\n' })
    expect(note.status).toBe(200)

    // The session token itself authenticates the relay (as server callers and tests do), so reconnects need no ticket.
    provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vault.json.id}/~${note.json.id}`, token: session, document: new Y.Doc() })
    const text = provider.document.getText('body')
    const deadline = Date.now() + 20_000
    while (!(provider.isSynced && text.length > 0)) {
      if (Date.now() > deadline) throw new Error('the editor never synced')
      await sleep(25)
    }
    text.insert(text.length, '@REAL-SIGKILL@')
    // The server logs the update, then SIGKILLs itself before the ack.
    expect((await first.exited).signal).toBe('SIGKILL')
    expect(first.output()).toContain('[failpoint] collab.after-log-before-ack: SIGKILL')
    expect(provider.hasUnsyncedChanges).toBe(true)

    const second = start('')
    await healthy(second)
    const resent = Date.now() + 60_000
    while (!(provider.isSynced && !provider.hasUnsyncedChanges)) {
      if (Date.now() > resent) throw new Error(`the editor never resent its update:\n${second.output().slice(-3000)}`)
      await sleep(100)
    }
    expect(text.toString().split('@REAL-SIGKILL@').length - 1).toBe(1)
    // REST GET folds the log first (§6): the note holds the text once.
    const read = await api<{ body: string }>('GET', `/api/vaults/${vault.json.id}/notes/docs/killed`, session)
    expect(read.json.body.split('@REAL-SIGKILL@').length - 1).toBe(1)
  }, 240_000)
})
