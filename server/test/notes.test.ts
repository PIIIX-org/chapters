import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let readerCookie: string
let strangerCookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const reader = await createActiveUser()
  const stranger = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  readerCookie = await loginCookie(app, reader.email)
  strangerCookie = await loginCookie(app, stranger.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'Notes vault' },
    })).json() as { id: string }
  ).id
  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
  })
})

afterAll(async () => app.close())

function vaultFile(...parts: string[]): string {
  return join(config.dataDir, 'vaults', vaultId, ...parts)
}

describe('notes CRUD + OKF on disk', () => {
  it('creates a note, writes the OKF file and the type index.md', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'people', name: 'john-doe', body: 'Hello [[projects/apollo]]' },
    })
    expect(res.statusCode).toBe(200)

    const raw = await readFile(vaultFile('people', 'john-doe.md'), 'utf8')
    expect(raw).toMatch(/^---\n/)
    expect(raw).toContain('type: people')
    expect(raw).toContain('Hello [[projects/apollo]]')

    const index = await readFile(vaultFile('people', 'index.md'), 'utf8')
    expect(index).toContain('[[people/john-doe]]')
  })

  it('rejects duplicates and invalid paths', async () => {
    const dupe = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'people', name: 'john-doe' },
    })
    expect(dupe.statusCode).toBe(409)

    const traversal = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: '..', name: 'evil' },
    })
    expect(traversal.statusCode).toBe(400)
  })

  it('reader can read tree + note, cannot write; stranger sees nothing', async () => {
    const tree = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/tree`,
      headers: { cookie: readerCookie },
    })
    expect(tree.statusCode).toBe(200)
    expect(Object.keys(tree.json() as Record<string, unknown>)).toContain('people')

    const note = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/notes/people/john-doe`,
      headers: { cookie: readerCookie },
    })
    expect(note.statusCode).toBe(200)

    const write = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/people/john-doe`,
      headers: { cookie: readerCookie },
      body: { body: 'nope' },
    })
    expect(write.statusCode).toBe(404)

    const strangerRead = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/notes/people/john-doe`,
      headers: { cookie: strangerCookie },
    })
    expect(strangerRead.statusCode).toBe(404)
  })

  it('updates persist to disk', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/notes/people/john-doe`,
      headers: { cookie: ownerCookie },
      body: { body: 'Updated body', frontmatter: { type: 'people', tags: ['vip'] } },
    })
    expect(res.statusCode).toBe(200)
    const raw = await readFile(vaultFile('people', 'john-doe.md'), 'utf8')
    expect(raw).toContain('Updated body')
    expect(raw).toContain('vip')
  })

  it('rename moves the file and refreshes index.md', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes-rename`,
      headers: { cookie: ownerCookie },
      body: { from: 'people/john-doe', to: 'john' },
    })
    expect(res.statusCode).toBe(200)
    await expect(stat(vaultFile('people', 'john.md'))).resolves.toBeTruthy()
    await expect(stat(vaultFile('people', 'john-doe.md'))).rejects.toThrow()
    const index = await readFile(vaultFile('people', 'index.md'), 'utf8')
    expect(index).toContain('[[people/john]]')
    expect(index).not.toContain('john-doe')
  })

  it('soft delete moves to trash; restore brings it back', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${vaultId}/notes/people/john`,
      headers: { cookie: ownerCookie },
    })
    expect(del.statusCode).toBe(200)
    const { id } = del.json() as { id: string }
    await expect(stat(vaultFile('people', 'john.md'))).rejects.toThrow()
    await expect(stat(vaultFile('.trash', `${id}.md`))).resolves.toBeTruthy()

    const trash = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/trash`,
      headers: { cookie: ownerCookie },
    })
    expect((trash.json() as Array<{ id: string }>).some((t) => t.id === id)).toBe(true)

    const restore = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/trash/${id}/restore`,
      headers: { cookie: ownerCookie },
    })
    expect(restore.statusCode).toBe(200)
    await expect(stat(vaultFile('people', 'john.md'))).resolves.toBeTruthy()
  })
})
