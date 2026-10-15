// Concurrent edit_note against one note and against sibling notes in one
// folder, at N = 5, 10, 20 parallel writers. Every writer has its OWN MCP
// connection (even = admin, odd = member with an edit share), so note_history
// attribution can be checked exactly: revision.actorId must be the writer's
// connection id and the revision body must hold that writer's marker.
//
// Scenarios per N:
//   append-same       read_note + edit_note(body + own line) on one note (the
//                     only way an agent can "append": edit_note replaces the body)
//   replace-same      edit_note(full frontmatter + body) on one note
//   append-different  read + append on N sibling notes, one per writer
//   replace-different full frontmatter + body on N siblings (frontmatter change
//                     regenerates the folder's index.md files)
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { McpClient, stringField, type ToolResult } from '../lib/mcp.ts'

interface Writer {
  i: number
  connId: string
  user: 'admin' | 'member'
  mcp: McpClient
}

interface Revision {
  id: string
  actorType: string
  actorId: string | null
  action: string
  body: string
  frontmatter: Record<string, unknown>
  createdAt: string
}

interface WriteOutcome {
  writer: number
  ok: boolean
  error?: string
  ms: number
}

const SIZES = (process.env.LAB_CONCURRENCY_SIZES ?? '5,10,20').split(',').map(Number)
const SETTLE_MS = 3_000

function classifyError(text: string): string {
  if (/ENOENT|\.tmp/.test(text)) return 'ENOENT/.tmp'
  if (/HTTP 429/.test(text)) return 'HTTP 429'
  if (/^HTTP /.test(text)) return text.slice(0, 12)
  if (/damaged/.test(text)) return 'damaged-note'
  return text.replace(/^Error: /, '').slice(0, 60)
}

function tally(outcomes: WriteOutcome[]) {
  const errors: Record<string, number> = {}
  for (const o of outcomes) if (!o.ok) errors[classifyError(o.error ?? '')] = (errors[classifyError(o.error ?? '')] ?? 0) + 1
  const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b)
  return {
    ok: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    errors,
    p50ms: Math.round(ms[Math.floor(ms.length / 2)] ?? 0),
    maxMs: Math.round(ms.at(-1) ?? 0),
  }
}

async function timed(fn: () => Promise<ToolResult>, writer: number): Promise<WriteOutcome> {
  const r = await fn()
  return { writer, ok: r.ok, error: r.ok ? undefined : r.text, ms: r.ms }
}

/** Revisions created after `sinceIso`, oldest first, via the MCP note_history tool. */
async function historySince(admin: McpClient, vaultId: string, path: string, sinceIso: string) {
  const r = await admin.call('note_history', { vaultId, path })
  if (!r.ok) throw new Error(`note_history ${path}: ${r.text.slice(0, 300)}`)
  if (!Array.isArray(r.json)) throw new Error(`note_history ${path}: not an array`)
  // Rows of note_revisions as server/src/notes/store.ts listRevisions returns them.
  const revs: Revision[] = r.json
  return revs.filter((rev) => rev.createdAt > sinceIso).reverse()
}

/**
 * For writers that reported success: is there a revision attributed to their
 * connection that contains their marker? For every mcp revision: does the
 * body contain a marker of the connection it is attributed to?
 */
function attribution(revs: Revision[], writers: Writer[], okWriters: number[], marker: (i: number) => string) {
  const byConn = new Map(writers.map((w) => [w.connId, w]))
  const missing = okWriters.filter(
    (i) => !revs.some((r) => r.actorId === writers[i]!.connId && r.body.includes(marker(i))),
  )
  const misattributed = revs.filter((r) => {
    if (r.actorType !== 'mcp') return false
    const w = r.actorId ? byConn.get(r.actorId) : undefined
    return !w || !r.body.includes(marker(w.i))
  })
  return {
    revisions: revs.length,
    byActorType: revs.reduce<Record<string, number>>((m, r) => ((m[r.actorType] = (m[r.actorType] ?? 0) + 1), m), {}),
    missingRevisionFor: missing,
    /** Missing writers whose content IS in history, but under a non-mcp (anonymous collab) actor. */
    anonymized: missing.filter((i) => revs.some((r) => r.actorType !== 'mcp' && r.body.includes(marker(i)))),
    misattributed: misattributed.map((r) => ({ id: r.id, actorId: r.actorId, body: r.body.slice(0, 120) })),
  }
}

