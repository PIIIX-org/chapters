import * as Y from 'yjs'

/**
 * The relay's side of the note size cap (#491, notes/size-cap.ts): decides,
 * before a client's Yjs update is applied, whether it would push the note
 * body past the cap. Measuring the body per keystroke would serialize the
 * whole note on every one, so each document keeps a running upper bound
 * instead, and the exact (whole-document) work only happens near the cap:
 *
 * 1. Bound: body bytes at the last exact measure, plus the length of every
 *    update applied since (an update carries its inserted text as UTF-8, so
 *    it cannot add more body bytes than its own length, whatever its origin:
 *    clients, MCP/REST writes through openDirectConnection, the load), plus
 *    this update and the structs Yjs holds pending (this update can unblock
 *    them).
 * 2. An update that inserts no text (deletions, frontmatter) cannot grow the
 *    body.
 * 3. Exact: measure the body now; the bound restarts from it.
 * 4. Otherwise apply the update to a scratch copy and measure: at most the
 *    larger of the cap and the current body, plus one frame of work. The
 *    update fits if the body ends up within the cap or no larger than now, so
 *    a note already over the cap (stored before it) can shrink, even in an
 *    update that also adds text (an editor's reconnect sends its typing and
 *    its cuts together), as assertBodyFits allows.
 */
interface Meter {
  /** Body UTF-8 bytes at the last exact measure. */
  bytes: number
  /** Lengths of the updates applied since. */
  since: number
}

const meters = new WeakMap<Y.Doc, Meter>()

function meterFor(doc: Y.Doc): Meter {
  let meter = meters.get(doc)
  if (!meter) {
    const created: Meter = { bytes: Buffer.byteLength(doc.getText('body').toString()), since: 0 }
    doc.on('update', (update: Uint8Array) => {
      created.since += update.length
    })
    meters.set(doc, created)
    meter = created
  }
  return meter
}

/** Restarts the bound from a body the caller has already serialized (the relay's store). */
export function bodyMeasured(doc: Y.Doc, body: string): void {
  const meter = meterFor(doc)
  meter.bytes = Buffer.byteLength(body)
  meter.since = 0
}

function insertsText(structs: Array<Y.Item | Y.GC | Y.Skip>): boolean {
  return structs.some((struct) => struct instanceof Y.Item && struct.content instanceof Y.ContentString)
}

/** False when applying `update` (a Yjs v1 update from a client) would leave the body over `limit` and larger than now. */
export function updateFits(doc: Y.Doc, update: Uint8Array, limit: number): boolean {
  const meter = meterFor(doc)
  // Yjs keeps pending structs as one v2 update.
  const pending = doc.store.pendingStructs?.update
  const pendingBytes = pending?.length ?? 0
  if (meter.bytes + meter.since + update.length + pendingBytes <= limit) return true
  if (!insertsText(Y.decodeUpdate(update).structs) && !(pending && insertsText(Y.decodeUpdateV2(pending).structs))) {
    return true
  }
  meter.bytes = Buffer.byteLength(doc.getText('body').toString())
  meter.since = 0
  if (meter.bytes + update.length + pendingBytes <= limit) return true
  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(scratch, update)
    const after = Buffer.byteLength(scratch.getText('body').toString())
    return after <= limit || after <= meter.bytes
  } finally {
    scratch.destroy()
  }
}
