// #583, end to end: the real server (src/index.ts) on its own database and
// data directory, stopped with SIGTERM and with SIGKILL, must report on its
// next boot how the previous process ended. Reaches the fix only through
// `/health`, which dev already serves, so it fails there on an assertion.
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
// The test database's server; the spawned app gets a database of its own,
// so its boot work (migrations, catch-ups, setup token) touches nothing the
// other test files use.
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://elara:elara@localhost:5432/elara_test'
const DB_NAME = `${new URL(BASE_URL).pathname.slice(1) || 'elara_test'}_lifecycle`
const dbUrl = new URL(BASE_URL)
dbUrl.pathname = `/${DB_NAME}`
const DB_URL = dbUrl.toString()

interface Health {
  status: string
  bootId?: string
  startedAt?: string
  version?: string | null
  lastShutdown?: string
  previousBootId?: string | null
}

interface Running {
  child: ChildProcess
  output: () => string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

let dataDir: string
let port: number
const runs: Running[] = []

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

function start(): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      // The ELARA_* names win over every alias in config.ts.
      ELARA_DATABASE_URL: DB_URL,
      ELARA_DATA_DIR: dataDir,
      ELARA_LOCAL_REPOS_ROOT: join(dataDir, 'local-repos'),
      ELARA_PORT: String(port),
      ELARA_VERSION: 'lifecycle-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d) => (out += String(d)))
  child.stderr?.on('data', (d) => (out += String(d)))
  // Subscribed now: the exit can come before anyone awaits it.
  const exited = once(child, 'exit').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }))
  const run = { child, output: () => out, exited }
  runs.push(run)
  return run
}

async function healthy(run: Running, timeoutMs = 90_000): Promise<Health> {
  const t0 = Date.now()
  let exited = false
  void run.exited.then(() => (exited = true))
  for (;;) {
    if (exited) throw new Error(`server exited before it was healthy:\n${run.output().slice(-3000)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) return (await res.json()) as Health
    } catch {
      /* not listening yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`server not healthy after ${timeoutMs} ms:\n${run.output().slice(-3000)}`)
    // Polling another process over HTTP: there is no event to await.
    await sleep(250)
  }
}

/** Sends the signal and waits for the exit (the test timeout bounds a hang). */
async function stop(run: Running, signal: NodeJS.Signals) {
  run.child.kill(signal)
  return run.exited
}

/** The structured boot line (one JSON object per line). */
function bootLine(run: Running): Record<string, unknown> | undefined {
  for (const line of run.output().split('\n')) {
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object' && v.event === 'boot') return v
    } catch {
      /* not JSON */
    }
  }
  return undefined
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elara-lifecycle-boot-'))
  port = await freePort()
  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`)
    await sql.unsafe(`CREATE DATABASE "${DB_NAME}"`)
  })
})

afterAll(async () => {
  for (const r of runs) if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGKILL')
  await Promise.all(runs.map((r) => r.exited))
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`))
  rmSync(dataDir, { recursive: true, force: true })
})

describe('restart observability (#583)', () => {
  it('reports unknown on a first boot, graceful after SIGTERM, unclean after SIGKILL', async () => {
    const first = start()
    const h1 = await healthy(first)
    expect(h1.lastShutdown).toBe('unknown')
    expect(h1.previousBootId).toBeNull()
    expect(h1.version).toBe('lifecycle-test')
    expect(h1.bootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(Date.parse(h1.startedAt ?? '')).toBeLessThanOrEqual(Date.now())
    expect(bootLine(first)).toMatchObject({ event: 'boot', bootId: h1.bootId, lastShutdown: 'unknown', previous: null })

    // Graceful: the SIGTERM handler flushes, closes and exits 0.
    expect(await stop(first, 'SIGTERM')).toEqual({ code: 0, signal: null })

    const second = start()
    const h2 = await healthy(second)
    expect(h2.lastShutdown).toBe('graceful')
    expect(h2.previousBootId).toBe(h1.bootId)
    expect(h2.bootId).not.toBe(h1.bootId)
    expect((h2.bootId ?? '') > (h1.bootId ?? '')).toBe(true)
    expect(Date.parse(h2.startedAt ?? '')).toBeGreaterThan(Date.parse(h1.startedAt ?? ''))
    expect(bootLine(second)).toMatchObject({
      lastShutdown: 'graceful',
      previous: { bootId: h1.bootId, signal: 'SIGTERM' },
    })

    // Unclean: SIGKILL gives the process no chance to write anything.
    expect(await stop(second, 'SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' })

    const third = start()
    const h3 = await healthy(third)
    expect(h3.lastShutdown).toBe('unclean')
    expect(h3.previousBootId).toBe(h2.bootId)
    expect(h3.bootId).not.toBe(h2.bootId)
    expect(bootLine(third)).toMatchObject({ lastShutdown: 'unclean', previous: { bootId: h2.bootId, stoppedAt: null } })

    expect(await stop(third, 'SIGTERM')).toEqual({ code: 0, signal: null })
  }, 300_000)
})
