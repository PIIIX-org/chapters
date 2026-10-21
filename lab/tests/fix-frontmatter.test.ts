// PR #400 (fix/okf-frontmatter-fence): a `---` inside a frontmatter value or
// in the body must not be read as the closing fence. On dev the parser
// (server/src/notes/okf.ts parseNote, `/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/`)
// stops at the first `---` anywhere, so `title: alpha---beta` reads back as
// `alpha` with the rest spilled into the body.
//
// Per case, through the real surfaces:
//   create   MCP create_note -> read_note + the file on disk
//   edit     MCP edit_note body only (frontmatter must be kept) -> read_note
//   full     MCP edit_note full frontmatter (adds another dashed value) -> read_note
//   collab   a real Hocuspocus client (run inside the app container with the
//            image's own @hocuspocus/provider) loads the note, checks what it
//            sees, inserts text and sets a dashed frontmatter value, leaves;
//            then read_note
// A refused write (fixed code rejects notes that would not round-trip) is
// "not corrupted" but is reported separately: refusing a legal value is
// itself a usability defect.
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { collabDocName } from '../lib/collab.ts'
import { dbNoteId } from '../lib/datapath.ts'

interface Case {
  id: string
  frontmatter: Record<string, unknown>
  body: string
}

const CASES: Case[] = [
  { id: 'inline-title', frontmatter: { title: 'alpha---beta' }, body: 'Intro\n---\nAfter the rule.\n' },
  { id: 'multiline-description', frontmatter: { title: 'x', description: 'before\n---\nafter' }, body: 'plain body' },
  { id: 'title-is-fence', frontmatter: { title: '---' }, body: '---\nbody starts with a rule' },
  { id: 'tags-with-dashes', frontmatter: { title: 't', tags: ['a---b', '---'] }, body: 'tags' },
  { id: 'body-looks-like-frontmatter', frontmatter: { title: 'y' }, body: '---\nfoo: bar\n---\nreal body' },
  { id: 'leading-newline-body', frontmatter: { title: 'z---' }, body: '\nstarts with a blank line\n---' },
]

const TYPE = 'concepts'

interface Snapshot {
  ok: boolean
  frontmatter?: Record<string, unknown>
  body?: string
  error?: string
}

interface Verdict {
  stage: string
  outcome: 'intact' | 'corrupted' | 'refused' | 'error'
  detail: string
}

/** Every expected key equal, body equal. Extra keys the server adds are fine. */
function compare(stage: string, want: Case, got: Snapshot): Verdict {
  if (!got.ok) return { stage, outcome: 'error', detail: got.error ?? 'read failed' }
  const bad = Object.entries({ type: TYPE, ...want.frontmatter })
    .filter(([k, v]) => JSON.stringify(got.frontmatter?.[k]) !== JSON.stringify(v))
    .map(([k, v]) => `${k}: want ${JSON.stringify(v)} got ${JSON.stringify(got.frontmatter?.[k])}`)
  if (got.body !== want.body) bad.push(`body: want ${JSON.stringify(want.body)} got ${JSON.stringify(got.body)}`)
  return bad.length === 0 ? { stage, outcome: 'intact', detail: '' } : { stage, outcome: 'corrupted', detail: bad.join('; ') }
}

async function readBack(ctx: LabContext, vaultId: string, path: string): Promise<Snapshot> {
  const r = await ctx.mcp('adminAccount').call('read_note', { vaultId, path })
  const j = r.json as { frontmatter?: Record<string, unknown>; body?: string } | undefined
  return r.ok && j ? { ok: true, frontmatter: j.frontmatter, body: j.body } : { ok: false, error: r.text.slice(0, 300) }
}

/** Runs a Hocuspocus client inside the app container; returns its JSON report. */
async function collabSession(
  ctx: LabContext,
  cfg: { name: string; token: string; insert: string; setFrontmatter: Record<string, unknown>; holdMs: number },
): Promise<{ synced: boolean; before?: Snapshot; after?: Snapshot; authFailed?: string; error?: string }> {
  const script = `
import { setTimeout as sleep } from 'node:timers/promises'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
// Real time on purpose: a live websocket session against the running relay.
const cfg = ${JSON.stringify({ ...cfg, url: 'ws://127.0.0.1:3000/collab' })}
const out = { synced: false }
const doc = new Y.Doc()
const snap = () => ({ ok: true, frontmatter: doc.getMap('frontmatter').toJSON(), body: doc.getText('body').toString() })
try {
  const provider = new HocuspocusProvider({
    url: cfg.url, name: cfg.name, token: cfg.token, document: doc,
    onSynced: () => { out.synced = true },
    onAuthenticationFailed: (e) => { out.authFailed = String(e && e.reason ? e.reason : e) },
  })
  const t0 = Date.now()
  while (!out.synced && !out.authFailed && Date.now() - t0 < 20000) await sleep(100)
  if (out.synced) {
    out.before = snap()
    doc.transact(() => {
      doc.getText('body').insert(0, cfg.insert)
      for (const [k, v] of Object.entries(cfg.setFrontmatter)) doc.getMap('frontmatter').set(k, v)
    })
    await sleep(cfg.holdMs)
    out.after = snap()
  }
  provider.destroy()
} catch (err) {
  out.error = String(err && err.stack ? err.stack : err)
}
await sleep(500)
console.log('LABJSON' + JSON.stringify(out))
process.exit(0)
`
  const r = await ctx.docker.appExec(['node', '--input-type=module'], script)
  const line = r.stdout.split('\n').find((l) => l.startsWith('LABJSON'))
  if (!line) return { synced: false, error: `exit ${r.code}: ${(r.stderr || r.stdout).slice(0, 800)}` }
  return JSON.parse(line.slice('LABJSON'.length))
}

