import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer, type RawData } from 'ws'
import type * as Y from 'yjs'
import { getSessionUser } from '../auth/sessions.js'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { readNote, updateNote, splitPath } from '../notes/store.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { affects, onPermissionChange } from './permission-events.js'
import { publishNoteState } from './viewers.js'
import { consumeTicket } from './tickets.js'
import { COLLAB_PATH } from './routes.js'

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
 * The sync relay (spec 5 + audit hardening). It has no listener of its own:
 * it is attached to Fastify's HTTP server and answers websocket upgrades on
 * `COLLAB_PATH` only, so the whole app is one process on one port. Editors
 * only — read-only live viewers are served via the SSE hub and never join
 * here. MCP writes (sub-project 6) use openDirectConnection on this instance,
 * so every AI edit is a visible participant in the same engine.
 */
let currentInstance: Hocuspocus | null = null

export interface CollabRelay {
  /** The running Hocuspocus engine. */
  hocuspocus: Hocuspocus
  /** Detach, flush debounced note writes, drop remaining sockets. */
  destroy(): Promise<void>
}

/**
 * Hocuspocus hooks read `request.headers` and the query string, and the
 * upstream (crossws) integration hands them a WHATWG Request. Build the same
 * shape from the node upgrade request so hook payloads are unchanged.
 */
function toRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost'
  return new Request(`http://${host}${req.url ?? '/'}`, {
    headers: req.headers as Record<string, string>,
  })
}

/** ws hands us Buffer (or fragments); Hocuspocus wants one Uint8Array view. */
function toBytes(data: RawData): Uint8Array {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** The running relay instance, if any — MCP writes route through it. */
export function getCollab(): Hocuspocus | null {
  return currentInstance
}

export function startCollabServer(httpServer: HttpServer): CollabRelay {
  // Constructed but never `listen()`ed: we only want its hooks, its document
  // lifecycle and its `destroy()` (which flushes pending note writes).
  const server = new Server({
    debounce: DEBOUNCE_MS,
    maxDebounce: DEBOUNCE_MS * 5,
    quiet: true,

    /**
     * Identity only. A browser presents a single-use ticket (its session
     * cookie is httpOnly and unreadable from JS); server-side callers and the
     * tests present a raw session token. Neither says what the connection may
     * *do* — that is the live `edit` check below, and `beforeHandleMessage`
     * on every message after it.
     */
    async onAuthenticate({ token, documentName }) {
      const ticketUser = token ? consumeTicket(token) : null
      const userId =
        ticketUser ?? (token ? ((await getSessionUser(token))?.id ?? null) : null)
      if (!userId) throw new Error('authentication required')
      const { vaultId } = parseDocName(documentName)
      const access = await resolveAccess(userId, vaultId)
      if (!atLeast(access, 'edit')) {
        await logSecurityEvent({
          type: 'permission_denied',
          actorUserId: userId,
          detail: { surface: 'collab', documentName },
        })
        throw new Error('edit access required')
      }
      return { userId } satisfies ConnectionContext
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

  const hocuspocus = server.hocuspocus
  const wss = new WebSocketServer({ noServer: true })

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Node destroys upgrade sockets itself only while nothing listens for the
    // event. Once we listen, every path we do not serve is ours to refuse —
    // handing an arbitrary path to the relay would make it answer everywhere.
    if ((req.url ?? '').split('?')[0] !== COLLAB_PATH) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = hocuspocus.handleConnection(ws, toRequest(req))
      ws.on('message', (data) => connection.handleMessage(toBytes(data)))
      ws.on('close', (code, reason) =>
        connection.handleClose({ code, reason: reason.toString() }),
      )
      // Without this the process dies. A `ws` socket that hits a protocol
      // error emits 'error', and an EventEmitter with no 'error' listener
      // rethrows — so six malformed bytes from anyone who can reach this path,
      // authenticated or not, take the whole server down and every other
      // customer's session with it. `close` always follows, so the connection
      // is cleaned up by the handler above; this only has to stop the throw.
      ws.on('error', (err) => {
        console.error('[collab] socket error:', err)
      })
    })
  }
  httpServer.on('upgrade', onUpgrade)

  wireKick(hocuspocus)
  currentInstance = hocuspocus

  return {
    hocuspocus,
    destroy: async () => {
      httpServer.off('upgrade', onUpgrade)
      await server.destroy()
      for (const client of wss.clients) client.terminate()
      wss.close()
      currentInstance = null
    },
  }
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
