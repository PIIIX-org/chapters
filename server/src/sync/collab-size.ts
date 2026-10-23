import * as Y from 'yjs'

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
 *    body.
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

function insertsText(structs: Array<Y.Item | Y.GC | Y.Skip>): boolean {
  return structs.some((struct) => struct instanceof Y.Item && struct.content instanceof Y.ContentString)
}

/**
 * Bytes `value` (a value Yjs stores as JSON-like content) takes written out
 * as JSON; binary data counts its length. Measured without building the
 * JSON text: a large Uint8Array would turn into an object ten times its size.
 */
function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value))
  if (value === null || value === undefined) return 4
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value).length
  if (value instanceof Uint8Array) return value.length
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1)
    for (const item of value) bytes += jsonBytes(item)
    return bytes
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    let bytes = 2 + Math.max(0, entries.length - 1)
    for (const [key, item] of entries) bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + jsonBytes(item)
    return bytes
  }
  return 0
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
 * live item's content and map key, frontmatter included. One pass over the
 * document's items, no serialization of the body.
 */
export function restBytes(doc: Y.Doc): number {
  const body = doc.getText('body')
  let bytes = 0
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.deleted) continue
      if (struct.parent === body && struct.content instanceof Y.ContentString) continue
      bytes += contentBytes(struct.content) + (struct.parentSub === null ? 0 : Buffer.byteLength(struct.parentSub))
    }
  }
  return bytes
}

/** False when applying `update` (a Yjs v1 update from a client) would leave the body or the rest over `limit` and larger than now. */
export function updateFits(doc: Y.Doc, update: Uint8Array, limit: number): boolean {
  const meter = meterFor(doc)
  // Yjs keeps pending structs as one v2 update.
  const pending = doc.store.pendingStructs?.update
  const incoming = update.length + (pending?.length ?? 0)

  let bodyFits = meter.bytes + meter.since + incoming <= limit
  if (!bodyFits && !insertsText(Y.decodeUpdate(update).structs) && !(pending && insertsText(Y.decodeUpdateV2(pending).structs))) {
    bodyFits = true
  }
  if (!bodyFits) {
    meter.bytes = Buffer.byteLength(doc.getText('body').toString())
    meter.since = 0
    bodyFits = meter.bytes + incoming <= limit
  }

  let restFits = meter.rest + REST_EXPANSION * (meter.restSince + incoming) <= limit
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
