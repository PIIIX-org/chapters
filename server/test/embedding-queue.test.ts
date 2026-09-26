import { describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes, vaults } from '../src/db/schema.js'
import { embedder } from '../src/search/embeddings.js'
import {
  flushEmbeddings,
  scheduleEmbedding,
  scheduleMissingEmbeddings,
} from '../src/search/embedding-queue.js'
import { createActiveUser } from './helpers.js'

async function makeVaultAndNote(body = 'Testing embeddings') {
  const user = await createActiveUser()
  const [vault] = await db
    .insert(vaults)
    .values({ name: 'embed-test-vault', ownerId: user.id })
    .returning()
  const [note] = await db
    .insert(notes)
    .values({
      vaultId: vault!.id,
      type: 'note',
      name: 'Test Note',
      path: `note-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
      body,
      frontmatter: {},
    })
    .returning()
  return { vault: vault!, note: note! }
}

describe('embedding queue reliability', () => {
  it('embeds a note and writes embedding to db', async () => {
    const { note } = await makeVaultAndNote('Hello world note content')
    scheduleEmbedding(note.id)
    await flushEmbeddings()

    const updated = (await db.select().from(notes).where(eq(notes.id, note.id)))[0]
    expect(updated?.embedding).not.toBeNull()
  })

  it('retries up to 3 times on embedding error before marking permanently failed', async () => {
    const { note } = await makeVaultAndNote('Transient error note content')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let callCount = 0
    const embedSpy = vi.spyOn(embedder, 'embed').mockImplementation(async () => {
      callCount += 1
      throw new Error(`Synthetic ONNX failure ${callCount}`)
    })

    try {
      scheduleEmbedding(note.id)
      await flushEmbeddings()

      expect(callCount).toBe(3)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[embedding-queue] embedding failed for note'),
        expect.any(Error),
      )
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[embedding-queue] embedding permanently failed for note'),
        expect.any(Error),
      )
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      embedSpy.mockRestore()
    }
  })

  it('scheduleMissingEmbeddings enqueues all notes with null embeddings', async () => {
    const { note } = await makeVaultAndNote('Unembedded note')
    expect(note.embedding).toBeNull()

    const embedSpy = vi.spyOn(embedder, 'embed').mockResolvedValue([new Array(384).fill(0.1)])

    try {
      const count = await scheduleMissingEmbeddings(5)
      expect(count).toBeGreaterThanOrEqual(1)
      expect(count).toBeLessThanOrEqual(5)

      await flushEmbeddings()
    } finally {
      embedSpy.mockRestore()
    }
  })
})

