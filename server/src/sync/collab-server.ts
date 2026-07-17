import { Server, type Hocuspocus } from '@hocuspocus/server'
import type * as Y from 'yjs'
import { getSessionUser } from '../auth/sessions.js'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { readNote, updateNote, splitPath } from '../notes/store.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { affects, onPermissionChange } from './permission-events.js'
import { publishNoteState } from './viewers.js'

const DEBOUNCE_MS = Number(process.env.COLLAB_DEBOUNCE_MS ?? 2000)

function parseDocName(name: string): { vaultId: string; path: string } {
  const slash = name.indexOf('/')
  if (slash === -1) throw new Error(`invalid document name: ${name}`)
  const vaultId = name.slice(0, slash)
  const path = name.slice(slash + 1)
  splitPath(path) // validates type/name slugs
  return { vaultId, path }
}

interface ConnectionContext {
  userId: string
}

function docState(document: Y.Doc): { frontmatter: Record<string, unknown>; body: string } {
  return {
    frontmatter: document.getMap('frontmatter').toJSON(),
    body: document.getText('body').toString(),
  }
}

/**
 * The sync relay (spec 5 + audit hardening), running as Hocuspocus's own
 * Server on a dedicated port in the same process. Editors only —
 * read-only live viewers are served via the SSE hub and never join here.
 * MCP writes (sub-project 6) use openDirectConnection on this instance,
 * so every AI edit is a visible participant in the same engine.
 */
let currentInstance: Hocuspocus | null = null

/** The running relay instance, if any — MCP writes route through it. */
export function getCollab(): Hocuspocus | null {
  return currentInstance
}

export async function startCollabServer(port: number): Promise<Server> {
  const server = new Server({
    port,
    debounce: DEBOUNCE_MS,
    maxDebounce: DEBOUNCE_MS * 5,
    quiet: true,

    async onAuthenticate({ token, documentName }) {
      const user = token ? await getSessionUser(token) : null
      if (!user) throw new Error('authentication required')
      const { vaultId } = parseDocName(documentName)
      const access = await resolveAccess(user.id, vaultId)
      if (!atLeast(access, 'edit')) {
        await logSecurityEvent({
          type: 'permission_denied',
          actorUserId: user.id,
          detail: { surface: 'collab', documentName },
        })
        throw new Error('edit access required')
      }
      return { userId: user.id } satisfies ConnectionContext
    },

    async onLoadDocument({ documentName, document }) {
      const { vaultId, path } = parseDocName(documentName)
      const note = await readNote(vaultId, path)
      if (!note) throw new Error(`note does not exist: ${documentName}`)
      const body = document.getText('body')
      if (body.length === 0) body.insert(0, note.body)
      const fm = document.getMap('frontmatter')
      for (const [key, value] of Object.entries(note.frontmatter)) {
        if (fm.get(key) === undefined) fm.set(key, value)
      }
      return document
    },

    /**
     * Per-operation enforcement (audit rule): every inbound message
     * re-resolves live access. Throwing drops the message and kills the
     * connection — independent of the event-driven kick below.
     */
    // ponytail: per-message DB re-check; event-invalidated per-connection state if profiling demands
    async beforeHandleMessage({ documentName, context }) {
      const { userId } = context as ConnectionContext
      const { vaultId } = parseDocName(documentName)
      const access = await resolveAccess(userId, vaultId)
      if (!atLeast(access, 'edit')) throw new Error('access revoked')
    },

    async onStoreDocument({ documentName, document }) {
      const { vaultId, path } = parseDocName(documentName)
      const state = docState(document)
      try {
        await updateNote(vaultId, path, state)
      } catch (err) {
        // Invalid collab state (e.g. bad frontmatter): keep last valid file.
        console.error(`collab store rejected for ${documentName}:`, err)
      }
    },

    async onChange({ documentName, document }) {
      const { vaultId, path } = parseDocName(documentName)
      publishNoteState(vaultId, path, docState(document))
    },
  })

  await server.listen(port)
  wireKick(server.hocuspocus)
  currentInstance = server.hocuspocus
  return server
}

/** Event-driven kick: revocation closes affected sockets immediately. */
function wireKick(hocuspocus: Hocuspocus): void {
  onPermissionChange((change) => {
    hocuspocus.documents.forEach((doc, documentName) => {
      const { vaultId } = parseDocName(documentName)
      doc.getConnections().forEach((connection) => {
        const { userId } = connection.context as ConnectionContext
        if (!affects(change, userId, vaultId)) return
        void resolveAccess(userId, vaultId).then((access) => {
          if (!atLeast(access, 'edit')) connection.close()
        })
      })
    })
  })
}
