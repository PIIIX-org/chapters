// A git repository that does not move, served to the app over smart HTTP
// (#767). restart-extraction syncs the same repository several times over
// ~25 min and compares the syncs; cloning the live PIIIX-org/chapters
// default branch made a merge to dev mid-run look like lost files (run
// 39257370750). Instead the test builds a one-commit repository from the
// commit under test (`git archive`) and serves it with `git http-backend`
// from the runner; the app container reaches it as `host.docker.internal`
// (lab/docker-compose.lab.yml maps it to the host gateway).
//
// node:http and node:child_process only, so lab/lib/git-fixture.test.ts
// runs it under plain Node in CI and the lab runs it under Bun.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(args: string[], opts: { cwd?: string; input?: Buffer; env?: NodeJS.ProcessEnv } = {}): Buffer {
  const r = spawnSync('git', args, { cwd: opts.cwd, input: opts.input, env: opts.env, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr?.toString().slice(0, 500)}`)
  return r.stdout
}

export interface PinnedRepo {
  /** Directory holding `<name>.git` (GIT_PROJECT_ROOT). */
  root: string
  name: string
  /** The one commit of the served repository. */
  commit: string
  /** The commit of `sourceDir` it was built from. */
  sourceCommit: string
  close(): void
}

/**
 * A bare repository `<name>.git` whose only commit holds the tree of `ref`
 * in `sourceDir` (tracked files only: never the runner's untracked
 * `.env`, `lab-env.json`, `lab-results/`). Works on a shallow checkout.
 */
export function buildPinnedRepo(sourceDir: string, name: string, ref = 'HEAD'): PinnedRepo {
  const root = mkdtempSync(join(tmpdir(), 'lab-git-'))
  const work = join(root, 'work')
  mkdirSync(work)
  const sourceCommit = git(['-C', sourceDir, 'rev-parse', `${ref}^{commit}`]).toString().trim()
  const tar = git(['-C', sourceDir, 'archive', '--format=tar', sourceCommit])
  const untar = spawnSync('tar', ['-x', '-C', work], { input: tar, maxBuffer: 1 << 30 })
  if (untar.status !== 0) throw new Error(`tar -x failed: ${untar.stderr?.toString().slice(0, 500)}`)
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: 'elara-lab',
    GIT_AUTHOR_EMAIL: 'elara-lab@example.com',
    GIT_COMMITTER_NAME: 'elara-lab',
    GIT_COMMITTER_EMAIL: 'elara-lab@example.com',
  }
  git(['init', '-q', '-b', 'main'], { cwd: work })
  git(['add', '-A', '-f'], { cwd: work })
  git(['commit', '-q', '--no-gpg-sign', '-m', `lab fixture: ${sourceCommit}`], { cwd: work, env: identity })
  const commit = git(['rev-parse', 'HEAD'], { cwd: work }).toString().trim()
  git(['clone', '-q', '--bare', work, join(root, `${name}.git`)])
  rmSync(work, { recursive: true, force: true })
  return { root, name, commit, sourceCommit, close: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Serves every repository under `projectRoot` read-only over git's smart
 * HTTP protocol (`git http-backend` as CGI), so `git clone --depth 1` and
 * `git ls-remote` work. Push is refused (http-backend's default without
 * REMOTE_USER).
 */
export async function serveGit(projectRoot: string, host = '0.0.0.0'): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        // Unset (chunked request): http-backend reads the body to EOF.
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
        REMOTE_ADDR: req.socket.remoteAddress ?? '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    req.pipe(cgi.stdin)
    let stderr = ''
    cgi.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    // CGI output: headers, a blank line, the body.
    let head = Buffer.alloc(0)
    let headersDone = false
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const crlf = head.indexOf('\r\n\r\n')
      const lf = head.indexOf('\n\n')
      const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf
      if (end < 0) return
      headersDone = true
      let status = 200
      for (const line of head.subarray(0, end).toString().split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i < 0) continue
        const key = line.slice(0, i).trim()
        const value = line.slice(i + 1).trim()
        if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 500
        else res.setHeader(key, value)
      }
      res.writeHead(status)
      res.write(head.subarray(end + (end === crlf ? 4 : 2)))
    })
    cgi.on('close', (code) => {
      if (!headersDone) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.write(`git http-backend exited ${code} without a response: ${stderr.slice(0, 500)}`)
      }
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
