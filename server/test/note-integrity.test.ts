import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { checkNoteFiles } from '../src/notes/integrity.js'
import { parseNote, serializeNote, type Frontmatter, type OkfNote } from '../src/notes/okf.js'
import { getLiveNote, noteFile } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

const NAMES = ['healthy', 'stripped', 'vanished', 'rebodied', 'retagged', 'reworked', 'reordered']

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Integrity vault' } })
  ).json().id
  for (const name of NAMES) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'guides', name, body: `${name} body`, frontmatter: { status: 'draft', tags: ['a', 'b'] } },
    })
    expect(res.statusCode).toBe(200)
  }
})

// These tests damage files on purpose. Rewrite every file from its row so the
// suite leaves the vault intact for the CI vault-invariant gate (#578).
afterAll(async () => {
  for (const name of NAMES) {
    const row = (await getLiveNote(vaultId, `guides/${name}`))!
    await writeFile(
      noteFile(vaultId, row.path),
      serializeNote({ frontmatter: row.frontmatter as Frontmatter, body: row.body }),
      'utf8',
    )
  }
  expect(await checkNoteFiles(vaultId)).toEqual({ checked: NAMES.length, problems: [] })
  await app.close()
})

const file = (name: string) => noteFile(vaultId, `guides/${name}`)

async function rewrite(name: string, change: (note: OkfNote) => void) {
  const note = parseNote(await readFile(file(name), 'utf8'))
  change(note)
  await writeFile(file(name), serializeNote(note), 'utf8')
}

async function problemsFor(name: string) {
  const { problems } = await checkNoteFiles(vaultId)
  return problems.filter((p) => p.path === `guides/${name}`)
}

describe('checkNoteFiles', () => {
  it('reports a vault whose files match their rows as clean', async () => {
    expect(await checkNoteFiles(vaultId)).toEqual({ checked: NAMES.length, problems: [] })
  })

  it('reports a fence-less file as unparseable', async () => {
    // The #384 damage: a generated table written over the note, no frontmatter fence.
    await writeFile(file('stripped'), '## Concepts & Artifacts\n\n| Concept |\n', 'utf8')
    const problems = await problemsFor('stripped')
    expect(problems).toEqual([
      expect.objectContaining({ vaultId, vaultName: 'Integrity vault', path: 'guides/stripped', problem: 'unparseable' }),
    ])
    expect(problems[0]!.detail).toMatch(/frontmatter/)
  })

  it('reports a missing file as missing', async () => {
    await rm(file('vanished'))
    expect(await problemsFor('vanished')).toEqual([
      expect.objectContaining({ vaultId, path: 'guides/vanished', problem: 'missing-file' }),
    ])
  })

  it('reports a file whose body differs from the row as a body mismatch only', async () => {
    await rewrite('rebodied', (note) => {
      note.body = 'rebodied body, edited on disk'
    })
    const problems = await problemsFor('rebodied')
    expect(problems).toEqual([expect.objectContaining({ path: 'guides/rebodied', problem: 'body-mismatch' })])
    expect(problems[0]!.detail).toMatch(/^first difference at offset 13 \(file 29 chars, row 1[34] chars\)$/)
  })

  it('reports a file whose frontmatter differs from the row as a frontmatter mismatch only', async () => {
    await rewrite('retagged', (note) => {
      note.frontmatter.status = 'done'
      note.frontmatter.tags = ['a']
    })
    const problems = await problemsFor('retagged')
    expect(problems).toEqual([expect.objectContaining({ path: 'guides/retagged', problem: 'frontmatter-mismatch' })])
    expect(problems[0]!.detail).toBe('differing keys: status, tags')
  })

  it('reports both kinds when frontmatter and body differ', async () => {
    await rewrite('reworked', (note) => {
      delete note.frontmatter.status
      note.body = 'rewritten'
    })
    expect((await problemsFor('reworked')).map((p) => p.problem)).toEqual(['frontmatter-mismatch', 'body-mismatch'])
  })

  it('ignores frontmatter key order', async () => {
    await rewrite('reordered', (note) => {
      note.frontmatter = Object.fromEntries(Object.entries(note.frontmatter).reverse()) as Frontmatter
    })
    expect(await problemsFor('reordered')).toEqual([])
  })

  it('counts every live note and reports nothing for the intact one', async () => {
    const { checked, problems } = await checkNoteFiles(vaultId)
    expect(checked).toBe(NAMES.length)
    expect(problems.map((p) => `${p.path} ${p.problem}`)).toEqual([
      'guides/rebodied body-mismatch',
      'guides/retagged frontmatter-mismatch',
      'guides/reworked frontmatter-mismatch',
      'guides/reworked body-mismatch',
      'guides/stripped unparseable',
      'guides/vanished missing-file',
    ])
  })
})
