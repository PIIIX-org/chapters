import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { sql } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { db } from '../src/db/client.js'
import { getLiveNote, purgeNote, renameNote, softDeleteNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { writeThroughCollab } from '../src/sync/crdt-write.js'
import { createActiveUser, loginCookie, loginToken } from './helpers.js'
// Imported per test (not at the top), so the rest of this file also runs against code from before S2b (fails-before).
const backfill = () => import('../src/sync/collab-backfill.js')
const dryRun = () => import('../src/notes/migrate-store.js')

// ADR-003 S2b: collab documents are named by note id (`<vault>/~<noteId>`)
// and their Yjs state lives in note_crdt + note_updates, written in the same
// transaction as the row. A load never rebuilds the text from a stale copy
// (#488), a store cut short by a crash cannot leave a stale copy behind
// (#832), a rename never splits a note into two documents (#834), and an
// editor from before S2b (path names) is refused with `reload-required`.

let app: FastifyInstance
let collab: CollabRelay
let port: number
let token: string
let cookie: string
let vaultId: string
const providers: HocuspocusProvider[] = []

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const count = (s: string | undefined, needle: string) => (s ?? '').split(needle).length - 1

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'S2b relay vault' } })).json().id
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await collab.destroy()
  await app.close()
})

async function create(name: string, body: string): Promise<{ id: string; path: string }> {
  const res = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/notes`, headers: { cookie }, body: { type: 'docs', name, body } })
  expect(res.statusCode).toBe(200)
  return { id: res.json().id, path: `docs/${name}` }
}

function connect(name: string, document = new Y.Doc(), onRefused?: (reason: string) => void): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name,
    token,
    document,
    onAuthenticationFailed: ({ reason }) => onRefused?.(reason),
  })
  providers.push(provider)
  return provider
}

async function open(noteId: string, document?: Y.Doc) {
  const provider = connect(`${vaultId}/~${noteId}`, document)
  const text = provider.document.getText('body')
  let syncs = 0
  provider.on('synced', ({ state }: { state: boolean }) => {
    if (state) syncs++
  })
  await waitFor(() => provider.isSynced && text.length > 0)
  const synced = syncs
  return {
    provider,
    text,
    /** Resolves once the provider synced again after the relay restarted. */
    resynced: () => waitFor(() => syncs > synced && provider.isSynced, 15_000),
  }
}

const rowBody = async (path: string) => (await getLiveNote(vaultId, path))?.body

describe('document names (§5.4)', () => {
  it('refuses a path-named connection from an older bundle with reason reload-required, and stores nothing from it', async () => {
    const note = await create('legacy-name', 'Kept as it is.\n')
    const reasons: string[] = []
    const document = new Y.Doc()
    document.getText('body').insert(0, 'typed in an old tab ')
    const old = connect(`${vaultId}/${note.path}`, document, (reason) => reasons.push(reason))
    // Before S2b the relay served path names: it synced and stored the old tab's text.
    await waitFor(() => reasons.length > 0 || old.isSynced)
    expect(reasons).toEqual(['reload-required'])
    expect(await rowBody(note.path)).toBe('Kept as it is.\n')
  })

  it('loads the note by id and returns the note id on REST GET', async () => {
    const note = await create('by-id', 'Loaded by id.\n')
    const got = (await app.inject({ method: 'GET', url: `/api/vaults/${vaultId}/notes/${note.path}`, headers: { cookie } })).json()
    expect(got.id).toBe(note.id)
    const { text } = await open(note.id)
    expect(text.toString()).toBe('Loaded by id.\n')
  })
})

describe('delete, purge and restore close and reopen the note (§5.5)', () => {
  function tab(noteId: string) {
    const closes: string[] = []
    const refusals: string[] = []
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: `${vaultId}/~${noteId}`,
      token,
      document: new Y.Doc(),
      onAuthenticationFailed: ({ reason }) => refusals.push(reason),
      onClose: ({ event }) => closes.push(event.reason),
    })
    providers.push(provider)
    return { provider, closes, refusals, text: provider.document.getText('body') }
  }

  it('closes open editors at once with note-deleted, refuses reconnects until a restore, then lets editors in', async () => {
    const note = await create('deleted-open', 'Still here.\n')
    const open1 = tab(note.id)
    await waitFor(() => open1.provider.isSynced && open1.text.length > 0)
    const deleted = await app.inject({ method: 'DELETE', url: `/api/vaults/${vaultId}/notes/${note.path}`, headers: { cookie } })
    expect(deleted.statusCode).toBeLessThan(300)
    await waitFor(() => open1.closes.includes('note-deleted'), 3000)
    open1.provider.destroy()

    const refused = tab(note.id)
    await waitFor(() => refused.refusals.length > 0)
    expect(refused.refusals).toEqual(['note-deleted'])
    refused.provider.destroy()

    const restored = await app.inject({ method: 'POST', url: `/api/vaults/${vaultId}/trash/${note.id}/restore`, headers: { cookie } })
    expect(restored.statusCode).toBeLessThan(300)
    const again = tab(note.id)
    await waitFor(() => again.provider.isSynced && again.text.length > 0)
    expect(again.text.toString()).toBe('Still here.\n')
    expect(again.refusals).toEqual([])
  }, 20_000)

  it('purge refuses the note with note-deleted', async () => {
    const note = await create('purged-open', 'Going.\n')
    await softDeleteNote(vaultId, note.path)
    expect(await purgeNote(vaultId, note.id)).toBe(true)
    const late = tab(note.id)
    await waitFor(() => late.refusals.length > 0)
    expect(late.refusals).toEqual(['note-deleted'])
  })
})

describe('a crash around the relay store (#832)', () => {
  it('a client that stays connected through a restart does not double its typing (store committed)', async () => {
    const note = await create('stays-after', 'live note\n')
    const { text, resynced } = await open(note.id)
    const marker = '@CW-STAY-after@'
    text.insert(text.length, `\n${marker}`)
    await waitFor(async () => count(await rowBody(note.path), marker) === 1)
    // The relay goes away (its store has committed) and comes back; the client reconnects with its own items.
    await collab.destroy()
    collab = startCollabServer(app.server)
    await resynced()
    expect(count(text.toString(), marker)).toBe(1)
    expect(count(text.toString(), 'live note')).toBe(1)
    expect(count(await rowBody(note.path), marker)).toBe(1)
  }, 30_000)

  it('a client that stays connected through a kill before the store committed does not double its typing', async () => {
    const note = await create('stays-before', 'live note\n')
    const { text, resynced } = await open(note.id)
    // What the database holds before the store: a SIGKILL before COMMIT leaves exactly this.
    const [before] = (await db.execute(sql`
      SELECT n.body, n.frontmatter, n.seq, c.snapshot, c.snapshot_through, c.folded_through, c.folded_seq,
        (SELECT coalesce(max(id), 0) FROM note_updates) AS last_update
      FROM notes n JOIN note_crdt c ON c.note_id = n.id WHERE n.id = ${note.id}`)) as unknown as Array<Record<string, unknown>>
    const marker = '@CW-STAY-before@'
    text.insert(text.length, `\n${marker}`)
    await waitFor(async () => count(await rowBody(note.path), marker) === 1)
    await collab.destroy()
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.execute(sql`UPDATE notes SET body = ${before!.body}, frontmatter = ${JSON.stringify(before!.frontmatter)}::jsonb, seq = ${before!.seq} WHERE id = ${note.id}`)
      await tx.execute(sql`DELETE FROM note_revisions WHERE note_id = ${note.id} AND seq > ${before!.seq}`)
      await tx.execute(sql`DELETE FROM note_updates WHERE note_id = ${note.id} AND id > ${before!.last_update}`)
      await tx.execute(sql`
        UPDATE note_crdt SET snapshot = ${before!.snapshot}, snapshot_through = ${before!.snapshot_through},
          folded_through = ${before!.folded_through}, folded_seq = ${before!.folded_seq}
        WHERE note_id = ${note.id}`)
    })
    expect(count(await rowBody(note.path), marker)).toBe(0)
    collab = startCollabServer(app.server)
    await resynced()
    // The relay stores what the client sent again, once.
    await waitFor(async () => count(await rowBody(note.path), marker) === 1, 15_000)
    expect(count(text.toString(), marker)).toBe(1)
    expect(count(text.toString(), 'live note')).toBe(1)
  }, 40_000)
})

describe('a renamed note open in two editors (#834, §5.5)', () => {
  it('keeps both tabs connected to one document: their typing and an agent write, each once', async () => {
    const note = await create('renamed-typing', 'Shared text.\n')
    const before = await open(note.id)
    await renameNote(vaultId, note.path, 'renamed-typing-to')
    // A second tab opened at the new path joins the same document (named by id): no second history to diverge.
    const after = await open(note.id)
    expect(after.text.toString()).toBe(before.text.toString())
    // Typed in the first tab after the rename, not stored yet (the store is debounced).
    before.text.insert(0, 'Old tab. ')
    await waitFor(() => !before.provider.hasUnsyncedChanges)
    await writeThroughCollab(vaultId, 'docs/renamed-typing-to', { body: (current) => `${current}Agent line.\n` }, { type: 'user' })
    for (const tab of [before, after]) {
      await waitFor(() => tab.text.toString().includes('Agent line.') && tab.text.toString().includes('Old tab. '))
      expect(tab.text.toString()).toBe('Old tab. Shared text.\nAgent line.\n')
    }
    await waitFor(async () => (await rowBody('docs/renamed-typing-to')) === 'Old tab. Shared text.\nAgent line.\n')
  }, 20_000)
})

describe('rebase of a row changed behind the store (§5.4)', () => {
  it('keeps both sides where they do not overlap and never rebuilds the text', async () => {
    const note = await create('behind', 'one\ntwo\nthree\n')
    const { text, resynced } = await open(note.id)
    text.insert(text.length, 'typed\n')
    await waitFor(async () => (await rowBody(note.path))?.endsWith('typed\n') === true)
    await collab.destroy()
    // Old code or manual SQL changes the first line; the trigger bumps seq past note_crdt.folded_seq.
    await db.execute(sql`UPDATE notes SET body = ${'ONE\ntwo\nthree\ntyped\n'} WHERE id = ${note.id}`)
    collab = startCollabServer(app.server)
    await resynced()
    await waitFor(() => text.toString() === 'ONE\ntwo\nthree\ntyped\n')
    expect(await rowBody(note.path)).toBe('ONE\ntwo\nthree\ntyped\n')
    const [outOfBand] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM note_revisions WHERE note_id = ${note.id} AND action = 'migration:backfill'`)) as unknown as Array<{ n: number }>
    expect(outOfBand!.n).toBe(1)
  }, 30_000)
})

