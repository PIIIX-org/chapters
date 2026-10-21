import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { readNote } from '../src/notes/store.js'
import { db } from '../src/db/client.js'
import { sessions } from '../src/db/schema.js'
import { hashToken } from '../src/auth/tokens.js'
import { createActiveUser, loginCookie, TEST_PASSWORD } from './helpers.js'

/**
 * #498: a live collab connection belongs to the session that opened it. When
 * that session ends (logout, password change or reset, deactivation, expiry)
 * every socket it opened is closed and nothing it sends afterwards is stored,
 * in this tab or any other tab of the same session.
 */

let app: FastifyInstance
let collab: CollabRelay
let port: number
let collabUrl: string

interface Editor {
  provider: HocuspocusProvider
  closes: string[]
  authFailed: boolean
}

const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function mintTicket(cookie: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/collab/ticket', headers: { cookie } })
  expect(res.statusCode).toBe(200)
  const { token } = res.json() as { token: string }
  return token
}

/** A browser tab: a fresh ticket from the session cookie, as the editor does. */
async function openTab(cookie: string, docName: string): Promise<Editor> {
  return connect(await mintTicket(cookie), docName)
}

function connect(token: string, docName: string): Editor {
  const closes: string[] = []
  const state = { authFailed: false }
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: docName,
    token,
    document: new Y.Doc(),
    onClose: ({ event }) => {
      closes.push(event.reason)
    },
    onAuthenticationFailed: () => {
      state.authFailed = true
    },
  })
  providers.push(provider)
  return {
    provider,
    closes,
    get authFailed() {
      return state.authFailed
    },
  }
}

function body(editor: Editor): Y.Text {
  return editor.provider.document.getText('body')
}

async function joined(editor: Editor, text: string): Promise<void> {
  await waitFor(() => body(editor).toString().includes(text))
}

/** A user who owns a vault with one note, plus their logged-in cookie. */
async function ownerWithNote(name: string) {
  const user = await createActiveUser()
  const cookie = await loginCookie(app, user.email)
  const vaultId = (
    (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie },
        body: { name: `Logout vault ${name}` },
      })
    ).json() as { id: string }
  ).id
  const created = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie },
    body: { type: 'docs', name, body: `Start of ${name}.` },
  })
  const docName = `${vaultId}/~${(created.json() as { id: string }).id}`
  return { user, cookie, vaultId, path: `docs/${name}`, docName, start: `Start of ${name}.` }
}

async function storedBody(vaultId: string, path: string): Promise<string> {
  return (await readNote(vaultId, path))?.body ?? ''
}

/** Waits until the stored note holds `marker`, then returns the stored body. */
async function storedWith(vaultId: string, path: string, marker: string): Promise<string> {
  let stored = ''
  const start = Date.now()
  while (!stored.includes(marker)) {
    if (Date.now() - start > 8000) throw new Error(`never stored ${marker}`)
    await new Promise((r) => setTimeout(r, 50))
    stored = await storedBody(vaultId, path)
  }
  return stored
}

async function logout(cookie: string): Promise<number> {
  return (await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })).statusCode
}

/**
 * The refused edit and the control edit travel on two sockets, which the
 * relay does not order, and a refused edit has no acknowledgement to await.
 * A short real gap puts the refused one first, so without the fix it would be
 * in the store the control edit triggers.
 */
