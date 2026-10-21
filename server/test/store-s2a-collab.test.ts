import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { getLiveNote, renameNote, writeNote } from '../src/notes/store.js'
import { setStoreMigrationPending } from '../src/notes/store-tx.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { createActiveUser, loginCookie, loginToken, noteDocName } from './helpers.js'

// ADR-003 S2a write path through the S2b relay (documents named by note id): a server write holding a
// note's lock never waits for the relay's store hook (§5.1, R5-1), its change
// reaches the open editor (§5.2 step 8), and a renamed note open at both its
// old and its new path keeps both tabs' typing exactly once (§5.5).

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2a relay vault' } })).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

async function create(name: string, body: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body } })
  expect(res.statusCode).toBe(200)
  return `docs/${name}`
}

async function open(path: string) {
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: await noteDocName(vaultId, path), token, document: new Y.Doc() })
  providers.push(provider)
  const text = provider.document.getText('body')
  await waitFor(() => provider.isSynced && text.length > 0)
  return {
    text,
    async type(index: number, typed: string) {
      text.insert(index, typed)
      await waitFor(() => !provider.hasUnsyncedChanges)
    },
  }
}

const rowBody = async (path: string) => (await getLiveNote(vaultId, path))?.body

describe('a write to an open note (§5.1 R5-1, §5.2 step 8)', () => {
  it('completes while the relay store is due under its lock; the store runs after it and keeps both', async () => {
    const path = await create('due-store', 'Start.')
    const editor = await open(path)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let computing!: () => void
    const inCompute = new Promise<void>((r) => (computing = r))
    // The write holds the note lock while it waits on the gate.
    const write = writeNote(
      vaultId,
      path,
      async (current) => {
        computing()
        await gate
        return { frontmatter: { ...current.frontmatter, type: 'docs' }, body: `${current.body}\nAgent line.` }
      },
      { type: 'mcp', id: randomUUID() },
    )
    await inCompute
    // Typing makes a relay store due (debounce 150 ms in tests, maxDebounce 750 ms); it waits for the lock.
    // Since S3 the typing is logged before it is acked, without waiting for the write's lock.
    await editor.type(0, 'Typed. ')
    await new Promise((r) => setTimeout(r, 900))
    release()
    const written = await write
    expect(written?.body).toContain('Agent line.')
    // The store that waited runs after the write: the row keeps the agent's line and the typing.
    await waitFor(async () => {
      const body = await rowBody(path)
      return Boolean(body?.includes('Agent line.') && body.includes('Typed. '))
    })
    expect(editor.text.toString()).toContain('Agent line.')
    expect(editor.text.toString().match(/Typed\. /g)).toHaveLength(1)
    // No store in between wrote the editors' older state back over the acknowledged write.
    const after = (await db.execute(sql`
      SELECT r.body FROM note_revisions r JOIN notes n ON n.id = r.note_id
      WHERE n.vault_id = ${vaultId} AND n.path = ${path}
        AND r.ord > (SELECT min(ord) FROM note_revisions WHERE note_id = r.note_id AND body LIKE '%Agent line.%')
      ORDER BY r.ord`)) as unknown as Array<{ body: string }>
    expect(after.filter((r) => !r.body.includes('Agent line.'))).toEqual([])
  }, 20_000)

  it('an agent edit reaches the open editor and is still in the row after the next debounced store', async () => {
    const path = await create('acked-stays', 'One.')
    const editor = await open(path)
    await writeThroughCollab(vaultId, path, { body: 'One.\nTwo.' }, { type: 'mcp', id: randomUUID() })
    await waitFor(() => editor.text.toString() === 'One.\nTwo.')
    await editor.type(0, 'Zero. ')
    await waitFor(async () => (await rowBody(path)) === 'Zero. One.\nTwo.')
  }, 15_000)
})

describe('a renamed note open in a tab from before the rename and one after it (§5.5)', () => {
  it('keeps the typing of both tabs, each exactly once', async () => {
    const path = await create('two-docs', 'Shared.')
    const oldTab = await open(path)
    await renameNote(vaultId, path, 'two-docs-moved', { type: 'mcp', id: randomUUID() })
    const newTab = await open('docs/two-docs-moved')
    await oldTab.type(0, 'Old tab. ')
    await newTab.type(newTab.text.length, ' New tab.')
    await waitFor(async () => {
      const body = await rowBody('docs/two-docs-moved')
      return Boolean(body?.includes('Old tab. ') && body.includes(' New tab.'))
    })
    const body = (await rowBody('docs/two-docs-moved'))!
    expect(body.match(/Old tab\. /g)).toHaveLength(1)
    expect(body.match(/ New tab\./g)).toHaveLength(1)
    // Nothing is stored at the old path.
    expect(await getLiveNote(vaultId, path)).toBeNull()
  }, 20_000)
})

