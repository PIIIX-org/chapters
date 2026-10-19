// #491: one body-size cap on every write path. REST and MCP refused a note
// only when Fastify's 1 MiB request limit tripped (so a body under 1 MiB with
// JSON escaping was refused), import took any size, and the collab relay
// stored up to ws's 100 MiB default. The cap is the body's UTF-8 bytes,
// ELARA_NOTE_MAX_BYTES, default 1 MiB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { loadCrdtState } from '../src/sync/crdt-store.js'
import { serializeNote } from '../src/notes/okf.js'
import { createNote, readNote } from '../src/notes/store.js'
import { restoreBackup } from '../src/export/restore.js'
import { createActiveUser, loginCookie, loginToken, uniqueEmail } from './helpers.js'

/** The default cap: 1 MiB of UTF-8. */
const CAP = 1024 * 1024
const LINE = 'Größe — ✓ a line of note text with "quotes"\n'

/** A body of exactly `bytes` UTF-8 bytes, multibyte and newline-heavy (JSON escaping grows it). */
function bodyOfBytes(bytes: number): string {
  const head = LINE.repeat(Math.floor(bytes / Buffer.byteLength(LINE)))
  return head + 'a'.repeat(bytes - Buffer.byteLength(head))
}

let app: FastifyInstance
let collab: CollabRelay
let baseUrl: string
let collabUrl: string
let ownerCookie: string
let ownerToken: string
let mcpToken: string
let vaultId: string
const providers: HocuspocusProvider[] = []
const clients: Client[] = []

/** Polls `check`: the relay and its debounced store are real, so their effects are awaited, not faked. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await delay(50)
  }
}

/** Resolves once the relay has no store of the note scheduled or running. */
function storeSettled(path: string): Promise<void> {
  const id = `onStoreDocument-${vaultId}/${path}`
  const { debouncer } = collab.hocuspocus
  return waitFor(() => !debouncer.isDebounced(id) && !debouncer.isCurrentlyExecuting(id))
}

interface Closed {
  code: number
  reason: string
}

function connect(name: string, closes: Closed[] = []): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: `${vaultId}/${name}`,
    token: ownerToken,
    document: new Y.Doc(),
    onClose: ({ event }) => closes.push({ code: event.code, reason: event.reason }),
  })
  providers.push(provider)
  return provider
}

async function newNote(name: string, body: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'docs', name, body },
  })
  expect(res.statusCode).toBe(200)
}

async function restBody(path: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/vaults/${vaultId}/notes/${path}`,
    headers: { cookie: ownerCookie },
  })
  return (res.json() as { body: string }).body
}

async function storedCrdtBody(path: string): Promise<string> {
  const state = await loadCrdtState(vaultId, path)
  const doc = new Y.Doc()
  if (state) Y.applyUpdate(doc, state)
  return doc.getText('body').toString()
}

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: 'size-cap-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    }),
  )
  clients.push(client)
  return client
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content[0]?.text ?? ''
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  collab = startCollabServer(app.server)
  collabUrl = `ws://127.0.0.1:${port}/collab`

  const owner = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  ownerToken = await loginToken(app, owner.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Size cap vault' },
    })).json() as { id: string }
  ).id
  mcpToken = (
    (await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'size-cap-agent', scope: 'vault', vaultId },
    })).json() as { token: string }
  ).token
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  for (const client of clients) await client.close().catch(() => {})
  await collab.destroy()
  await app.close()
})

