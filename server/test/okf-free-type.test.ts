// #444 (owner decision D8, #930): the frontmatter `type` is a free OKF
// type (SPEC §4.1: "Metric", "BigQuery Table"); `notes.type` stays the
// folder (the path's first segment), so the search/graph `types` filter and
// structural edges keep keying on the folder. A note without `type` still
// gets the folder as its type.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { and, asc, eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { noteRevisions, notes } from '../src/db/schema.js'
import { restoreBackup } from '../src/export/restore.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { serializeNote } from '../src/notes/okf.js'
import { createNote, getLiveNote, readNote, renameNote, revertNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie, uniqueEmail, wipeInstance } from './helpers.js'

/** The spec repo's sample bundle, GoogleCloudPlatform/open-knowledge-format@ad30107c bundles/acme_retail (Apache-2.0). */
const BUNDLE = resolve(__dirname, 'fixtures/okf-acme-retail')

function bundleFiles(dir = BUNDLE): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const full = join(dir, entry)
      return statSync(full).isDirectory() ? bundleFiles(full) : [relative(BUNDLE, full)]
    })
    .sort()
}

let app: FastifyInstance
let cookie: string
let vaultId: string
let mcp: Client

async function mcpCall(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await mcp.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function noteRow(path: string) {
  const [row] = await db
    .select({ type: notes.type, frontmatter: notes.frontmatter })
    .from(notes)
    .where(and(eq(notes.vaultId, vaultId), eq(notes.path, path)))
  return row as { type: string; frontmatter: Record<string, unknown> } | undefined
}

async function searchPaths(query: string, types: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/vaults/${vaultId}/search?q=${encodeURIComponent(query)}&types=${types}`,
    headers: { cookie },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json<Array<{ path: string }> | { results: Array<{ path: string }> }>()
  return (Array.isArray(body) ? body : body.results).map((r) => r.path)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Free type' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'free-type', scope: 'account' } })
  mcp = new Client({ name: 'free-type-test', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
})

afterAll(async () => {
  await mcp.close()
  await app.close()
})

describe('frontmatter type is free; notes.type stays the folder (#444)', () => {
  it('create_note (MCP) keeps type: decision under notes/, notes.type is the folder, the folder filter finds it', async () => {
    const created = await mcpCall('create_note', {
      vaultId,
      path: 'notes/adr-zephyr',
      frontmatter: { type: 'decision', title: 'Zephyr' },
      body: 'We pick zephyrquartz for storage.\n',
    })
    expect(created.isError, created.text).toBe(false)
    expect(await noteRow('notes/adr-zephyr')).toMatchObject({ type: 'notes', frontmatter: { type: 'decision' } })

    const read = await mcpCall('read_note', { vaultId, path: 'notes/adr-zephyr' })
    expect(read.text).toContain('decision')

    expect(await searchPaths('zephyrquartz', 'notes')).toContain('notes/adr-zephyr')
    expect(await searchPaths('zephyrquartz', 'decision')).toEqual([])
  })

  it('create (REST) keeps type: decision under notes/; an edit and a move keep it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'notes', name: 'adr-rest', frontmatter: { type: 'decision' }, body: 'REST decision.\n' },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json<{ type: string; frontmatter: Record<string, unknown> }>()).toMatchObject({
      type: 'notes',
      frontmatter: { type: 'decision' },
    })

    const edited = await mcpCall('edit_note', { vaultId, path: 'notes/adr-rest', body: 'REST decision, revised.\n' })
    expect(edited.isError, edited.text).toBe(false)
    expect(await noteRow('notes/adr-rest')).toMatchObject({ type: 'notes', frontmatter: { type: 'decision' } })

    const moved = await mcpCall('rename_note', { vaultId, from: 'notes/adr-rest', toName: 'decisions/adr-rest' })
    expect(moved.isError, moved.text).toBe(false)
    expect(await noteRow('decisions/adr-rest')).toMatchObject({ type: 'decisions', frontmatter: { type: 'decision' } })
  })

  it('edit_note can set the semantic type, and removing it falls back to the folder', async () => {
    expect((await mcpCall('create_note', { vaultId, path: 'notes/plain', body: 'x\n' })).isError).toBe(false)
    expect((await noteRow('notes/plain'))?.frontmatter.type).toBe('notes')

    const set = await mcpCall('edit_note', { vaultId, path: 'notes/plain', frontmatter: { type: 'Meeting Note' } })
    expect(set.isError, set.text).toBe(false)
    expect(await noteRow('notes/plain')).toMatchObject({ type: 'notes', frontmatter: { type: 'Meeting Note' } })

    const removed = await mcpCall('edit_note', { vaultId, path: 'notes/plain', removeKeys: ['type'] })
    expect(removed.isError, removed.text).toBe(false)
    expect((await noteRow('notes/plain'))?.frontmatter.type).toBe('notes')
  })

  it('refuses an empty or non-string type', async () => {
    const empty = await mcpCall('create_note', { vaultId, path: 'notes/bad-type', frontmatter: { type: '  ' } })
    expect(empty.isError).toBe(true)
    const numeric = await mcpCall('create_note', { vaultId, path: 'notes/bad-type', frontmatter: { type: 7 } })
    expect(numeric.isError).toBe(true)
    expect(await getLiveNote(vaultId, 'notes/bad-type')).toBeNull()
  })

  it('imports the OKF sample bundle with no note refused for its type', async () => {
    const zip = new AdmZip()
    for (const f of bundleFiles()) zip.addFile(f, readFileSync(join(BUNDLE, f)))
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'acme_retail (OKF sample)', mergeable: false, shares: [] })))
    const boundary = '----okfboundary'
    const res = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="acme.zip"\r\ncontent-type: application/zip\r\n\r\n`),
        zip.toBuffer(),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    })
    expect(res.statusCode).toBe(200)
    const result = res.json<{ vaultId: string; imported: number; skipped: string[] }>()

    // No note is refused for its type (dev before #444 skipped all 10).
    expect(result.skipped.filter((s) => /type/.test(s))).toEqual([])
    // The 9 concepts become 9/9 once #563 (`verified` as the spec writes
    // it, {by, at} without `tier`) and #970 (nested producer keys:
    // `parameters`, `executor`, `attester`, `not`) land. Until then the rest
    // of the bundle is refused for those reasons only; the validator reports
    // `verified` first, so the 3 notes with nested keys show #563 today.
    const verified = 'verified must be an object or array of objects with valid tier'
    expect(result.skipped.map((s) => s.replace(/: .*/, '')).sort()).toEqual([
      'computations/gross-margin-period',
      'computations/revenue-ytd',
      'metrics/gross-margin',
      'metrics/gross-margin-legacy',
      'metrics/revenue',
      'policies/margin-standard',
      'policies/revenue-recognition',
      'tables/orders',
    ])
    for (const skip of result.skipped) expect(skip).toContain(verified)
    expect(result.imported).toBe(2)

    const imported = await db
      .select({ path: notes.path, type: notes.type, frontmatter: notes.frontmatter })
      .from(notes)
      .where(eq(notes.vaultId, result.vaultId))
    expect(imported.map(({ path, type, frontmatter }) => ({ path, type, okfType: (frontmatter as Record<string, unknown>).type })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'log', type: 'log', okfType: 'Log' },
      { path: 'skills/run-on-bq', type: 'skills', okfType: 'Skill' },
    ])
  })

  /** Creates `from` with `frontmatter`, moves it to `to`, then reverts it to its `create` revision. */
  async function revertAfterMove(from: string, to: string, frontmatter: Record<string, unknown>) {
    const created = await createNote(vaultId, { path: from, frontmatter, body: 'v1\n' })
    await renameNote(vaultId, from, to)
    const [first] = await db
      .select({ id: noteRevisions.id })
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, created.id), eq(noteRevisions.action, 'create')))
      .orderBy(asc(noteRevisions.ord))
    expect(await revertNote(vaultId, to, first!.id, { type: 'user' })).not.toBeNull()
    return noteRow(to)
  }

  it('a revert to a revision from before a move gives a folder type the current folder', async () => {
    expect(await revertAfterMove('drafts/rv', 'specs/rv', {})).toMatchObject({ type: 'specs', frontmatter: { type: 'specs' } })
    // The revision itself recorded at the old folder too: the type follows the note when it moves again.
    await renameNote(vaultId, 'specs/rv', 'guides/rv')
    expect(await noteRow('guides/rv')).toMatchObject({ type: 'guides', frontmatter: { type: 'guides' } })
  })

  it('a revert to a revision from before a move keeps a semantic type', async () => {
    expect(await revertAfterMove('drafts/rv-sem', 'specs/rv-sem', { type: 'decision' })).toMatchObject({
      type: 'specs',
      frontmatter: { type: 'decision' },
    })
  })

  // Last: restoring a whole instance wipes the database the tests above use.
  it('restores a note whose type is not its folder (format-1 archive)', async () => {
    await wipeInstance()
    const userId = randomUUID()
    const restoredVault = randomUUID()
    const now = new Date().toISOString()
    const zip = new AdmZip()
    zip.addFile(
      'account-dump.json',
      Buffer.from(
        JSON.stringify({
          users: [{ id: userId, email: uniqueEmail('restore'), passwordHash: 'x', status: 'active', role: 'admin', emailVerifiedAt: now, totpSecret: null, mfaEnabledAt: null, createdAt: now }],
          teams: [],
          teamMemberships: [],
          vaults: [{ id: restoredVault, name: 'R', ownerId: userId, mergeable: false, createdAt: now, deletedAt: null }],
          vaultShares: [],
          mcpConnections: [],
          securityEvents: [],
          notifications: [],
        }),
      ),
    )
    zip.addFile(`vaults/${restoredVault}/notes/adr-restored.md`, Buffer.from(serializeNote({ frontmatter: { type: 'decision' }, body: 'Restored decision.\n' })))
    zip.addFile(`vaults/${restoredVault}/notes/numeric-type.md`, Buffer.from('---\ntype: 7\n---\nA number is not a type.\n'))
    const plan = await restoreBackup(zip.toBuffer())
    // A type that is not a string is refused as on create and edit, not turned into "7".
    expect(plan.warnings.filter((w) => w.includes('note skipped'))).toEqual([
      `note skipped: ${restoredVault}/notes/numeric-type: frontmatter type must be a non-empty string`,
    ])
    expect(await getLiveNote(restoredVault, 'notes/numeric-type')).toBeNull()
    const note = await readNote(restoredVault, 'notes/adr-restored')
    expect(note?.row.type).toBe('notes')
    expect(note?.frontmatter.type).toBe('decision')
  })
})
