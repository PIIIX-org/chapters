// #1061: the verifier stage reorders the fused list by a cross-encoder's scores and says how sure it is. The tests pass
// their own verifier objects (the real model is the benchmark's); this file imports nothing new, so it fails on an
// assertion before the change.
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../src/db/client.js'
import { vaults } from '../src/db/schema.js'
import { createNote } from '../src/notes/store.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { searchNotes } from '../src/search/search.js'
import { createActiveUser } from './helpers.js'

let vaultId: string
const scope = () => ({ vaultIds: [vaultId], repositoryIds: [] as string[] })

beforeAll(async () => {
  const user = await createActiveUser()
  const [v] = await db.insert(vaults).values({ name: 'verifier-vault', ownerId: user.id }).returning()
  vaultId = v!.id
  await createNote(vaultId, { path: 'docs/orchard-a', body: '# Orchard A\n\nThe kiwifruit harvest happens in autumn.\n' })
  await createNote(vaultId, { path: 'docs/orchard-b', body: '# Orchard B\n\nKiwifruit vines need a trellis; the harvest tools are stored in the shed.\n' })
  await createNote(vaultId, { path: 'docs/orchard-c', body: '# Orchard C\n\nA kiwifruit harvest log for the autumn crew.\n' })
  await flushEmbeddings()
}, 120_000)

/** Scores by path: the verifier that prefers what the test says. */
const prefers = (scores: Record<string, number>) => ({
  score: async (_query: string, passages: string[]) => passages.map((p) => scores[Object.keys(scores).find((k) => p.includes(k)) ?? ''] ?? 0),
})
const ask = (query: string, verifier: unknown) => searchNotes(scope(), query, 10, {}, { verifier } as never)

describe('the verifier stage', () => {
  it('puts the passage the verifier prefers first and commits to it when it is clearly ahead', async () => {
    const fused = await ask('kiwifruit harvest', null)
    expect(fused.verifier).toBeUndefined()
    expect(fused.confidence).toBeUndefined()
    const last = fused.results.at(-1)!.path
    const res = await ask('kiwifruit harvest', prefers({ [last]: 0.95 }))
    expect(res.results[0]!.path).toBe(last)
    expect(res.results.map((r) => r.path).sort()).toEqual(fused.results.map((r) => r.path).sort())
    expect(res).toMatchObject({ verifier: 'applied', confidence: 0.95, answer: last, degraded: false })
    expect(res.ambiguous).toBeUndefined()
  })

  it('says ambiguous when two are close and likely, and commits to none', async () => {
    const res = await ask('kiwifruit harvest', prefers({ 'docs/orchard-a': 0.9, 'docs/orchard-b': 0.85 }))
    expect(res).toMatchObject({ verifier: 'applied', ambiguous: true, confidence: 0.05 })
    expect(res.answer).toBeUndefined()
    expect(res.results.slice(0, 2).map((r) => r.path)).toEqual(['docs/orchard-a', 'docs/orchard-b'])
  })

  it('says nothing is above the floor with a low confidence and no answer', async () => {
    const res = await ask('kiwifruit harvest', prefers({ 'docs/orchard-a': 0.2, 'docs/orchard-b': 0.1 }))
    expect(res).toMatchObject({ verifier: 'applied', confidence: 0.1 })
    expect(res.answer).toBeUndefined()
    expect(res.ambiguous).toBeUndefined()
  })

  it('keeps the fused order and says degraded when the verifier fails or is too slow', async () => {
    const fused = await ask('kiwifruit harvest', null)
    const failing = await ask('kiwifruit harvest', { score: async () => Promise.reject(new Error('model missing')) })
    expect(failing.results.map((r) => r.path)).toEqual(fused.results.map((r) => r.path))
    expect(failing.degraded).toEqual({ reason: 'verifier_failed' })
    expect(failing.verifier).toBeUndefined()
    expect(failing.confidence).toBeUndefined()
  })

  it('does not rerank a query the English model cannot read: the fused order stands and the answer says so', async () => {
    await createNote(vaultId, { path: 'docs/persian-a', body: '# باغ\n\nبرداشت کیوی در پاییز انجام می‌شود.\n' })
    await createNote(vaultId, { path: 'docs/persian-b', body: '# کیوی\n\nدرخت کیوی نیاز به داربست دارد و برداشت در پاییز است.\n' })
    await flushEmbeddings()
    const spy = { calls: 0, score: async (_q: string, p: string[]) => (spy.calls++, p.map(() => 0.9)) }
    for (const query of ['برداشت کیوی در پاییز', 'كيوي kiwifruit harvest', 'حصاد الكيوي']) {
      const fused = await ask(query, null)
      const res = await ask(query, spy)
      expect(res.results.map((r) => r.path), query).toEqual(fused.results.map((r) => r.path))
      expect(res.verifier, query).toBe('skipped_language')
      expect(res.confidence).toBeUndefined()
    }
    expect(spy.calls).toBe(0)
  })
})
