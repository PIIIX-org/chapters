import * as Y from 'yjs'
import { jsonBytes } from '../notes/size-cap.js'

/**
 * The relay's side of the note size cap (#491, notes/size-cap.ts): decides,
 * before a client's Yjs update is applied, whether it would push the note
 * past the cap. Two parts of the document are bounded, each by the cap:
 *
 * - the body: its text as UTF-8 bytes, what assertBodyFits measures;
 * - the rest (#780): every other piece of content the document holds
 *   (contentBytes): the frontmatter map's keys and values as JSON, which the
 *   store writes to the row and the file, and anything else a client puts
 *   in the document (other root types, embeds and formatting in the body),
 *   which is never stored to the note but stays in its CRDT log.
 *
 * Measuring per keystroke would serialize the whole note on every one, so
 * each document keeps a running upper bound per part instead, and the exact
 * (whole-document) work only happens near the cap:
 *
 * 1. Bound: the part at its last exact measure, plus the length of every
 *    update applied since (whatever its origin: clients, server writes
 *    pushed into the document, the load), this update and the structs Yjs
 *    holds pending (this update can unblock them). An update carries its
 *    inserted text as UTF-8, so it adds at most its own length to the body;
 *    written out as JSON a value takes at most REST_EXPANSION times its
 *    encoding (`false` is one byte encoded and five as JSON, a control
 *    character one and six), so the rest's bound counts that many.
 * 2. An update that inserts no text (deletions, frontmatter) cannot grow the
 *    body, and one that adds nothing but text to the body (typing,
 *    deletions) cannot grow the rest (addsRest, #947).
 * 3. Exact: measure the part now; its bound restarts from it.
 * 4. Otherwise apply the update to a scratch copy and measure: at most the
 *    larger of the cap and the current document, plus one frame of work. The
 *    update fits if each part ends up within the cap or no larger than now,
 *    so a note already over the cap (stored before it) can shrink, even in
 *    an update that also adds (an editor's reconnect sends its typing and its
 *    cuts together), as assertBodyFits allows.
 */
interface Meter {
  /** Body UTF-8 bytes at the last exact measure. */
  bytes: number
  /** Lengths of the updates applied since. */
  since: number
  /** contentBytes of the rest at its last exact measure. */
  rest: number
  /** Lengths of the updates applied since the rest was measured. */
  restSince: number
}

/** The most JSON bytes one byte of a Yjs update can turn into (see step 1 above). */
const REST_EXPANSION = 6

const meters = new WeakMap<Y.Doc, Meter>()

function meterFor(doc: Y.Doc): Meter {
  let meter = meters.get(doc)
  if (!meter) {
    const created: Meter = { bytes: Buffer.byteLength(doc.getText('body').toString()), since: 0, rest: restBytes(doc), restSince: 0 }
    doc.on('update', (update: Uint8Array) => {
      created.since += update.length
      created.restSince += update.length
    })
    meters.set(doc, created)
    meter = created
  }
  return meter
}

/** Restarts the body's bound from a body the caller has already serialized (the relay's store). */
export function bodyMeasured(doc: Y.Doc, body: string): void {
  const meter = meterFor(doc)
  meter.bytes = Buffer.byteLength(body)
  meter.since = 0
}

type Struct = Y.Item | Y.GC | Y.Skip

function insertsText(structs: Struct[]): boolean {
  return structs.some((struct) => struct instanceof Y.Item && struct.content instanceof Y.ContentString)
}

/**
 * True when `structs` (a decoded update and the structs Yjs holds pending,
 * which it can unblock) may add to the rest of `doc` (#947): an item that is
 * anything but text in the body (other content, a map entry, text in another
 * type). Deletions add nothing. So plain typing on a note whose rest is over
 * the cap is not measured per keystroke.
 *
 * The answer must follow what Yjs does with the update, not what the update
 * says about itself (#949 review): Yjs skips the structs the document already
 * holds and keeps only the last of two sections for one client, so an
 * update that re-sends an id the document has, or holds one id twice, counts
 * as rest (an honest editor's update carries only new structs) and the full
 * check runs. A decoded item typed next to another one names no parent, only
 * its neighbours (`origin`, `rightOrigin`): its parent is the neighbour's, in
 * the document first (where Yjs looks), else in these structs. A neighbour
 * found in neither (still on its way) counts as rest too.
 */
