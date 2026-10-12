import type { DirectConnection } from '@hocuspocus/server'
import { YAMLParseError } from 'yaml'
import { getCollab } from './collab-server.js'
import { getLiveNote, readNote, updateNote, type Actor, type NoteRow } from '../notes/store.js'
import { OkfValidationError } from '../notes/okf.js'

/** A partial write to a note whose file cannot be parsed (#391). 409 over REST. */
export class NoteFileDamagedError extends Error {
  readonly statusCode = 409
  constructor(path: string) {
    super(
      `note file for ${path} is damaged and cannot be read; repair it by writing both frontmatter and body, or by reverting to a recorded revision`,
    )
  }
}

/** True when the note's file exists but does not parse; an I/O failure is rethrown. */
async function noteFileDamaged(vaultId: string, path: string): Promise<boolean> {
  try {
    await readNote(vaultId, path)
    return false
  } catch (err) {
    if (err instanceof OkfValidationError || err instanceof YAMLParseError) return true
    throw err
  }
}

/**
 * Note writes flow through the live CRDT engine when it's running (spec 6:
 * an external/REST/AI edit is a visible participant, never a sudden unexplained
 * change, and in-memory Yjs documents must not clobber external writes). The
 * attributed store write happens immediately here; the relay's debounced store
 * of the same state dedupes in the audit trail.
 */
export async function writeThroughCollab(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: string },
  actor: Actor,
): Promise<NoteRow | null> {
  const collab = getCollab()
  const docName = `${vaultId}/${path}`
  if (collab) {
    const existing = await getLiveNote(vaultId, path)
    if (!existing) return null
    let connection: DirectConnection
    try {
      connection = await collab.openDirectConnection(docName, {
        userId: actor.type === 'user' ? actor.id : 'mcp',
      })
    } catch (err) {
      // Loading the collab document parses the note's file. When the file is
      // damaged (e.g. #384's fence-less index), no document can load, so no
      // live editor holds one: a full replacement (edit with frontmatter and
      // body, or a revert) needs nothing from the old file and is written
      // straight to the store, which rewrites, and so repairs, the file. A
      // partial write would have to merge with content that cannot be read.
      if (!(await noteFileDamaged(vaultId, path))) throw err
      if (input.frontmatter === undefined || input.body === undefined) throw new NoteFileDamagedError(path)
      return updateNote(vaultId, path, input, actor)
    }
    try {
      await connection.transact((document) => {
        if (input.body !== undefined) {
          const text = document.getText('body')
          text.delete(0, text.length)
          text.insert(0, input.body)
        }
        if (input.frontmatter !== undefined) {
          const fm = document.getMap('frontmatter')
          for (const key of [...fm.keys()]) fm.delete(key)
          for (const [key, value] of Object.entries(input.frontmatter)) fm.set(key, value)
        }
      })
    } finally {
      await connection.disconnect()
    }
  }
  return updateNote(vaultId, path, input, actor)
}
