import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Server, type Hocuspocus } from '@hocuspocus/server'
import { WebSocketServer, type RawData } from 'ws'
import * as Y from 'yjs'
import { getSessionUser, sessionActive } from '../auth/sessions.js'
import { hashToken } from '../auth/tokens.js'
import { atLeast, resolveAccess } from '../vaults/permissions.js'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { compactCollabState, keepRefusedTyping, loadCollabState, updateNote } from '../notes/store.js'
import { NoteNotMigratedError, StoreBusyError, collabNoteMigrated, noteMigrated, storeMigrationPending } from '../notes/store-tx.js'
import { docState, forgetLivePath, livePath, parseDocName, registerLiveDocs, setLivePath, type LiveDocument } from './live-docs.js'
import { rememberLoadedState } from './note-crdt.js'
import { NoteWriteQuarantinedError } from '../notes/growth-guard.js'
import { logSecurityEvent } from '../auth/security-events.js'
import { affects, onPermissionChange } from './permission-events.js'
import { publishNoteState } from './viewers.js'
import { consumeTicket } from './tickets.js'
import { COLLAB_PATH } from './routes.js'
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
 * Closes the socket of a connection whose document could not be loaded
 * because the store is busy (writes paused, ADR-003 §5.1, or a lock
 * timeout): loading a document is a store transaction (seed, catch-up).
 * Hocuspocus answers a failed load with `permission-denied`, which the
 * editor takes as a revocation; a socket close with 1013 makes it reconnect
 * with backoff instead and load the document once the store takes writes.
 */
