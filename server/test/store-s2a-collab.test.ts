import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { getLiveNote, renameNote, writeNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 S2a with the unchanged path-named relay: a server write holding a
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
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vaultId}/${path}`, token, document: new Y.Doc() })
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

describe('a renamed note open at its old and its new path (§5.5, S2a)', () => {
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
