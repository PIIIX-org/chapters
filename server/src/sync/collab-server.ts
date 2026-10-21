import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer, type RawData } from 'ws'
import * as Y from 'yjs'
import { getSessionUser, sessionActive } from '../auth/sessions.js'
import { hashToken } from '../auth/tokens.js'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { getLiveNote, noteLock, readNote, updateNote, splitPath } from '../notes/store.js'
import { NoteNotMigratedError, noteMigrated } from '../notes/store-tx.js'
import { withKeyLock } from '../notes/key-lock.js'
import { docState, liveDocumentsOf, mergeDocuments, registerLiveDocs, sharesHistory, type LiveDocument } from './live-docs.js'
import { NoteWriteQuarantinedError } from '../notes/growth-guard.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { affects, onPermissionChange } from './permission-events.js'
import { publishNoteState } from './viewers.js'
import { consumeTicket } from './tickets.js'
import { COLLAB_PATH } from './routes.js'
import { loadCrdtState, saveCrdtState } from './crdt-store.js'
import { recordJob } from '../monitoring/metrics.js'
import { config } from '../config.js'
import { noteTransportLimit } from '../notes/size-cap.js'
import { bodyMeasured, updateFits } from './collab-size.js'
import { forgetAgentPresence, stripAgentClaims } from './agent-presence.js'
import { writesPaused } from '../notes/maintenance-lock.js'

export const ALLOWED_UPGRADES = new Set([COLLAB_PATH, '/elara-collab'])

const DEBOUNCE_MS = Number(process.env.COLLAB_DEBOUNCE_MS ?? 2000)

/** y-protocols/sync message types that carry a Yjs update (step 2 of the handshake, and live edits). */
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

/**
 * Thrown from `beforeSync` for an update the size cap refuses (#491).
 * Hocuspocus closes the document connection with this code and reason
 * before applying anything; the reason reaches the client in the close
 * message (client/src/hooks/useCollabDoc.ts reads `note-too-large`).
 */
class NoteTooLargeRefusal extends Error {
  readonly code = 4413
  readonly reason = 'note-too-large'
  constructor(documentName: string, limit: number) {
    super(`refused an update to ${documentName}: the note body would pass ${limit} bytes (ELARA_NOTE_MAX_BYTES)`)
  }
}

/**
 * Thrown from `beforeSync` while writes are paused (ADR-003 §5.1): nothing
 * of the update is applied or stored. The hook also closes the socket with
 * 1013 ("try again later"): a document-level close leaves the provider
 * detached, while a socket close makes it reconnect with backoff and resend
 * what the relay never took. The editor treats the reason as a drop.
 */
class StorePausedRefusal extends Error {
  readonly code = 1013
  readonly reason = 'store-paused'
  constructor(documentName: string) {
    super(`refused an update to ${documentName}: writes are paused until the instance lock is held again`)
  }
}

/**
 * Why a connection whose session ended is closed (#498): logout here or in
 * another tab, a password change or reset, deactivation, expiry. Thrown from
 * `beforeHandleMessage` and passed to `close()`; the editor
 * (client/src/hooks/useCollabDoc.ts) reads `signed-out` and stops.
 */
class SessionEnded extends Error {
  readonly code = 4401
  readonly reason = 'signed-out'
  constructor(documentName: string) {
    super(`the session that opened ${documentName} ended`)
  }
}

/**
 * The quarantine revision of each loaded document's current episode (#492):
 * stores that continue it update that revision. A document loaded afresh
 * (after an unload) has none, so its quarantine never overwrites an earlier
 * episode's refused body, the only copy of what was typed then.
 */
const quarantineEpisodes = new WeakMap<Y.Doc, string>()

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
  /** Hash of the session the connection was opened with; absent on direct connections. */
  sessionHash?: string
  /** That session ended: nothing more is taken from this connection. */
  sessionEnded?: boolean
  accessVerifiedAt?: number
  /** A change the server pushed into the document (live-docs.ts), whose writer already ran the quarantine check. */
  directWrite?: boolean
}

