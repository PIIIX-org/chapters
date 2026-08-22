/**
 * Graph assembly profiler (issue #93).
 *
 * `buildGraph()` runs Louvain over the whole assembled node/edge set on every
 * call, uncached, against a stated 10k-note budget — and nobody has measured
 * it. The open question is whether Louvain is actually the bottleneck or
 * whether the O(n²) pairwise structural-edge loops are, so this harness has to
 * separate them.
 *
 * `assemble.ts` exposes only `buildGraph()`, and it is owned by another change.
 * So: this script times the real `buildGraph()` end to end for the honest
 * number, and separately re-runs a phase-by-phase RECONSTRUCTION of the same
 * pipeline (same queries, same loops, same Louvain call) to attribute the time.
 * The reconstruction mirrors `assemble.ts` at the commit it was written
 * against — if that file changes shape, this one drifts and must be resynced.
 *
 *   pnpm tsx src/scripts/profile-graph.ts            # 1000 5000 10000
 *   pnpm tsx src/scripts/profile-graph.ts 2000
 *
 * Seeds a throwaway user+vault per size and deletes it afterwards. Point
 * DATABASE_URL at a scratch database.
 */
import { performance } from 'node:perf_hooks'
import { UndirectedGraph } from 'graphology'
import louvainModule from 'graphology-communities-louvain'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db, sql } from '../db/client.js'
import { runMigrations } from '../db/migrate.js'
import { noteLinks, notes, semanticEdges, users, vaults } from '../db/schema.js'
import { buildGraph } from '../graph/assemble.js'
import { deleteSemanticEdgesFor } from '../search/semantic-edges.js'
import { config } from '../config.js'

/** louvain ships CJS-flavored typings that fight NodeNext default imports. */
type LouvainFn = (graph: UndirectedGraph) => Record<string, number>
const louvain = ((louvainModule as { default?: unknown }).default ?? louvainModule) as LouvainFn

/** Mirrors the private constant in assemble.ts. Resync if that one moves. */
const STRUCTURAL_GROUP_CAP = 50
/** Tag group size, deliberately just under the cap so the O(n²) loops actually run. */
const TAG_GROUP_SIZE = 40
/** Semantic neighbors seeded per note — matches the default config.semanticK. */
const SEMANTIC_K = config.semanticK
const NOTE_TYPES = ['note', 'idea', 'task', 'reference', 'log']
const INSERT_CHUNK = 1000

if (config.isProd) throw new Error('refusing to seed/delete against NODE_ENV=production')

const sizes = process.argv.slice(2).map(Number)
const SIZES = sizes.length > 0 ? sizes : [1000, 5000, 10000]
if (SIZES.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('sizes must be positive integers')

type Timings = Map<string, number>

async function phase<T>(t: Timings, name: string, fn: () => T | Promise<T>): Promise<T> {
  const start = performance.now()
  const out = await fn()
  t.set(name, (t.get(name) ?? 0) + (performance.now() - start))
  return out
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------- seeding

/**
 * Synthetic vault. Embeddings are deliberately NOT computed: `buildGraph()`
 * never reads the embedding column, it reads the stored `semantic_edges` rows,
 * so real kNN seeding would cost O(n²) queries to produce the same edge count.
 * Edge topology, not edge accuracy, is what the profile measures.
 */
async function seed(n: number): Promise<{ userId: string; vaultId: string; noteIds: string[] }> {
  const [user] = await db
    .insert(users)
    .values({
      email: `graph-profile-${Date.now()}@local`,
      passwordHash: 'profiling-only-never-logged-in',
      status: 'active',
    })
    .returning({ id: users.id })
  const [vault] = await db
    .insert(vaults)
    .values({ name: `graph-profile-${n}`, ownerId: user!.id })
    .returning({ id: vaults.id })

  const noteIds: string[] = []
  const rows = Array.from({ length: n }, (unused, i) => ({
    vaultId: vault!.id,
    type: NOTE_TYPES[i % NOTE_TYPES.length]!,
    name: `note-${i}`,
    path: `notes/${i}.md`,
    // `type:` groups blow past the cap (reported as capped); `tag:` groups sit
    // just under it, which is what drives the pairwise loops.
    frontmatter: {
      tags: [`group-${Math.floor(i / TAG_GROUP_SIZE)}`],
      timestamp: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString(),
    },
    body: `synthetic note ${i} [[notes/${(i + 1) % n}.md]]`,
  }))
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const inserted = await db.insert(notes).values(part).returning({ id: notes.id })
    for (const r of inserted) noteIds.push(r.id)
  }

  const links = noteIds.map((id, i) => ({ sourceNoteId: id, targetPath: `notes/${(i + 1) % n}.md` }))
  for (const part of chunk(links, INSERT_CHUNK)) await db.insert(noteLinks).values(part)

  const sem: (typeof semanticEdges.$inferInsert)[] = []
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= Math.min(SEMANTIC_K, n - 1); k++) {
      sem.push({
        sourceType: 'note',
        sourceId: noteIds[i]!,
        targetType: 'note',
        targetId: noteIds[(i + k) % n]!,
        similarity: 0.9 - k * 0.01,
      })
    }
  }
  for (const part of chunk(sem, INSERT_CHUNK)) await db.insert(semanticEdges).values(part)

  return { userId: user!.id, vaultId: vault!.id, noteIds }
}