// Megabyte bodies through a real relay and MCP client: past vitest's 5 s default.
describe('note body size cap (#491)', { timeout: 30_000 }, () => {
  it('REST stores a body of exactly the cap and refuses one byte more with 413 naming the limit', async () => {
    await newNote('rest-cap', bodyOfBytes(CAP))
    expect(Buffer.byteLength(await restBody('docs/rest-cap'))).toBe(CAP)

    const over = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/rest-cap`,
      headers: { cookie: ownerCookie },
      body: { body: bodyOfBytes(CAP + 1) },
    })
    expect(over.statusCode).toBe(413)
    expect((over.json() as { error: string }).error).toContain(String(CAP))
    expect(Buffer.byteLength(await restBody('docs/rest-cap'))).toBe(CAP)

    // Measured in UTF-8 bytes, not characters: fewer than CAP characters, more than CAP bytes.
    const multibyte = '✓'.repeat(CAP / 2)
    expect(multibyte.length).toBeLessThan(CAP)
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'docs', name: 'rest-multibyte', body: multibyte },
    })
    expect(created.statusCode).toBe(413)
  })

  it('MCP create_note/edit_note use the same cap: exactly the cap is stored, one byte more is a tool error', async () => {
    const client = await mcpClient()
    const created = await client.callTool({
      name: 'create_note',
      arguments: { vaultId, path: 'docs/mcp-cap', body: bodyOfBytes(CAP) },
    })
    expect(created.isError).toBeFalsy()
    expect(Buffer.byteLength(await restBody('docs/mcp-cap'))).toBe(CAP)

    const over = await client.callTool({
      name: 'edit_note',
      arguments: { vaultId, path: 'docs/mcp-cap', body: bodyOfBytes(CAP + 1) },
    })
    expect(over.isError).toBe(true)
    expect(textOf(over)).toContain(String(CAP))
    expect(Buffer.byteLength(await restBody('docs/mcp-cap'))).toBe(CAP)
  })

  it('import uses the same cap: an over-cap note is skipped with the reason, the rest is imported', async () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'Imported big' }), 'utf8'))
    zip.addFile('docs/fits.md', Buffer.from(serializeNote({ frontmatter: { type: 'docs' }, body: bodyOfBytes(CAP) }), 'utf8'))
    zip.addFile('docs/too-big.md', Buffer.from(serializeNote({ frontmatter: { type: 'docs' }, body: bodyOfBytes(CAP + 1) }), 'utf8'))
    const boundary = '----sizecapboundary'
    const res = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: { cookie: ownerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="v.zip"\r\ncontent-type: application/zip\r\n\r\n`,
        ),
        zip.toBuffer(),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    })
    expect(res.statusCode).toBe(200)
    const result = res.json() as { vaultId: string; imported: number; skipped: string[] }
    expect(result.imported).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toMatch(/^docs\/too-big: .*1048576/)
    expect(await readNote(result.vaultId, 'docs/too-big')).toBeNull()
  })

  it('collab refuses an update that would push the body over the cap, and never stores it', async () => {
    await newNote('collab-over', 'small start')
    const closes: Closed[] = []
    const provider = connect('docs/collab-over', closes)
    await waitFor(() => provider.isSynced)

    provider.document.getText('body').insert(0, `OVER-CAP-MARKER ${bodyOfBytes(CAP)}`)
    await waitFor(() => closes.some((c) => c.reason === 'note-too-large'))
    await storeSettled('docs/collab-over')

    const serverDoc = collab.hocuspocus.documents.get(`${vaultId}/docs/collab-over`)
    expect(serverDoc?.getText('body').toString() ?? 'small start').toBe('small start')
    expect(await restBody('docs/collab-over')).toBe('small start')
    const file = await readFile(join(config.dataDir, 'vaults', vaultId, 'docs', 'collab-over.md'), 'utf8')
    expect(file).not.toContain('OVER-CAP-MARKER')
    expect(await storedCrdtBody('docs/collab-over')).toBe('small start')
    provider.destroy()
  })

  it('collab closes a frame over the transport limit before reading it, and never stores it', async () => {
    await newNote('collab-frame', 'frame start')
    const closes: Closed[] = []
    const provider = connect('docs/collab-frame', closes)
    await waitFor(() => provider.isSynced)

    provider.document.getText('body').insert(0, `HUGE-FRAME-MARKER ${'x'.repeat(6 * CAP)}`)
    await waitFor(() => closes.some((c) => c.code === 1009))
    provider.destroy()
    await storeSettled('docs/collab-frame')

    expect(await restBody('docs/collab-frame')).toBe('frame start')
    expect(await storedCrdtBody('docs/collab-frame')).toBe('frame start')
  })

  it('a note of exactly the cap round-trips: collab stores it, an agent reads and edits it, the editor sees the edit', async () => {
    await newNote('collab-fits', 'tiny')
    const closes: Closed[] = []
    const provider = connect('docs/collab-fits', closes)
    await waitFor(() => provider.isSynced)

    const full = bodyOfBytes(CAP)
    provider.document.transact(() => {
      const text = provider.document.getText('body')
      text.delete(0, text.length)
      text.insert(0, full)
    })
    await waitFor(async () => (await restBody('docs/collab-fits')) === full)
    expect(closes).toEqual([])

    const client = await mcpClient()
    const read = await client.callTool({ name: 'read_note', arguments: { vaultId, path: 'docs/collab-fits' } })
    expect((JSON.parse(textOf(read)) as { body: string }).body).toBe(full)
    // Same size: the last line swapped for the agent's own.
    const edited = `${full.slice(0, full.length - 20)}appended by agent!!!`
    expect(Buffer.byteLength(edited)).toBe(CAP)
    const edit = await client.callTool({ name: 'edit_note', arguments: { vaultId, path: 'docs/collab-fits', body: edited } })
    expect(edit.isError).toBeFalsy()
    await waitFor(() => provider.document.getText('body').toString() === edited)
    expect(closes).toEqual([])
  })

  it('a REST write over the cap never reaches the live document', async () => {
    await newNote('collab-rest', 'live start')
    const provider = connect('docs/collab-rest')
    await waitFor(() => provider.isSynced)

    const res = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/collab-rest`,
      headers: { cookie: ownerCookie },
      body: { body: bodyOfBytes(CAP + 1) },
    })
    expect(res.statusCode).toBe(413)
    // writeThroughCollab edits the live document before it answers: refused means never edited.
    expect(collab.hocuspocus.documents.get(`${vaultId}/docs/collab-rest`)?.getText('body').toString()).toBe('live start')
    provider.destroy()
  })

  it('a note stored before the cap can shrink and take frontmatter edits, but not grow', async () => {
    process.env.ELARA_NOTE_MAX_BYTES = String(2 * CAP)
    try {
      await createNote(vaultId, { path: 'docs/legacy', body: bodyOfBytes(CAP + 1000) })
    } finally {
      delete process.env.ELARA_NOTE_MAX_BYTES
    }

    const fm = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/legacy`,
      headers: { cookie: ownerCookie },
      body: { frontmatter: { type: 'docs', tags: ['big'] } },
    })
    expect(fm.statusCode).toBe(200)

    const grow = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/docs/legacy`,
      headers: { cookie: ownerCookie },
      body: { body: bodyOfBytes(CAP + 2000) },
    })
    expect(grow.statusCode).toBe(413)

    const closes: Closed[] = []
    const provider = connect('docs/legacy', closes)
    await waitFor(() => provider.isSynced)
    const text = provider.document.getText('body')
    text.delete(0, 500)
    const shrunk = text.toString()
    await waitFor(async () => (await restBody('docs/legacy')) === shrunk)
    expect(closes).toEqual([])

    text.insert(0, 'MORE')
    await waitFor(() => closes.some((c) => c.reason === 'note-too-large'))
    await storeSettled('docs/legacy')
    expect(await restBody('docs/legacy')).toBe(shrunk)
    provider.destroy()
  })

  it('restore keeps a backed-up note over the cap instead of dropping it', async () => {
    const userId = randomUUID()
    const restoredVault = randomUUID()
    const now = new Date().toISOString()
    const dump = {
      users: [{ id: userId, email: uniqueEmail('cap-restore'), passwordHash: 'x', status: 'active', role: 'member', createdAt: now }],
      teams: [],
      teamMemberships: [],
      vaults: [{ id: restoredVault, name: 'Big restore', ownerId: userId, mergeable: false, createdAt: now }],
      vaultShares: [],
      mcpConnections: [],
      securityEvents: [],
      notifications: [],
    }
    const zip = new AdmZip()
    zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump), 'utf8'))
    const big = bodyOfBytes(CAP + 1)
    zip.addFile(
      `vaults/${restoredVault}/docs/big.md`,
      Buffer.from(serializeNote({ frontmatter: { type: 'docs' }, body: big }), 'utf8'),
    )
    const result = await restoreBackup(zip.toBuffer())
    expect(result.notesSkipped).toEqual([])
    expect((await readNote(restoredVault, 'docs/big'))?.body).toBe(big)
  })
})
