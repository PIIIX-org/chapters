import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
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
import { collabDocName } from '../src/sync/live-docs.js'
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

/**
 * Backends holding the instance lock in session form (the reserved
 * connections), in this database only: advisory locks are per database, and
 * other worktrees' test databases on the same server use the same key.
 */
async function lockHolders(): Promise<number[]> {
  const key = INSTANCE_LOCK_KEY
  const rows = await other<Array<{ pid: number }>>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
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
  it('re-acquires in one loop while Postgres is unreachable: bounded attempts, one connection after the resume, none after release', async () => {
    // A TCP proxy in front of Postgres that can be cut, as a network outage or a Postgres restart would
    // (pg_terminate_backend leaves Postgres reachable, so the first re-acquire always works).
    const target = new URL(config.databaseUrl)
    const live = new Set<Socket>()
    let down = false
    let attempts = 0
    const accepted = new Set<Socket>()
    const proxy: Server = createServer((client) => {
      attempts++
      accepted.add(client)
      client.on('close', () => accepted.delete(client))
      if (down) {
        // Accept, then close cleanly (FIN), as a proxy or load balancer with its upstream down does. postgres.js
        // reconnects at once when the first query's socket closes cleanly, so this is the case a backoff must hold.
        client.end()
        return
      }
      const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) })
      live.add(client)
      client.on('close', () => {
        live.delete(client)
        upstream.destroy()
      })
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    const proxied = new URL(config.databaseUrl)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(typeof address === 'object' && address ? address.port : 0)
    try {
      const lock = await hold('shared', { databaseUrl: proxied.toString(), backoffMs: 50, maxBackoffMs: 400, heartbeatMs: 200 })
      expect(live.size).toBe(1)
      down = true
      for (const socket of live) socket.destroy()
      await waitFor(() => writesPaused())
      const before = attempts
      // The outage itself is real time: the backoff runs on the real clock against a real socket.
      await new Promise((r) => setTimeout(r, 1500))
      const during = attempts - before
      down = false
      await waitFor(() => !writesPaused())
      // One loop at 50 ms doubling to 400 ms makes about 6 attempts in 1.5 s, one connection each; a loop per
      // failed attempt, or postgres.js's immediate reconnect, makes hundreds (372 and 1172 before the fixes).
      expect(during).toBeGreaterThanOrEqual(2)
      expect(during).toBeLessThanOrEqual(10)
      await new Promise((r) => setTimeout(r, 500))
      expect(live.size).toBe(1)
      // The cut connection's backend ends once Postgres sees its socket close.
      await waitFor(async () => (await lockHolders()).length === 1)
      held.splice(held.indexOf(lock), 1)
      await lock.release()
      await waitFor(() => live.size === 0)
      await waitFor(async () => (await lockHolders()).length === 0)
    } finally {
      for (const socket of accepted) socket.destroy()
      await new Promise((resolve) => proxy.close(resolve))
    }
  })

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
    const paused = await createNote(vaultId, { type: 'docs', name: 'paused-agent', body: 'x' }).catch((err: unknown) => err)
    expect(paused).toBeInstanceOf(StoreBusyError)
    // Safe to show in production (app.ts hides other 5xx messages): it names no path or content.
    expect((paused as StoreBusyError).expose).toBe(true)
    expect((paused as StoreBusyError).message).toMatch(/maintenance lock connection lost/)
    const res = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/${note.path}`,
      headers: { cookie },
      body: { body: 'during pause' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().message).toMatch(/maintenance lock connection lost/)
    expect((await getLiveNote(vaultId, note.path))?.body).toBe('before')
    await waitFor(() => !writesPaused())
    expect(await lockHolders()).toHaveLength(1)
    await createNote(vaultId, { type: 'docs', name: 'paused-agent', body: 'after' })
  })

  it('keeps collab updates unacked while paused; the tab survives the unload and reloads, and its edit is saved after the resume', async () => {
    const note = await createNote(vaultId, { type: 'docs', name: 'paused-collab', body: 'base' })
    const docName = collabDocName(vaultId, note.id)
    const refusals: string[] = []
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: docName,
      token,
      document: new Y.Doc(),
      onAuthenticationFailed: ({ reason }) => void refusals.push(reason),
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
    // The store-busy close left the document with no connection: the relay unloads it (no compaction while
    // paused), and every reconnect's load is a store transaction the pause refuses with store-busy too.
    await waitFor(() => !collab.hocuspocus.documents.has(docName))
    await waitFor(() => !writesPaused())
    await waitFor(async () => (await getLiveNote(vaultId, note.path))?.body === 'base typed', 15_000)
    await waitFor(() => !provider.hasUnsyncedChanges)
    // Never a refusal the editor would stop at (revoked): only socket closes it reconnects after.
    expect(refusals.filter((r) => r !== 'store-busy')).toEqual([])
  })

  it('while paused: an unmigrated note is refused at authentication (note-not-migrated), an open editor gets the pause close, a load waits (store-busy)', async () => {
    const migrated = await createNote(vaultId, { type: 'docs', name: 'paused-migrated', body: 'migrated' })
    const unmigrated = await createNote(vaultId, { type: 'docs', name: 'paused-unmigrated', body: 'unmigrated' })
    const unopened = await createNote(vaultId, { type: 'docs', name: 'paused-unopened', body: 'unopened' })
    await db.execute(sql`DELETE FROM note_projections WHERE note_id = ${unmigrated.id} AND projection = 'backfill'`)
    type Key = 'migrated' | 'unmigrated' | 'unopened'
    const closes: Record<Key, string[]> = { migrated: [], unmigrated: [], unopened: [] }
    const refused: Record<Key, string[]> = { migrated: [], unmigrated: [], unopened: [] }
    const open = (noteId: string, key: Key) => {
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/collab`,
        name: collabDocName(vaultId, noteId),
        token,
        document: new Y.Doc(),
        onClose: ({ event }) => void closes[key].push(event.reason),
        onAuthenticationFailed: ({ reason }) => void refused[key].push(reason),
      })
      providers.push(provider)
      return provider
    }
    // Opened before the pause: loading a document is a store transaction (seed, catch-up).
    const editor = open(migrated.id, 'migrated')
    await waitFor(() => editor.isSynced)
    await hold('shared', { backoffMs: 1500 })
    await dropLockConnection()
    await waitFor(() => writesPaused())
    setStoreMigrationPending(true)
    try {
      const blocked = open(unmigrated.id, 'unmigrated')
      const waiting = open(unopened.id, 'unopened')
      await waitFor(() => refused.unmigrated.length > 0 && closes.unopened.includes('store-busy'))
      expect(refused.unmigrated[0]).toBe('note-not-migrated')
      expect(blocked.isSynced).toBe(false)
      expect(closes.unmigrated).not.toContain('store-busy')
      // A load refused for a busy store is a socket close the editor reconnects after, never a refusal it stops at.
      expect(refused.unopened).toEqual([])
      editor.document.getText('body').insert(0, 'typed ')
      await waitFor(() => closes.migrated.includes('store-busy'))
      blocked.destroy()
      await waitFor(() => !writesPaused())
      await waitFor(() => waiting.isSynced, 15_000)
      expect(refused.unopened).toEqual([])
    } finally {
      setStoreMigrationPending(false)
    }
    await waitFor(async () => (await getLiveNote(vaultId, migrated.path))?.body === 'typed migrated', 15_000)
  }, 45_000)

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
