import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// #481: an agent that reads or writes a note people have open shows up in
// their "In this note now" row, as an agent, until it goes quiet. Before, MCP
// wrote through a direct connection that never joined awareness, so nobody
// could tell an agent was there.

const IDLE_MS = 1500
// Read when presence is shown, so setting it here is enough.
process.env.COLLAB_AGENT_IDLE_MS = String(IDLE_MS)

const AGENT_NAME = 'presence-agent'

let app: FastifyInstance
let collab: CollabRelay
let collabUrl: string
let cookie: string
let sessionToken: string
let vaultId: string
let mcpToken: string
let connectionId: string
let client: Client
let counter = 0
const providers: HocuspocusProvider[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  collabUrl = `ws://127.0.0.1:${port}/collab`
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  sessionToken = await loginToken(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Presence vault' } })
  ).json().id
  const connection = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: AGENT_NAME, scope: 'account' },
    })
  ).json() as { id: string; token: string }
  mcpToken = connection.token
  connectionId = connection.id
  client = new Client({ name: 'presence-test', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    }),
  )
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await client.close().catch(() => {})
  await collab.destroy()
  await app.close()
})

/**
 * Waits until `check` holds for what `provider` sees, re-checking on every
 * awareness update it receives, or until `ms` pass; the assertion after it
 * says what was missing. The expiry case needs the relay's real clock: its
 * timers run in the server under test, across a real socket, so fake timers
 * here would not move them; the idle timeout is shortened instead.
 */
// Executor form: the server's TypeScript lib predates Promise.withResolvers.
async function seen(provider: HocuspocusProvider, check: () => boolean, ms = 5000): Promise<void> {
  if (check()) return
  const awareness = provider.awareness!
  let onUpdate = (): void => {}
  let timer: NodeJS.Timeout | undefined
  try {
    await new Promise<void>((resolve) => {
      onUpdate = () => {
        if (check()) resolve()
      }
      awareness.on('update', onUpdate)
      timer = setTimeout(resolve, ms)
    })
  } finally {
    clearTimeout(timer)
    awareness.off('update', onUpdate)
  }
}

async function freshNote(): Promise<string> {
  const name = `presence-${++counter}`
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie },
    body: { type: 'docs', name, body: 'Original body.' },
  })
  expect(res.statusCode).toBe(200)
  return `docs/${name}`
}

/** A person with the note open, synced with the relay. */
async function open(path: string, state?: Record<string, unknown>): Promise<HocuspocusProvider> {
  let synced = (): void => {}
  const handshake = new Promise<void>((resolve) => (synced = resolve))
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: `${vaultId}/${path}`,
    token: sessionToken,
    document: new Y.Doc(),
    onSynced: () => synced(),
  })
  providers.push(provider)
  // One update, so a claim cannot arrive after the state it rides on.
  if (state) provider.awareness!.setLocalState(state)
  await handshake
  return provider
}

/** The agent states this provider sees, other than its own. */
function agentsSeenBy(provider: HocuspocusProvider): Array<Record<string, unknown>> {
  const awareness = provider.awareness!
  return [...awareness.getStates().entries()]
    .filter(([id, state]) => id !== awareness.clientID && state.agent !== undefined)
    .map(([, state]) => state)
}

async function call(name: string, args: Record<string, unknown>): Promise<void> {
  const result = await client.callTool({ name, arguments: { vaultId, ...args } })
  expect(result.isError ?? false).toBe(false)
}

describe('agents in editor presence (#481)', () => {
  it('an MCP write to an open note shows the agent as editing, by its connection name, then expires', async () => {
    const path = await freshNote()
    const person = await open(path)
    expect(agentsSeenBy(person)).toEqual([])

    await call('edit_note', { path, body: 'Written by the agent.' })

    await seen(person, () => agentsSeenBy(person).length === 1)
    expect(agentsSeenBy(person)).toEqual([{ agent: { name: AGENT_NAME, activity: 'editing' } }])
    // The label is all that is shared: never the token, nor the connection id.
    const wire = JSON.stringify([...person.awareness!.getStates().values()])
    expect(wire).not.toContain(mcpToken)
    expect(wire).not.toContain(connectionId)

    // Quiet for the idle timeout: gone from the row.
    await seen(person, () => agentsSeenBy(person).length === 0, IDLE_MS + 4000)
    expect(agentsSeenBy(person)).toEqual([])
  })

  it('an MCP read of an open note shows the agent as reading, and a later write as editing', async () => {
    const path = await freshNote()
    const person = await open(path)

    await call('read_note', { path })
    await seen(person, () => agentsSeenBy(person).length === 1)
    expect(agentsSeenBy(person)).toEqual([{ agent: { name: AGENT_NAME, activity: 'reading' } }])

    await call('edit_note', { path, body: 'Then edited.' })
    await seen(person, () => (agentsSeenBy(person)[0]?.agent as { activity?: string } | undefined)?.activity === 'editing')
    // One connection is one participant, not one per call.
    expect(agentsSeenBy(person)).toEqual([{ agent: { name: AGENT_NAME, activity: 'editing' } }])
  })

  it('a person who opens the note while the agent is there sees it too', async () => {
    const path = await freshNote()
    await open(path)
    await call('edit_note', { path, body: 'Agent was here.' })
    const late = await open(path)
    await seen(late, () => agentsSeenBy(late).length === 1)
    expect(agentsSeenBy(late)).toEqual([{ agent: { name: AGENT_NAME, activity: 'editing' } }])
  })

  it('reading a note nobody has open does not load it into the relay', async () => {
    const path = await freshNote()
    await call('read_note', { path })
    expect(collab.hocuspocus.documents.has(`${vaultId}/${path}`)).toBe(false)
  })

  it('a person cannot pose as an agent: the relay strips the claim', async () => {
    const path = await freshNote()
    const watcher = await open(path)
    const impostor = await open(path, {
      user: { id: 'u-x', name: 'mallory' },
      agent: { name: 'Claude', activity: 'editing' },
    })
    const impostorId = impostor.awareness!.clientID
    await seen(watcher, () => watcher.awareness!.getStates().get(impostorId)?.user !== undefined)
    expect(watcher.awareness!.getStates().get(impostorId)).toEqual({ user: { id: 'u-x', name: 'mallory' } })
    expect(agentsSeenBy(watcher)).toEqual([])
  })
})
