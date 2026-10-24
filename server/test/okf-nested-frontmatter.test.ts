// #563: OKF §5.2 writes `verified` as `{ by, at }` events and §5.3 has the
// consumer derive the trust tier, so an entry without `tier` is accepted.
// #970: OKF §4.1 "Consumers ... MUST NOT reject documents with unrecognized
// fields" and §10's `parameters`, `executor` and `attester` are nested, so a
// top-level key may hold mappings and lists of mappings, at most 8 levels
// deep. Known keys keep their type checks. A nested value survives every
// path: MCP and REST writes, the `.md` projection, export -> import,
// backup -> restore and the collab fold.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { restoreBackup } from '../src/export/restore.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { OkfValidationError, parseNote, serializeNote, validateNote, type Frontmatter } from '../src/notes/okf.js'
import { flushProjections } from '../src/notes/projector.js'
import { assertFrontmatterFits } from '../src/notes/size-cap.js'
import { getLiveNote, readNote } from '../src/notes/store.js'
import { startCollabServer, type CollabRelay } from '../src/sync/collab-server.js'
import { createActiveUser, loginCookie, loginToken, wipeInstance } from './helpers.js'

/** The nested keys of the OKF sample bundle's computations/revenue-ytd.md and metrics/gross-margin.md. */
const NESTED = {
  runtime: 'bigquery',
  parameters: [{ name: 'year', type: 'integer', required: true }],
  executor: { resource: 'skills/run-on-bq.md', receipt: ['job_id', 'executed_sql', 'result'] },
  attester: { resource: 'attesters/sql_equality.py' },
  not: [{ term: 'revenue minus product cost only', why: 'pre-FY2026 definition', instead: 'revenue minus full COGS' }],
}
const SPEC_VERIFIED = [
  { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
  { by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' },
]

/** `levels` lists nested in each other around one scalar. */
function nestedLists(levels: number): unknown {
  let value: unknown = 'leaf'
  for (let i = 0; i < levels; i++) value = [value]
  return value
}

/** `levels` mappings nested in each other around one scalar. */
function nestedMaps(levels: number): unknown {
  let value: unknown = 'leaf'
  for (let i = 0; i < levels; i++) value = { k: value }
  return value
}

const valid = (frontmatter: Record<string, unknown>) => () => validateNote('metrics', 'm', { type: 'Metric', ...frontmatter } as Frontmatter, '')

describe('validateNote: verified without tier (#563)', () => {
  it('accepts verified exactly as OKF §5.2 writes it: a list of {by, at} and a bare {by, at} mapping', () => {
    expect(valid({ verified: SPEC_VERIFIED })).not.toThrow()
    expect(valid({ verified: SPEC_VERIFIED[0] })).not.toThrow()
  })

  it('still accepts an Elara tier, and still checks tier, by and at when present', () => {
    expect(valid({ verified: { tier: 'human-reviewed', by: 'human:lab' } })).not.toThrow()
    expect(valid({ verified: [{ tier: 'bogus', by: 'human:a', at: '2026-06-25T09:00:00Z' }] })).toThrow(OkfValidationError)
    expect(valid({ verified: { by: 'human:a', at: '2026-06-25' } })).toThrow(OkfValidationError)
    expect(valid({ verified: { by: 7, at: '2026-06-25T09:00:00Z' } })).toThrow(OkfValidationError)
    // An entry that says nothing: neither a tier nor a {by, at} event.
    expect(valid({ verified: {} })).toThrow(OkfValidationError)
    expect(valid({ verified: [{ by: 'human:a' }] })).toThrow(OkfValidationError)
    expect(valid({ verified: 'yes' })).toThrow(OkfValidationError)
  })
})

describe('validateNote: nested producer keys (#970)', () => {
  it('accepts mappings and lists of mappings on §10 computation keys and unknown keys', () => {
    expect(valid(NESTED)).not.toThrow()
    expect(valid({ owner: { team: 'finance', people: [{ id: 'human:a', roles: ['approver'] }] } })).not.toThrow()
    expect(valid({ matrix: [[1, 2], [3, 4]] })).not.toThrow()
  })

  it('accepts 8 levels of nesting and refuses 9, on unknown and structured keys alike', () => {
    expect(valid({ deep: nestedLists(8) })).not.toThrow()
    expect(valid({ deep: nestedMaps(8) })).not.toThrow()
    expect(valid({ deep: nestedLists(9) })).toThrow('frontmatter key "deep" nests more than 8 levels of lists or mappings')
    expect(valid({ deep: nestedMaps(9) })).toThrow('frontmatter key "deep" nests more than 8 levels of lists or mappings')
    expect(valid({ properties: nestedMaps(9) })).toThrow('frontmatter key "properties" nests more than 8 levels')
  })

  it('refuses a hostile depth with a validation error, not a stack overflow, before the size cap measures it', () => {
    const hostile = JSON.parse(`{"type":"Metric","deep":${'['.repeat(200_000)}${']'.repeat(200_000)}}`) as Frontmatter
    expect(() => validateNote('metrics', 'm', hostile, '')).toThrow(OkfValidationError)
    expect(() => assertFrontmatterFits(hostile)).toThrow(OkfValidationError)
  })

  it('keeps the type checks on known keys', () => {
    expect(valid({ title: { en: 'x' } })).toThrow('title must be a string')
    expect(valid({ description: ['x'] })).toThrow('description must be a string')
    expect(valid({ tags: [{ name: 'x' }] })).toThrow('tags must be an array of strings')
    expect(valid({ timestamp: { at: '2026-06-25T09:00:00Z' } })).toThrow('timestamp must be an ISO 8601 datetime')
    expect(valid({ status: { value: 'active' } })).toThrow('status must be one of')
    expect(valid({ resource: { uri: 'x' } })).toThrow('resource must be a string')
    expect(() => validateNote('metrics', 'm', { type: { name: 'Metric' } } as unknown as Frontmatter, '')).toThrow(
      'frontmatter type must be a non-empty string',
    )
  })

  it('keeps the round-trip check for nested values', () => {
    expect(valid({ nested: { at: new Date(0) } })).toThrow(/does not survive serialization/)
  })
})

let app: FastifyInstance
let collab: CollabRelay
let port: number
let cookie: string
let token: string
let vaultId: string
let mcp: Client
const providers: HocuspocusProvider[] = []

async function mcpCall(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await mcp.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The note's `.md` projection, once the projector caught up. */
async function projected(vault: string, path: string): Promise<string> {
  await flushProjections()
  return readFile(join(config.dataDir, 'vaults', vault, `${path}.md`), 'utf8')
}

async function importZip(archive: Buffer): Promise<{ vaultId: string; imported: number; skipped: string[] }> {
  const boundary = '----nestedboundary'
  const res = await app.inject({
    method: 'POST',
    url: '/api/import',
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="export.zip"\r\ncontent-type: application/zip\r\n\r\n`),
      archive,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json()
}

async function exportZip(vault: string): Promise<AdmZip> {
  const res = await app.inject({ method: 'GET', url: `/api/vaults/${vault}/export`, headers: { cookie } })
  expect(res.statusCode).toBe(200)
  return new AdmZip(res.rawPayload)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  port = typeof address === 'object' && address ? address.port : 0
  collab = startCollabServer(app.server)
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  token = await loginToken(app, owner.email)
  vaultId = (await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Nested' } })).json<{ id: string }>().id
  const minted = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body: { name: 'nested', scope: 'account' } })
  mcp = new Client({ name: 'nested-test', version: '0.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` } },
    }),
  )
})

