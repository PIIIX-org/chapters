import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { DirectConnection } from '@hocuspocus/server'
import type * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { checkNoteFiles } from '../src/notes/integrity.js'
import { getRevision, listRevisionMeta, readNote, type RevisionDetail } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #438: edit_note (and REST PUT) used to replace the whole frontmatter map, so
// `frontmatter: { status: 'active' }` silently dropped the note's title and
// tags. A `frontmatter` map now merges per top-level key; `replace: true`
// replaces the whole map and `removeKeys` deletes keys.

let app: FastifyInstance
let cookie: string
let vaultId: string
let token: string
let connectionId: string
let ownerId: string
let client: Client
let counter = 0

const TITLE = 'Merge target'
const TAGS = ['alpha', 'beta']

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const owner = await createActiveUser()
  ownerId = owner.id
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Merge vault' } })
  ).json().id
  const connection = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'merge-agent', scope: 'account' },
    })
  ).json() as { id: string; token: string }
  token = connection.token
  connectionId = connection.id
  client = new Client({ name: 'merge-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
})

afterAll(async () => {
  await client.close().catch(() => {})
  await app.close()
})

/** A fresh note with a title, tags and a body; returns its path. */
async function freshNote(extra: Record<string, unknown> = {}): Promise<string> {
  const name = `merge-${++counter}`
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie },
    body: { type: 'docs', name, frontmatter: { title: TITLE, tags: TAGS, ...extra }, body: 'Original body.' },
  })
  expect(res.statusCode).toBe(200)
  return `docs/${name}`
}

async function editNote(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name: 'edit_note', arguments: { vaultId, ...args } })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content[0]?.text ?? '' }
}

async function stored(path: string): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
  const note = (await readNote(vaultId, path))!
  // The row and the canonical file agree after every write.
  const { problems } = await checkNoteFiles(vaultId)
  expect(problems.filter((p) => p.path === path)).toEqual([])
  return { frontmatter: note.frontmatter, body: note.body }
}

/** Every revision of the note with its content, newest first. */
async function revisionsOf(path: string): Promise<RevisionDetail[]> {
  const meta = (await listRevisionMeta(vaultId, path, 200, 0))!
  return (await Promise.all(meta.map((r) => getRevision(vaultId, r.id)))).map((r) => r!)
}

/**
 * The shared cases. `open` holds the note's live document open, like a person
 * with the note open (a no-op without the relay); `live` is its document.
 */
