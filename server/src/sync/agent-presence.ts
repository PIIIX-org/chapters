import { randomInt } from 'node:crypto'
import type { Document } from '@hocuspocus/server'
import { getCollab } from './collab-server.js'

/**
 * Agents in editor presence (#481). An MCP connection that reads or writes a
 * note people have open joins that note's "In this note now" row: the relay
 * puts an awareness state of its own on the document, so editors see who the
 * agent is and what it is doing, and it leaves once the agent goes quiet.
 *
 * The state is `{ agent: { name, activity } }`: the connection's label and
 * `editing` or `reading`. Nothing else about the connection is shared, not its
 * token, hash or id. It has no `user` and no cursor, so editors draw no caret
 * for it. Only the relay sets `agent`: `stripAgentClaims` removes it from
 * every state a client sends, so a person cannot pose as one.
 *
 * Only a document already loaded in the relay gets one. A read never loads a
 * document, so reading notes nobody has open costs nothing; a write loads its
 * document anyway, to edit it.
 */

export type AgentActivity = 'editing' | 'reading'

export interface AgentIdentity {
  /** Tells one connection from another on a document; never broadcast. */
  key: string
  /** Shown to editors: the MCP connection's label. */
  name: string
}

/** How long an agent stays in the row after its last read or write; read per call, so tests can shorten it. */
function agentIdleMs(): number {
  return Number(process.env.COLLAB_AGENT_IDLE_MS ?? 60_000)
}

/**
 * y-protocols drops a remote awareness state not renewed for 30 s, on the
 * relay and in every editor, so a state that outlives that is renewed at
 * half of it, as clients renew their own.
 */
const RENEW_MS = 15_000

interface Presence {
  document: Document
  clientId: number
  name: string
  /** Editing until the idle timeout after its last write, reading after. */
  lastWriteAt: number
  idle?: NodeJS.Timeout
  renew?: NodeJS.Timeout
}

/** Per document name, per agent key. */
const present = new Map<string, Map<string, Presence>>()

function stopTimers(presence: Presence): void {
  clearTimeout(presence.idle)
  clearInterval(presence.renew)
}

/**
 * Sets (or, with `null`, removes) a relay-owned awareness state, as
 * `applyAwarenessUpdate` would for a remote client: a higher clock, a fresh
 * timestamp, and the `update` event the document broadcasts to its editors.
 * Receivers take an unknown client's state only from clock 1 on.
 */
function publish(document: Document, clientId: number, state: Record<string, unknown> | null): void {
  const awareness = document.awareness
  const clock = (awareness.meta.get(clientId)?.clock ?? 0) + 1
  const had = awareness.states.has(clientId)
  const changed = JSON.stringify(awareness.states.get(clientId) ?? null) !== JSON.stringify(state)
  awareness.meta.set(clientId, { clock, lastUpdated: Date.now() })
  if (state === null) awareness.states.delete(clientId)
  else awareness.states.set(clientId, state)
  const update = {
    added: !had && state !== null ? [clientId] : [],
    updated: had && state !== null ? [clientId] : [],
    removed: had && state === null ? [clientId] : [],
  }
  if (changed) awareness.emit('change', [update, 'agent-presence'])
  awareness.emit('update', [update, 'agent-presence'])
}

function publishPresence(presence: Presence): void {
  const activity: AgentActivity = Date.now() - presence.lastWriteAt < agentIdleMs() ? 'editing' : 'reading'
  publish(presence.document, presence.clientId, { agent: { name: presence.name, activity } })
}

function remove(documentName: string, key: string): void {
  const agents = present.get(documentName)
  const presence = agents?.get(key)
  if (!agents || !presence) return
  stopTimers(presence)
  agents.delete(key)
  if (agents.size === 0) present.delete(documentName)
  publish(presence.document, presence.clientId, null)
}

/** A client id no state on the document uses, the way Yjs picks its own: a random uint32. */
function freeClientId(document: Document): number {
  for (;;) {
    const id = randomInt(1, 2 ** 32)
    if (!document.awareness.meta.has(id) && id !== document.clientID) return id
  }
}

/**
 * Records that `agent` read or wrote the note at `vaultId/path`. A no-op
 * unless the relay runs and has that note's document loaded.
 */
export function showAgentPresence(vaultId: string, path: string, agent: AgentIdentity, activity: AgentActivity): void {
  const documentName = `${vaultId}/${path}`
  const document = getCollab()?.documents.get(documentName)
  if (!document) return
  let agents = present.get(documentName)
  if (!agents) present.set(documentName, (agents = new Map()))
  let presence = agents.get(agent.key)
  // A document unloaded and loaded again is a new one: start over on it.
  if (presence && presence.document !== document) {
    stopTimers(presence)
    presence = undefined
  }
  if (!presence) {
    const created: Presence = { document, clientId: freeClientId(document), name: agent.name, lastWriteAt: -Infinity }
    created.renew = setInterval(() => publishPresence(created), RENEW_MS).unref()
    agents.set(agent.key, (presence = created))
  }
  clearTimeout(presence.idle)
  presence.idle = setTimeout(() => remove(documentName, agent.key), agentIdleMs()).unref()
  presence.name = agent.name
  if (activity === 'editing') presence.lastWriteAt = Date.now()
  publishPresence(presence)
}

/**
 * For the relay's `beforeHandleAwareness`: a client speaks only for itself.
 * Its states lose any `agent` claim, and a state aimed at an agent's client id
 * (to replace or remove it) is dropped.
 */
export function stripAgentClaims(documentName: string, states: Map<number, Record<string, unknown>>): void {
  const agents = present.get(documentName)
  const agentIds = new Set([...(agents?.values() ?? [])].map((p) => p.clientId))
  for (const [clientId, state] of states) {
    if (agentIds.has(clientId)) states.delete(clientId)
    else if (Object.hasOwn(state, 'agent')) delete state.agent
  }
}

/** Stops the timers of a document's agents (unloaded) or of all (relay stopped). */
export function forgetAgentPresence(documentName?: string): void {
  for (const name of documentName === undefined ? [...present.keys()] : [documentName]) {
    for (const presence of present.get(name)?.values() ?? []) stopTimers(presence)
    present.delete(name)
  }
}
