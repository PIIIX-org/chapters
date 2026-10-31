// #1015 (ADR-004 §1.3, #1007): after a delete the stored semantic edges are those of an instance that never had
// the node. Each case builds world A, which has the node and then loses it (a purge, a trash, a file gone in a
// sync, a repository or vault deleted or trashed, a vault transferred), and world B, built without it; each world's
// stored rows, named by their ends' container and path, must be the same rows with the same similarities, as in
// `semantic-edges-order.test.ts`. A node that held the removed one has its (K+1)-th neighbour in B.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { notes } from '../src/db/schema.js'
import { purgeNote, restoreNote, softDeleteNote } from '../src/notes/store.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { recomputeSemanticEdges } from '../src/search/semantic-edges.js'
import { purgeVaultRecord } from '../src/vaults/routes.js'
import { loginCookie } from './helpers.js'
import {
  FILES,
  K,
  VICTIM_FILE,
  VICTIM_NOTE,
  addRepository,
  addVault,
  cleanup,
  fileIds,
  noteId,
  owner,
  rowsTouching,
  settle,
  storedRows,
  world,
} from './semantic-edges-world.js'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await cleanup()
  await app.close()
})

describe('a delete leaves the stored semantic edges of a world that never had the node (#1015)', () => {
  let full: string[]

  beforeAll(async () => {
    const w = await world()
    full = await storedRows([w.vaultId, w.repositoryId])
  }, 120_000)

  it('the fixture: the hub holds K rows, one of them the victim note, files hold notes and the victim file', () => {
    const hub = full.filter((r) => r.startsWith('note:deletes-vault/notes/hub →'))
    expect(hub).toHaveLength(K)
    expect(hub.some((r) => r.includes(`→ note:deletes-vault/${VICTIM_NOTE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('code:') && r.includes(`→ note:deletes-vault/${VICTIM_NOTE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('code:') && r.includes(`→ code:deletes-repo/${VICTIM_FILE} `))).toBe(true)
    expect(full.some((r) => r.startsWith('note:') && r.includes(`→ code:deletes-repo/${VICTIM_FILE} `))).toBe(true)
  })

  it('purge (the repro): the hub keeps K rows, those of a world without the note', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    expect(await purgeNote(a.vaultId, id)).toBe(true)
    await settle()
    const b = await world([VICTIM_NOTE])
    const rows = await storedRows([a.vaultId, a.repositoryId])
    expect(rows.filter((r) => r.startsWith('note:deletes-vault/notes/hub →'))).toHaveLength(K)
    expect(rows).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    expect(await rowsTouching([id])).toBe(0)
  }, 120_000)

  it('trash: the note keeps no rows and leaves every list, as if it never existed', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    await settle()
    const b = await world([VICTIM_NOTE])
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    expect(await rowsTouching([id])).toBe(0)
  }, 120_000)

  it('restore from the trash: the rows of a world that never trashed it', async () => {
    const a = await world()
    const id = await noteId(a.vaultId, VICTIM_NOTE)
    expect(await softDeleteNote(a.vaultId, VICTIM_NOTE)).not.toBeNull()
    await settle()
    expect(await restoreNote(a.vaultId, id)).not.toBeNull()
    await settle()
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(full)
  }, 120_000)

  it('a file removed by a sync: the rows of a world without the file', async () => {
    const a = await world()
    const before = await fileIds(a.repositoryId)
    const rest = FILES.filter((f) => f.path !== VICTIM_FILE).map((f) => f.path)
    expect((await syncRepositoryFiles(a.repositoryId, [], rest)).deleted).toBe(1)
    await settle()
    const b = await world([VICTIM_FILE])
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(await storedRows([b.vaultId, b.repositoryId]))
    const left = new Set(await fileIds(a.repositoryId))
    expect(await rowsTouching(before.filter((id) => !left.has(id)))).toBe(0)
  }, 120_000)

  it('a repository deleted: the vault keeps the rows of a world that never had it', async () => {
    const user = await owner()
    const vaultId = await addVault(user.id)
    const repositoryId = await addRepository(user.id, 'deletes-repo')
    await settle()
    const files = await fileIds(repositoryId)
    const res = await app.inject({ method: 'DELETE', url: `/api/repositories/${repositoryId}`, headers: { cookie: await loginCookie(app, user.email) } })
    expect(res.statusCode).toBe(200)
    await settle()
    const other = await owner()
    const b = await addVault(other.id)
    await settle()
    expect(await storedRows([vaultId])).toEqual(await storedRows([b]))
    expect(await rowsTouching(files)).toBe(0)
  }, 120_000)

  it('a vault purged: the repository keeps the rows of a world that never had it', async () => {
    const a = await world()
    const ids = (await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, a.vaultId))).map((r) => r.id)
    await purgeVaultRecord(a.vaultId)
    await settle()
    const other = await owner()
    const b = await addRepository(other.id, 'deletes-repo')
    await settle()
    expect(await storedRows([a.repositoryId])).toEqual(await storedRows([b]))
    expect(await rowsTouching(ids)).toBe(0)
  }, 120_000)

  /** A vault and a repository of one owner, all embedded, with the owner's session. */
  async function ownedWorld(): Promise<{ vaultId: string; repositoryId: string; cookie: string }> {
    const user = await owner()
    const vaultId = await addVault(user.id)
    const repositoryId = await addRepository(user.id, 'deletes-repo')
    await settle()
    return { vaultId, repositoryId, cookie: await loginCookie(app, user.email) }
  }

  /** Recomputes every node of these containers, as a rebuild (`pnpm reindex`) would. */
  async function recomputeAll(vaultId: string, repositoryId: string): Promise<void> {
    for (const n of await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, vaultId))) await recomputeSemanticEdges('note', n.id)
    for (const id of await fileIds(repositoryId)) await recomputeSemanticEdges('code', id)
  }

  it('a vault trashed (#1025): its notes keep no rows and are in no list, as in a world without the vault', async () => {
    const a = await ownedWorld()
    const ids = (await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, a.vaultId))).map((r) => r.id)
    expect((await app.inject({ method: 'DELETE', url: `/api/vaults/${a.vaultId}`, headers: { cookie: a.cookie } })).statusCode).toBe(200)
    await settle()
    const other = await owner()
    const rowsB = await storedRows([await addRepository(other.id, 'deletes-repo')])
    expect(await storedRows([a.repositoryId])).toEqual(rowsB)
    expect(await rowsTouching(ids)).toBe(0)
    // The reach is symmetric: once every node is recomputed, the notes still reach no file and no file reaches them.
    await recomputeAll(a.vaultId, a.repositoryId)
    expect(await storedRows([a.repositoryId])).toEqual(rowsB)
    expect(await rowsTouching(ids)).toBe(0)
  }, 120_000)

  it('a vault restored (#1025): the rows of a world that never trashed it, after its nodes were recomputed in the trash', async () => {
    const a = await ownedWorld()
    expect((await app.inject({ method: 'DELETE', url: `/api/vaults/${a.vaultId}`, headers: { cookie: a.cookie } })).statusCode).toBe(200)
    await settle()
    await recomputeAll(a.vaultId, a.repositoryId)
    const res = await app.inject({ method: 'POST', url: `/api/vaults/${a.vaultId}/restore`, headers: { cookie: a.cookie } })
    expect(res.statusCode).toBe(200)
    await settle()
    expect(await storedRows([a.vaultId, a.repositoryId])).toEqual(full)
  }, 120_000)

  it("a vault transferred: the rows of a world where the new owner always had it (#999's scope)", async () => {
    // A: the first owner has the vault and repository r1, the second r2; the vault moves to the second.
    const [first, second] = [await owner(), await owner()]
    const vaultId = await addVault(first.id)
    const r1 = await addRepository(first.id, 'deletes-r1')
    const r2 = await addRepository(second.id, 'deletes-r2')
    await settle()
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/transfer`,
      headers: { cookie: await loginCookie(app, first.email) },
      body: { newOwnerId: second.id },
    })
    expect(res.statusCode).toBe(200)
    await settle()
    // B: r1 alone with the first owner, the vault and r2 with the second from the start.
    const [firstB, secondB] = [await owner(), await owner()]
    const r1B = await addRepository(firstB.id, 'deletes-r1')
    const vaultB = await addVault(secondB.id)
    const r2B = await addRepository(secondB.id, 'deletes-r2')
    await settle()
    const rowsB = await storedRows([vaultB, r1B, r2B])
    expect(rowsB.some((r) => r.startsWith('code:deletes-r2/') && r.includes('→ note:'))).toBe(true)
    expect(await storedRows([vaultId, r1, r2])).toEqual(rowsB)
  }, 180_000)
})