function cases(live: () => Y.Doc | undefined, open: (path: string) => Promise<void>): void {
  /** The live document's frontmatter, when the relay is running. */
  const liveFrontmatter = () => live()?.getMap('frontmatter').toJSON() as Record<string, unknown> | undefined

  it('a partial frontmatter keeps title and tags and sets the given key', async () => {
    const path = await freshNote()
    await open(path)
    const edit = await editNote({ path, frontmatter: { status: 'active' } })
    expect(edit.isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toMatchObject({ type: 'docs', title: TITLE, tags: TAGS, status: 'active' })
    expect(note.body).toBe('Original body.')
    if (live()) expect(liveFrontmatter()).toMatchObject({ title: TITLE, tags: TAGS, status: 'active' })
  })

  it('records the merged frontmatter in a revision credited to the agent, and REST to the user', async () => {
    const path = await freshNote()
    await open(path)
    const before = (await revisionsOf(path)).length
    expect((await editNote({ path, frontmatter: { description: 'Merged.' } })).isError).toBe(false)
    // Through the relay its store of the document lands first, credited to
    // `collab` (#403); the agent's write of the same state must still be
    // recorded, credited to the connection.
    const revisions = await revisionsOf(path)
    const added = revisions.slice(0, revisions.length - before)
    expect(added.map((r) => r.actorType)).toEqual(live() ? ['mcp', 'collab'] : ['mcp'])
    expect(added[0]).toMatchObject({ action: 'update', actorType: 'mcp', actorId: connectionId })
    for (const revision of added) {
      expect(revision.frontmatter).toMatchObject({ title: TITLE, tags: TAGS, description: 'Merged.' })
    }

    const put = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/${path}`,
      headers: { cookie },
      body: { frontmatter: { status: 'active' } },
    })
    expect(put.statusCode).toBe(200)
    expect((await revisionsOf(path))[0]).toMatchObject({ action: 'update', actorType: 'user', actorId: ownerId })
  })

  it('replace: true replaces the whole map (type is kept)', async () => {
    const path = await freshNote({ status: 'active' })
    await open(path)
    const edit = await editNote({ path, frontmatter: { title: 'Only title' }, replace: true })
    expect(edit.isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toEqual({ type: 'docs', title: 'Only title' })
    if (live()) expect(liveFrontmatter()).toEqual({ type: 'docs', title: 'Only title' })
  })

  it('removeKeys deletes keys and keeps the rest', async () => {
    const path = await freshNote({ status: 'active' })
    await open(path)
    const edit = await editNote({ path, removeKeys: ['tags', 'status', 'not-there'] })
    expect(edit.isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toMatchObject({ type: 'docs', title: TITLE })
    expect(note.frontmatter).not.toHaveProperty('tags')
    expect(note.frontmatter).not.toHaveProperty('status')
    if (live()) expect(liveFrontmatter()).not.toHaveProperty('tags')
  })

  it('removeKeys combines with a merge in one write', async () => {
    const path = await freshNote()
    await open(path)
    const edit = await editNote({ path, frontmatter: { status: 'draft' }, removeKeys: ['tags'] })
    expect(edit.isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toMatchObject({ title: TITLE, status: 'draft' })
    expect(note.frontmatter).not.toHaveProperty('tags')
  })

  it('refuses an invalid merged result and writes nothing', async () => {
    const path = await freshNote()
    await open(path)
    const before = await stored(path)
    const revisions = (await revisionsOf(path)).length
    for (const frontmatter of [{ status: 'not-a-status' }, { title: null }, { tags: 'one' }]) {
      const edit = await editNote({ path, frontmatter, body: 'Must not land.' })
      expect(edit.isError).toBe(true)
      expect(edit.text).toMatch(/must be/)
    }
    expect(await stored(path)).toEqual(before)
    expect((await revisionsOf(path)).length).toBe(revisions)
    if (live()) {
      expect(liveFrontmatter()).toMatchObject({ title: TITLE, tags: TAGS })
      expect(liveFrontmatter()).not.toHaveProperty('status')
      expect(live()!.getText('body').toString()).toBe('Original body.')
    }
  })

  it('refuses contradictory arguments', async () => {
    const path = await freshNote()
    await open(path)
    const both = await editNote({ path, frontmatter: { status: 'active' }, removeKeys: ['status'] })
    expect(both.isError).toBe(true)
    expect(both.text).toMatch(/status/)
    const bare = await editNote({ path, replace: true, body: 'x' })
    expect(bare.isError).toBe(true)
    expect(bare.text).toMatch(/replace/)
    expect((await stored(path)).frontmatter).toMatchObject({ title: TITLE, tags: TAGS })
    expect((await stored(path)).body).toBe('Original body.')
  })

  it('a body-only edit leaves the frontmatter untouched', async () => {
    const path = await freshNote({ status: 'active' })
    await open(path)
    const before = (await stored(path)).frontmatter
    expect((await editNote({ path, body: 'New body.' })).isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toEqual(before)
    expect(note.body).toBe('New body.')
  })

  it('null is a value, not a removal; nested maps are replaced whole', async () => {
    const path = await freshNote({ properties: { a: 1, b: 2 } })
    await open(path)
    expect((await editNote({ path, frontmatter: { reviewer: null, properties: { a: 3 } } })).isError).toBe(false)
    const note = await stored(path)
    expect(note.frontmatter).toMatchObject({ title: TITLE, tags: TAGS, reviewer: null })
    expect(note.frontmatter.properties).toEqual({ a: 3 })
  })

  it('REST PUT merges the same way, with replace and removeKeys', async () => {
    const path = await freshNote()
    await open(path)
    const put = (body: object) =>
      app.inject({ method: 'PUT', url: `/api/vaults/${vaultId}/notes/${path}`, headers: { cookie }, body })
    expect((await put({ frontmatter: { status: 'active' } })).statusCode).toBe(200)
    expect((await stored(path)).frontmatter).toMatchObject({ title: TITLE, tags: TAGS, status: 'active' })
    expect((await put({ removeKeys: ['tags'] })).statusCode).toBe(200)
    expect((await stored(path)).frontmatter).not.toHaveProperty('tags')
    const invalid = await put({ frontmatter: { status: 'nope' } })
    expect(invalid.statusCode).toBe(400)
    expect((await stored(path)).frontmatter).toMatchObject({ title: TITLE, status: 'active' })
    expect((await put({ frontmatter: { title: 'Replaced' }, replace: true })).statusCode).toBe(200)
    expect((await stored(path)).frontmatter).toEqual({ type: 'docs', title: 'Replaced' })
  })
}

describe('edit_note frontmatter merge without the relay', () => {
  cases(() => undefined, async () => {})
})

describe('edit_note frontmatter merge through the live relay', () => {
  let collab: CollabRelay
  let connection: DirectConnection | null = null
  let liveName = ''

  async function openLive(path: string): Promise<void> {
    await connection?.disconnect()
    liveName = `${vaultId}/${path}`
    connection = await collab.hocuspocus.openDirectConnection(liveName, { userId: 'test-reader' })
  }

  beforeAll(() => {
    collab = startCollabServer(app.server)
  })

  afterAll(async () => {
    await connection?.disconnect()
    await collab.destroy()
  })

  cases(() => collab.hocuspocus.documents.get(liveName), openLive)

  it('merges onto keys a person set in the live document that are not stored yet', async () => {
    const path = await freshNote()
    await openLive(path)
    await connection!.transact((document) => document.getMap('frontmatter').set('description', 'Typed live.'))
    expect((await editNote({ path, frontmatter: { status: 'active' } })).isError).toBe(false)
    expect((await stored(path)).frontmatter).toMatchObject({
      title: TITLE,
      tags: TAGS,
      description: 'Typed live.',
      status: 'active',
    })
  })

  it('names an invalid key already in the live document, and replace: true gets past it', async () => {
    const path = await freshNote()
    await openLive(path)
    // A person typed a value the relay refuses to store (it keeps the last valid file).
    await connection!.transact((document) => document.getMap('frontmatter').set('status', 'bogus'))
    const merged = await editNote({ path, frontmatter: { description: 'Agent note.' } })
    expect(merged.isError).toBe(true)
    expect(merged.text).toMatch(/"status" is already on the note.*`replace: true`/)
    const replaced = await editNote({ path, frontmatter: { title: TITLE, description: 'Agent note.' }, replace: true })
    expect(replaced.isError).toBe(false)
    expect((await stored(path)).frontmatter).toEqual({ type: 'docs', title: TITLE, description: 'Agent note.' })
  })
})
