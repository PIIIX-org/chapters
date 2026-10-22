/**
 * The bridge between the transactional store and the relay (ADR-003 §5.2
 * step 8, S2b). Documents are named by note id (`<vault>/~<noteId>`), so a
 * note has at most one loaded document, whatever its path, and its CRDT
 * state lives in `note_crdt` + `note_updates` (note-crdt.ts).
 *
 * A write compiles its change into one Yjs update against the note's
 * materialised CRDT state, commits it with the row, and then, still under
 * the note's lock, applies the same update to the loaded document with a
 * local origin: characters the write does not change keep their Yjs
 * identity, and typing that reached the relay meanwhile merges as a
 * concurrent edit. Nothing here awaits a Hocuspocus store hook (§5.1): the
 * relay schedules the store of the change itself, and that store waits for
 * the note lock.
 *
 * The relay registers itself here (registerLiveDocs) so the store does not
 * import the relay.
 */
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as Y from 'yjs'
import { sameContent } from '../notes/frontmatter-order.js'
import { applyTextDiff } from './text-diff.js'
import { moveViewers } from './viewers.js'

/** A note's state as the collab document holds it. */
export interface DocState {
  frontmatter: Record<string, unknown>
  body: string
}

export function docState(document: Y.Doc): DocState {
  return {
    frontmatter: document.getMap('frontmatter').toJSON(),
    body: document.getText('body').toString(),
  }
}

/**
 * Whether a document already holds `target` (body and frontmatter, key order
 * ignored). The S2b backfill attaches a bin equal to the row as is and puts a
 * diff to the row on top of any other; `migrate-store --dry-run` predicts that
 * split with this same rule (#873).
 */
export function sameDocState(state: DocState, target: DocState): boolean {
  return state.body === target.body && sameContent(state.frontmatter, target.frontmatter)
}

/**
 * The relay's name of a note's document (ADR-003 §5.4): `<vaultId>/~<noteId>`.
 * `~` never appears in a slug (notes/okf.ts), so a pre-S2b path name
 * (`<vaultId>/<path>`) can never be mistaken for one.
 */
export function collabDocName(vaultId: string, noteId: string): string {
  return `${vaultId}/~${noteId}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The vault and note of a document name, or `legacy` for a name of the
 * path-named scheme an older bundle sends (refused with `reload-required`).
 * Throws on anything else.
 */
export function parseDocName(name: string): { vaultId: string; noteId: string } | { legacy: true; vaultId: string } {
  const slash = name.indexOf('/')
  if (slash === -1) throw new Error(`invalid document name: ${name}`)
  const vaultId = name.slice(0, slash)
  const rest = name.slice(slash + 1)
  if (!rest.startsWith('~')) return { legacy: true, vaultId }
  const noteId = rest.slice(1)
  if (!UUID.test(noteId) || !UUID.test(vaultId)) throw new Error(`invalid document name: ${name}`)
  return { vaultId, noteId }
}

/** A loaded relay document, its name and the users with it open. */
export interface LiveDocument {
  doc: Y.Doc
  name: string
  editors: string[]
}

export interface LiveDocs {
  /** The document of note `noteId` if it finished loading (a loading one counts as not loaded). */
  ofNote(noteId: string): LiveDocument | null
  /** Closes every connection to note `noteId`'s document, with the reason `note-deleted`. */
  closeNote(noteId: string): void
}

let registry: LiveDocs | null = null

/** Called by the relay when it starts (and with null when it stops). */
export function registerLiveDocs(docs: LiveDocs | null): void {
  registry = docs
}

/** The relay's loaded document of note `noteId`, if any. */
export function liveDocumentOf(noteId: string): LiveDocument | null {
  return registry?.ofNote(noteId) ?? null
}

/**
 * After a delete or purge commits (§5.5): the note's editors are closed at
 * once with `note-deleted`, which the editor treats as final (no retry); a
 * reconnect is refused with the same reason until the note is restored.
 */
export function closeNoteEditors(noteId: string): void {
  registry?.closeNote(noteId)
}

/**
 * The current path of each note with a loaded document (set at load, moved
 * by a rename): the relay publishes the document's states to the live
 * viewers of that path (viewers.ts), which stay keyed by path.
 */
const livePaths = new Map<string, { vaultId: string; path: string }>()

export function setLivePath(noteId: string, vaultId: string, path: string): void {
  livePaths.set(noteId, { vaultId, path })
}

export function livePath(noteId: string): { vaultId: string; path: string } | undefined {
  return livePaths.get(noteId)
}

export function forgetLivePath(noteId: string): void {
  livePaths.delete(noteId)
}

/**
 * A note moved (rename, §5.4 "Live viewers"): its document keeps its name,
 * and its viewers move to the new path, told once where it is now.
 */
export function noteMoved(noteId: string, vaultId: string, from: string, to: string): void {
  if (livePaths.has(noteId)) livePaths.set(noteId, { vaultId, path: to })
  moveViewers(vaultId, from, to)
}

/**
 * The Yjs client id of every change this server process authors (ADR-003
 * §5.2 step 5): one random id per process. Writes to a note are serialised
 * under its lock, so the id's clock never forks within a document.
 *
 * It is 2^32 plus 48 random bits, above every editor's id (Yjs draws a
 * uint32): Yjs orders two inserts at one spot by client id, larger last, so
 * a server change compiled while a person's keystrokes were in flight at
 * the same spot (an agent appending where they type) goes after their
 * characters instead of splitting their word (#408). Yjs encodes client ids
 * as variable-length integers up to 2^53, so the id survives every update
 * and state vector.
 */
export const SERVER_CLIENT_ID = 2 ** 32 + randomBytes(6).readUIntLE(0, 6)

/** A copy of `doc`'s state: the base a write's change is compiled against. */
export function cloneDocument(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))
  return clone
}

/**
 * The Yjs update that turns `base` into `next`: a character diff of the body
 * and per-key set/delete of the frontmatter, authored by SERVER_CLIENT_ID.
 * `base` is consumed (it ends up holding `next`).
 */
export function compileChange(base: Y.Doc, next: DocState): Uint8Array {
  const before = Y.encodeStateVector(base)
  base.clientID = SERVER_CLIENT_ID
  base.transact(() => {
    applyTextDiff(base.getText('body'), next.body)
    const map = base.getMap('frontmatter')
    const current = map.toJSON() as Record<string, unknown>
    for (const key of Object.keys(current)) if (!Object.hasOwn(next.frontmatter, key)) map.delete(key)
    for (const [key, value] of Object.entries(next.frontmatter)) {
      if (!isDeepStrictEqual(current[key], value)) map.set(key, value)
    }
  })
  return Y.encodeStateAsUpdate(base, before)
}

/** The transaction origin of a pushed change: a Hocuspocus local origin, so its store runs (and is not re-screened, #492). */
const PUSH_ORIGIN = { source: 'local', context: { userId: 'server', directWrite: true } }

/** Applies a committed update to the note's loaded document, if any (§5.2 step 8). */
export function pushToLiveDocument(noteId: string, update: Uint8Array | null): void {
  const live = liveDocumentOf(noteId)
  if (live && update) Y.applyUpdate(live.doc, update, PUSH_ORIGIN)
}
