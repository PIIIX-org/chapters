import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createNote, listRevisions, readNote, updateNote, type Actor } from '../src/notes/store.js'
import { createActiveUser, loginCookie } from './helpers.js'

// #480: a repeat of the note's current state must not record a revision. The
// dedupe compared `JSON.stringify` of the frontmatter, so the same map in a
// different key order (jsonb returns keys in its own order; the collab
// document and a frontmatter merge keep theirs) counted as a change.
// A repeat is the same state from the same author, or from the relay; an
// attributed write of the state the relay just stored is still recorded, so
// the agent or person behind it stays in the history (#403).

let app: FastifyInstance
let vaultId: string
let counter = 0
let author: Actor
const agent: Actor = { type: 'mcp', id: randomUUID() }
const relay: Actor = { type: 'collab' }

const FRONTMATTER = {
  title: 'Dedupe target',
  status: 'active',
  tags: ['alpha', 'beta'],
  properties: { owner: 'ops', limits: { cpu: 2, memory: '1Gi' } },
}

beforeAll(async () => {
  app = await buildApp()
  const owner = await createActiveUser()
  author = { type: 'user', id: owner.id }
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
  const row = await createNote(
    vaultId,
    { type: 'docs', name: `dedupe-${++counter}`, frontmatter: FRONTMATTER, body: 'Body.' },
    author,
  )
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
    await updateNote(vaultId, path, { frontmatter: reordered, body: 'Body.' }, author)
    expect(await revisionCount(path)).toBe(before)
  })

  it('the frontmatter as parsed back from the note file records no revision', async () => {
    const { path } = await freshNote()
    const before = await revisionCount(path)
    const fromFile = (await readNote(vaultId, path))!
    await updateNote(
      vaultId,
      path,
      { frontmatter: reversedKeys(fromFile.frontmatter) as Record<string, unknown>, body: fromFile.body },
      author,
    )
    expect(await revisionCount(path)).toBe(before)
  })

  it('a real change still records a revision: array order, a nested value, the body', async () => {
    const { path, frontmatter } = await freshNote()
    let expected = await revisionCount(path)
    await updateNote(vaultId, path, { frontmatter: { ...frontmatter, tags: ['beta', 'alpha'] } }, author)
    expect(await revisionCount(path)).toBe(++expected)
    await updateNote(
      vaultId,
      path,
      {
        frontmatter: { ...frontmatter, tags: ['beta', 'alpha'], properties: { owner: 'ops', limits: { cpu: 4, memory: '1Gi' } } },
      },
      author,
    )
    expect(await revisionCount(path)).toBe(++expected)
    await updateNote(vaultId, path, { body: 'Another body.' }, author)
    expect(await revisionCount(path)).toBe(++expected)
    const latest = (await listRevisions(vaultId, path))![0]!
    expect(latest.frontmatter).toMatchObject({ tags: ['beta', 'alpha'], properties: { limits: { cpu: 4 } } })
  })

  it('the same state from another author is recorded and credited; the relay repeating it is not', async () => {
    const { path, frontmatter } = await freshNote()
    const before = await revisionCount(path)
    // The relay stores an agent's change first (credited to `collab`, #403),
    // then the agent's attributed write of the same state lands.
    await updateNote(vaultId, path, { frontmatter: { ...frontmatter, status: 'draft' } }, relay)
    await updateNote(vaultId, path, { frontmatter: reversedKeys({ ...frontmatter, status: 'draft' }) as Record<string, unknown> }, agent)
    // A later relay store of the unchanged document adds nothing.
    await updateNote(vaultId, path, { frontmatter: { ...frontmatter, status: 'draft' } }, relay)
    // Another connection writing the same state is a different author.
    const other: Actor = { type: 'mcp', id: randomUUID() }
    await updateNote(vaultId, path, { frontmatter: { ...frontmatter, status: 'draft' } }, other)
    const added = (await listRevisions(vaultId, path))!.slice(0, (await revisionCount(path)) - before)
    expect(added.map((r) => [r.actorType, r.actorId])).toEqual([
      ['mcp', other.id],
      ['mcp', agent.id],
      ['collab', null],
    ])
  })
})
