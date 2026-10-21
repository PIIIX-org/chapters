/**
 * The S2a bridge between the transactional store and the unchanged relay
 * (ADR-003 §5.2 step 8, S2a line; §5.5). Documents are still named by path
 * (`<vault>/<path>`) and their CRDT state still lives in `.crdt/<path>.bin`.
 *
 * After a write commits, still under the note's lock, the committed change
 * is pushed into the relay's loaded document as a diff (characters the write
 * does not change keep their Yjs identity), built on a clone of the document
 * taken before the write, and applied with a local origin: typing that
 * reached the relay in between merges as a concurrent edit. Nothing here
 * awaits a Hocuspocus store hook (§5.1): the relay schedules the store of the
 * change itself, and that store waits for the note lock.
 *
 * A note whose document is not loaded keeps its bin current instead: the
 * diff from the bin's own text to the committed text is applied to the bin's
 * state and saved, so the next load finds bin = row and never rebuilds the
 * document (the #488 duplication window).
 *
 * The relay registers itself here (registerLiveDocs) so the store does not
 * import the relay.
 */
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import * as Y from 'yjs'
import { applyTextDiff } from './text-diff.js'
import { loadCrdtState, saveCrdtState } from './crdt-store.js'

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

/** A loaded relay document, its name and the users with it open. */
export interface LiveDocument {
  doc: Y.Doc
  name: string
  editors: string[]
}

export interface LiveDocs {
  /**
   * Every document that finished loading (a loading one counts as not
   * loaded) from note `noteId`: the note id is recorded at load, so a
   * document left open at a renamed note's old path is found, and a new note
   * at that path is never confused with it.
   */
  ofNote(noteId: string): LiveDocument[]
}

let registry: LiveDocs | null = null

/** Called by the relay when it starts (and with null when it stops). */
export function registerLiveDocs(docs: LiveDocs | null): void {
  registry = docs
}

/** The relay's loaded documents of note `noteId`. */
export function liveDocumentsOf(noteId: string): LiveDocument[] {
  return registry?.ofNote(noteId) ?? []
}

/**
 * The Yjs client id of every change this server process authors (ADR-003
 * §5.2 step 5): one random uint32 per process. Writes to a note are
 * serialised under its lock, so the id's clock never forks within a document.
 */
export const SERVER_CLIENT_ID = randomBytes(4).readUInt32LE(0)

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

/** The origin of a merge of two documents of one note: a local change, stored (and screened) by the relay. */
export const MERGE_ORIGIN = { source: 'local', context: { userId: 'server' } }

/** Merges two documents of one note into each other, so each holds the other's typing (§5.5, S2a). */
export function mergeDocuments(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), MERGE_ORIGIN)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), MERGE_ORIGIN)
}

/**
 * Pushes a committed write into the loaded documents of a note (§5.2 step 8,
 * S2a). The change is compiled once, against `base` (the clone of `docs[0]`
 * taken before the write), and the same Yjs update is applied to every
 * document that shares that history, so no document is diffed separately
 * (which would delete typing only it holds). A document without shared
 * history gets a diff compiled against its own state. `committedFor` gives
 * the state to push given a document's current state (S2a keeps the editors'
 * body when the write did not change it).
 */
export function pushToDocuments(docs: Y.Doc[], base: Y.Doc, committedFor: (current: DocState) => DocState): void {
  const primary = docs[0]!
  const update = compileChange(base, committedFor(docState(base)))
  base.destroy()
  for (const doc of docs) {
    if (doc === primary || sharesHistory(doc, primary)) {
      Y.applyUpdate(doc, update, PUSH_ORIGIN)
    } else {
      const own = cloneDocument(doc)
      Y.applyUpdate(doc, compileChange(own, committedFor(docState(own))), PUSH_ORIGIN)
      own.destroy()
    }
  }
}

/**
 * Keeps the `.crdt` bin of a note whose document is not loaded equal to the
 * committed state: the diff is computed from the bin's own text and map, not
 * the row. Notes with no bin are left alone (the relay seeds them on first
 * open). Returns the bin's resulting state, or null when there is no bin.
 */
export async function updateBin(vaultId: string, path: string, committed: DocState): Promise<Uint8Array | null> {
  const saved = await loadCrdtState(vaultId, path)
  if (!saved) return null
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, saved)
    const current = docState(doc)
    if (current.body === committed.body && isDeepStrictEqual(current.frontmatter, committed.frontmatter)) return saved
    Y.applyUpdate(doc, compileChange(cloneDocument(doc), committed))
    const state = Y.encodeStateAsUpdate(doc)
    await saveCrdtState(vaultId, path, state)
    return state
  } finally {
    doc.destroy()
  }
}

/**
 * The client's `sharesHistory` rule (client/src/hooks/useCollabDoc.ts),
 * applied to two server documents: true if they have a Yjs client in common
 * other than SERVER_CLIENT_ID. Every server write is pushed into every open
 * document of a note under that one id, also into unrelated ones, so it
 * proves nothing about where the documents came from; counting it would merge
 * two unrelated copies of the same text into a doubled note.
 */
export function sharesHistory(a: Y.Doc, b: Y.Doc): boolean {
  for (const client of a.store.clients.keys()) {
    if (client !== SERVER_CLIENT_ID && b.store.clients.has(client)) return true
  }
  return false
}