function addsRest(doc: Y.Doc, structs: Struct[]): boolean {
  const items = new Map<number, Y.Item[]>()
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue
    // An id the document already holds: Yjs would skip or split it, whatever the update claims for it.
    if (struct.id.clock < Y.getState(doc.store, struct.id.client)) return true
    if (!(struct instanceof Y.Item)) continue
    const list = items.get(struct.id.client)
    if (list) list.push(struct)
    else items.set(struct.id.client, [struct])
  }
  for (const list of items.values()) {
    list.sort((a, b) => a.id.clock - b.id.clock)
    // Two structs for one id (a client's section twice): Yjs keeps one, not necessarily the one read here.
    for (let i = 1; i < list.length; i++) if (list[i]!.id.clock < list[i - 1]!.id.clock + list[i - 1]!.length) return true
  }
  /** The item of these structs that holds `id`, or null. */
  const local = (id: Y.ID): Y.Item | null => {
    const list = items.get(id.client)
    if (!list) return null
    let low = 0
    let high = list.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const item = list[mid]!
      if (id.clock < item.id.clock) high = mid - 1
      else if (id.clock >= item.id.clock + item.length) low = mid + 1
      else return item
    }
    return null
  }
  const body = doc.getText('body')
  const known = new Map<Y.Item, boolean>()
  /** Whether `start`'s parent is the root `body`; every item walked through gets the same answer. */
  const inBody = (start: Y.Item): boolean => {
    const walked: Y.Item[] = []
    let item = start
    let answer = false
    for (;;) {
      const seen = known.get(item)
      if (seen !== undefined) {
        answer = seen
        break
      }
      // A cycle of neighbours (a malformed update) ends here, as rest.
      if (walked.length > structs.length) break
      walked.push(item)
      // A map entry (an item typed next to one inherits its key): never body text.
      if (item.parentSub !== null) break
      // Decoded: a root's name, the id of a nested type (never the body, a root), or null (typed next to a neighbour).
      const parent: unknown = item.parent
      if (typeof parent === 'string') {
        answer = parent === 'body'
        break
      }
      if (parent !== null) break
      const neighbour = item.origin ?? item.rightOrigin
      if (neighbour === null) break
      // The document first: Yjs links the item to the neighbour it holds.
      if (neighbour.clock < Y.getState(doc.store, neighbour.client)) {
        const held = Y.getItem(doc.store, neighbour)
        answer = held instanceof Y.Item && held.parent === body && held.parentSub === null
        break
      }
      const next = local(neighbour)
      if (!next) break
      item = next
    }
    for (const item of walked) known.set(item, answer)
    return answer
  }
  return structs.some(
    (struct) =>
      struct instanceof Y.Item &&
      !(struct.content instanceof Y.ContentDeleted) &&
      (!(struct.content instanceof Y.ContentString) || struct.parentSub !== null || !inBody(struct)),
  )
}

/** Bytes of `item`'s own content (a nested type counts one; its content is in its own items). */
function contentBytes(content: Y.Item['content']): number {
  if (content instanceof Y.ContentString) return Buffer.byteLength(content.str)
  if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON) {
    let bytes = 0
    for (const value of content.getContent()) bytes += jsonBytes(value)
    return bytes
  }
  if (content instanceof Y.ContentBinary) return content.content.length
  if (content instanceof Y.ContentEmbed) return jsonBytes(content.embed)
  if (content instanceof Y.ContentFormat) return Buffer.byteLength(content.key) + jsonBytes(content.value)
  if (content instanceof Y.ContentDoc) return Buffer.byteLength(content.doc?.guid ?? '') + jsonBytes(content.opts)
  if (content instanceof Y.ContentType) return 1
  return 0
}

/**
 * The rest of `doc` (everything but the body's text): the bytes of every
 * live item's content and map key, frontmatter included, and entries of the
 * body type's own map (anything under `body` that is not its text, #952), so
 * every byte falls under one of the two bounds. One pass over the document's
 * items, no serialization of the body.
 */
export function restBytes(doc: Y.Doc): number {
  const body = doc.getText('body')
  let bytes = 0
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.deleted) continue
      // Only the body's own text is the body measure's; a map entry on the body root is rest (#952).
      if (struct.parent === body && struct.parentSub === null && struct.content instanceof Y.ContentString) continue
      bytes += contentBytes(struct.content) + (struct.parentSub === null ? 0 : Buffer.byteLength(struct.parentSub))
    }
  }
  return bytes
}

/**
 * The exact sizes of `doc`'s two parts, the "now" updateFits compares an
 * update against (each part may end up within the cap or no larger than
 * this); both bounds restart from them. The relay sends them to an editor it
 * refuses, so the editor resumes under the same rule (#948).
 */
export function documentSizes(doc: Y.Doc): { bodyBytes: number; otherBytes: number } {
  const meter = meterFor(doc)
  meter.bytes = Buffer.byteLength(doc.getText('body').toString())
  meter.since = 0
  meter.rest = restBytes(doc)
  meter.restSince = 0
  return { bodyBytes: meter.bytes, otherBytes: meter.rest }
}

/** False when applying `update` (a Yjs v1 update from a client) would leave the body or the rest over `limit` and larger than now. */
export function updateFits(doc: Y.Doc, update: Uint8Array, limit: number): boolean {
  const meter = meterFor(doc)
  // Yjs keeps pending structs as one v2 update.
  const pending = doc.store.pendingStructs?.update
  const incoming = update.length + (pending?.length ?? 0)
  // Decoded once, only when a bound is passed.
  let decoded: Struct[] | undefined
  const structs = () => (decoded ??= [...Y.decodeUpdate(update).structs, ...(pending ? Y.decodeUpdateV2(pending).structs : [])])

  let bodyFits = meter.bytes + meter.since + incoming <= limit
  if (!bodyFits && !insertsText(structs())) bodyFits = true
  if (!bodyFits) {
    meter.bytes = Buffer.byteLength(doc.getText('body').toString())
    meter.since = 0
    bodyFits = meter.bytes + incoming <= limit
  }

  let restFits = meter.rest + REST_EXPANSION * (meter.restSince + incoming) <= limit
  if (!restFits && !addsRest(doc, structs())) restFits = true
  if (!restFits) {
    meter.rest = restBytes(doc)
    meter.restSince = 0
    restFits = meter.rest + REST_EXPANSION * incoming <= limit
  }
  if (bodyFits && restFits) return true

  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(scratch, update)
    if (!bodyFits) {
      const after = Buffer.byteLength(scratch.getText('body').toString())
      if (after > limit && after > meter.bytes) return false
    }
    if (!restFits) {
      const after = restBytes(scratch)
      if (after > limit && after > meter.rest) return false
    }
    return true
  } finally {
    scratch.destroy()
  }
}
