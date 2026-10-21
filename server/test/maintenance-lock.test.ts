import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { createNote, getLiveNote } from '../src/notes/store.js'
import { StoreBusyError, setStoreMigrationPending } from '../src/notes/store-tx.js'
import {
  holdInstanceLock,
  INSTANCE_LOCK_KEY,
  MaintenanceInProgressError,
  writesPaused,
  type InstanceLock,
  type InstanceLockOptions,
} from '../src/notes/maintenance-lock.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'

// ADR-003 §5.1 rev 5, §9: the instance maintenance lock on a reserved
// connection. A server holds the shared form; if that connection drops it
// pauses writes (agent/REST: retry / 503; collab: unacked), re-acquires with
// backoff and resumes, and exits only when an exporter holds the exclusive form.

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []
const held: InstanceLock[] = []
const other = postgres(config.databaseUrl, { max: 1, onnotice: () => {} })

async function waitFor(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Backends holding the instance lock in session form (the reserved connections). */
async function lockHolders(): Promise<number[]> {
  const key = INSTANCE_LOCK_KEY
  const rows = await other<Array<{ pid: number }>>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND classid = ${Number(key >> 32n)}::bigint::oid AND objid = ${Number(key & 0xffff_ffffn)}::bigint::oid`
  return rows.map((r) => r.pid)
}

/** Drops the reserved connection as a network cut or a Postgres restart would. */
async function dropLockConnection(): Promise<void> {
  const pids = await lockHolders()
  expect(pids).toHaveLength(1)
  await other`SELECT pg_terminate_backend(${pids[0]!})`
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
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Maintenance vault' } })).json().id
})

afterEach(async () => {
  await other`SELECT pg_advisory_unlock_all()`
  while (held.length > 0) await held.pop()!.release()
  expect(writesPaused()).toBe(false)
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
  await other.end()
})

async function hold(mode: 'shared' | 'exclusive', options: InstanceLockOptions = {}): Promise<InstanceLock> {
  const lock = await holdInstanceLock(mode, { backoffMs: 100, maxBackoffMs: 400, ...options })
  held.push(lock)
  return lock
}

describe('instance maintenance lock (§5.1, §9)', () => {
  it('holds the shared form on its own connection; the exclusive form is refused while it is held, and the reverse', async () => {
    await hold('shared')
    expect(await lockHolders()).toHaveLength(1)
    await expect(holdInstanceLock('exclusive')).rejects.toBeInstanceOf(MaintenanceInProgressError)
    await held.pop()!.release()
    expect(await lockHolders()).toHaveLength(0)
    await hold('exclusive')
    await expect(holdInstanceLock('shared')).rejects.toBeInstanceOf(MaintenanceInProgressError)
    // The exporter's own store transactions still run.
    await createNote(vaultId, { type: 'docs', name: `exporter-${randomUUID().slice(0, 8)}`, body: 'x' })
  })

  it('a dropped lock connection pauses agent and REST writes, then resumes once the lock is held again', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'paused-rest', body: 'before' })
    await hold('shared', { backoffMs: 600 })
    await dropLockConnection()
    await waitFor(() => writesPaused())
    await expect(createNote(vaultId, { type: 'docs', name: 'paused-agent', body: 'x' })).rejects.toBeInstanceOf(StoreBusyError)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/${note.path}`,
      headers: { cookie },
      body: { body: 'during pause' },
    })
    expect(res.statusCode).toBe(503)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('before')
    await waitFor(() => !writesPaused())
    expect(await lockHolders()).toHaveLength(1)
    await createNote(vaultId, { type: 'docs', name: 'paused-agent', body: 'after' })
  })

  it('keeps collab updates unacked while paused; the editor resends them after the resume', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'paused-collab', body: 'base' })
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: `${vaultId}/${note.path}`,
      token,
      document: new Y.Doc(),
    })
    providers.push(provider)
    const text = provider.document.getText('body')
    await waitFor(() => provider.isSynced && text.length > 0)
    await hold('shared', { backoffMs: 1500 })
    await dropLockConnection()
    await waitFor(() => writesPaused())
    text.insert(text.length, ' typed')
    // A real socket round trip: an ack never comes, so there is no event to await; give the relay time to (not) take it.
    await new Promise((r) => setTimeout(r, 400))
    expect(writesPaused()).toBe(true)
    expect(provider.hasUnsyncedChanges).toBe(true)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('base')
    await waitFor(() => !writesPaused())
    await waitFor(async () => (await getLiveNote(vaultId, note.path))?.body === 'base typed', 15_000)
    await waitFor(() => !provider.hasUnsyncedChanges)
  }, 30_000)

  it('while paused, a note the migration has not processed is refused at authentication (permission-denied), never with the pause close', async () => {
    const migrated = await createNote(vaultId, { type: 'docs', name: 'paused-migrated', body: 'migrated' })
    const unmigrated = await createNote(vaultId, { type: 'docs', name: 'paused-unmigrated', body: 'unmigrated' })
    await db.execute(sql`DELETE FROM note_projections WHERE note_id = ${unmigrated.id} AND projection = 'backfill'`)
    await hold('shared', { backoffMs: 1500 })
    await dropLockConnection()
    await waitFor(() => writesPaused())
    setStoreMigrationPending(true)
    try {
      const closes: Record<'migrated' | 'unmigrated', string[]> = { migrated: [], unmigrated: [] }
      let refused = ''
      const open = (path: string, key: 'migrated' | 'unmigrated') => {
        const provider = new HocuspocusProvider({
          url: `ws://127.0.0.1:${port}/collab`,
          name: `${vaultId}/${path}`,
          token,
          document: new Y.Doc(),
          onClose: ({ event }) => void closes[key].push(event.reason),
          onAuthenticationFailed: ({ reason }) => {
            if (key === 'unmigrated') refused = reason
          },
        })
        providers.push(provider)
        return provider
      }
      const blocked = open(unmigrated.path, 'unmigrated')
      const editor = open(migrated.path, 'migrated')
      await waitFor(() => refused !== '' && editor.isSynced)
      expect(refused).toBe('permission-denied')
      expect(blocked.isSynced).toBe(false)
      expect(closes.unmigrated).not.toContain('store-paused')
      // The migrated note authenticates and syncs (reads are not paused); its first update gets the pause close.
      editor.document.getText('body').insert(0, 'typed ')
      await waitFor(() => closes.migrated.includes('store-paused'))
      blocked.destroy()
    } finally {
      setStoreMigrationPending(false)
    }
    await waitFor(() => !writesPaused())
    await waitFor(async () => (await getLiveNote(vaultId, migrated.path))?.body === 'typed migrated', 15_000)
  }, 30_000)

  it('exits (stays paused) only when an exporter holds the exclusive form', async () => {
    let exited = 0
    await hold('shared', { backoffMs: 500, onExclusiveHeld: () => exited++ })
    await dropLockConnection()
    await waitFor(() => writesPaused())
    // The exporter starts in the gap, before the re-acquire.
    const [taken] = await other<Array<{ ok: boolean }>>`SELECT pg_try_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint) AS ok`
    expect(taken!.ok).toBe(true)
    await waitFor(() => exited === 1)
    expect(writesPaused()).toBe(true)
    await expect(createNote(vaultId, { type: 'docs', name: 'never', body: 'x' })).rejects.toBeInstanceOf(StoreBusyError)
  })

  it('refuses a store transaction while another process holds the exclusive form', async () => {
    await other`SELECT pg_advisory_lock(${INSTANCE_LOCK_KEY.toString()}::bigint)`
    await expect(createNote(vaultId, { type: 'docs', name: 'refused', body: 'x' })).rejects.toBeInstanceOf(StoreBusyError)
  })
})