const test: LabTest = {
  name: 'fix-frontmatter',
  tier: 'fast',
  description: "PR #400: '---' in frontmatter values/body survives create, edit, full edit and a live collab session.",
  async run(ctx) {
    const checks: Check[] = []
    const acct = ctx.mcp('adminAccount')
    const vault = await ctx.createVault('admin', ctx.uniq('fix-fm'))
    const sessionToken = ctx.env.users.admin.cookie.split('=')[1]!
    const results: Array<{ id: string; verdicts: Verdict[]; disk?: string; collab?: unknown }> = []

    for (const c of CASES) {
      const name = c.id
      const path = `${TYPE}/${name}`
      const verdicts: Verdict[] = []
      const fm = { type: TYPE, ...c.frontmatter }

      // ---- create
      const created = await acct.call('create_note', { vaultId: vault.id, path, frontmatter: fm, body: c.body })
      if (!created.ok) {
        verdicts.push({ stage: 'create', outcome: 'refused', detail: created.text.slice(0, 300) })
        results.push({ id: c.id, verdicts })
        continue
      }
      verdicts.push(compare('create', c, await readBack(ctx, vault.id, path)))
      const disk = await ctx.docker.appExec(['cat', `/data/elara/vaults/${vault.id}/${TYPE}/${name}.md`])

      // ---- body-only edit: frontmatter must be kept as is
      const edited: Case = { ...c, body: `${c.body}\nedited ---` }
      const e1 = await acct.call('edit_note', { vaultId: vault.id, path, body: edited.body })
      verdicts.push(
        e1.ok ? compare('edit-body', edited, await readBack(ctx, vault.id, path)) : { stage: 'edit-body', outcome: 'refused', detail: e1.text.slice(0, 300) },
      )

      // ---- full-frontmatter edit adding another dashed value
      const full: Case = { ...edited, frontmatter: { ...c.frontmatter, description: 'one---two' } }
      const e2 = await acct.call('edit_note', { vaultId: vault.id, path, frontmatter: { type: TYPE, ...full.frontmatter }, body: full.body })
      const afterFull = e2.ok ? compare('edit-frontmatter', full, await readBack(ctx, vault.id, path)) : undefined
      verdicts.push(afterFull ?? { stage: 'edit-frontmatter', outcome: 'refused', detail: e2.text.slice(0, 300) })

      // ---- live collab session on the (expected) current state
      const base = afterFull?.outcome === 'intact' ? full : edited
      const collab = await collabSession(ctx, {
        name: collabDocName(vault.id, await dbNoteId(ctx, vault.id, path)),
        token: sessionToken,
        insert: 'COLLAB ',
        setFrontmatter: { resource: 'collab---value' },
        holdMs: 4_000,
      })
      if (!collab.synced) {
        verdicts.push({ stage: 'collab-load', outcome: 'error', detail: collab.authFailed ?? collab.error ?? 'never synced' })
      } else {
        verdicts.push(compare('collab-load', base, collab.before!))
        const want: Case = { ...base, frontmatter: { ...base.frontmatter, resource: 'collab---value' }, body: `COLLAB ${base.body}` }
        // The store is debounced; poll the read path for up to 20 s (real time on purpose: live relay).
        let got: Snapshot = { ok: false }
        const t0 = Date.now()
        while (Date.now() - t0 < 20_000) {
          got = await readBack(ctx, vault.id, path)
          if (got.body?.startsWith('COLLAB ')) break
          await Bun.sleep(1_000)
        }
        const v = compare('collab-store', want, got)
        verdicts.push(
          got.body?.startsWith('COLLAB ')
            ? v
            : { stage: 'collab-store', outcome: 'refused', detail: `collab edit never reached the note: ${v.detail}` },
        )
      }
      results.push({ id: c.id, verdicts, disk: disk.stdout.slice(0, 600), collab })
    }

    const appLogs = await ctx.docker.app.logs('app', 300)
    const collabRejections = appLogs.split('\n').filter((l) => /collab store rejected|crdt state save rejected/.test(l)).slice(0, 20)

    for (const r of results) {
      for (const v of r.verdicts) {
        checks.push({
          name: `${r.id}: ${v.stage}`,
          expected: 'note reads back unchanged (no corruption, no refusal)',
          actual: v.outcome + (v.detail ? `: ${v.detail.slice(0, 400)}` : ''),
          ok: v.outcome === 'intact' ? true : v.outcome === 'error' ? null : false,
          severity: v.outcome === 'corrupted' ? 'high' : 'medium',
        })
      }
    }
    const count = (o: Verdict['outcome']) => results.flatMap((r) => r.verdicts).filter((v) => v.outcome === o).length
    return {
      summary:
        `${CASES.length} notes with '---' in frontmatter values/body, 5 stages each (create, body edit, full edit, collab load, collab store). ` +
        `intact ${count('intact')}, corrupted ${count('corrupted')}, refused ${count('refused')}, error ${count('error')}. ` +
        `Collab store rejections in app log: ${collabRejections.length}.`,
      checks,
      data: { vaultId: vault.id, results, collabRejections },
    }
  },
}
export default test
