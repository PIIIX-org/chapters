import * as Y from 'yjs'

/**
 * UTF-8 bytes of `text`, which is how the relay measures a note against its
 * cap (server/src/notes/size-cap.ts), counted without encoding a copy.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair: one 4-byte character.
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** A size in UTF-8 bytes, for the notices that quote one. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Bytes `value` (a value Yjs stores as JSON-like content) takes written out
 * as JSON; binary data counts its length.
 */
function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return utf8Length(JSON.stringify(value))
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
    for (const [key, item] of entries) bytes += jsonBytes(key) + 1 + jsonBytes(item)
    return bytes
  }
  return 0
}

function contentBytes(content: Y.Item['content']): number {
  if (content instanceof Y.ContentString) return utf8Length(content.str)
  if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON) {
    let bytes = 0
    for (const value of content.getContent()) bytes += jsonBytes(value)
    return bytes
  }
  if (content instanceof Y.ContentBinary) return content.content.length
  if (content instanceof Y.ContentEmbed) return jsonBytes(content.embed)
  if (content instanceof Y.ContentFormat) return utf8Length(content.key) + jsonBytes(content.value)
  if (content instanceof Y.ContentDoc) return utf8Length(content.doc?.guid ?? '') + jsonBytes(content.opts)
  if (content instanceof Y.ContentType) return 1
  return 0
}

/**
 * Everything in `doc` but the body's text, in bytes: the frontmatter's keys
 * and values as JSON, and any other content, map entries on the body root
 * included (#952). The relay bounds it by the same
 * cap as the body (#780) and measures it the same way
 * (server/src/sync/collab-size.ts `restBytes`), so the editor knows when a
 * change it refused fits again.
 */
export function restBytes(doc: Y.Doc): number {
  const body = doc.getText('body')
  let bytes = 0
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.deleted) continue
      // Only the body's own text is the body measure's; a map entry on the body root is rest (#952).
      if (struct.parent === body && struct.parentSub === null && struct.content instanceof Y.ContentString) continue
      bytes += contentBytes(struct.content) + (struct.parentSub === null ? 0 : utf8Length(struct.parentSub))
    }
  }
  return bytes
}
