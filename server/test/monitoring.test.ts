import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { setTimeout as sleep } from 'node:timers/promises'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { db } from '../src/db/client.js'
import { repositories, repositoryFiles } from '../src/db/schema.js'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { getLiveNote } from '../src/notes/store.js'
import { embedder } from '../src/search/embeddings.js'
import { flushEmbeddings, scheduleEmbedding } from '../src/search/embedding-queue.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// #705: server errors and failed background jobs are reported (the
// monitoring endpoint the uptime monitor reads, and one structured log line
// each) with route template, status, request id, actor, job kind and subject
// id; never note text, paths, query strings or credentials. Every failure
// below is made to carry a note's text, a unique marker and a GitHub-token
// shaped secret in its error message, URL or query; none of them may appear
// in what is reported.

const MARKER = `zqmarker${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const SECRET = `ghp_${'A1b2C3d4E5'.repeat(3)}x9Y8z7`
const TOKEN = `monitor-${'0123456789abcdef'.repeat(3)}`
const ENDPOINT = '/api/admin/monitoring'

let app: FastifyInstance
let collab: CollabRelay
let port: number
let adminCookie: string
let memberCookie: string
let ownerToken: string
let vaultId: string
let noteId: string
let notePath: string
/** Every console line the process wrote during the test (reports go to the log as JSON lines). */
const logged: string[] = []

interface Report {
  event?: string
  type?: string
  route?: string
  status?: number
  reqId?: string
  durationMs?: number
  actor?: string
  job?: string
  subjectId?: string | null
  error?: { name: string | null; code: string | null } | null
}

interface Snapshot {
  bootId: string
  totals: { requests: number; serverErrors: number; jobFailures: number }
  jobs: Record<string, { succeeded: number; failed: number }>
  routes: Array<{ route: string; count: number; serverErrors: number; p95Ms: number; maxMs: number }>
  errors: Array<Report & { seq: number; at: string }>
  lastSeq: number
}

async function snapshot(): Promise<{ raw: string; body: Snapshot }> {
  const res = await app.inject({ method: 'GET', url: ENDPOINT, headers: { authorization: `Bearer ${TOKEN}` } })
  expect(res.statusCode).toBe(200)
  return { raw: res.body, body: res.json() as Snapshot }
}

/** The structured report lines in the log (`{"event":"server_error"|"job_failure",...}`). */
function reportLines(): Report[] {
  const out: Report[] = []
  for (const line of logged) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as Report
      if (parsed.event === 'server_error' || parsed.event === 'job_failure') out.push(parsed)
    } catch {
      /* not a report */
    }
  }
  return out
}

function expectClean(text: string): void {
  expect(text).not.toContain(MARKER)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('note text')
  expect(text).not.toContain(notePath)
}

// Polls: the collab case runs a real websocket relay with its store debounce
// (COLLAB_DEBOUNCE_MS) in another socket's callbacks, so there is no promise
// to await and fake timers would stop the relay itself.
async function waitFor(check: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await sleep(50)
  }
}

beforeAll(async () => {
  vi.stubEnv('ELARA_MONITORING_TOKEN', TOKEN)
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' '))
    })
  }
  app = await buildApp()
  // The injected server error: a route that reads the note and fails with
  // its text, the way an fs or Postgres error quotes paths and values.
  app.get<{ Params: { vaultId: string; '*': string } }>('/api/monitoring-test/:vaultId/*', async (req) => {
    const note = await getLiveNote(req.params.vaultId, req.params['*'])
    throw new Error(`could not render ${req.url}: ${note?.body ?? 'no note'}`)
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)

  const admin = await createActiveUser({ role: 'admin' })
  const owner = await createActiveUser()
  adminCookie = await loginCookie(app, admin.email)
  memberCookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie: memberCookie }, body: { name: 'Monitoring vault' } })
  ).json<{ id: string }>().id
  const created = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: memberCookie },
    body: { type: 'docs', name: MARKER, body: `note text ${MARKER} with a token ${SECRET}` },
  })
  expect(created.statusCode).toBe(200)
  const row = created.json<{ id: string; path: string }>()
  noteId = row.id
  notePath = row.path
  await flushEmbeddings()
})

afterAll(async () => {
  await collab?.destroy()
  await app?.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('monitoring endpoint access (#705)', () => {
  it('needs the monitoring token or an admin session; /health shows nothing new', async () => {
    expect((await app.inject({ method: 'GET', url: ENDPOINT })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: ENDPOINT, headers: { authorization: `Bearer ${TOKEN}x` } })).statusCode,
    ).toBe(401)
    expect((await app.inject({ method: 'GET', url: ENDPOINT, headers: { authorization: TOKEN } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: ENDPOINT, headers: { cookie: memberCookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: ENDPOINT, headers: { cookie: adminCookie } })).statusCode).toBe(200)
    const viaToken = await snapshot()
    expect(viaToken.body.bootId).toMatch(/^[0-9a-f-]{36}$/)

    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }]) {
      const health = await app.inject({ method: 'GET', url: '/health', headers })
      expect(Object.keys(health.json()).sort()).toEqual(['bootId', 'lastShutdown', 'previousBootId', 'startedAt', 'status', 'version'])
    }
  })
})

describe('error and job reports carry no note text (#705)', () => {
  it('reports a 5xx with route template, status, request id and actor, and no note text, path, query or secret', async () => {
    const before = (await snapshot()).body
    const res = await app.inject({
      method: 'GET',
      url: `/api/monitoring-test/${vaultId}/${notePath}?q=${MARKER}&access_token=${SECRET}`,
      headers: { cookie: memberCookie },
    })
    expect(res.statusCode).toBe(500)

    const { raw, body } = await snapshot()
    expect(body.totals.serverErrors).toBe(before.totals.serverErrors + 1)
    const record = body.errors.find((e) => e.type === 'request' && e.seq > before.lastSeq)
    expect(record).toMatchObject({
      type: 'request',
      route: 'GET /api/monitoring-test/:vaultId/*',
      status: 500,
      actor: 'user',
      error: { name: 'Error', code: null },
    })
    expect(record!.reqId).toMatch(/^[\w.-]+$/)
    expect(record!.durationMs).toBeGreaterThanOrEqual(0)
    const route = body.routes.find((r) => r.route === 'GET /api/monitoring-test/:vaultId/*')
    expect(route).toMatchObject({ count: 1, serverErrors: 1 })
    expectClean(raw)

    const line = reportLines().find((r) => r.event === 'server_error' && r.reqId === record!.reqId)
    expect(line).toMatchObject({ route: 'GET /api/monitoring-test/:vaultId/*', status: 500, actor: 'user' })
    for (const r of reportLines()) expectClean(JSON.stringify(r))
  })

  it('reports a permanently failed embedding job by note id, without the error text', async () => {
    const before = (await snapshot()).body
    const embed = vi.spyOn(embedder, 'embed').mockRejectedValue(new Error(`model failed on note text ${MARKER} ${SECRET}`))
    try {
      scheduleEmbedding(noteId)
      await flushEmbeddings()
    } finally {
      embed.mockRestore()
    }
    const { raw, body } = await snapshot()
    expect(body.jobs.embedding!.failed).toBe(before.jobs.embedding!.failed + 1)
    expect(body.totals.jobFailures).toBe(before.totals.jobFailures + 1)
    expect(body.errors.filter((e) => e.seq > before.lastSeq)).toEqual([
      expect.objectContaining({ type: 'job', job: 'embedding', subjectId: noteId, error: { name: 'Error', code: null } }),
    ])
    expectClean(raw)
    expect(reportLines().some((r) => r.event === 'job_failure' && r.job === 'embedding' && r.subjectId === noteId)).toBe(true)
    for (const r of reportLines()) expectClean(JSON.stringify(r))
  })

  it('reports a failed extraction by file id and a failed git sync by repository id', async () => {
    const owner = await createActiveUser()
    const before = (await snapshot()).body
    const [pushed] = await db
      .insert(repositories)
      .values({ name: 'monitoring-extraction', ownerId: owner.id, ingestionMethod: 'agent_push' })
      .returning()
    const embed = vi.spyOn(embedder, 'embed').mockRejectedValueOnce(new Error(`extraction saw ${MARKER} ${SECRET}`))
    try {
      await syncRepositoryFiles(pushed!.id, [{ path: `${MARKER}.txt`, content: `note text ${MARKER}` }], [`${MARKER}.txt`])
      await flushExtraction()
    } finally {
      embed.mockRestore()
    }
    const [file] = await db
      .select({ id: repositoryFiles.id })
      .from(repositoryFiles)
      .where(and(eq(repositoryFiles.repositoryId, pushed!.id), eq(repositoryFiles.path, `${MARKER}.txt`)))

    const [git] = await db
      .insert(repositories)
      .values({ name: 'monitoring-sync', ownerId: owner.id, ingestionMethod: 'git', gitUrl: `file:///nonexistent/${MARKER}/repo.git` })
      .returning()
    await expect(syncGitRepository(git!.id)).rejects.toThrow()

    const { raw, body } = await snapshot()
    expect(body.jobs.extraction!.failed).toBe(before.jobs.extraction!.failed + 1)
    expect(body.jobs.sync!.failed).toBe(before.jobs.sync!.failed + 1)
    const fresh = body.errors.filter((e) => e.seq > before.lastSeq)
    expect(fresh).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'job', job: 'extraction', subjectId: file!.id }),
        expect.objectContaining({ type: 'job', job: 'sync', subjectId: git!.id }),
      ]),
    )
    expectClean(raw)
    for (const r of reportLines()) expectClean(JSON.stringify(r))
  }, 20_000)

  it('reports a rejected collab store (the file keeps its last version) by vault id', async () => {
    const before = (await snapshot()).body
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: `${vaultId}/${notePath}`,
      token: ownerToken,
      document: new Y.Doc(),
    })
    try {
      await waitFor(() => provider.document.getText('body').toString().includes(MARKER))
      provider.document.getText('body').insert(0, `${MARKER} edited `)
      // Not an array: the shared validation rejects the store.
      provider.document.getMap('frontmatter').set('tags', `note text ${MARKER} ${SECRET}`)
      await waitFor(async () => (await snapshot()).body.jobs['collab-store']!.failed > before.jobs['collab-store']!.failed)
      // Put it right again, so the note the suite leaves behind is valid.
      provider.document.getMap('frontmatter').set('tags', ['ok'])
      await waitFor(async () => ((await getLiveNote(vaultId, notePath))?.body ?? '').includes(`${MARKER} edited`))
    } finally {
      provider.destroy()
    }
    const { raw, body } = await snapshot()
    expect(body.errors.filter((e) => e.seq > before.lastSeq)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'job', job: 'collab-store', subjectId: vaultId })]),
    )
    expectClean(raw)
    for (const r of reportLines()) expectClean(JSON.stringify(r))
  }, 20_000)
})