function closeForRetry(socket: ConnectionContext['socket'], err: unknown): void {
  if (!(err instanceof StoreBusyError) || !socket) return
  socket.close(1013, 'store-busy')
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
 * Why a note's editors are closed or refused (ADR-003 §5.5): the note is in
 * the trash or purged. Passed to `close()` right after a delete or purge
 * commits (live-docs.ts closeNoteEditors), and thrown from `onAuthenticate`
 * for a note that is not live; the editor (client/src/hooks/useCollabDoc.ts)
 * reads `note-deleted`, stops reconnecting and says the note is in the trash.
 */
class NoteDeletedRefusal extends Error {
  readonly code = 4410
  readonly reason = 'note-deleted'
  constructor(documentName: string) {
    super(`${documentName}: the note was deleted`)
  }
}

/** Documents whose editors were closed because the note was deleted: their unload stores nothing and reports nothing. */
const deletedDocuments = new WeakSet<Y.Doc>()

/**
 * Thrown from `onAuthenticate` for a note the store migration has not
 * processed yet (ADR-003 §8, Q5): Hocuspocus sends `reason` to the client as
 * the authentication failure; the editor (client/src/hooks/useCollabDoc.ts)
 * reads `note-not-migrated` and says an administrator must restart the server.
 */
class NoteNotMigratedRefusal extends Error {
  readonly reason = 'note-not-migrated'
  constructor() {
    super(new NoteNotMigratedError().message)
  }
}

/**
 * Thrown from `onAuthenticate` for a document named by path (`<vault>/<path>`),
 * the scheme of bundles from before ADR-003 S2b (§5.4): nothing such a tab
 * sends is stored. The editor (client/src/hooks/useCollabDoc.ts) reads
 * `reload-required` and says "Reload to keep editing"; the reload loads the
 * bundle that names documents by note id, and the tab's unsent typing,
 * kept in this browser (#720), is merged once or offered as text.
 */
class ReloadRequiredRefusal extends Error {
  readonly reason = 'reload-required'
  constructor(documentName: string) {
    super(`refused ${documentName}: documents are named by note id since ADR-003 S2b; the editor must reload`)
  }
}

/**
 * The quarantine revision of each loaded document's current episode (#492):
 * stores that continue it update that revision. A document loaded afresh
 * (after an unload) has none, so its quarantine never overwrites an earlier
 * episode's refused body, the only copy of what was typed then.
 */
const quarantineEpisodes = new WeakMap<Y.Doc, string>()

interface ConnectionContext {
  userId: string
  /** Hash of the session the connection was opened with; absent on direct connections. */
  sessionHash?: string
  /** That session ended: nothing more is taken from this connection. */
  sessionEnded?: boolean
  accessVerifiedAt?: number
  /** A change the server pushed into the document (live-docs.ts), whose writer already ran the quarantine check. */
  directWrite?: boolean
  /** The connection's socket (handleConnection's default context): closed when a load must be retried. */
  socket?: { close(code?: number, reason?: string): void }
}

/** The note each loaded document holds (its name says so; kept once the load finished). */
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
      const name = parseDocName(documentName)
      // A bundle from before S2b names documents by path: refused before anything else, nothing it sends is stored.
      if ('legacy' in name) throw new ReloadRequiredRefusal(documentName)
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
      const { vaultId, noteId } = name
      const access = await resolveAccess(userId, vaultId)
      if (!atLeast(access, 'edit')) {
        await logSecurityEvent({
          type: 'permission_denied',
          actorUserId: userId,
          detail: { surface: 'collab', documentName },
        })
        throw new Error('edit access required')
      }
      // The note by id, in that vault, live: a trashed or purged note takes no editor.
      const [note] = await db
        .select({ id: notes.id, deletedAt: notes.deletedAt })
        .from(notes)
        .where(and(eq(notes.id, noteId), eq(notes.vaultId, vaultId)))
      if (!note || note.deletedAt) throw new NoteDeletedRefusal(documentName)
      // A note the store migration has not processed yet takes no writes, so no
      // editor either: nothing may be typed that could not be stored. The
      // refusal carries its own reason, which the editor shows as such.
      if (storeMigrationPending() && !(await noteMigrated(db, note.id))) throw new NoteNotMigratedRefusal()
      // The same for a note whose S2b backfill failed at this boot: its bin is attached at the next restart.
      if (!collabNoteMigrated(note.id)) throw new NoteNotMigratedRefusal()
      return { userId, sessionHash } satisfies ConnectionContext
    },

    /**
     * Loads the note's document from its CRDT state in the database
     * (ADR-003 §5.4 "Load"), under the note's locks: seeded
     * deterministically on first open, a row changed behind the store
     * rebased into it. Never a file, never a `.crdt` bin, never a rebuild of
     * the text, so a client holding the document's items never sees them
     * twice (#488, #832).
     */
    async onLoadDocument({ documentName, document, context }) {
      const name = parseDocName(documentName)
      if ('legacy' in name) throw new ReloadRequiredRefusal(documentName)
      const { state, path, lastId } = await loadCollabState(name.vaultId, name.noteId).catch((err: unknown) => {
        closeForRetry((context as Partial<ConnectionContext> | undefined)?.socket, err)
        throw err
      })
      Y.applyUpdate(document, state)
      // The stored state this document holds, so its stores need not materialise it again (§5.4 "Before S3").
      if (lastId !== null) rememberLoadedState(document, name.noteId, lastId)
      documentNotes.set(document, name.noteId)
      setLivePath(name.noteId, name.vaultId, path)
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
     * Stores the document into its note through the transactional store
     * (ADR-003 §5.4, S2b), which takes the note's lock: a write holding it
     * finishes (and pushes its change into this document) first. The typing
     * since the stored state is appended to the note's CRDT log and folded
     * into the row in one transaction. A trashed or purged note stores
     * nothing.
     */
    async onStoreDocument({ documentName, document, lastContext }) {
      const name = parseDocName(documentName)
      const context: Partial<ConnectionContext> | undefined = lastContext
      const noteId = documentNotes.get(document)
      const { vaultId } = name
      try {
        // A document that repeats a block of the stored note (a stale client
        // merged into a rebuilt document doubled it, #488) is quarantined
        // (#492): kept as a revision, not stored. Editors keep what they see;
        // the next store without the repeat is written as usual and ends the episode.
        // The state is the one the write appends to the CRDT log, taken under
        // the note's lock: a server write that held the lock has pushed its
        // change into this document by then, so a store never writes the
        // editors' older state back over an acknowledged write.
        // The note is looked up by id each round: a rename between the lookup and the lock finds it at its new path.
        for (let round = 0; ; round++) {
          const [note] = noteId
            ? await db.select({ path: notes.path, deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, noteId))
            : []
          if (!noteId || !note || note.deletedAt || round === 3) {
            // Closed by a delete or purge (§5.5): nothing to store, and nothing went wrong.
            if (deletedDocuments.has(document) && (!note || note.deletedAt)) return
            const reason = !note ? 'the note was purged' : note.deletedAt ? 'the note is in the trash' : 'the note kept moving'
            console.error(`collab store of ${documentName} not stored: ${reason}`)
            recordJob('collab-store', { error: { name: 'NoteGone', message: reason } }, vaultId)
            return
          }
          const stored = await updateNote(
            vaultId,
            note.path,
            (current) => {
              bodyMeasured(document, current.body)
              return current
            },
            undefined,
            {
              relay: { noteId, doc: document },
              ...(context?.directWrite ? {} : { quarantine: 'repeated-block' as const, episode: quarantineEpisodes.get(document) }),
            },
          )
          if (stored) break
        }
        quarantineEpisodes.delete(document)
        recordJob('collab-store', 'ok', vaultId)
      } catch (err) {
        // A rejected store is a failed job (#705): the row keeps its last valid
        // version while editors see their edit, so the owner must hear of it.
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
        // Refused, not failed: the typing still goes into the CRDT log, with the reason (§5.4 fold step 5).
        if (noteId && !(err instanceof StoreBusyError)) {
          await keepRefusedTyping(vaultId, noteId, document, err instanceof Error ? err.message : String(err)).catch((keepErr) =>
            console.error(`collab typing of ${documentName} not kept:`, keepErr),
          )
        }
      }
    },

    /** Live viewers stay keyed by path (§5.4): the note's current path, which a rename moves. */
    async onChange({ document }) {
      const noteId = documentNotes.get(document)
      const at = noteId ? livePath(noteId) : undefined
      if (at) publishNoteState(at.vaultId, at.path, docState(document))
    },

    /** The document unloaded: its CRDT tail is compacted into the snapshot (§5.4 fold step 6). */
    async afterUnloadDocument({ documentName }) {
      forgetAgentPresence(documentName)
      const name = parseDocName(documentName)
      if ('legacy' in name) return
      forgetLivePath(name.noteId)
      await compactCollabState(name.vaultId, name.noteId).catch((err) =>
        console.error(`collab compaction of ${documentName} failed:`, err),
      )
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
      const connection = hocuspocus.handleConnection(ws, toRequest(req), { socket: ws })
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
    ofNote(noteId): LiveDocument | null {
      for (const [name, doc] of hocuspocus.documents) {
        if (doc.isLoading || documentNotes.get(doc) !== noteId) continue
        const editors = [...new Set([...doc.getConnections()].map((c) => (c.context as ConnectionContext).userId))]
        return { doc, name, editors }
      }
      return null
    },
    closeNote(noteId) {
      for (const [name, doc] of hocuspocus.documents) {
        if (documentNotes.get(doc) !== noteId) continue
        deletedDocuments.add(doc)
        doc.getConnections().forEach((connection) => connection.close(new NoteDeletedRefusal(name)))
      }
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
