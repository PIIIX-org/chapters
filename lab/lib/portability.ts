// Helpers shared by the portability tests (export-roundtrip, backup-restore,
// attachments, multilingual-search): a zip reader (no dependencies on the
// runner), binary fixtures (real PNG/PDF bytes), multipart upload and raw
// downloads with the bootstrap session cookie, SQL against a second
// database in the db container, the OKF reference parser bridge, and a
// minimal JSON Schema checker for the vendored OKF schemas (vendor/okf).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deflateSync, inflateRawSync } from 'node:zlib'
import { COMPOSE, exec } from './docker.ts'

// ------------------------------------------------------------------ zip

export interface ZipEntry {
  name: string
  data: Uint8Array
  /** 0 = stored, 8 = deflate. */
  method: number
  /** General-purpose flag bit 11: file name is UTF-8. */
  utf8Flag: boolean
}

/** Reads every file entry of a zip (central directory walk). Directories are skipped. */
export function readZip(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`zip: bad central directory entry at ${p}`)
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
    const raw = buf.subarray(start, start + csize)
    let data: Uint8Array
    if (method === 0) data = raw.slice()
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw))
    else throw new Error(`zip: unsupported method ${method} for ${name}`)
    out.push({ name, data, method, utf8Flag: (flags & 0x800) !== 0 })
  }
  return out
}

/** Writes zip entries to a directory (for the external OKF parser). */
export function extractZip(entries: ZipEntry[], dir: string): void {
  for (const e of entries) {
    if (e.name.includes('..') || e.name.startsWith('/')) throw new Error(`zip slip: ${e.name}`)
    const target = join(dir, e.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, e.data)
  }
}

/** Store-only zip (UTF-8 names) for crafted import archives. */
export function writeZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x800, true)
    lv.setUint16(12, 0x21, true) // 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, f.data.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    lh.set(name, 30)
    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, f.data.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    ch.set(name, 46)
    locals.push(lh, f.data)
    centrals.push(ch)
    offset += lh.length + f.data.length
  }
  const cd = concat(centrals)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cd.length, true)
  ev.setUint32(16, offset, true)
  return concat([...locals, cd, eocd])
}

// ------------------------------------------------------------- fixtures

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  const typed = new TextEncoder().encode(type)
  out.set(typed, 4)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A real, decodable RGB PNG (w x h) whose pixels depend on `seed`. */
export function makePng(w: number, h: number, seed: number): Uint8Array {
  const stride = 1 + w * 3
  const rows = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      rows[o] = (x * 37 + seed) & 0xff
      rows[o + 1] = (y * 53 + seed * 3) & 0xff
      rows[o + 2] = (x * y + seed * 7) & 0xff
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(rows))),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  return concat(parts)
}

