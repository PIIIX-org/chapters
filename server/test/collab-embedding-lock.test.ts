import { expect, it, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { db } from '../src/db/client.js'
import { notes, noteUpdates, vaults } from '../src/db/schema.js'
import { appendCollabUpdate, loadCollabState, type LoggedUpdate } from '../src/notes/store.js'
import * as blockRows from '../src/search/block-rows.js'
import { flushEmbeddings, scheduleEmbedding } from '../src/search/embedding-queue.js'
import { createActiveUser, noteVectors } from './helpers.js'

// #1126: an embed_note job holds the parent row while replacing its blocks.
// Its lock must exclude edits/deletes, but not note_updates' FK KEY SHARE.
it('commits collab typing before an embedding releases the note row', async () => {
  const owner = await createActiveUser()
  const [vault] = await db.insert(vaults).values({ name: 'embedding append lock', ownerId: owner.id }).returning()
  const [note] = await db.insert(notes).values({
    vaultId: vault!.id, type: 'docs', name: 'typed', path: 'docs/typed', frontmatter: { type: 'docs' }, body: 'Start.\n',
  }).returning()
  const doc = new Y.Doc()
  // The project's ES2023 type library does not include Promise.withResolvers.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let entered!: () => void
  const replacing = new Promise<void>((resolve) => (entered = resolve))
  const replace = blockRows.replaceBlockSet
  const spy = vi.spyOn(blockRows, 'replaceBlockSet').mockImplementation(async (...args) => {
    if (args[1] === 'note' && args[2] === note!.id) {
      entered()
      await held
    }
    return replace(...args)
  })
  let embedding: Promise<void> | undefined
  let append: Promise<LoggedUpdate | null> | undefined
  try {
    const loaded = await loadCollabState(vault!.id, note!.id)
    Y.applyUpdate(doc, loaded.state)
    const before = Y.encodeStateVector(doc)
    doc.getText('body').insert(0, '@DURING-EMBED@ ')
    const update = Y.encodeStateAsUpdate(doc, before)
    scheduleEmbedding(note!.id)
    embedding = flushEmbeddings()
    await replacing

    // Await the real append or detect its DB lock dependency, not a guessed
    // elapsed time. The embedding cannot commit until release() below.
    let settled = false
    append = appendCollabUpdate(vault!.id, note!.id, update, { type: 'collab', id: owner.id })
      .finally(() => { settled = true })
    while (!settled) {
      const blocked = await db.execute(sql`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO note_updates%'
          AND cardinality(pg_blocking_pids(pid)) > 0`)
      expect(blocked, 'a collab append must not wait for the embedding row lock').toHaveLength(0)
    }
    const logged = await append
    expect(logged).not.toBeNull()
    const [stored] = await db.select().from(noteUpdates).where(eq(noteUpdates.id, logged!.id))
    expect(Buffer.from(stored!.update)).toEqual(Buffer.from(update))

    // Both ordinary content updates and key-changing writes/deletes still
    // conflict with the embedding's lock; NOWAIT makes this deterministic.
    for (const mode of ['NO KEY UPDATE', 'UPDATE']) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM notes WHERE id = ${note!.id} FOR ${sql.raw(mode)} NOWAIT`)
      })).rejects.toMatchObject({ cause: { code: '55P03' } })
    }
    release()
    await embedding
    // The paused worker ran the real block replacement, not a fake result.
    expect(await noteVectors(note!.id)).toHaveLength(1)
  } finally {
    release()
    await embedding
    await append
    spy.mockRestore()
    doc.destroy()
    await db.delete(vaults).where(eq(vaults.id, vault!.id))
  }
})
