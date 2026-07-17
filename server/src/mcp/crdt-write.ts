import { getCollab } from '../sync/collab-server.js'
import { getLiveNote, updateNote, type Actor, type NoteRow } from '../notes/store.js'

/**
 * MCP edits flow through the live CRDT engine when it's running (spec 6:
 * an AI edit is a visible participant, never a sudden unexplained
 * change). The attributed store write happens immediately here; the
 * relay's debounced store of the same state dedupes in the audit trail.
 */
export async function writeThroughCollab(
  vaultId: string,
  path: string,
  input: { frontmatter?: Record<string, unknown>; body?: string },
  actor: Actor,
): Promise<NoteRow | null> {
  const collab = getCollab()
  const docName = `${vaultId}/${path}`
  if (collab && (collab.documents.has(docName) || collab.getConnectionsCount() > 0)) {
    const existing = await getLiveNote(vaultId, path)
    if (!existing) return null
    const connection = await collab.openDirectConnection(docName, { userId: `mcp` })
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