/** A minimal valid one-page PDF whose content stream shows `text` (Helvetica, WinAnsi). */
export function makePdf(text: string): Uint8Array {
  const esc = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = `BT /F1 14 Tf 20 100 Td (${esc}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

// --------------------------------------------------------------- http

export interface RawResponse {
  status: number
  headers: Record<string, string>
  bytes: Uint8Array
  text: string
  json: unknown
}

async function toRaw(res: Response): Promise<RawResponse> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), bytes, text, json }
}

/** GET with an optional session cookie; returns the raw bytes and headers. */
export async function getRaw(baseUrl: string, path: string, cookie?: string): Promise<RawResponse> {
  const res = await fetch(baseUrl + path, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  })
  return toRaw(res)
}

/** multipart/form-data POST with one `file` field — what client/src/api/assets.ts sends. */
export async function postFile(
  baseUrl: string,
  path: string,
  cookie: string | undefined,
  fileName: string,
  bytes: Uint8Array,
  mime: string,
): Promise<RawResponse> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), fileName)
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(300_000),
  })
  return toRaw(res)
}

// ---------------------------------------------------------------- sql

/** SQL string literal (standard_conforming_strings is on in Postgres >= 9.1). */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** psql -At against an arbitrary database in the db container. */
export async function psqlDb(database: string, sql: string): Promise<string> {
  const r = await exec(
    [...COMPOSE, 'exec', '-T', 'db', 'sh', '-c', `psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d ${database}`],
    sql,
  )
  if (r.code !== 0) throw new Error(`psql(${database}) failed (${r.code}): ${r.stderr.slice(0, 1000)}\nSQL: ${sql.slice(0, 300)}`)
  return r.stdout.trim()
}

export async function psqlRowsDb<T = Record<string, unknown>>(database: string, query: string): Promise<T[]> {
  const out = await psqlDb(database, `select coalesce(json_agg(t), '[]'::json) from (${query}) t;`)
  return JSON.parse(out) as T[]
}

// ------------------------------------------------------------ compare

/** Canonical JSON (sorted keys) for structural equality of JSON values. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Paths where two JSON values differ (dotted), for diff tables. */
export function jsonDiff(a: unknown, b: unknown, path = ''): string[] {
  if (canon(a) === canon(b)) return []
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    return keys.flatMap((k) => jsonDiff(a[k], b[k], path ? `${path}.${k}` : k))
  }
  return [`${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`]
}

/** First differing byte offset of two strings' UTF-8 encodings, or -1. */
export function firstByteDiff(a: string, b: string): number {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return i
  return x.length === y.length ? -1 : n
}

// --------------------------------------------------- OKF (vendor/okf)

/**
 * Splits a markdown file into frontmatter text and body the way generic
 * frontmatter readers do (line-based: first line `---`, next line that is
 * exactly `---`). Independent of Elara's regex in server/src/notes/okf.ts.
 */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---\n', 3)
  const endEof = raw.endsWith('\n---') ? raw.length - 4 : -1
  if (end < 0 && endEof < 0) return null
  const at = end >= 0 ? end : endEof
  return { yaml: raw.slice(4, at + 1), body: raw.slice(at + 5) }
}

/** Bun's built-in YAML parser (YAML 1.2), an implementation independent of Elara's `yaml` package. */
export function bunYamlParse(text: string): unknown {
  // Bun.YAML exists since Bun 1.2.21; the type may lag in @types/bun.
  const y = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML
  return y.parse(text)
}

type Schema = {
  $ref?: string
  type?: string | string[]
  required?: string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean | Schema
  items?: Schema
  enum?: unknown[]
  pattern?: string
  oneOf?: Schema[]
}

const schemaCache = new Map<string, Schema>()
export function loadOkfSchema(file: string): Schema {
  let s = schemaCache.get(file)
  if (!s) {
    s = JSON.parse(readFileSync(join('vendor/okf/schemas', file), 'utf8')) as Schema
    schemaCache.set(file, s)
  }
  return s
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

/**
 * The subset of JSON Schema 2020-12 the vendored OKF schemas use: $ref
 * (sibling file), type, required, properties, additionalProperties, items,
 * enum, pattern, oneOf. Returns error strings (empty = valid).
 */
export function validateSchema(value: unknown, schema: Schema, path = '$'): string[] {
  if (schema.$ref) return validateSchema(value, loadOkfSchema(schema.$ref.replace(/^\.\//, '')), path)
  const errors: string[] = []
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const t = typeOf(value)
    const okType = types.some((x) => x === t || (x === 'number' && t === 'integer'))
    if (!okType) return [`${path}: expected ${types.join('|')}, got ${t} (${JSON.stringify(value)?.slice(0, 60)})`]
  }
  if (schema.enum && !schema.enum.some((e) => canon(e) === canon(value))) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`)
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`)
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => validateSchema(value, s, path).length === 0).length
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf (expected exactly 1)`)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    for (const r of schema.required ?? []) if (!(r in o)) errors.push(`${path}: missing required "${r}"`)
    for (const [k, v] of Object.entries(o)) {
      const sub = schema.properties?.[k]
      if (sub) errors.push(...validateSchema(v, sub, `${path}.${k}`))
      else if (schema.additionalProperties === false) errors.push(`${path}: additional property "${k}"`)
      else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(v, schema.additionalProperties, `${path}.${k}`))
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateSchema(v, schema.items!, `${path}[${i}]`)))
  }
  return errors
}

