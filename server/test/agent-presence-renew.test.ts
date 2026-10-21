import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Document } from '@hocuspocus/server'
import { forgetAgentPresence, showAgentPresence } from '../src/sync/agent-presence.js'

// #481: y-protocols drops a remote awareness state nobody renewed for 30 s,
// on the relay and in every editor. An agent stays for the 60 s idle timeout,
// so the relay has to renew its state before then, and then remove it.
// Driven on a bare relay document with fake timers. (The awareness's own
// expiry check reads lib0's clock, which fake timers do not move, so the test
// asserts the age it checks instead.)

const documents = new Map<string, Document>()
vi.mock('../src/sync/collab-server.js', () => ({ getCollab: () => ({ documents }) }))

const NAME = 'vault-1/~note-1'
const AGENT = { key: 'connection-1', name: 'Claude Code' }
let document: Document

beforeEach(() => {
  delete process.env.COLLAB_AGENT_IDLE_MS // the documented default, 60 s
  vi.useFakeTimers()
  document = new Document(NAME)
  documents.set(NAME, document)
})

afterEach(() => {
  forgetAgentPresence()
  document.destroy()
  documents.clear()
  vi.useRealTimers()
})

const agentIds = () => [...document.awareness.getStates()].filter(([, state]) => state.agent !== undefined).map(([id]) => id)
const agents = () => agentIds().map((id) => document.awareness.getStates().get(id))

/** Expect the agent's state to be younger than y-protocols' 30 s expiry at every 5 s step over `ms`. */
function renewedThrough(ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
    vi.advanceTimersByTime(5_000)
    const [id] = agentIds()
    expect(id).toBeDefined()
    expect(Date.now() - document.awareness.meta.get(id!)!.lastUpdated).toBeLessThan(30_000)
  }
}

describe('agent presence timing (#481)', () => {
  it('is renewed within the 30 s awareness expiry while present, and leaves 60 s after the last call', () => {
    showAgentPresence('vault-1', 'note-1', AGENT, 'reading')
    expect(agents()).toEqual([{ agent: { name: 'Claude Code', activity: 'reading' } }])

    renewedThrough(45_000)

    showAgentPresence('vault-1', 'note-1', AGENT, 'editing')
    renewedThrough(55_000)
    expect(agents()).toEqual([{ agent: { name: 'Claude Code', activity: 'editing' } }])

    vi.advanceTimersByTime(6_000)
    expect(agents()).toEqual([])
  })

  it('reads after a write keep it editing until the write is a full idle timeout old', () => {
    showAgentPresence('vault-1', 'note-1', AGENT, 'editing')
    vi.advanceTimersByTime(30_000)
    showAgentPresence('vault-1', 'note-1', AGENT, 'reading')
    expect(agents()).toEqual([{ agent: { name: 'Claude Code', activity: 'editing' } }])
    vi.advanceTimersByTime(31_000)
    showAgentPresence('vault-1', 'note-1', AGENT, 'reading')
    expect(agents()).toEqual([{ agent: { name: 'Claude Code', activity: 'reading' } }])
  })

  it('does nothing for a note the relay has not loaded', () => {
    showAgentPresence('vault-1', 'docs/closed', AGENT, 'editing')
    expect(agents()).toEqual([])
    expect(vi.getTimerCount()).toBe(1) // the awareness's own expiry check, nothing of ours
  })
})
