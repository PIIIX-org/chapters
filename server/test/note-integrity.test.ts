import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { checkNoteFiles } from '../src/notes/integrity.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Integrity vault' } })
  ).json().id
  for (const name of ['healthy', 'stripped', 'vanished']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'guides', name, body: `${name} body` },
    })
    expect(res.statusCode).toBe(200)
  }
})

afterAll(async () => app.close())

describe('checkNoteFiles', () => {
  it('reports a vault with intact files as clean', async () => {
    expect(await checkNoteFiles(vaultId)).toEqual({ checked: 3, problems: [] })
  })

  it('reports a fence-less file as unparseable and a missing file as missing, and nothing else', async () => {
    const dir = join(config.dataDir, 'vaults', vaultId, 'guides')
    // The #384 damage: a generated table written over the note, no frontmatter fence.
    await writeFile(join(dir, 'stripped.md'), '## Concepts & Artifacts\n\n| Concept |\n', 'utf8')
    await rm(join(dir, 'vanished.md'))

    const { checked, problems } = await checkNoteFiles(vaultId)
    expect(checked).toBe(3)
    expect(problems).toEqual([
      expect.objectContaining({ vaultId, vaultName: 'Integrity vault', path: 'guides/stripped', problem: 'unparseable' }),
      expect.objectContaining({ vaultId, path: 'guides/vanished', problem: 'missing-file' }),
    ])
    expect(problems[0]!.detail).toMatch(/frontmatter/)
  })
})