async function teardown(userId: string, vaultId: string, noteIds: string[]): Promise<void> {
  for (const part of chunk(noteIds, 5000)) await deleteSemanticEdgesFor('note', part)
  await db.delete(vaults).where(eq(vaults.id, vaultId)) // cascades notes + note_links
  await db.delete(users).where(eq(users.id, userId))
}

// -------------------------------------------------- phase reconstruction

interface Stats {
  nodes: number
  edges: number
  extracted: number
  semantic: number
  structural: number
  cappedGroups: number
  louvainCommunities: number
}

/** Same pipeline as buildGraph(), notes-only, with a clock around each phase. */
async function reconstruct(vaultId: string, t: Timings): Promise<Stats> {
  const total = performance.now()

  const noteRows = await phase(t, 'q: notes', () =>
    db
      .select({
        id: notes.id,
        vaultId: notes.vaultId,
        path: notes.path,
        type: notes.type,
        frontmatter: notes.frontmatter,
      })
      .from(notes)
      .where(and(inArray(notes.vaultId, [vaultId]), isNull(notes.deletedAt))),
  )

  const internalNodes = await phase(t, 'filter + index maps', () => {
    const built = noteRows.map((r) => {
      const fm = r.frontmatter as { tags?: string[]; timestamp?: string }
      return {
        id: r.id,
        resourceId: r.vaultId,
        path: r.path,
        type: r.type,
        tags: Array.isArray(fm.tags) ? fm.tags : [],
      }
    })
    return built
  })
  const byId = new Map(internalNodes.map((n) => [n.id, n]))
  const noteByVaultPath = new Map(internalNodes.map((n) => [`${n.resourceId}:${n.path}`, n.id]))
  const noteIds = internalNodes.map((n) => n.id)

  const edges: { source: string; target: string; kind: string }[] = []
  const seen = new Set<string>()
  const addEdge = (a: string, b: string, kind: string) => {
    if (a === b) return
    const key = a < b ? `${a}|${b}|${kind}` : `${b}|${a}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source: a, target: b, kind })
  }

  const links = await phase(t, 'q: note_links', () =>
    db.select().from(noteLinks).where(inArray(noteLinks.sourceNoteId, noteIds)),
  )
  await phase(t, 'loop: extracted', () => {
    for (const link of links) {
      const source = byId.get(link.sourceNoteId)
      if (!source) continue
      const targetId = noteByVaultPath.get(`${source.resourceId}:${link.targetPath}`)
      if (targetId) addEdge(link.sourceNoteId, targetId, 'extracted')
    }
  })
  const extracted = edges.length

  const sem = await phase(t, 'q: semantic_edges', () =>
    db
      .select()
      .from(semanticEdges)
      .where(or(inArray(semanticEdges.sourceId, noteIds), inArray(semanticEdges.targetId, noteIds))),
  )
  await phase(t, 'loop: semantic', () => {
    for (const edge of sem) {
      if (byId.has(edge.sourceId) && byId.has(edge.targetId)) {
        addEdge(edge.sourceId, edge.targetId, 'semantic')
      }
    }
  })
  const semantic = edges.length - extracted

  const groups = await phase(t, 'loop: group bucketing', () => {
    const g = new Map<string, string[]>()
    const add = (key: string, id: string) => {
      const list = g.get(key)
      if (list) list.push(id)
      else g.set(key, [id])
    }
    for (const n of internalNodes) {
      add(`type:${n.type}`, n.id)
      for (const tag of n.tags) add(`tag:${tag}`, n.id)
    }
    return g
  })

  const cappedGroups = await phase(t, 'loop: pairwise structural', () => {
    const capped: string[] = []
    for (const [key, ids] of groups) {
      if (ids.length > STRUCTURAL_GROUP_CAP) {
        capped.push(key)
        continue
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) addEdge(ids[i]!, ids[j]!, 'structural')
      }
    }
    return capped
  })
  const structural = edges.length - extracted - semantic

  const g = await phase(t, 'graphology build', () => {
    const graph = new UndirectedGraph()
    for (const id of byId.keys()) graph.addNode(id)
    for (const e of edges) {
      if (!graph.hasEdge(e.source, e.target)) graph.addEdge(e.source, e.target)
    }
    return graph
  })

  const communities = await phase(t, 'louvain', () =>
    g.order > 0 && g.size > 0 ? louvain(g) : {},
  )

  t.set('reconstruction total', performance.now() - total)
  return {
    nodes: internalNodes.length,
    edges: edges.length,
    extracted,
    semantic,
    structural,
    cappedGroups: cappedGroups.length,
    louvainCommunities: new Set(Object.values(communities)).size,
  }
}

// ------------------------------------------------------------------ main

const PHASES = [
  'seed',
  'buildGraph (cold)',
  'buildGraph (warm)',
  'q: notes',
  'q: note_links',
  'q: semantic_edges',
  'filter + index maps',
  'loop: extracted',
  'loop: semantic',
  'loop: group bucketing',
  'loop: pairwise structural',
  'graphology build',
  'louvain',
  'reconstruction total',
]

function table(header: string, rows: [string, ...string[]][], columns: string[]): string {
  const widths = [Math.max(...rows.map((r) => r[0].length), header.length), ...columns.map((c) => Math.max(c.length, 12))]
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')
  return [
    line([header, ...columns]),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(r)),
  ].join('\n')
}

await runMigrations()

const results = new Map<number, { timings: Timings; stats: Stats }>()
for (const n of SIZES) {
  console.log(`seeding ${n} notes...`)
  const timings: Timings = new Map()
  const { userId, vaultId, noteIds } = await phase(timings, 'seed', () => seed(n))
  try {
    const resources = { vaultIds: [vaultId], repositoryIds: [] }
    const cold = await phase(timings, 'buildGraph (cold)', () => buildGraph(resources))
    const stats = await reconstruct(vaultId, timings)
    await phase(timings, 'buildGraph (warm)', () => buildGraph(resources))
    if (cold.edges.length !== stats.edges) {
      console.warn(
        `WARNING: reconstruction drifted from assemble.ts — buildGraph produced ${cold.edges.length} edges, reconstruction ${stats.edges}`,
      )
    }
    results.set(n, { timings, stats })
  } finally {
    await teardown(userId, vaultId, noteIds)
  }
}

const columns = SIZES.map((n) => `${n} notes`)
const fmt = (v: number | undefined) => (v === undefined ? '-' : v.toFixed(1))
const statRow = (label: string, pick: (s: Stats) => number): [string, ...string[]] => [
  label,
  ...SIZES.map((n) => String(pick(results.get(n)!.stats))),
]

console.log('')
console.log(
  table('graph', [
    statRow('nodes', (s) => s.nodes),
    statRow('edges (total)', (s) => s.edges),
    statRow('  extracted', (s) => s.extracted),
    statRow('  semantic', (s) => s.semantic),
    statRow('  structural', (s) => s.structural),
    statRow('capped groups', (s) => s.cappedGroups),
    statRow('communities', (s) => s.louvainCommunities),
  ], columns),
)
console.log('')
console.log(
  table(
    'phase (ms)',
    PHASES.map((p) => [p, ...SIZES.map((n) => fmt(results.get(n)!.timings.get(p)))] as [string, ...string[]]),
    columns,
  ),
)

await sql.end()
