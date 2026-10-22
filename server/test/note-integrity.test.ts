import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { checkNoteFiles } from '../src/notes/integrity.js'
import { parseNote, serializeNote, type Frontmatter, type OkfNote } from '../src/notes/okf.js'
import { noteFile, vaultDir } from '../src/notes/store.js'
import { createActiveUser, loginCookie, rewriteNoteFileFromRow } from './helpers.js'
import { flushProjections } from '../src/notes/projector.js'

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
  // Files are projections written after commit (ADR-003 §7).
  await flushProjections()
})

// These tests damage files on purpose. Rewrite every file from its row so the
// suite leaves the vault intact for the CI vault-invariant gate (#578).
afterAll(async () => {
  for (const name of NAMES) await rewriteNoteFileFromRow(vaultId, `guides/${name}`)
  expect(await checkNoteFiles(vaultId)).toEqual({ checked: NAMES.length, problems: [], pending: [] })
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
    expect(await checkNoteFiles(vaultId)).toEqual({ checked: NAMES.length, problems: [], pending: [] })
  })

  it('lists a note whose file projection has not reached its row as pending, and does not compare its file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'pending', name: 'unprojected', body: 'not on disk yet' },
    })
    expect(res.statusCode).toBe(200)
    const report = await checkNoteFiles(vaultId)
    expect(report.problems).toEqual([])
    expect(report.pending.map((p) => `${p.path} ${p.projection}`)).toEqual(['pending/unprojected dir_index', 'pending/unprojected file'])
    await app.inject({ method: 'DELETE', url: `/api/vaults/${vaultId}/notes/pending/unprojected`, headers: { cookie } })
    await flushProjections()
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
    expect(problems[0]!.detail).toBe('first difference at offset 13 (file 29 chars, row 13 chars)')
  })

  it('reports a file whose frontmatter differs from the row as a frontmatter mismatch only', async () => {
    await rewrite('retagged', (note) => {
      note.frontmatter.status = 'active'
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

  it('reports a .md file that no note, generated index or projector record owns as an orphan (#495)', async () => {
    const stray = join(vaultDir(vaultId), 'loose/stray.md')
    await mkdir(dirname(stray), { recursive: true })
    await writeFile(stray, '---\ntype: loose\n---\nstray\n', 'utf8')
    // Dot-directories and assets/ are not note files.
    await mkdir(join(vaultDir(vaultId), '.orphans'), { recursive: true })
    await writeFile(join(vaultDir(vaultId), '.orphans/old.md'), 'moved earlier', 'utf8')
    const { problems } = await checkNoteFiles(vaultId)
    expect(problems.filter((p) => p.problem === 'orphan-file')).toEqual([
      expect.objectContaining({ vaultId, path: 'loose/stray.md', problem: 'orphan-file' }),
    ])
    // guides/index.md is the generated index of a directory with notes: owned.
    expect(problems.some((p) => p.path === 'guides/index.md')).toBe(false)
    await rm(join(vaultDir(vaultId), 'loose'), { recursive: true })
    await rm(join(vaultDir(vaultId), '.orphans'), { recursive: true })
  })
})