afterAll(async () => {
  providers.forEach((p) => p.destroy())
  await mcp.close()
  await collab.destroy()
  await app.close()
})

describe('nested frontmatter on every path (#970, #563)', () => {
  it('create_note and edit_note (MCP) store nested values and tierless verified; the .md file reads back the same', async () => {
    const created = await mcpCall('create_note', {
      vaultId,
      path: 'computations/revenue-ytd',
      frontmatter: { type: 'Attested Computation', ...NESTED, verified: SPEC_VERIFIED },
      body: 'Revenue for a fiscal year.\n',
    })
    expect(created.isError, created.text).toBe(false)
    const edited = await mcpCall('edit_note', {
      vaultId,
      path: 'computations/revenue-ytd',
      frontmatter: { parameters: [...NESTED.parameters, { name: 'region', type: 'string', required: false }] },
      ops: [{ op: 'frontmatter_add', key: 'not', value: { term: 'bookings', why: 'not recognized', instead: 'revenue' } }],
    })
    expect(edited.isError, edited.text).toBe(false)

    const want = {
      ...NESTED,
      parameters: [...NESTED.parameters, { name: 'region', type: 'string', required: false }],
      not: [...NESTED.not, { term: 'bookings', why: 'not recognized', instead: 'revenue' }],
      verified: SPEC_VERIFIED,
    }
    const note = await readNote(vaultId, 'computations/revenue-ytd')
    expect(note?.frontmatter).toMatchObject(want)
    const file = await projected(vaultId, 'computations/revenue-ytd')
    expect(parseNote(file).frontmatter).toEqual(note?.frontmatter)
    expect(file).toBe(serializeNote({ frontmatter: note!.frontmatter, body: note!.body }))
  })

  it('REST create and PUT store nested values', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'metrics', name: 'gross-margin', frontmatter: { type: 'Metric', not: NESTED.not }, body: 'Gross margin.\n' },
    })
    expect(created.statusCode, created.body).toBe(200)
    const put = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/metrics/gross-margin`,
      headers: { cookie },
      body: { frontmatter: { executor: NESTED.executor } },
    })
    expect(put.statusCode, put.body).toBe(200)
    expect((await getLiveNote(vaultId, 'metrics/gross-margin'))?.frontmatter).toMatchObject({ not: NESTED.not, executor: NESTED.executor })
    const refused = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/metrics/gross-margin`,
      headers: { cookie },
      body: { frontmatter: { deep: nestedMaps(9) } },
    })
    expect(refused.statusCode).toBe(400)
  })

  it('an edit in the collab editor folds a nested value into the row and the file', async () => {
    const note = await getLiveNote(vaultId, 'metrics/gross-margin')
    const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: `${vaultId}/~${note!.id}`, token, document: new Y.Doc() })
    providers.push(provider)
    await waitFor(() => provider.isSynced && provider.document.getText('body').length > 0)
    provider.document.getMap('frontmatter').set('attester', { resource: 'attesters/margin.py', checks: [{ name: 'equality' }] })
    await waitFor(async () => (await readNote(vaultId, 'metrics/gross-margin'))?.frontmatter.attester !== undefined)
    const row = await readNote(vaultId, 'metrics/gross-margin')
    expect(row?.frontmatter).toMatchObject({ not: NESTED.not, attester: { resource: 'attesters/margin.py', checks: [{ name: 'equality' }] } })
    await waitFor(async () => parseNote(await projected(vaultId, 'metrics/gross-margin')).frontmatter.attester !== undefined)
    provider.destroy()
  })

  it('export -> import -> export keeps nested notes byte for byte', async () => {
    const first = await exportZip(vaultId)
    const files = ['computations/revenue-ytd.md', 'metrics/gross-margin.md']
    for (const f of files) expect(first.getEntry(f), f).not.toBeNull()

    const imported = await importZip(first.toBuffer())
    expect(imported.skipped).toEqual([])
    expect(imported.imported).toBe(2)
    for (const f of files) {
      const path = f.replace(/\.md$/, '')
      expect((await readNote(imported.vaultId, path))?.frontmatter).toEqual((await readNote(vaultId, path))?.frontmatter)
    }

    const second = await exportZip(imported.vaultId)
    for (const f of files) expect(second.getEntry(f)!.getData().toString('utf8'), f).toBe(first.getEntry(f)!.getData().toString('utf8'))
  })

  // Last: a restore needs an empty instance, so it wipes what the tests above made.
  it('backup -> restore keeps nested notes', async () => {
    await flushProjections()
    const before = await readNote(vaultId, 'computations/revenue-ytd')
    const beforeFile = await projected(vaultId, 'computations/revenue-ytd')
    const archive = await buildInstanceBackup()
    await wipeInstance()
    const plan = await restoreBackup(archive)
    expect(plan.warnings.filter((w) => w.includes('skipped'))).toEqual([])
    const after = await readNote(vaultId, 'computations/revenue-ytd')
    expect(after?.frontmatter).toEqual(before?.frontmatter)
    expect(await projected(vaultId, 'computations/revenue-ytd')).toBe(beforeFile)
  })
})
