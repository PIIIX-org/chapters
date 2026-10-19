import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createNote, listRevisions, readNote, updateNote } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #480: a write of the note's current state must not record a revision. The
// dedupe compared `JSON.stringify` of the frontmatter, so the same map in a
// different key order (jsonb returns keys in its own order; the collab
// document and a frontmatter merge keep theirs) counted as a change, and one
// edit through the relay recorded two identical revisions.

let app: FastifyInstance
let vaultId: string
let counter = 0

const FRONTMATTER = {
  title: 'Dedupe target',
  status: 'active',
  tags: ['alpha', 'beta'],
  properties: { owner: 'ops', limits: { cpu: 2, memory: '1Gi' } },
}

beforeAll(async () => {
  app = await buildApp()
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  vaultId = (
    await app.inject({ method: 'POST', url: '/api/vaults', headers: { cookie }, body: { name: 'Dedupe vault' } })
  ).json().id
})

afterAll(async () => {
  await app.close()
})

/** A fresh note; returns its path and its stored frontmatter (with `type` and `timestamp`). */
async function freshNote(): Promise<{ path: string; frontmatter: Record<string, unknown> }> {
  const row = await createNote(vaultId, { type: 'docs', name: `dedupe-${++counter}`, frontmatter: FRONTMATTER, body: 'Body.' })
  return { path: row.path, frontmatter: row.frontmatter as Record<string, unknown> }
}

async function revisionCount(path: string): Promise<number> {
  return (await listRevisions(vaultId, path))!.length
}

/** The same object with its keys, and those of nested objects, in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversedKeys(inner)]),
  )
}

describe('revision dedupe (#480)', () => {
  it('the same frontmatter in another key order, nested maps too, records no revision', async () => {
    const { path, frontmatter } = await freshNote()
    const before = await revisionCount(path)
    const reordered = reversedKeys(frontmatter) as Record<string, unknown>
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(frontmatter))
    await updateNote(vaultId, path, { frontmatter: reordered, body: 'Body.' })
    expect(await revisionCount(path)).toBe(before)
  })

  it('the frontmatter as parsed back from the note file records no revision', async () => {
    const { path } = await freshNote()
    const before = await revisionCount(path)
    const fromFile = (await readNote(vaultId, path))!
    await updateNote(vaultId, path, { frontmatter: reversedKeys(fromFile.frontmatter) as Record<string, unknown>, body: fromFile.body })
    expect(await revisionCount(path)).toBe(before)
  })

  it('a real change still records a revision: array order, a nested value, the body', async () => {
    const { path, frontmatter } = await freshNote()
    let expected = await revisionCount(path)
    await updateNote(vaultId, path, { frontmatter: { ...frontmatter, tags: ['beta', 'alpha'] } })
    expect(await revisionCount(path)).toBe(++expected)
    await updateNote(vaultId, path, {
      frontmatter: { ...frontmatter, tags: ['beta', 'alpha'], properties: { owner: 'ops', limits: { cpu: 4, memory: '1Gi' } } },
    })
    expect(await revisionCount(path)).toBe(++expected)
    await updateNote(vaultId, path, { body: 'Another body.' })
    expect(await revisionCount(path)).toBe(++expected)
    const latest = (await listRevisions(vaultId, path))![0]!
    expect(latest.frontmatter).toMatchObject({ tags: ['beta', 'alpha'], properties: { limits: { cpu: 4 } } })
  })
})