/** One file as read by the OKF reference parser (lab/okf_ref_check.py). */
export interface OkfRefDoc {
  path: string
  ok: boolean
  error?: string
  frontmatter?: Record<string, unknown>
  body?: string
  validateError?: string | null
  trustTier?: string
  isStale?: boolean
  reserved?: boolean
}

/**
 * Runs the pinned OKF reference parser (GoogleCloudPlatform/open-knowledge-format
 * src/reference_agent/bundle/document.py, fetched by the workflow into
 * /tmp/okf-ref) over a bundle directory. null = parser unavailable.
 */
export async function okfReferenceParse(dir: string): Promise<{ docs: OkfRefDoc[] | null; stderr: string; parser: string }> {
  const r = await exec(['python3', 'lab/okf_ref_check.py', dir])
  if (r.code !== 0) return { docs: null, stderr: r.stderr.slice(0, 2000), parser: '' }
  const out = JSON.parse(r.stdout) as { parser: string; docs: OkfRefDoc[] }
  return { docs: out.docs, stderr: r.stderr.slice(0, 2000), parser: out.parser }
}

// -------------------------------------------------- vault snapshots

/** One notes row as ground truth (live and trashed), with revision count and wikilink targets. */
export interface NoteRow {
  id: string
  vault_id: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  trashed: boolean
  revisions: number
  links: string[]
  embedded: boolean
}

/** SQL ground truth for the notes of some vaults; `database` null = the app's own database. */
export async function noteSnapshot(database: string | null, vaultIds: string[]): Promise<NoteRow[]> {
  const query = `select n.id, n.vault_id, n.path, n.frontmatter, n.body, n.deleted_at is not null as trashed,
      (select count(*) from note_revisions r where r.note_id = n.id)::int as revisions,
      coalesce((select json_agg(l.target_path order by l.target_path) from note_links l where l.source_note_id = n.id), '[]'::json) as links,
      n.embedding is not null as embedded
    from notes n where n.vault_id in (${vaultIds.map(lit).join(',') || 'null'})
    order by n.vault_id, n.path, n.created_at`
  return database ? psqlRowsDb<NoteRow>(database, query) : psqlRowsDb<NoteRow>('"$POSTGRES_DB"', query)
}

export interface AssetInfo {
  fileName: string
  size: number
  sha256: string
}

/** Assets of a vault through the REST routes the UI uses (list + download each). */
export async function assetSnapshot(baseUrl: string, cookie: string, vaultId: string): Promise<AssetInfo[]> {
  const list = await getRaw(baseUrl, `/api/vaults/${vaultId}/assets`, cookie)
  if (list.status !== 200) throw new Error(`asset list ${vaultId}: ${list.status} ${list.text.slice(0, 200)}`)
  // Shape of GET /api/vaults/:id/assets (server/src/notes/routes.ts:342-349).
  const listed = list.json as { assets: Array<{ fileName: string; size: number }> }
  const assets = listed.assets
  const out: AssetInfo[] = []
  for (const a of assets) {
    const r = await getRaw(baseUrl, `/api/vaults/${vaultId}/assets/${encodeURIComponent(a.fileName)}`, cookie)
    out.push({ fileName: a.fileName, size: r.bytes.length, sha256: r.status === 200 ? sha256(r.bytes) : `HTTP ${r.status}` })
  }
  return out.sort((x, y) => x.fileName.localeCompare(y.fileName))
}

/** `/api/vaults/<id>/assets/<file>` references in a note body (the form the editor inserts). */
export function assetRefs(body: string): Array<{ vaultId: string; fileName: string }> {
  return [...body.matchAll(/\/api\/vaults\/([0-9a-f-]{36})\/assets\/([A-Za-z0-9._%-]+)/g)].map((m) => ({
    vaultId: m[1]!,
    fileName: decodeURIComponent(m[2]!),
  }))
}

/**
 * Polls `probe` until it returns a value (not undefined) or `timeoutMs` passes.
 * Live-server integration: the server exposes no event for queue/collab
 * completion, so the awaited condition is re-read instead of guessed with a sleep.
 */
export async function poll<T>(probe: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 500): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const v = await probe()
    if (v !== undefined || performance.now() > deadline) return v
    await Bun.sleep(intervalMs)
  }
}
