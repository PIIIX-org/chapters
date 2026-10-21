import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { createNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 §11, S3 performance acceptance (perf rule 4, docs/agents/implementation.md):
// save-to-visible p95 < 250 ms while the relay folds a 1 MiB note with 3
// typists. Every keystroke is committed to note_updates before the relay
// applies and acks it, and a keystroke that arrives while a fold of the 1 MiB
// note holds the note's lock waits for it. With the relay's real debounce the
// three typists keep typing past the 10 s max debounce, so a fold runs among
// their keystrokes. A keystroke's save-to-visible time is the later of its
// ack (the typist's editor shows it saved) and the moment both other typists
// see it.

// The relay's production debounce (2 s, 10 s max; the suite default is 150 ms).
vi.hoisted(() => {
  process.env.COLLAB_DEBOUNCE_MS = '2000'
})

const BUDGET_MS = 250
// About 13 s of typing: past the 10 s max debounce, so folds run while the three type.
const KEYSTROKES_PER_TYPIST = 110
const KEYSTROKE_GAP_MS = 120

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S3 perf vault' } })).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

/** About 1 MiB of distinct lines (a repeated block would be quarantined, #492). */
function bigBody(): string {
  const lines: string[] = []
  let size = 0
  for (let i = 0; size < 1_000_000; i++) {
    const line = `Paragraph ${i}: notes on item ${(i * 7919) % 100_003} with detail ${(i * 104_729) % 1_000_003}.\n`
    lines.push(line)
    size += line.length
  }
  return lines.join('')
}

describe('S3 performance acceptance (§11)', () => {
  it(`save-to-visible p95 < ${BUDGET_MS} ms while folding a 1 MiB note with 3 typists`, async () => {
    const note = await createNote(vaultId, { path: 'docs/big-typed', body: bigBody() })
    const sent = new Map<string, { at: number; typist: number; acked?: number; seen: Map<number, number> }>()
    const typists = [0, 1, 2].map((typist) => {
      const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vaultId}/~${note.id}`, token, document: new Y.Doc() })
      providers.push(provider)
      const text = provider.document.getText('body')
      text.observe((event) => {
        if (event.transaction.local) return
        for (const op of event.delta) {
          if (typeof op.insert !== 'string') continue
          const key = /\[k\d+-\d+\]/.exec(op.insert)?.[0]
          const entry = key ? sent.get(key) : undefined
          if (entry && !entry.seen.has(typist)) entry.seen.set(typist, performance.now())
        }
      })
      provider.on('unsyncedChanges', ({ number }: { number: number }) => {
        if (number !== 0) return
        const now = performance.now()
        for (const entry of sent.values()) if (entry.typist === typist && entry.acked === undefined) entry.acked = now
      })
      return { provider, text }
    })
    await waitFor(() => typists.every(({ provider, text }) => provider.isSynced && text.length > 0))

    const foldsBefore = await revisionCount(note.id)
    // Each typist types at its own place (start, middle, end), staggered so the three interleave.
    await Promise.all(
      typists.map(async ({ text }, typist) => {
        await new Promise((r) => setTimeout(r, typist * (KEYSTROKE_GAP_MS / 3)))
        for (let n = 0; n < KEYSTROKES_PER_TYPIST; n++) {
          const key = `[k${typist}-${n}]`
          const at = typist === 0 ? 0 : typist === 1 ? Math.floor(text.length / 2) : text.length
          sent.set(key, { at: performance.now(), typist, seen: new Map() })
          text.insert(at, key)
          await new Promise((r) => setTimeout(r, KEYSTROKE_GAP_MS))
        }
      }),
    )
    await waitFor(() => [...sent.values()].every((e) => e.acked !== undefined && e.seen.size === 2))

    const latencies = [...sent.values()].map((e) => Math.max(e.acked!, ...e.seen.values()) - e.at).sort((a, b) => a - b)
    const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * q) - 1)]!
    const folds = (await revisionCount(note.id)) - foldsBefore
    console.log(
      `[S3 perf] ${latencies.length} keystrokes, ${folds} folds of the 1 MiB note: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${p(1).toFixed(1)} ms`,
    )
    // The relay folded the big note while the typists typed.
    expect(folds).toBeGreaterThan(0)
    expect(p(0.95)).toBeLessThan(BUDGET_MS)
  }, 120_000)
})

async function revisionCount(noteId: string): Promise<number> {
  const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM note_revisions WHERE note_id = ${noteId}`)) as unknown as Array<{ n: number }>
  return row!.n
}