async function gap(): Promise<void> {
  // Promise.withResolvers is past the TypeScript target (ES2023).
  await new Promise((resolve) => setTimeout(resolve, 200))
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  collabUrl = `ws://127.0.0.1:${port}/collab`
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

describe('a collab socket ends with its session (#498)', () => {
  it('logout closes the socket, and text typed after it is never stored', async () => {
    const note = await ownerWithNote('typed-after-logout')
    const tab = await openTab(note.cookie, note.docName)
    // Another session of the same user (another device) keeps editing: the
    // control that proves the relay is still storing.
    const otherDevice = await openTab(await loginCookie(app, note.user.email), note.docName)
    await joined(tab, note.start)
    await joined(otherDevice, note.start)

    body(tab).insert(0, 'BEFORE-LOGOUT ')
    await storedWith(note.vaultId, note.path, 'BEFORE-LOGOUT')

    expect(await logout(note.cookie)).toBe(200)
    body(tab).insert(0, 'AFTER-LOGOUT ')
    await gap()
    body(otherDevice).insert(body(otherDevice).length, ' OTHER-DEVICE')

    const stored = await storedWith(note.vaultId, note.path, 'OTHER-DEVICE')
    expect(stored).not.toContain('AFTER-LOGOUT')
    expect(collab.hocuspocus.documents.get(note.docName)?.getText('body').toString()).not.toContain(
      'AFTER-LOGOUT',
    )
    expect(body(otherDevice).toString()).not.toContain('AFTER-LOGOUT')
    expect(tab.closes).toContain('signed-out')
    expect(otherDevice.closes).toEqual([])
  })

  it("logout in one tab closes the session's other tabs too", async () => {
    const note = await ownerWithNote('other-tab')
    const tabA = await openTab(note.cookie, note.docName)
    const tabB = await openTab(note.cookie, note.docName)
    const otherDevice = await openTab(await loginCookie(app, note.user.email), note.docName)
    await joined(tabA, note.start)
    await joined(tabB, note.start)
    await joined(otherDevice, note.start)

    expect(await logout(note.cookie)).toBe(200)
    body(tabB).insert(0, 'OTHER-TAB ')
    await gap()
    body(otherDevice).insert(body(otherDevice).length, ' CONTROL')

    const stored = await storedWith(note.vaultId, note.path, 'CONTROL')
    expect(stored).not.toContain('OTHER-TAB')
    expect(tabA.closes).toContain('signed-out')
    expect(tabB.closes).toContain('signed-out')
    expect(otherDevice.closes).toEqual([])
  })

  it('a ticket minted before logout is refused after it', async () => {
    const note = await ownerWithNote('stale-ticket')
    const token = await mintTicket(note.cookie)
    expect(await logout(note.cookie)).toBe(200)

    const late = connect(token, note.docName)
    await waitFor(() => late.authFailed || body(late).length > 0)
    expect(late.authFailed).toBe(true)
    expect(body(late).toString()).toBe('')
  })

  it('a ticket of an expired session is refused', async () => {
    const note = await ownerWithNote('expired-session')
    const token = await mintTicket(note.cookie)
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(note.cookie.split('=')[1]!)))

    const late = connect(token, note.docName)
    await waitFor(() => late.authFailed || body(late).length > 0)
    expect(late.authFailed).toBe(true)
    expect(body(late).toString()).toBe('')
  })

  it("a password change closes the other sessions' sockets and spares its own", async () => {
    const note = await ownerWithNote('password-change')
    const otherCookie = await loginCookie(app, note.user.email)
    const here = await openTab(note.cookie, note.docName)
    const elsewhere = await openTab(otherCookie, note.docName)
    await joined(here, note.start)
    await joined(elsewhere, note.start)

    const res = await app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: note.cookie },
      body: { currentPassword: TEST_PASSWORD, newPassword: 'a-new-correct-horse-498' },
    })
    expect(res.statusCode).toBe(200)

    body(elsewhere).insert(0, 'ELSEWHERE ')
    await gap()
    body(here).insert(body(here).length, ' HERE')

    const stored = await storedWith(note.vaultId, note.path, 'HERE')
    expect(stored).not.toContain('ELSEWHERE')
    expect(elsewhere.closes).toContain('signed-out')
    expect(here.closes).toEqual([])
  })

  it('deactivating the user closes their sockets and stores nothing more from them', async () => {
    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const note = await ownerWithNote('deactivated')
    // A co-editor of the note stays: the control that the relay still stores.
    const coEditor = await createActiveUser()
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${note.vaultId}/shares`,
      headers: { cookie: note.cookie },
      body: { granteeType: 'user', granteeId: coEditor.id, permission: 'edit' },
    })
    const tab = await openTab(note.cookie, note.docName)
    const control = await openTab(await loginCookie(app, coEditor.email), note.docName)
    await joined(tab, note.start)
    await joined(control, note.start)

    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${note.user.id}/deactivate`,
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    body(tab).insert(0, 'DEACTIVATED ')
    await gap()
    body(control).insert(body(control).length, ' CO-EDITOR')

    const stored = await storedWith(note.vaultId, note.path, 'CO-EDITOR')
    expect(stored).not.toContain('DEACTIVATED')
    expect(tab.closes).toContain('signed-out')
    expect(control.closes).toEqual([])
  })

  it('logout ends the live read-only view of that session', async () => {
    const note = await ownerWithNote('live-view')
    const res = await fetch(`http://127.0.0.1:${port}/api/vaults/${note.vaultId}/live/${note.path}`, {
      headers: { cookie: note.cookie },
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    await reader.read()

    expect(await logout(note.cookie)).toBe(200)
    // A stream that stays open never resolves the read: bound it.
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read().then((chunk) => (chunk.done ? 'ended' : 'data')),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still open'), 2000)
      }),
    ])
    clearTimeout(timer)
    expect(next).toBe('ended')
    await reader.cancel().catch(() => undefined)
  })
})
