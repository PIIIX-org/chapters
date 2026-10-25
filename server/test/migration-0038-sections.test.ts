// #464 review: a repository file's `section` blocks are never embedded. Earlier
// heads of the #464 PR embedded them, and a file they extracted carries the
// current EXTRACTOR_VERSION, so no catch-up would clear those vectors:
// migration 0038 does. Runs its statement on rows shaped like what those heads
// left; symbol and file vectors, and note sections, keep theirs.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db, sql as pg } from '../src/db/client.js'
import { blocks, repositories, repositoryFiles } from '../src/db/schema.js'
import { createActiveUser } from './helpers.js'

const vector = new Array(384).fill(0.1)

describe('migration 0038 clears code section vectors (#464)', () => {
  it('a code section loses its vector and embed_key; a symbol, a file block and a note section keep theirs', async () => {
    const owner = await createActiveUser()
    const [repo] = await db.insert(repositories).values({ name: 'migration-0038', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    const content = '# Guide\n\n## Install\n'
    const [file] = await db
      .insert(repositoryFiles)
      .values({ repositoryId: repo!.id, path: 'docs/guide.md', language: 'markdown', content, contentHash: 'h0038', size: content.length })
      .returning()
    const row = (blockId: string, kind: 'file' | 'section' | 'symbol') => ({
      ownerType: 'code' as const,
      ownerId: file!.id,
      containerId: repo!.id,
      blockId,
      kind,
      innerPath: kind === 'file' ? '' : blockId,
      startLine: 1,
      endLine: 3,
      contentHash: 'c',
      ownerVersion: 'h0038',
      embedKey: `k-${blockId}`,
      embedding: vector,
    })
    await db.insert(blocks).values([row('b_file', 'file'), row('b_section', 'section'), row('b_symbol', 'symbol')])
    // A note's section with the same kind: not a code block, so untouched.
    const noteOwner = '00000000-0000-4000-8000-000000000038'
    await db.insert(blocks).values({ ...row('b_note_section', 'section'), ownerType: 'note', ownerId: noteOwner, containerId: noteOwner })

    await pg.unsafe(await readFile(join(import.meta.dirname, '..', 'drizzle', '0038_unembed_code_sections.sql'), 'utf8'))

    const after = await db
      .select({ blockId: blocks.blockId, embedKey: blocks.embedKey, embedded: sql<boolean>`${blocks.embedding} IS NOT NULL` })
      .from(blocks)
      .where(eq(blocks.containerId, repo!.id))
      .orderBy(blocks.blockId)
    expect(after).toEqual([
      { blockId: 'b_file', embedKey: 'k-b_file', embedded: true },
      { blockId: 'b_section', embedKey: null, embedded: false },
      { blockId: 'b_symbol', embedKey: 'k-b_symbol', embedded: true },
    ])
    const [note] = await db.select({ embedKey: blocks.embedKey }).from(blocks).where(eq(blocks.ownerId, noteOwner))
    expect(note?.embedKey).toBe('k-b_note_section')
    await db.delete(blocks).where(eq(blocks.ownerId, noteOwner))
    await db.delete(repositories).where(eq(repositories.id, repo!.id))
  })
})