describe('the S2b backfill (§8 step 4, #488)', () => {
  it('attaches a stale bin whose text is an older revision, so a tab holding its items merges once', async () => {
    const note = await create('stale-bin', 'Old body.\n')
    // The pre-S2b relay's bin, and a tab holding the same items.
    const tab = new Y.Doc()
    tab.getText('body').insert(0, 'Old body.\n')
    tab.getMap('frontmatter').set('type', 'docs')
    const bin = join(config.dataDir, 'vaults', vaultId, '.crdt', `${note.path}.bin`)
    await mkdir(dirname(bin), { recursive: true })
    await writeFile(bin, Y.encodeStateAsUpdate(tab))
    // An agent edit the bin never saw: bin text != row text, the S18 case.
    await writeThroughCollab(vaultId, note.path, { body: 'New body.\n' }, { type: 'user' })
    const report = await (await backfill()).runCollabBackfill()
    expect(report.failed).toEqual([])
    expect(report.setAside.map((s) => s.noteId)).not.toContain(note.id)
    const marker = '@S18@'
    tab.getText('body').insert(tab.getText('body').length, marker)
    const { text } = await open(note.id, tab)
    await waitFor(() => text.toString().includes('New body.'))
    expect(text.toString()).toBe(`New body.\n${marker}`)
    await waitFor(async () => (await rowBody(note.path)) === `New body.\n${marker}`)
  }, 20_000)

  it('sets aside a bin that matches neither the row, the file nor any revision; the note is seeded instead', async () => {
    const note = await create('foreign-bin', 'Successor text.\n')
    const predecessor = new Y.Doc()
    predecessor.getText('body').insert(0, 'A trashed predecessor at the same path.\n')
    const bin = join(config.dataDir, 'vaults', vaultId, '.crdt', `${note.path}.bin`)
    await mkdir(dirname(bin), { recursive: true })
    await writeFile(bin, Y.encodeStateAsUpdate(predecessor))
    const report = await (await backfill()).runCollabBackfill()
    const aside = report.setAside.find((s) => s.noteId === note.id)
    expect(aside).toBeDefined()
    expect((await stat(aside!.movedTo)).isFile()).toBe(true)
    expect(await readFile(aside!.movedTo)).toEqual(Buffer.from(Y.encodeStateAsUpdate(predecessor)))
    const { text } = await open(note.id)
    expect(text.toString()).toBe('Successor text.\n')
  }, 20_000)

  it('migrate-store --dry-run predicts what the backfill does with each bin', async () => {
    const writeBin = async (path: string, text: string) => {
      const doc = new Y.Doc()
      doc.getText('body').insert(0, text)
      doc.getMap('frontmatter').set('type', 'docs')
      const bin = join(config.dataDir, 'vaults', vaultId, '.crdt', `${path}.bin`)
      await mkdir(dirname(bin), { recursive: true })
      await writeFile(bin, Y.encodeStateAsUpdate(doc))
    }
    const row = await create('plan-row', 'Row text.\n')
    await writeBin(row.path, 'Row text.\n')
    const revision = await create('plan-revision', 'First text.\n')
    await writeBin(revision.path, 'First text.\n')
    await writeThroughCollab(vaultId, revision.path, { body: 'Second text.\n' }, { type: 'user' })
    const foreign = await create('plan-foreign', 'Mine.\n')
    await writeBin(foreign.path, 'Somebody else.\n')
    const none = await create('plan-none', 'No bin.\n')
    const opened = await create('plan-opened', 'Opened.\n')
    ;(await open(opened.id)).provider.destroy()
    const notes = [row, revision, foreign, none, opened]
    const plan = await (await dryRun()).planStoreMigration({ vaultId })
    expect(notes.map((n) => plan.notes.find((p) => p.noteId === n.id)?.collab)).toEqual(['attach', 'attach', 'set-aside', 'seed', 'has-state'])
    const report = await (await backfill()).runCollabBackfill()
    expect(report.failed).toEqual([])
    const aside = new Set(report.setAside.map((s) => s.noteId))
    const states = (await db.execute(sql`
      SELECT note_id FROM note_crdt WHERE note_id IN (${row.id}, ${revision.id}, ${foreign.id}, ${none.id}, ${opened.id})`)) as unknown as Array<{ note_id: string }>
    const hasState = new Set(states.map((s) => s.note_id))
    // attach and has-state both leave the note with CRDT state; set-aside and seed leave none until first open.
    expect(notes.map((n) => (aside.has(n.id) ? 'set-aside' : hasState.has(n.id) ? 'state' : 'seed'))).toEqual([
      'state',
      'state',
      'set-aside',
      'seed',
      'state',
    ])
  }, 20_000)
})
