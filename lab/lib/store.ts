// ADR-003 store helpers for the lab (§11): recreate the app with a failpoint
// armed or with the image from before S2a, run the store CLIs, and assert
// the invariants I2, I4, I5 and I8 after a restart.
import type { Check } from './context.ts'
import { COMPOSE, appExec, exec, psql, psqlRows, waitHealthy, type ExecResult } from './docker.ts'

/** DATA_DIR inside the app container. */
export const DATA = '/data/elara'

/** The `dev` commit #828 (ADR-003 S2a-1) was based on (S1 + S5 + #826 ord): the "old image" of §11 migration and rollback. */
export const PRE_S2A_REF = process.env.LAB_PRE_S2A_REF ?? '87ccfadafe288110d12c853e5e1384da8d1f8bd0'
export const PRE_S2A_TAG = 'elara-lab-pre-s2a:latest'

/** The app container, running or stopped (`compose ps -a`): the image switch and kill checks run while it is down. */
async function appContainer(): Promise<string> {
  const r = await exec([...COMPOSE, 'ps', '-a', '-q', 'app'])
  const id = r.stdout.trim().split('\n')[0]
  if (!id) throw new Error(`no app container: ${r.stderr}`)
  return id
}

async function composeEnv(env: Record<string, string>, ...args: string[]): Promise<ExecResult> {
  const t0 = performance.now()
  const proc = Bun.spawn([...COMPOSE, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout, stderr, ms: performance.now() - t0 }
}

/** The image name compose runs the app from (`<project>-app`) and the id it points at now. */
export async function appImage(): Promise<{ name: string; id: string }> {
  const cid = await appContainer()
  const r = await exec(['docker', 'inspect', '-f', '{{.Config.Image}} {{.Image}}', cid])
  const [name, id] = r.stdout.trim().split(' ')
  if (r.code !== 0 || !name || !id) throw new Error(`docker inspect ${cid}: ${r.stderr}`)
  return { name, id }
}

/** The app process's identity: container id, start time and restart count (changes when a failpoint kills it and Docker restarts it). */
export async function appProcess(): Promise<string> {
  const cid = await appContainer()
  const r = await exec(['docker', 'inspect', '-f', '{{.State.Running}} {{.State.StartedAt}} {{.RestartCount}}', cid])
  return `${cid} ${r.stdout.trim()}`
}

/**
 * Waits until the app process seen as `before` (appProcess) is gone: a
 * failpoint SIGKILLed it. `restart: unless-stopped` may already have
 * started the next one, so a changed start time counts as well.
 */
export async function waitAppKilled(before: string, timeoutMs = 60_000): Promise<boolean> {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    const now = await appProcess()
    if (now !== before || now.split(' ')[1] === 'false') return true
    await Bun.sleep(200)
  }
  return false
}

/**
 * Recreates the app container (`up -d --no-build --force-recreate app`) with
 * `ELARA_FAILPOINTS` set to `failpoints` (empty: inert) and waits for health
 * unless `wait` is false (a failpoint at boot keeps it from getting healthy).
 */
export async function recreateApp(baseUrl: string, failpoints = '', wait = true): Promise<void> {
  const r = await composeEnv({ ELARA_FAILPOINTS: failpoints }, 'up', '-d', '--no-build', '--force-recreate', 'app')
  if (r.code !== 0) throw new Error(`recreating the app failed (${r.code}): ${r.stderr.slice(0, 1000)}`)
  if (wait) await waitHealthy(baseUrl)
}

/** Stops the app gracefully (SIGTERM: folds, projector drain, `stopped` marker). */
export async function stopApp(): Promise<void> {
  const r = await exec([...COMPOSE, 'stop', 'app'])
  if (r.code !== 0) throw new Error(`stopping the app failed: ${r.stderr}`)
}

/**
 * Builds the image from before S2a once per runner, from the commit
 * PRE_S2A_REF (fetched shallow from origin), as `elara-lab-pre-s2a`.
 */
