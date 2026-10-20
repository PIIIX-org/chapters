import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { teams, users, vaultShares } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #621: an import used to grant every active user named in the archive's
// manifest.json the listed permission on the new vault, without asking. A
// crafted archive could hand anyone edit access. Now nothing is granted unless
// the importer opts in, and even then only to grantees that exist and are
// active here, at read or edit (never above the importer's own access).

let app: FastifyInstance
type User = typeof users.$inferSelect

let importer: User
let importerCookie: string
let editor: User
let reader: User
let deactivated: User
let teamName: string
let teamId: string
let ambiguousTeam: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  importer = await createActiveUser()
  importerCookie = await loginCookie(app, importer.email)
  editor = await createActiveUser()
  reader = await createActiveUser()
  deactivated = await createActiveUser({ status: 'deactivated' })
  teamName = `import-team-${Date.now()}`
  teamId = (await db.insert(teams).values({ name: teamName }).returning())[0]!.id
  ambiguousTeam = `twin-team-${Date.now()}`
  await db.insert(teams).values([{ name: ambiguousTeam }, { name: ambiguousTeam }])
})

afterAll(async () => app.close())

// What a real export of a shared vault carries: every grantee valid here.
function validShares() {
  return [
    { granteeType: 'user', email: editor.email, permission: 'edit' },
    { granteeType: 'user', email: reader.email.toUpperCase(), permission: 'read' },
    { granteeType: 'team', teamName, permission: 'read' },
  ]
}

function manifestShares() {
  return [
    ...validShares(),
    { granteeType: 'user', email: deactivated.email, permission: 'edit' },
    { granteeType: 'user', email: 'nobody-here@example.invalid', permission: 'read' },
    { granteeType: 'user', email: importer.email, permission: 'read' },
    { granteeType: 'user', email: reader.email, permission: 'edit' },
    { granteeType: 'team', teamName: ambiguousTeam, permission: 'read' },
    { granteeType: 'team', teamName: 'no-such-team', permission: 'read' },
  ]
}

async function importArchive(shares: unknown[], query = '') {
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ name: 'Shared vault', mergeable: false, shares }), 'utf8'))
  zip.addFile('people/ada.md', Buffer.from('---\ntype: people\n---\nAnalytical engines.\n', 'utf8'))
  const boundary = '----importshares'
  const res = await app.inject({
    method: 'POST',
    url: `/api/import${query}`,
    headers: { cookie: importerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="v.zip"\r\ncontent-type: application/zip\r\n\r\n`,
      ),
      zip.toBuffer(),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  })
  return res
}

interface ShareOutcome {
  granteeType: string
  grantee: string
  permission: string
  reason?: string
}

interface ImportResult {
  vaultId: string
  imported: number
  appliedShares: ShareOutcome[]
  skippedShares: ShareOutcome[]
}

async function sharesOf(vaultId: string) {
  return db
    .select({ granteeType: vaultShares.granteeType, granteeId: vaultShares.granteeId, permission: vaultShares.permission })
    .from(vaultShares)
    .where(eq(vaultShares.vaultId, vaultId))
}

describe('import never grants access from the manifest unless asked (#621)', () => {
  it('grants nothing by default and reports every manifest share as skipped', async () => {
    const res = await importArchive(validShares())
    expect(res.statusCode).toBe(200)
    const result: ImportResult = res.json()
    expect(result.imported).toBe(1)
    expect(await sharesOf(result.vaultId)).toEqual([])
    expect(result.appliedShares).toEqual([])
    expect(result.skippedShares).toHaveLength(validShares().length)
    expect(result.skippedShares.every((s) => s.reason === 'not_requested')).toBe(true)
    expect(result.skippedShares[0]).toEqual({
      granteeType: 'user',
      grantee: editor.email,
      permission: 'edit',
      reason: 'not_requested',
    })
  })

  it('applyShares=false is the same as leaving it out', async () => {
    const res = await importArchive(validShares(), '?applyShares=false')
    expect(res.statusCode).toBe(200)
    const result: ImportResult = res.json()
    expect(await sharesOf(result.vaultId)).toEqual([])
  })

  it('with applyShares=true, applies only shares to existing active grantees and reports the rest', async () => {
    const res = await importArchive(manifestShares(), '?applyShares=true')
    expect(res.statusCode).toBe(200)
    const result: ImportResult = res.json()

    const rows = await sharesOf(result.vaultId)
    expect(rows).toHaveLength(3)
    expect(rows).toEqual(
      expect.arrayContaining([
        { granteeType: 'user', granteeId: editor.id, permission: 'edit' },
        { granteeType: 'user', granteeId: reader.id, permission: 'read' },
        { granteeType: 'team', granteeId: teamId, permission: 'read' },
      ]),
    )
    expect(result.appliedShares).toEqual([
      { granteeType: 'user', grantee: editor.email, permission: 'edit' },
      { granteeType: 'user', grantee: reader.email, permission: 'read' },
      { granteeType: 'team', grantee: teamName, permission: 'read' },
    ])
    expect(result.skippedShares).toEqual([
      { granteeType: 'user', grantee: deactivated.email, permission: 'edit', reason: 'no_active_user' },
      { granteeType: 'user', grantee: 'nobody-here@example.invalid', permission: 'read', reason: 'no_active_user' },
      { granteeType: 'user', grantee: importer.email, permission: 'read', reason: 'importer' },
      { granteeType: 'user', grantee: reader.email, permission: 'edit', reason: 'duplicate' },
      { granteeType: 'team', grantee: ambiguousTeam, permission: 'read', reason: 'ambiguous_team' },
      { granteeType: 'team', grantee: 'no-such-team', permission: 'read', reason: 'no_team' },
    ])

    // The opted-in grant is real access, at exactly the archived level.
    const editorCookie = await loginCookie(app, editor.email)
    const access = await app.inject({
      method: 'GET',
      url: `/api/vaults/${result.vaultId}/access`,
      headers: { cookie: editorCookie },
    })
    const body: unknown = access.json()
    expect(body).toEqual({ access: 'edit' })
  })

  it('never grants a permission above edit, or a malformed entry, even when asked', async () => {
    const res = await importArchive(
      [
        { granteeType: 'user', email: editor.email, permission: 'owner' },
        { granteeType: 'user', email: reader.email, permission: 'admin' },
        { granteeType: 'user', permission: 'read' },
        { granteeType: 'robot', email: editor.email, permission: 'read' },
      ],
      '?applyShares=true',
    )
    expect(res.statusCode).toBe(200)
    const result: ImportResult = res.json()
    expect(await sharesOf(result.vaultId)).toEqual([])
    expect(result.appliedShares).toEqual([])
    expect(result.skippedShares.map((s) => s.reason)).toEqual([
      'invalid_permission',
      'invalid_permission',
      'invalid_entry',
      'invalid_entry',
    ])
  })
})