/** The note each loaded document was loaded from (ADR-003 §5.5, S2a): its stores go to that note only. */
const documentNotes = new WeakMap<Y.Doc, string>()

/**
 * The sync relay (spec 5 + audit hardening). It has no listener of its own:
 * it is attached to Fastify's HTTP server and answers websocket upgrades on
 * `COLLAB_PATH` only, so the whole app is one process on one port. Editors
 * only — read-only live viewers are served via the SSE hub and never join
 * here. Server writes reach loaded documents through live-docs.ts.
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
    unloadImmediately: false,
    quiet: true,

    /**
     * Identity only. A browser presents a single-use ticket (its session
     * cookie is httpOnly and unreadable from JS); server-side callers and the
     * tests present a raw session token. Either way the connection belongs to
     * that session and ends with it (#498): a ticket whose session ended
     * since it was minted is refused. Neither says what the connection may
     * *do* — that is the live `edit` check below, and `beforeHandleMessage`
     * on every message after it.
     */
    async onAuthenticate({ token, documentName }) {
      const ticket = token ? consumeTicket(token) : null
      let sessionHash: string | null = null
      let userId: string | null = null
      if (ticket) {
        if (await sessionActive(ticket.sessionHash)) {
          userId = ticket.userId
          sessionHash = ticket.sessionHash
        }
      } else if (token) {
        userId = (await getSessionUser(token))?.id ?? null
        sessionHash = hashToken(token)
      }
      if (!userId || !sessionHash) throw new Error('authentication required')
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
      // A note the store migration has not processed yet takes no writes, so no
      // editor either: nothing may be typed that could not be stored. The tab
      // shows the relay's refusal ("this note stopped syncing"), not a silent editor.
      const { path } = parseDocName(documentName)
      const note = await getLiveNote(vaultId, path)
      if (note && !(await noteMigrated(db, note.id))) throw new Error(new NoteNotMigratedError().message)
      return { userId, sessionHash } satisfies ConnectionContext
    },

    /**
     * Loads the path-named document from the note's row (the database is
     * the authority, ADR-003 §6) and its `.crdt` bin, under the note's lock
     * (§5.2, S2a): a write to the note either finished first (and kept the
     * bin equal to the row, so nothing is rebuilt) or waits for the load and
     * then pushes into the loaded document. Records the note's id: the
     * document's stores go to that note only (§5.5).
     */
    async onLoadDocument({ documentName, document }) {
      const { vaultId, path } = parseDocName(documentName)
      await withKeyLock(noteLock(vaultId, path), async () => {
        const note = await readNote(vaultId, path)
        if (!note) throw new Error(`note does not exist: ${documentName}`)
        if (!(await noteMigrated(db, note.row.id))) throw new NoteNotMigratedError()
        documentNotes.set(document, note.row.id)
        const savedUpdate = await loadCrdtState(vaultId, path)
        if (savedUpdate) {
          Y.applyUpdate(document, savedUpdate)
          const body = document.getText('body')
          const currentBody = body.toString()
          if (currentBody !== note.body) {
            body.delete(0, body.length)
            body.insert(0, note.body)
          }
          const fm = document.getMap('frontmatter')
          const currentFm = fm.toJSON() as Record<string, unknown>
          for (const key of Object.keys(currentFm)) {
            if (!(key in note.frontmatter)) {
              fm.delete(key)
            }
          }
          for (const [key, value] of Object.entries(note.frontmatter)) {
            if (JSON.stringify(currentFm[key]) !== JSON.stringify(value)) {
              fm.set(key, value)
            }
          }
        } else {
          const body = document.getText('body')
          if (body.length === 0) body.insert(0, note.body)
          const fm = document.getMap('frontmatter')
          for (const [key, value] of Object.entries(note.frontmatter)) {
            if (fm.get(key) === undefined) fm.set(key, value)
          }
          await saveCrdtState(vaultId, path, Y.encodeStateAsUpdate(document))
        }
      })
      return document
    },

    /**
     * Per-operation enforcement (audit rule): every inbound message
     * re-resolves live access and the session behind the connection.
     * Throwing drops the message and kills the connection — independent of
     * the event-driven kick below, which flags `sessionEnded` so a message
     * already queued behind the kick is refused too.
     */
    // ponytail: per-message DB re-check cached for 10s; wireKick handles instant event-driven revocation (GR-03)
    async beforeHandleMessage({ documentName, context }) {
      const ctx = context as ConnectionContext
      if (ctx.sessionEnded) throw new SessionEnded(documentName)
      const now = Date.now()
      if (ctx.accessVerifiedAt && now - ctx.accessVerifiedAt < 10_000) {
        return
      }
      const { userId } = ctx
      // Expiry, or an end no event announced.
      if (ctx.sessionHash && !(await sessionActive(ctx.sessionHash))) {
        ctx.sessionEnded = true
        throw new SessionEnded(documentName)
      }
      const { vaultId } = parseDocName(documentName)
      const access = await resolveAccess(userId, vaultId)
      if (!atLeast(access, 'edit')) throw new Error('access revoked')
      ctx.accessVerifiedAt = now
    },

    /**
     * Before an update is applied. While writes are paused (the maintenance
     * lock's connection dropped, ADR-003 §5.1) the update is refused and the
     * connection closed, so it stays unacked and the editor resends it after
     * reconnecting. Then the size cap (#491): the relay never holds or stores
     * a body over it. See collab-size.ts for how this stays off the whole
     * document on ordinary keystrokes.
     */
    async beforeSync({ type, payload, document, documentName, connection }) {
      if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return
      if (writesPaused()) {
        const refusal = new StorePausedRefusal(documentName)
        connection.webSocket.close(refusal.code, refusal.reason)
        throw refusal
      }
      const limit = config.noteMaxBytes
      if (!updateFits(document, payload, limit)) throw new NoteTooLargeRefusal(documentName, limit)
    },

    /** Only the relay puts agents in presence (#481, agent-presence.ts). */
    async beforeHandleAwareness({ documentName, states }) {
      stripAgentClaims(documentName, states)
    },

    /**
     * Stores the document into the note it loaded (ADR-003 §5.5, S2a), by
     * id, through the transactional store, which takes the note's lock: a
     * write holding it finishes (and pushes its change into this document)
     * first. A document whose path the note no longer has (renamed while
     * open) stores into the note at its current path, never into a note
     * created later at the old path; when the note is also open at its
     * current path, the two documents are merged into each other instead and
     * the current-path document stores. A trashed or purged note stores nothing.
     */
    async onStoreDocument({ documentName, document, lastContext }) {
      const { vaultId, path: docPath } = parseDocName(documentName)
      const context: Partial<ConnectionContext> | undefined = lastContext
      const noteId = documentNotes.get(document)
      const [note] = noteId
        ? await db.select({ path: notes.path, deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, noteId))
        : []
      if (!noteId || !note || note.deletedAt) {
        const reason = !note ? 'the note was purged' : 'the note is in the trash'
        console.error(`collab store of ${documentName} not stored: ${reason}`)
        recordJob('collab-store', { error: { name: 'NoteGone', message: reason } }, vaultId)
        return
      }
      const path = note.path
      if (path !== docPath) {
        const current = liveDocumentsOf(noteId).find((d) => d.name === `${vaultId}/${path}`)
        if (current && current.doc !== document) {
          if (!sharesHistory(document, current.doc)) {
            console.error(`collab store of ${documentName} not stored: the note is open at ${path} with unrelated history`)
            recordJob('collab-store', { error: { name: 'UnrelatedHistory', message: `${docPath} -> ${path}` } }, vaultId)
            return
          }
          // Each tab sees the other's typing; the current-path document stores the merged state.
          mergeDocuments(current.doc, document)
          return
        }
      }
      // A rejected store is a failed job (#705): the row keeps its last valid
      // version while editors see their edit, so the owner must hear of it.
      let failed = false
      try {
        // A document that repeats a block of the stored note (a stale client
        // merged into a rebuilt document doubles it, #488) is quarantined
        // (#492): kept as a revision, not stored. Editors keep what they see;
        // the next store without the repeat is written as usual and ends the episode.
        // The state is read under the note's lock (updateNote calls it there):
        // a server write that held the lock has pushed its change into this
        // document by then, so a store never writes the editors' older state
        // back over an acknowledged write.
        const state = () => {
          const now = docState(document)
          bodyMeasured(document, now.body)
          return now
        }
        await updateNote(vaultId, path, state, undefined, {
          relay: { noteId },
          ...(context?.directWrite ? {} : { quarantine: 'repeated-block' as const, episode: quarantineEpisodes.get(document) }),
        })
        quarantineEpisodes.delete(document)
      } catch (err) {
        if (err instanceof NoteWriteQuarantinedError) {
          quarantineEpisodes.set(document, err.revisionId)
          // One report per episode: stores that continue it count as `repeated`.
          if (!err.repeat) console.error(`collab store quarantined for ${documentName}: ${err.message}`)
          recordJob('collab-store', { error: err, repeat: err.repeat }, vaultId)
        } else {
          // Invalid collab state (e.g. bad frontmatter): keep last valid row.
          console.error(`collab store rejected for ${documentName}:`, err)
          recordJob('collab-store', { error: err }, vaultId)
        }
        failed = true
      }
      try {
        await saveCrdtState(vaultId, path, Y.encodeStateAsUpdate(document))
      } catch (err) {
        console.error(`crdt state save rejected for ${documentName}:`, err)
        recordJob('collab-store', { error: err }, vaultId)
        failed = true
      }
      if (!failed) recordJob('collab-store', 'ok', vaultId)
    },

    async onChange({ documentName, document }) {
      const { vaultId, path } = parseDocName(documentName)
      publishNoteState(vaultId, path, docState(document))
    },

    async afterUnloadDocument({ documentName }) {
      forgetAgentPresence(documentName)
    },
  })

  const hocuspocus = server.hocuspocus
  // Frames past the transport limit are refused by ws before they are read
  // (close 1009); the default was 100 MiB (#491).
  const wss = new WebSocketServer({ noServer: true, maxPayload: noteTransportLimit() })

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Node destroys upgrade sockets itself only while nothing listens for the
    // event. Once we listen, every path we do not serve is ours to refuse —
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (!ALLOWED_UPGRADES.has(pathname)) {
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

  const unbindKick = wireKick(hocuspocus)
  currentInstance = hocuspocus
  registerLiveDocs({
    ofNote(noteId) {
      const out: LiveDocument[] = []
      hocuspocus.documents.forEach((doc, name) => {
        if (doc.isLoading || documentNotes.get(doc) !== noteId) return
        const editors = [...new Set([...doc.getConnections()].map((c) => (c.context as ConnectionContext).userId))]
        out.push({ doc, name, editors })
      })
      return out
    },
  })

  return {
    hocuspocus,
    destroy: async () => {
      httpServer.off('upgrade', onUpgrade)
      unbindKick()
      await server.destroy()
      for (const client of wss.clients) client.terminate()
      wss.close()
      currentInstance = null
      registerLiveDocs(null)
      forgetAgentPresence()
    },
  }
}

/**
 * Event-driven kick: revocation closes affected sockets immediately. A
 * connection whose session ended closes at once, before any access check
 * (#498): every tab of that session, whatever its access.
 */
function wireKick(hocuspocus: Hocuspocus): () => void {
  return onPermissionChange((change) => {
    hocuspocus.documents.forEach((doc, documentName) => {
      const { vaultId } = parseDocName(documentName)
      doc.getConnections().forEach((connection) => {
        const ctx = connection.context as ConnectionContext
        if (ctx.sessionHash && change.sessionHashes?.includes(ctx.sessionHash)) {
          ctx.sessionEnded = true
          connection.close(new SessionEnded(documentName))
          return
        }
        if (!affects(change, ctx.userId, vaultId)) return
        ctx.accessVerifiedAt = undefined
        void resolveAccess(ctx.userId, vaultId).then((access) => {
          if (!atLeast(access, 'edit')) connection.close()
        })
      })
    })
  })
}