async function dbNote(ctx: LabContext, vaultId: string, path: string) {
  const rows = await ctx.docker.psqlRows<{ body: string; description: string | null }>(
    `select body, frontmatter->>'description' as description from notes
     where vault_id = '${vaultId}' and deleted_at is null and (path = '${path}' or path = '${path}.md')`,
  )
  return rows[0]
}

const test: LabTest = {
  name: 'concurrency',
  tier: 'fast',
  description: 'Parallel edit_note appends/replacements on one note and on sibling notes; lost updates, errors, attribution.',
  async run(ctx) {
    const checks: Check[] = []
    const data: Record<string, unknown> = {}
    const admin = ctx.mcp('adminAccount')
    const vault = await ctx.createVault('admin', ctx.uniq('lab-concurrency'))
    await admin.must('share_vault', {
      vaultId: vault.id,
      granteeType: 'user',
      granteeId: ctx.env.users.member.id,
      permission: 'edit',
    })

    const maxN = Math.max(...SIZES)
    const writers: Writer[] = []
    for (let i = 0; i < maxN; i++) {
      const user = i % 2 === 0 ? 'admin' : 'member'
      const c = await ctx.mintToken(user, `lab conc writer ${i}`)
      writers.push({ i, connId: c.id, user, mcp: new McpClient(ctx.baseUrl, c.token, `writer-${i}`) })
    }

    const shared = 'concepts/conc-shared'
    await admin.must('create_note', {
      vaultId: vault.id,
      path: shared,
      frontmatter: { type: 'concepts', title: 'shared' },
      body: 'start\n',
    })

    for (const N of SIZES) {
      const ws = writers.slice(0, N)

      // ---- append-same
      {
        const reset = await admin.must<{ updatedAt: string }>('edit_note', { vaultId: vault.id, path: shared, body: `# A${N}\n` })
        // Real time on purpose: revision createdAt is a server timestamp; keep the reset strictly before the burst.
        await Bun.sleep(50)
        const since = (await historySince(admin, vault.id, shared, '0')).at(-1)?.createdAt ?? reset.updatedAt
        const line = (i: number) => `- A${N} w${i} `
        const outcomes = await Promise.all(
          ws.map((w) =>
            timed(async () => {
              const cur = await w.mcp.call('read_note', { vaultId: vault.id, path: shared })
              if (!cur.ok) return cur
              const body = stringField(cur.json, 'body') ?? ''
              return w.mcp.call('edit_note', { vaultId: vault.id, path: shared, body: `${body}${line(w.i)}\n` })
            }, w.i),
          ),
        )
        // Real time on purpose: the collab relay's debounced store runs on the server clock; let it land before reading.
        await Bun.sleep(SETTLE_MS)
        const final = (await admin.must<{ body: string }>('read_note', { vaultId: vault.id, path: shared })).body
        const okWriters = outcomes.filter((o) => o.ok).map((o) => o.writer)
        const lost = okWriters.filter((i) => !final.includes(line(i)))
        const revs = await historySince(admin, vault.id, shared, since)
        const attr = attribution(revs, writers, okWriters, line)
        const t = tally(outcomes)
        const phantom = outcomes.filter((o) => !o.ok && (final.includes(line(o.writer)) || revs.some((r) => r.body.includes(line(o.writer))))).map((o) => o.writer)
        data[`append-same N=${N}`] = { ...t, lost: lost.length, lostWriters: lost, phantomWriters: phantom, finalLines: final.split('\n').length - 1, attribution: attr }
        checks.push(
          { name: `append-same N=${N}: lost updates`, expected: '0 of acknowledged appends lost', actual: `${lost.length} of ${okWriters.length} acknowledged appends lost`, ok: lost.length === 0, severity: 'high' },
          { name: `append-same N=${N}: write errors`, expected: '0', actual: `${t.failed} ${JSON.stringify(t.errors)}`, ok: t.failed === 0, severity: 'high' },
          { name: `append-same N=${N}: attribution`, expected: 'every ack has its own revision; 0 misattributed', actual: `missing ${attr.missingRevisionFor.length} (${attr.anonymized.length} recorded as anonymous collab), misattributed ${attr.misattributed.length}, revisions ${attr.revisions} ${JSON.stringify(attr.byActorType)}`, ok: attr.missingRevisionFor.length === 0 && attr.misattributed.length === 0, severity: 'medium' },
          { name: `append-same N=${N}: failed writes not persisted`, expected: '0 writes that returned an error but landed', actual: `${phantom.length} of ${t.failed} failed writes landed anyway`, ok: phantom.length === 0, severity: 'high' },
        )
      }

      // ---- replace-same
      {
        const before = await historySince(admin, vault.id, shared, '0')
        const since = before.at(-1)!.createdAt
        const marker = (i: number) => `R${N} w${i}.`
        const outcomes = await Promise.all(
          ws.map((w) =>
            timed(
              () =>
                w.mcp.call('edit_note', {
                  vaultId: vault.id,
                  path: shared,
                  frontmatter: { type: 'concepts', title: 'shared', description: marker(w.i) },
                  body: `${marker(w.i)}\n`,
                }),
              w.i,
            ),
          ),
        )
        // Real time on purpose: the collab relay's debounced store runs on the server clock.
        await Bun.sleep(SETTLE_MS)
        const file = await admin.must<{ body: string; frontmatter: { description?: string } }>('read_note', { vaultId: vault.id, path: shared })
        const row = await dbNote(ctx, vault.id, shared)
        const okWriters = outcomes.filter((o) => o.ok).map((o) => o.writer)
        const bodyWriter = /R\d+ w(\d+)\./.exec(file.body)?.[1]
        const fmWriter = /R\d+ w(\d+)\./.exec(file.frontmatter.description ?? '')?.[1]
        const torn = bodyWriter !== fmWriter
        const diverged = !row || row.body !== file.body || row.description !== (file.frontmatter.description ?? null)
        const revs = await historySince(admin, vault.id, shared, since)
        const attr = attribution(revs, writers, okWriters, marker)
        const t = tally(outcomes)
        const phantom = outcomes.filter((o) => !o.ok && (file.body.includes(marker(o.writer)) || revs.some((r) => r.body.includes(marker(o.writer))))).map((o) => o.writer)
        data[`replace-same N=${N}`] = { ...t, final: { bodyWriter, fmWriter, fileBody: file.body, db: row }, torn, diverged, phantomWriters: phantom, attribution: attr }
        checks.push(
          { name: `replace-same N=${N}: write errors`, expected: '0', actual: `${t.failed} ${JSON.stringify(t.errors)}`, ok: t.failed === 0, severity: 'high' },
          { name: `replace-same N=${N}: torn note`, expected: 'body and frontmatter from the same writer', actual: `body w${bodyWriter}, frontmatter w${fmWriter}`, ok: !torn, severity: 'high' },
          { name: `replace-same N=${N}: file vs database`, expected: 'disk file == notes row', actual: diverged ? `diverged: file "${file.body.trim()}" db "${row?.body.trim()}"` : 'same', ok: !diverged, severity: 'high' },
          { name: `replace-same N=${N}: attribution`, expected: 'every ack has its own revision; 0 misattributed', actual: `missing ${attr.missingRevisionFor.length} (${attr.anonymized.length} recorded as anonymous collab), misattributed ${attr.misattributed.length}, revisions ${attr.revisions} ${JSON.stringify(attr.byActorType)}`, ok: attr.missingRevisionFor.length === 0 && attr.misattributed.length === 0, severity: 'medium' },
          { name: `replace-same N=${N}: failed writes not persisted`, expected: '0 writes that returned an error but landed', actual: `${phantom.length} of ${t.failed} failed writes landed anyway`, ok: phantom.length === 0, severity: 'high' },
        )
      }

      // ---- sibling notes in one folder
      const folder = `concepts/folder-n${N}`
      const paths = ws.map((w) => `${folder}/note-${w.i}`)
      for (const p of paths) {
        await admin.must('create_note', { vaultId: vault.id, path: p, frontmatter: { type: 'concepts', title: p }, body: 'start\n' })
      }

      // ---- append-different
      {
        const line = (i: number) => `- AD${N} w${i} `
        const outcomes = await Promise.all(
          ws.map((w) =>
            timed(async () => {
              const cur = await w.mcp.call('read_note', { vaultId: vault.id, path: paths[w.i]! })
              if (!cur.ok) return cur
              const body = stringField(cur.json, 'body') ?? ''
              return w.mcp.call('edit_note', { vaultId: vault.id, path: paths[w.i]!, body: `${body}${line(w.i)}\n` })
            }, w.i),
          ),
        )
        await Bun.sleep(SETTLE_MS)
        const lost: number[] = []
        for (const o of outcomes.filter((x) => x.ok)) {
          const r = await admin.call('read_note', { vaultId: vault.id, path: paths[o.writer]! })
          if (!(stringField(r.json, 'body') ?? '').includes(line(o.writer))) lost.push(o.writer)
        }
        const t = tally(outcomes)
        data[`append-different N=${N}`] = { ...t, lost: lost.length, lostWriters: lost }
        checks.push(
          { name: `append-different N=${N}: lost updates`, expected: '0', actual: `${lost.length} of ${t.ok}`, ok: lost.length === 0, severity: 'high' },
          { name: `append-different N=${N}: write errors`, expected: '0', actual: `${t.failed} ${JSON.stringify(t.errors)}`, ok: t.failed === 0, severity: 'high' },
        )
      }

      // ---- replace-different (frontmatter change -> folder index regeneration)
      {
        const marker = (i: number) => `RD${N} w${i}.`
        const sinceSiblings = new Date().toISOString()
        const outcomes = await Promise.all(
          ws.map((w) =>
            timed(
              () =>
                w.mcp.call('edit_note', {
                  vaultId: vault.id,
                  path: paths[w.i]!,
                  frontmatter: { type: 'concepts', title: paths[w.i]!, description: marker(w.i) },
                  body: `${marker(w.i)}\n`,
                }),
              w.i,
            ),
          ),
        )
        await Bun.sleep(SETTLE_MS)
        const wrong: Array<{ writer: number; body?: string; db?: string }> = []
        const misattributed: unknown[] = []
        const missing: number[] = []
        const anonymized: number[] = []
        for (const o of outcomes.filter((x) => x.ok)) {
          const p = paths[o.writer]!
          const r = await admin.call('read_note', { vaultId: vault.id, path: p })
          const row = await dbNote(ctx, vault.id, p)
          const body = stringField(r.json, 'body') ?? `READ FAILED ${r.text.slice(0, 80)}`
          if (!body.includes(marker(o.writer)) || row?.body !== body) wrong.push({ writer: o.writer, body, db: row?.body })
          const revs = await historySince(admin, vault.id, p, sinceSiblings)
          const attr = attribution(revs, writers, [o.writer], marker)
          missing.push(...attr.missingRevisionFor)
          anonymized.push(...attr.anonymized)
          misattributed.push(...attr.misattributed)
        }
        const browse = await admin.call('browse_vault', { vaultId: vault.id, path: folder })
        const t = tally(outcomes)
        data[`replace-different N=${N}`] = {
          ...t,
          wrong,
          missingRevisionFor: missing,
          anonymized,
          misattributed,
          browseFolder: { ok: browse.ok, chars: browse.text.length, text: browse.text.slice(0, 1500) },
        }
        checks.push(
          { name: `replace-different N=${N}: write errors`, expected: '0', actual: `${t.failed} ${JSON.stringify(t.errors)}`, ok: t.failed === 0, severity: 'high' },
          { name: `replace-different N=${N}: wrong final content or file/db divergence`, expected: '0', actual: String(wrong.length), ok: wrong.length === 0, severity: 'high' },
          { name: `replace-different N=${N}: attribution`, expected: '0 missing, 0 misattributed', actual: `missing ${missing.length} (${anonymized.length} recorded as anonymous collab), misattributed ${misattributed.length}`, ok: missing.length === 0 && misattributed.length === 0, severity: 'medium' },
          { name: `replace-different N=${N}: folder still browsable`, expected: 'browse_vault ok', actual: browse.ok ? 'ok' : browse.text.slice(0, 200), ok: browse.ok, severity: 'medium' },
        )
      }
      ctx.log(`N=${N} done`)
    }

    const failed = checks.filter((c) => c.ok === false)
    const appendLoss = SIZES.map((N) => {
      const d = data[`append-same N=${N}`]
      return d && typeof d === 'object' ? `N=${N}: ${Reflect.get(d, 'lost')}/${Reflect.get(d, 'ok')} lost` : `N=${N}: ?`
    }).join(', ')
    return {
      summary: `Concurrent edit_note on vault ${vault.id}. Appends to one note (read+edit): ${appendLoss}. ${failed.length} of ${checks.length} checks failed.`,
      checks,
      data: { vaultId: vault.id, writers: writers.map((w) => ({ i: w.i, user: w.user, connId: w.connId })), ...data },
    }
  },
}
export default test