export async function buildPreS2aImage(): Promise<void> {
  if ((await exec(['docker', 'image', 'inspect', PRE_S2A_TAG])).code === 0) return
  const fetched = await exec(['git', 'fetch', '--depth', '1', 'origin', PRE_S2A_REF])
  if (fetched.code !== 0) throw new Error(`git fetch ${PRE_S2A_REF}: ${fetched.stderr}`)
  const built = await exec(['sh', '-c', `git archive ${PRE_S2A_REF} | docker build -q -t ${PRE_S2A_TAG} --build-arg ELARA_VERSION=${PRE_S2A_REF} -`])
  if (built.code !== 0) throw new Error(`building the pre-S2a image failed: ${built.stderr.slice(-2000)}`)
}

/**
 * Runs the app from `image` (an id or tag) by pointing compose's app image
 * name at it and recreating the container without a build. Returns the id
 * the name pointed at before, to switch back with the same call.
 */
export async function runAppImage(baseUrl: string, image: string, wait = true): Promise<string> {
  const current = await appImage()
  const tagged = await exec(['docker', 'tag', image, current.name])
  if (tagged.code !== 0) throw new Error(`docker tag ${image} ${current.name}: ${tagged.stderr}`)
  await recreateApp(baseUrl, '', wait)
  return current.id
}

/** A one-off container of the current app image (`compose run --rm --no-deps app …`), with the app itself stopped or not. */
export async function runCli(args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  return composeEnv(env, 'run', '--rm', '--no-deps', '-T', 'app', 'node', '--import', 'tsx', ...args)
}

/** Files under `DATA/vaults/<vault>/<sub>` (recursive), for conflict copies and orphans. */
export async function listFiles(vaultId: string, sub: string): Promise<string[]> {
  const r = await appExec(['sh', '-c', `cd ${DATA}/vaults/${vaultId} 2>/dev/null && find ${sub} -type f 2>/dev/null | sort; true`])
  return r.stdout.split('\n').filter(Boolean)
}

/** The invariants of §11 that S2a promises, as lab checks, for one vault (I1 is the caller's: it knows the acked writes). */
export async function storeInvariants(vaultId: string, label: string, opts: { conflictsBefore?: number } = {}): Promise<Check[]> {
  const checks: Check[] = []
  const idle = await appExec(['node', '--import', 'tsx', 'src/scripts/check-notes.ts', '--vault', vaultId, '--wait-idle=120', '--fail-on-pending'])
  checks.push({
    name: `${label}: I4 check-notes --wait-idle --fail-on-pending clean`,
    expected: 'exit 0',
    actual: `exit ${idle.code}${idle.code === 0 ? '' : `: ${(idle.stdout + idle.stderr).trim().slice(-600)}`}`,
    ok: idle.code === 0,
  })
  const gaps = await psqlRows<{ path: string }>(`
    SELECT n.path FROM notes n WHERE n.vault_id = '${vaultId}'
      AND NOT EXISTS (SELECT 1 FROM note_revisions r WHERE r.note_id = n.id AND r.seq = n.seq AND r.body = n.body)`)
  checks.push({
    name: `${label}: I2 a revision at every note's seq equals the row`,
    expected: '0 notes without one',
    actual: gaps.length === 0 ? '0' : `${gaps.length}: ${gaps.map((g) => g.path).slice(0, 10).join(', ')}`,
    ok: gaps.length === 0,
  })
  const tmp = (await appExec(['sh', '-c', `find ${DATA}/vaults -name '*.tmp' | wc -l`])).stdout.trim()
  checks.push({ name: `${label}: I5 no *.tmp under DATA_DIR/vaults`, expected: '0', actual: tmp, ok: tmp === '0' })
  const pending = await psql(`
    SELECT count(*) FROM note_projections p JOIN notes n ON n.id = p.note_id
    WHERE n.vault_id = '${vaultId}' AND p.applied_seq < p.target_seq`)
  checks.push({ name: `${label}: no pending projection once idle`, expected: '0', actual: pending, ok: pending === '0' })
  if (opts.conflictsBefore !== undefined) {
    const conflicts = (await listFiles(vaultId, '.conflicts')).length
    checks.push({
      name: `${label}: I8 no new conflict copy`,
      expected: String(opts.conflictsBefore),
      actual: String(conflicts),
      ok: conflicts === opts.conflictsBefore,
    })
  }
  return checks
}
