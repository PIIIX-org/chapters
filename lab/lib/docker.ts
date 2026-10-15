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

export const app = {
  /** `docker compose restart app`: SIGTERM (graceful: index.ts flush handlers run), then start. */
  async restart(baseUrl: string) {
    const r = await compose('restart', 'app')
    const healthyMs = await waitHealthy(baseUrl)
    return { restartMs: r.ms, healthyMs }
  },
  /** SIGKILL the app (crash), then start it again and wait for health. */
  async crash(baseUrl: string) {
    const kill = await compose('kill', '-s', 'SIGKILL', 'app')
    const start = await compose('start', 'app')
    const healthyMs = await waitHealthy(baseUrl)
    return { killMs: kill.ms, startMs: start.ms, healthyMs }
  },
  stop: () => compose('stop', 'app'),
  start: () => compose('start', 'app'),
  /** Last `n` log lines of a service. */
  async logs(service = 'app', n = 200) {
    return (await compose('logs', '--no-color', '--tail', String(n), service)).stdout
  },
}