describe('live documents are named by note id (§5.4)', () => {
  it('a write to a new note at a renamed note\'s old path never reaches the renamed note', async () => {
    const path = await create('reused', 'The first note.')
    await open(path)
    await renameNote(vaultId, path, 'reused-moved', { type: 'mcp', id: randomUUID() })
    await create('reused', 'The second note.')
    await writeThroughCollab(vaultId, path, { body: 'The second note, edited.' }, { type: 'mcp', id: randomUUID() })
    expect(await rowBody(path)).toBe('The second note, edited.')
    // Past a debounced store of the old-path tab, the renamed note keeps its own text.
    await new Promise((r) => setTimeout(r, 600))
    expect(await rowBody('docs/reused-moved')).toBe('The first note.')
  }, 15_000)

  it('an old-path tab of a renamed note keeps an acknowledged agent write when it stores', async () => {
    const path = await create('old-tab', 'Line one.')
    const tab = await open(path)
    await renameNote(vaultId, path, 'old-tab-moved', { type: 'mcp', id: randomUUID() })
    await writeThroughCollab(vaultId, 'docs/old-tab-moved', { body: 'Line one.\nAgent line.' }, { type: 'mcp', id: randomUUID() })
    await waitFor(() => tab.text.toString().includes('Agent line.'))
    await tab.type(0, 'Typed. ')
    await waitFor(async () => (await rowBody('docs/old-tab-moved')) === 'Typed. Line one.\nAgent line.')
  }, 15_000)

  it('a write while the note is open at its old and new path keeps the old tab\'s unstored typing in the row and both tabs', async () => {
    const path = await create('both-open', 'Shared.')
    const oldTab = await open(path)
    await renameNote(vaultId, path, 'both-open-moved', { type: 'mcp', id: randomUUID() })
    const newTab = await open('docs/both-open-moved')
    await oldTab.type(0, 'Old tab. ')
    // Within the relay's debounce: the old tab's typing is not stored yet.
    await writeThroughCollab(vaultId, 'docs/both-open-moved', { frontmatter: { status: 'active' }, frontmatterMode: 'merge' }, { type: 'mcp', id: randomUUID() })
    expect(await rowBody('docs/both-open-moved')).toBe('Old tab. Shared.')
    await waitFor(() => newTab.text.toString() === 'Old tab. Shared.')
    expect(oldTab.text.toString()).toBe('Old tab. Shared.')
  }, 15_000)
})

describe('a renamed note opened again at its new path (§5.4, #834)', () => {
  it('joins the same document: server writes reach both tabs once, no merge, no doubled text', async () => {
    const body = 'paragraph 0: the first line.\n\nparagraph 1: the second line.'
    const path = await create('unrelated', body)
    const oldTab = await open(path)
    await renameNote(vaultId, path, 'unrelated-moved', { type: 'mcp', id: randomUUID() })
    const newTab = await open('docs/unrelated-moved')
    const agent = { type: 'mcp' as const, id: randomUUID() }
    await writeThroughCollab(vaultId, 'docs/unrelated-moved', { body: `${body}\n\nfirst agent line.` }, agent)
    await writeThroughCollab(vaultId, 'docs/unrelated-moved', { body: `${body}\n\nfirst agent line.\nsecond agent line.` }, agent)
    const expected = `${body}\n\nfirst agent line.\nsecond agent line.`
    expect(await rowBody('docs/unrelated-moved')).toBe(expected)
    await waitFor(() => newTab.text.toString() === expected && oldTab.text.toString() === expected)
    expect(newTab.text.toString().match(/paragraph 0:/g)).toHaveLength(1)
  }, 15_000)
})

describe('a note the store migration has not processed (§8, Q5)', () => {
  it('cannot be opened in an editor: the relay refuses it, so nothing is typed that could not be stored', async () => {
    const id = randomUUID()
    await db.execute(sql`
      INSERT INTO notes (id, vault_id, type, name, path, frontmatter, body)
      VALUES (${id}, ${vaultId}, 'docs', 'unmigrated', 'docs/unmigrated', '{"type":"docs"}'::jsonb, 'from before the store')`)
    setStoreMigrationPending(true)
    try {
      let refused = ''
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: `${vaultId}/~${id}`,
        token,
        document: new Y.Doc(),
        onAuthenticationFailed: ({ reason }) => {
          refused = reason
        },
      })
      providers.push(provider)
      await waitFor(() => refused !== '')
      // The refusal's own reason (Hocuspocus sends `error.reason`); the editor reads it and asks for a restart.
      expect(refused).toBe('note-not-migrated')
      expect(provider.isSynced).toBe(false)
      expect(collab.hocuspocus.documents.has(`${vaultId}/~${id}`)).toBe(false)
    } finally {
      setStoreMigrationPending(false)
      await db.execute(sql`DELETE FROM notes WHERE id = ${id}`)
    }
  }, 15_000)
})

describe('a frontmatter-only edit while the editor holds a doubled note (#488, #492)', () => {
  it('keeps the stored body: the doubled text is never committed as the agent\'s write', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `paragraph ${i}: the ${i * 7}th observation about item ${i * 13 + 5} notes that value ${i * 31 + 2} changed after run ${i}.`).join('\n\n')
    const path = await create('doubled-fm', body)
    const editor = await open(path)
    await editor.type(editor.text.length, `\n\n${body}`)
    // The relay quarantines the doubled document (#492): the row keeps the single body.
    await waitFor(async () => {
      const rows = (await db.execute(sql`
        SELECT 1 FROM note_revisions r JOIN notes n ON n.id = r.note_id
        WHERE n.vault_id = ${vaultId} AND n.path = ${path} AND r.action = 'quarantine'`)) as unknown as unknown[]
      return rows.length > 0
    })
    expect(await rowBody(path)).toBe(body)
    const actor = { type: 'mcp' as const, id: randomUUID() }
    const row = await writeThroughCollab(vaultId, path, { frontmatter: { status: 'active' }, frontmatterMode: 'merge' }, actor, { quarantine: 'all' })
    expect(row?.body).toBe(body)
    expect((await getLiveNote(vaultId, path))?.frontmatter).toMatchObject({ status: 'active' })
    // The editor keeps what it shows.
    expect(editor.text.toString()).toBe(`${body}\n\n${body}`)
  }, 15_000)
})
