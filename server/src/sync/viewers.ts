import type { FastifyReply } from 'fastify'
import { resolveAccess } from '../vaults/permissions.js'
import { affects, onPermissionChange } from './permission-events.js'

interface Viewer {
  userId: string
  /** The session the stream was opened with; it ends with it (#498). */
  sessionHash: string
  vaultId: string
  path: string
  reply: FastifyReply
}

/**
 * SSE hub for read-only live viewers. Viewers never join the Yjs doc —
 * they receive content states only, no awareness/identity data (audit
 * presence rule enforced structurally).
 */
const viewers = new Set<Viewer>()

onPermissionChange((change) => {
  for (const viewer of [...viewers]) {
    if (change.sessionHashes?.includes(viewer.sessionHash)) {
      dropViewer(viewer)
      continue
    }
    if (!affects(change, viewer.userId, viewer.vaultId)) continue
    void resolveAccess(viewer.userId, viewer.vaultId).then((access) => {
      if (!access) dropViewer(viewer)
    })
  }
})

function dropViewer(viewer: Viewer): void {
  viewers.delete(viewer)
  viewer.reply.raw.end()
}

export function addViewer(viewer: Viewer): void {
  viewers.add(viewer)
  viewer.reply.raw.on('close', () => viewers.delete(viewer))
}

/** Pushes a new note state to every viewer of that doc. */
export function publishNoteState(
  vaultId: string,
  path: string,
  state: { frontmatter: unknown; body: string },
): void {
  const payload = `data: ${JSON.stringify(state)}\n\n`
  for (const viewer of viewers) {
    if (viewer.vaultId === vaultId && viewer.path === path) {
      viewer.reply.raw.write(payload)
    }
  }
}
