// Docker control for tests. Tests run on the runner host, next to the
// compose project, so they can restart/kill the app and query Postgres
// directly (ground truth that MCP does not expose).

/** The compose invocation the workflow used; run everything from the repo root. */
export const COMPOSE = ['docker', 'compose', '-f', 'docker-compose.yml', '-f', 'lab/docker-compose.lab.yml']

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  ms: number
}

export async function exec(cmd: string[], stdin?: string): Promise<ExecResult> {
  const t0 = performance.now()
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : 'pipe' })
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr, ms: performance.now() - t0 }
}

export async function compose(...args: string[]): Promise<ExecResult> {
  const r = await exec([...COMPOSE, ...args])
  if (r.code !== 0) throw new Error(`docker compose ${args.join(' ')} failed (${r.code}): ${r.stderr.slice(0, 1000)}`)
  return r
}

/** Polls GET /health until 200. Returns ms waited. */
export async function waitHealthy(baseUrl: string, timeoutMs = 300_000): Promise<number> {
  const t0 = performance.now()
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) return performance.now() - t0
    } catch {
      /* not up yet */
    }
    if (performance.now() - t0 > timeoutMs) throw new Error(`app not healthy after ${timeoutMs} ms`)
    await Bun.sleep(1_000)
  }
}

/** Runs SQL in the db container (psql -At). Returns raw stdout, trimmed. */
export async function psql(sql: string): Promise<string> {
  const r = await exec(
    [...COMPOSE, 'exec', '-T', 'db', 'sh', '-c', 'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    sql,
  )
  if (r.code !== 0) throw new Error(`psql failed (${r.code}): ${r.stderr.slice(0, 1000)}\nSQL: ${sql.slice(0, 500)}`)
  return r.stdout.trim()
}

/**
 * Runs a SELECT and returns its rows as JSON. Pass the bare query; it is
 * wrapped in `select coalesce(json_agg(t), '[]') from (<query>) t`.
 * T is the caller's statement of the row shape (columns of their own query).
 */
export async function psqlRows<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const out = await psql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t;`)
  return JSON.parse(out) as T[]
}

/** Runs a command in the app container (`docker compose exec -T app ...`); never throws. */
export async function appExec(args: string[], stdin?: string): Promise<ExecResult> {
  return exec([...COMPOSE, 'exec', '-T', 'app', ...args], stdin)
}

export async function appContainerId(): Promise<string> {
  const r = await exec([...COMPOSE, 'ps', '-q', 'app'])
  const id = r.stdout.trim()
  if (!id) throw new Error(`no app container: ${r.stderr}`)
  return id
}

export interface ContainerState {
  restartCount: number
  oomKilled: boolean
  startedAt: string
  status: string
  exitCode: number
}

/** `docker inspect` of a container; null when it cannot be read (e.g. mid-restart). */
export async function containerState(id: string): Promise<ContainerState | null> {
  const r = await exec([
    'docker',
    'inspect',
    '-f',
    '{"restartCount":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"startedAt":"{{.State.StartedAt}}","status":"{{.State.Status}}","exitCode":{{.State.ExitCode}}}',
    id,
  ])
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout.trim()) as ContainerState
  } catch {
    return null
  }
}

export const app = {
  /** `docker compose restart app`: SIGTERM (graceful: index.ts flush handlers run), then start. */
  async restart(baseUrl: string) {
    const r = await compose('restart', 'app')
    const healthyMs = await waitHealthy(baseUrl)
    return { restartMs: r.ms, healthyMs }
  },
  /**
   * SIGKILL the app (crash) via `docker kill` (lower latency than compose, so
   * tests can aim the kill), then start it again and wait for health.
   */
  async crash(baseUrl: string) {
    const cid = await appContainerId()
    const t0 = performance.now()
    const k = await exec(['docker', 'kill', '-s', 'KILL', cid])
    const killMs = performance.now() - t0
    // restart: unless-stopped may already be bringing it back; start is then a no-op or a harmless error.
    // TEMPORARY (#658 before-fix demo): the start fails, as in lab run 38957397867.
    const s = await exec(['sh', '-c', 'echo "injected: compose start app failed" >&2; exit 1'])
    const healthyMs = await waitHealthy(baseUrl)
    return { killMs, killCode: k.code, killErr: k.stderr.trim().slice(0, 300), startCode: s.code, healthyMs }
  },
  /** State of the current app container; throws when it cannot be read. */
  async state(): Promise<ContainerState> {
    const s = await containerState(await appContainerId())
    if (!s) throw new Error('docker inspect of the app container failed')
    return s
  },
  stop: () => compose('stop', 'app'),
  start: () => compose('start', 'app'),
  /** Last `n` log lines of a service. */
  async logs(service = 'app', n = 200) {
    return (await compose('logs', '--no-color', '--tail', String(n), service)).stdout
  },
}
