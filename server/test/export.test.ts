import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let readerCookie: string
let vaultId: string
let teammate: Awaited<ReturnType<typeof createActiveUser>>

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const reader = await createActiveUser()
  teammate = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  readerCookie = await loginCookie(app, reader.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Export vault' },
    })).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: teammate.id, permission: 'edit' },
  })
  for (const [type, name, body] of [
    ['people', 'ada', 'Analytical engines.'],
    ['projects', 'engine', 'See [[people/ada]].'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type, name, body },
    })
  }
  // One trashed note — must be excluded from exports.
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/notes`,
    headers: { cookie: ownerCookie },
    body: { type: 'people', name: 'ghost', body: 'Deleted soon.' },
  })
  await app.inject({
    method: 'DELETE',
    url: `/api/vaults/${vaultId}/notes/people/ghost`,
    headers: { cookie: ownerCookie },
  })
})

afterAll(async () => app.close())

describe('export', () => {
  it('vault zip contains the OKF tree + manifest, trash excluded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/export`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    const zip = new AdmZip(res.rawPayload)
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('people/ada.md')
    expect(names).toContain('projects/engine.md')
    expect(names).toContain('manifest.json')
    expect(names.some((n) => n.includes('ghost'))).toBe(false)

    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as {
      name: string
      shares: Array<{ email?: string; permission: string }>
    }
    expect(manifest.name).toBe('Export vault')
    expect(manifest.shares.some((s) => s.email === teammate.email)).toBe(true)

    const ada = zip.getEntry('people/ada.md')!.getData().toString('utf8')
    expect(ada).toMatch(/^---\n/)
    expect(ada).toContain('Analytical engines.')
  })

  it('read-only users cannot export in any form', async () => {
    for (const url of [
      `/api/vaults/${vaultId}/export`,
      `/api/vaults/${vaultId}/export/note/people/ada`,
      `/api/vaults/${vaultId}/export-links`,
    ]) {
      const res = await app.inject({
        method: url.endsWith('export-links') ? 'POST' : 'GET',
        url,
        headers: { cookie: readerCookie },
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('share links download sessionless, and revocation kills them', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/vaults/${vaultId}/export-links`,
        headers: { cookie: ownerCookie },
      })
    ).json() as { id: string; token: string }

    const download = await app.inject({
      method: 'GET',
      url: `/api/export-links/${created.token}`,
    })
    expect(download.statusCode).toBe(200)
    expect(new AdmZip(download.rawPayload).getEntry('people/ada.md')).toBeTruthy()

    await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}/export-links/${created.id}`,
      headers: { cookie: ownerCookie },
    })
    const after = await app.inject({ method: 'GET', url: `/api/export-links/${created.token}` })
    expect(after.statusCode).toBe(404)
  })

  it('import recreates the vault for the importer, validates notes, reports unmatched shares', async () => {
    const exportRes = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/export`,
      headers: { cookie: ownerCookie },
    })
    const zip = new AdmZip(exportRes.rawPayload)
    zip.addFile('bad type/oops.md', Buffer.from('---\ntype: bad type\n---\nnope', 'utf8'))
    const archive = zip.toBuffer()

    const importer = await createActiveUser()
    const importerCookie = await loginCookie(app, importer.email)
    const boundary = '----testboundary'
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="export.zip"\r\ncontent-type: application/zip\r\n\r\n`,
      ),
      archive,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: {
        cookie: importerCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    expect(res.statusCode).toBe(200)
    const result = res.json() as {
      vaultId: string
      imported: number
      skipped: string[]
      unmatchedShares: string[]
    }
    expect(result.imported).toBe(2)
    expect(result.skipped.length).toBe(1)
    // teammate exists on this instance → re-shared; reader too; importer owns.
    const access = await app.inject({
      method: 'GET',
      url: `/api/vaults/${result.vaultId}/access`,
      headers: { cookie: importerCookie },
    })
    expect((access.json() as { access: string }).access).toBe('owner')
    const teammateCookie = await loginCookie(app, teammate.email)
    const teammateAccess = await app.inject({
      method: 'GET',
      url: `/api/vaults/${result.vaultId}/access`,
      headers: { cookie: teammateCookie },
    })
    expect((teammateAccess.json() as { access: string }).access).toBe('edit')
  })

  it('admin backup bundles vaults + account dump; non-admins rejected', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/api/admin/backup',
      headers: { cookie: ownerCookie },
    })
    expect(denied.statusCode).toBe(403)

    const admin = await createActiveUser({ role: 'admin' })
    const adminCookie = await loginCookie(app, admin.email)
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/backup',
      headers: { cookie: adminCookie },
    })
    expect(res.statusCode).toBe(200)
    const zip = new AdmZip(res.rawPayload)
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('account-dump.json')
    expect(names.some((n) => n.startsWith(`vaults/${vaultId}/`))).toBe(true)
    const dump = JSON.parse(zip.getEntry('account-dump.json')!.getData().toString('utf8')) as {
      users: Array<{ email: string }>
      vaultShares: unknown[]
    }
    expect(dump.users.length).toBeGreaterThan(0)
  })
})
