import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { readNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { createActiveUser, loginCookie, loginToken, noteDocName } from './helpers.js'

// #483: an agent's edit_note reaches a person's open editor through the relay.
// The editor's caret is anchored to the characters the person sees, and their
// Ctrl+Z to the characters they typed. An edit that deletes the whole body and
// inserts an identical copy plus its change throws both away: the caret lands
// at the top and Ctrl+Z finds nothing left to undo.

/** The editor binding's transaction origin: what the person typed, the only thing their undo tracks. */
const TYPED = Symbol('typed')

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

// A real relay over a real socket: the conditions settle on network round
// trips, which fake timers cannot drive, so this polls for them (as
// collab.test.ts does).
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
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
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Agent edit vault' } })
  ).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

async function createNote(name: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie },
    body: { type: 'docs', name, body },
  })
  expect(res.statusCode).toBe(200)
  return `docs/${name}`
}

/** A person with the note open: their copy of it, their typing, their Ctrl+Z, and what the relay sends them. */
async function openEditor(path: string) {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: await noteDocName(vaultId, path),
    token,
    document: new Y.Doc(),
  })
  providers.push(provider)
  const doc = provider.document
  const text = doc.getText('body')
  await waitFor(() => provider.isSynced && text.length > 0)
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([TYPED]) })
  const received: unknown[] = []
  text.observe((event, transaction) => {
    if (transaction.origin === provider) received.push(event.delta)
  })
  return {
    doc,
    text,
    undo,
    received,
    /** Types at `index` and waits for the relay to acknowledge it, as a person who paused would. */
    async type(index: number, typed: string) {
      doc.transact(() => text.insert(index, typed), TYPED)
      await waitFor(() => !provider.hasUnsyncedChanges)
    },
  }
}

const agent = () => ({ type: 'mcp' as const, id: randomUUID() })

describe('an agent edit reaching an open editor (#483)', () => {
  it('appends as an insert at the end: the caret stays and Ctrl+Z still undoes the typing', async () => {
    const path = await createNote('append', 'First line.')
    const editor = await openEditor(path)
    await editor.type(editor.text.length, ' My words.')
    const typed = editor.text.toString()
    // The caret sits right after what the person typed.
    const caret = Y.createRelativePositionFromTypeIndex(editor.text, typed.length, -1)

    // The realistic agent append: read the note, send it back with a line added.
    const body = `${typed}\nAn agent line.\n`
    await writeThroughCollab(vaultId, path, { body }, agent())
    await waitFor(() => editor.text.toString() === body)

    expect(Y.createAbsolutePositionFromRelativePosition(caret, editor.doc)?.index).toBe(typed.length)
    editor.undo.undo()
    expect(editor.text.toString()).toBe('First line.\nAn agent line.\n')
    // The person can undo only what they typed: the agent's line is not theirs.
    editor.undo.undo()
    expect(editor.text.toString()).toBe('First line.\nAn agent line.\n')
    // What reached the editor: the agent's line, and nothing of the person's text.
    expect(editor.received).toEqual([[{ retain: typed.length }, { insert: '\nAn agent line.\n' }]])
  })

  it('changes only what it changed: a fix above the caret moves the caret with its text', async () => {
    const path = await createNote('fix-above', 'A title\n\nThe agent fixes this colour.\n\nThe person types here.')
    const editor = await openEditor(path)
    await editor.type(editor.text.length, ' And here.')
    const typed = editor.text.toString()
    const caret = Y.createRelativePositionFromTypeIndex(editor.text, typed.length, -1)

    const body = typed.replace('colour', 'color')
    await writeThroughCollab(vaultId, path, { body }, agent())
    await waitFor(() => editor.text.toString() === body)

    expect(Y.createAbsolutePositionFromRelativePosition(caret, editor.doc)?.index).toBe(body.length)
    editor.undo.undo()
    expect(editor.text.toString()).toBe('A title\n\nThe agent fixes this color.\n\nThe person types here.')
    expect(editor.received).toEqual([[{ retain: typed.indexOf('colour') + 4 }, { delete: 1 }]])
  })

  it('never splits an emoji: the body arrives exactly as sent, on the editor and on disk', async () => {
    // 😀 and 😁 share their first UTF-16 unit, 🔀 and 🤀 their second: a change
    // that kept the common unit would split a surrogate pair, which Yjs
    // stores as U+FFFD.
    const path = await createNote('emoji', 'Mood 😀 and 🔀 end')
    const editor = await openEditor(path)

    const body = 'Mood 😁 and 🤀 end'
    await writeThroughCollab(vaultId, path, { body }, agent())
    await waitFor(() => editor.received.length > 0)

    expect(editor.text.toString()).toBe(body)
    expect((await readNote(vaultId, path))?.body).toBe(body)
  })
})
