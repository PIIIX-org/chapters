// Regression probe for PR #402 (fix/note-write-race): with the relay running,
// edit_note goes through writeThroughCollab (server/src/sync/crdt-write.ts):
// a direct collab connection edits the document, disconnects (the relay
// stores the document WITHOUT an actor), then the attributed updateNote runs
// and dedupes against what the relay already stored. #402 serializes both
// behind per-note locks; the concurrency test showed every edit then landing
// as an anonymous 'collab' revision. This test removes concurrency entirely:
// one connection, sequential edits, one note — who does note_history credit?
import type { Check, LabTest } from '../lib/context.ts'

const EDITS = 5

interface Revision {
  id: string
  actorType: string
  actorId: string | null
  action: string
  body: string
  createdAt: string
}

const test: LabTest = {
  name: 'fix-attribution',
  description: 'Sequential (uncontended) edit_note calls: does note_history attribute each to the MCP connection?',
  async run(ctx) {
    const checks: Check[] = []
    const acct = ctx.mcp('adminAccount')
    const connId = ctx.env.tokens.adminAccount.id
    const vault = await ctx.createVault('admin', ctx.uniq('fix-attr'))
    const path = 'concepts/attributed'
    await acct.must('create_note', { vaultId: vault.id, path, frontmatter: { type: 'concepts', title: 'a' }, body: 'v0' })

    const perEdit: Array<{ i: number; ok: boolean; newest?: Pick<Revision, 'actorType' | 'actorId' | 'action'>; credited: boolean; anonymous: boolean }> = []
    for (let i = 1; i <= EDITS; i++) {
      const marker = `edit-${i}-${ctx.uniq('m')}`
      const r = await acct.call('edit_note', { vaultId: vault.id, path, body: marker })
      const h = await acct.call('note_history', { vaultId: vault.id, path })
      const revs = Array.isArray(h.json) ? (h.json as Revision[]) : []
      const withMarker = revs.filter((rev) => rev.body.includes(marker))
      const credited = withMarker.some((rev) => rev.actorType === 'mcp' && rev.actorId === connId)
      const newest = revs[0]
      perEdit.push({
        i,
        ok: r.ok,
        newest: newest && { actorType: newest.actorType, actorId: newest.actorId === connId ? 'this-connection' : newest.actorId, action: newest.action },
        credited,
        anonymous: !credited && withMarker.some((rev) => rev.actorType !== 'mcp'),
      })
    }
    const history = await acct.call('note_history', { vaultId: vault.id, path })
    const all = Array.isArray(history.json) ? (history.json as Revision[]) : []
    const byActorType = all.reduce<Record<string, number>>((m, r) => ((m[r.actorType] = (m[r.actorType] ?? 0) + 1), m), {})
    const credited = perEdit.filter((e) => e.credited).length
    const anonymous = perEdit.filter((e) => e.anonymous).length

    checks.push({
      name: 'sequential edit_note credited to the MCP connection',
      expected: `${EDITS}/${EDITS} edits have a revision with actorType mcp and this connection's id`,
      actual: `${credited}/${EDITS} credited, ${anonymous} recorded only as anonymous; history by actor ${JSON.stringify(byActorType)}`,
      ok: credited === EDITS,
      severity: 'high',
    })
    return {
      summary: `${EDITS} sequential edit_note calls on one note, one connection: ${credited} credited to the connection, ${anonymous} anonymous. History by actor type ${JSON.stringify(byActorType)}.`,
      checks,
      data: { vaultId: vault.id, perEdit, byActorType, revisions: all.map((r) => ({ actorType: r.actorType, actorId: r.actorId === connId ? 'this-connection' : r.actorId, action: r.action, body: r.body.slice(0, 60), createdAt: r.createdAt })) },
    }
  },
}
export default test
