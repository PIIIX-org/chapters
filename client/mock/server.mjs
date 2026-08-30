#!/usr/bin/env node
/**
 * Dependency-free mock of the Chapters API.
 *
 * Serves every endpoint the React client calls (see `client/src/api/*.ts`)
 * from in-memory fixtures, so the UI can be run and screenshotted without
 * Postgres, the collab relay or a mail sender. State is mutated by
 * POST/PUT/PATCH/DELETE and reset on restart.
 *
 *   MOCK_PORT    listen port (default 3999; use 3000 to sit behind vite's proxy)
 *   MOCK_ROLE    'admin' (default) or 'member' for the session user
 *   MOCK_EMAIL   session user's address (default taha@chapters.dev)
 *   MOCK_COLLAB  'offline' (default): POST /collab/ticket answers 503 so the
 *                editor falls back to the REST body with an "offline" status.
 *                'ticket': answer a well-formed ticket instead; the websocket
 *                handshake then fails (no relay here) and the editor shows
 *                "connecting" over an empty document.
 */
import http from 'node:http'
import { posix } from 'node:path'
import { createHash, randomUUID, randomBytes } from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT ?? 3999)
const ROLE = process.env.MOCK_ROLE === 'member' ? 'member' : 'admin'
const COLLAB = process.env.MOCK_COLLAB === 'ticket' ? 'ticket' : 'offline'
const MY_EMAIL = process.env.MOCK_EMAIL ?? 'taha@chapters.dev'

// ---------------------------------------------------------------------------
// Deterministic ids and times so URLs survive a restart.
// ---------------------------------------------------------------------------
let seed = 0x9e3779b9
function rand() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
function hex(n) {
  let s = ''
  while (s.length < n) s += Math.floor(rand() * 16).toString(16)
  return s
}
function uuid() {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(rand() * 4)).toString(16)}${hex(3)}-${hex(12)}`
}
function pick(list) {
  return list[Math.floor(rand() * list.length)]
}
const NOW = Date.now()
const ago = (days, hours = 0) => new Date(NOW - days * 864e5 - hours * 36e5).toISOString()
const now = () => new Date().toISOString()
const sha = (s) => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const mkUser = (email, extra = {}) => ({
  id: uuid(),
  email,
  status: 'active',
  role: 'member',
  emailVerifiedAt: ago(90),
  createdAt: ago(95),
  mfaEnabledAt: null,
  ...extra,
})
const ME = mkUser(MY_EMAIL, { role: ROLE, createdAt: ago(121), emailVerifiedAt: ago(120) })
const ADA = mkUser('ada@chapters.dev', { role: 'admin', mfaEnabledAt: ago(40) })
const GRACE = mkUser('grace@chapters.dev')
const LINUS = mkUser('linus@chapters.dev', { createdAt: ago(30), emailVerifiedAt: ago(30) })
const NOOR = mkUser('noor@chapters.dev', { role: 'admin', mfaEnabledAt: ago(10) })
const PRIYA = mkUser('priya.n@meridianlabs.io', { status: 'pending_approval', emailVerifiedAt: ago(0, 5), createdAt: ago(0, 6) })
const SAM = mkUser('sam.ortega@fastmail.com', { status: 'pending_approval', emailVerifiedAt: null, createdAt: ago(1, 2) })
const WEI = mkUser('wei@chapters.dev', { status: 'pending_approval', emailVerifiedAt: ago(2), createdAt: ago(2, 1) })
const OLD = mkUser('former.intern@chapters.dev', { status: 'deactivated', createdAt: ago(200), emailVerifiedAt: ago(199) })
const users = [ME, ADA, GRACE, LINUS, NOOR, PRIYA, SAM, WEI, OLD]

// ---------------------------------------------------------------------------
// Vaults and notes
// ---------------------------------------------------------------------------
// [type, slug, tags, daysAgo, body]
const RESEARCH_NOTES = [
  ['notes', 'attention-mechanisms', ['ml', 'transformers'], 3, `# Attention mechanisms

Scaled dot-product attention is the whole trick: a softmax over query-key
similarities, used to weight the values. Multi-head just runs it in parallel
over learned projections.

Where this matters for us: [[projects/semantic-search-v2]] embeds chunks with a
bi-encoder and re-ranks with a cross-encoder — the cross-encoder is attention
between query and document tokens, which is why it is slow and why it is good.

See also [[notes/retrieval-augmented-generation]] and the reading list in
[[notes/reading-list-q3]]. [[people/ada-okafor]] has the annotated paper.
`],
  ['notes', 'retrieval-augmented-generation', ['ml', 'search', 'rag'], 5, `# Retrieval-augmented generation

Retrieve first, then generate with the retrieved passages in context. The
retrieval half is what we already have in [[projects/semantic-search-v2]]; the
generation half is a model call we do not own.

## Failure modes seen so far

- Recall: the right chunk exists but is not in the top-k. Tracked in
  [[notes/semantic-knn-recall]].
- Chunk boundaries splitting a definition from its example.
- The model ignoring the context and answering from memory.

[[people/grace-lin]] wants the eval harness ([[notes/evaluation-harness]]) to
score each of these separately rather than one blended number.
`],
  ['notes', 'reading-list-q3', ['ml', 'reading'], 12, `# Reading list, Q3

| Paper | Status | Owner |
| --- | --- | --- |
| Attention Is All You Need | re-read | [[people/ada-okafor]] |
| Dense Passage Retrieval | done | [[people/grace-lin]] |
| ColBERT v2 | in progress | me |
| HNSW: efficient approximate nearest neighbour | queued | [[people/linus-berg]] |
| Fast unfolding of communities (Louvain) | done | me |

Notes go in their own files; this page is the index. Louvain feeds
[[notes/graph-communities]].
`],
  ['notes', 'semantic-knn-recall', ['search', 'ml', 'bug'], 1, `# Semantic kNN recall

The pgvector HNSW index returns the *approximate* nearest neighbours, and with
\`ef_search\` at its default of 40 we drop real matches whenever a vault has more
than a few thousand chunks.

## Findings

1. Raising \`ef_search\` to 200 recovers recall@10 from 0.71 to 0.96 on the
   [[projects/semantic-search-v2]] benchmark.
2. Latency goes from 9 ms to 31 ms per query — acceptable.
3. Filtering by vault *before* the kNN (not after) is the bigger win; post-
   filtering starves the result set.

Fix is on the \`fix/semantic-knn-recall\` branch. Harness numbers in
[[notes/evaluation-harness]].
`],
  ['notes', 'evaluation-harness', ['ml', 'search', 'tooling'], 4, `# Evaluation harness

A fixed query set (240 queries, hand-labelled) against a frozen snapshot of
three vaults. Reports recall@k, MRR and p95 latency per run, and diffs against
the previous run.

- Query set lives in the \`ml-pipeline\` repository under \`pipeline/eval\`.
- Runs are triggered from the CLI: \`pipeline eval --snapshot 2026-08-20\`.
- Results are pasted into [[notes/semantic-knn-recall]] when they change a
  decision.

Owner: [[people/grace-lin]]. Related: [[projects/semantic-search-v2]].
`],
  ['notes', 'graph-communities', ['graph', 'algorithms'], 7, `# Graph communities

Louvain modularity over the assembled graph (wikilinks + structural + semantic
edges). Deterministic because the RNG is seeded from the sorted node ids —
otherwise the community colours reshuffle on every refresh.

Aggregated view collapses each community to one node sized by member count;
drilling in shows the members. Cap at 2,500 members per drill-down.

Follow-ups tracked in [[projects/graph-explorer]]. Background in
[[notes/reading-list-q3]].
`],
  ['notes', 'chunking-strategies', ['search', 'ml'], 9, `# Chunking strategies

Fixed 512-token windows with 64-token overlap beat sentence-boundary chunks on
our recall benchmark, but lose on answer quality because they split lists.

Trying: heading-aware chunks (one chunk per markdown section, split only when a
section exceeds 800 tokens). [[people/linus-berg]] is implementing it in the
pipeline. Compare using [[notes/evaluation-harness]].
`],
  ['people', 'ada-okafor', ['team', 'ml'], 2, `# Ada Okafor

Research lead. Owns the model side of [[projects/semantic-search-v2]] and
reviews every embedding change.

- Prefers written proposals over meetings.
- Keeps the annotated paper copies referenced in [[notes/reading-list-q3]].
- Pairing slot: Tuesdays.
`],
  ['people', 'grace-lin', ['team', 'evaluation'], 6, `# Grace Lin

Runs the [[notes/evaluation-harness]] and is the reason we have numbers instead
of vibes. Asked for per-failure-mode scoring in
[[notes/retrieval-augmented-generation]].
`],
  ['people', 'linus-berg', ['team', 'infra'], 14, `# Linus Berg

Joined last month. Infra and pipeline work: currently
[[notes/chunking-strategies]], next the HNSW paper from
[[notes/reading-list-q3]].
`],
  ['projects', 'semantic-search-v2', ['search', 'ml', 'q3'], 1, `# Semantic search v2

**Goal:** recall@10 above 0.95 on the benchmark with p95 latency under 50 ms.

## Status

- [x] Bi-encoder embeddings for every chunk
- [x] Vault-scoped filtering before kNN ([[notes/semantic-knn-recall]])
- [ ] Cross-encoder re-rank of the top 50 ([[notes/attention-mechanisms]])
- [ ] Heading-aware chunking ([[notes/chunking-strategies]])

Team: [[people/ada-okafor]], [[people/grace-lin]], [[people/linus-berg]].
Measured by [[notes/evaluation-harness]].
`],
  ['projects', 'graph-explorer', ['graph', 'ui'], 8, `# Graph explorer

The merged graph across every vault and repository the user has opted in.
Communities from [[notes/graph-communities]]; filters by type, tag and time.

Open questions:
- Should code files and notes share a community space, or be separate layers?
- Semantic edges between vaults — useful or noise?
`],
  ['projects', 'vault-import', ['tooling', 'export'], 20, `# Vault import

Import always creates a new vault from an exported zip; it never merges.
Shares in the manifest are re-created when the email matches an account here,
and reported as unmatched otherwise.

Related: [[projects/graph-explorer]] needs the imported vault to be mergeable
by default.
`],
]

const PRODUCT_NOTES = [
  ['notes', 'onboarding-funnel', ['growth', 'metrics'], 2, `# Onboarding funnel

Signup → email verified → approved → first vault → first note → first share.

| Step | Conversion (Aug) |
| --- | --- |
| verified | 91% |
| approved | 78% |
| first vault | 64% |
| first note | 58% |
| first share | 19% |

The approval step is where we lose people who never come back. Discussed in
[[projects/self-serve-signup]]; [[people/priya-natarajan]] raised it first.
`],
  ['notes', 'pricing-experiments', ['growth', 'pricing'], 6, `# Pricing experiments

Three tiers tested on the marketing page in July: Solo / Team / Self-hosted.
Team at 12 seats minimum performed worst; per-seat with a 3-seat floor best.

Next: test whether "self-hosted, free" cannibalises Team. Decision needed by
the [[notes/roadmap-2026-h2]] review.
`],
  ['notes', 'customer-interview-meridian', ['customers', 'interview'], 3, `# Customer interview — Meridian Labs

With [[people/priya-natarajan]] and two of her researchers.

- They keep code and notes in separate tools and lose the links between them.
  [[projects/repository-ingestion]] is exactly what they asked for.
- Want a read-only share for external reviewers. We have it; they did not know.
- Graph view was the "wow" moment — but only once it had their own data in it.

Follow-up: pilot with their research vault. Tracked in [[projects/team-workspaces]].
`],
  ['notes', 'roadmap-2026-h2', ['roadmap', 'growth'], 1, `# Roadmap, 2026 H2

1. [[projects/self-serve-signup]] — remove the approval queue for verified
   company domains.
2. [[projects/repository-ingestion]] — GitHub app, then GitLab.
3. [[projects/team-workspaces]] — team-owned vaults, not just team shares.
4. Mobile read-only view.

Pricing decision from [[notes/pricing-experiments]] gates item 1.
`],
  ['notes', 'release-notes-0-9', ['release'], 10, `# Release notes 0.9

- Realtime co-editing through the collab relay.
- Revision history with revert.
- Repository ingestion (git and agent push).
- Merged graph with community aggregation.

Known issues: recall regression on large vaults (fixed in 0.9.1), and the
support themes in [[notes/support-themes-august]].
`],
  ['notes', 'support-themes-august', ['customers', 'support'], 4, `# Support themes, August

1. "Where did my note go?" — trash is under the vault menu; nobody finds it.
2. Share links that expire before the recipient opens them.
3. Webhook secret rotation breaking deliveries (the UI warns, people click
   through anyway).

[[people/sam-ortega]] handles most of these. Feeds [[notes/onboarding-funnel]].
`],
  ['people', 'meridian-labs', ['customers', 'pilot'], 3, `# Meridian Labs

Research consultancy, ~40 people. Pilot customer for repositories. Contact:
[[people/priya-natarajan]]. Interview notes in
[[notes/customer-interview-meridian]].
`],
  ['people', 'priya-natarajan', ['customers'], 3, `# Priya Natarajan

Head of research at [[people/meridian-labs]]. Signed up herself and is waiting
in the approval queue — approve her before the pilot call.
`],
  ['people', 'sam-ortega', ['team', 'support'], 5, `# Sam Ortega

Support and success. Writes [[notes/support-themes-august]] and wants a
dashboard instead of a monthly note.
`],
  ['projects', 'self-serve-signup', ['growth', 'auth'], 2, `# Self-serve signup

Skip manual approval for verified addresses on an allowlisted company domain.
Admins keep the queue for everyone else.

- Depends on the pricing decision ([[notes/pricing-experiments]]).
- Funnel impact estimated from [[notes/onboarding-funnel]]: +14% to first vault.
`],
  ['projects', 'team-workspaces', ['teams', 'sharing'], 7, `# Team workspaces

Today a team is only a share grantee. A team workspace would own vaults, so
membership changes move access automatically and leaving people take nothing
with them.

Pilot: [[people/meridian-labs]]. Roadmap: [[notes/roadmap-2026-h2]].
`],
  ['projects', 'repository-ingestion', ['code', 'graph'], 1, `# Repository ingestion

Code is a derived index; git stays the record of truth. Three ways in: clone a
git URL, a local path on the server, or an agent pushing files with a sync
token.

Customers asked for it in [[notes/customer-interview-meridian]]. Shipped in
[[notes/release-notes-0-9]]; webhook rotation issue in
[[notes/support-themes-august]].
`],
]

const PERSONAL_NOTES = [
  ['notes', 'weekly-review-2026-w35', ['review', 'personal'], 1, `# Weekly review, 2026-W35

**Went well:** the recall fix landed; ran three times; finished the book from
[[notes/books-2026]].

**Did not:** the Lisbon paperwork ([[projects/move-to-lisbon]]) — still on the
desk.

Next week: garden beds ([[projects/garden-2026]]), call [[people/mara]] about
the September trip.
`],
  ['notes', 'books-2026', ['reading', 'personal'], 4, `# Books 2026

- *The Dispossessed* — done, again.
- *Designing Data-Intensive Applications* — reference, not reading.
- *A Pattern Language* — for [[notes/home-office-setup]].
- *The Rust Programming Language* — see [[notes/learning-rust]].
`],
  ['notes', 'sourdough-log', ['cooking', 'personal'], 2, `# Sourdough log

- 2026-08-22: 78% hydration, 4 h bulk at 26 °C. Flat. Too warm.
- 2026-08-25: 75%, 3.5 h bulk, cold retard 14 h. Best crumb yet.
- 2026-08-28: same, added 10% rye. Denser but better flavour.

Starter feeding schedule is in [[notes/weekly-review-2026-w35]].
`],
  ['notes', 'running-plan', ['health', 'personal'], 3, `# Running plan

Building to a half in October. Three runs a week, long run Sunday.

| Week | Long run |
| --- | --- |
| 35 | 12 km |
| 36 | 14 km |
| 37 | 16 km |

[[people/dr-feld]] said the knee is fine as long as the increase stays under
10% a week.
`],
  ['notes', 'home-office-setup', ['home', 'personal'], 15, `# Home office setup

Desk by the window, monitor arm, the good chair. Still missing: acoustic
panels and a second lamp.

Might all be moot — see [[projects/move-to-lisbon]].
`],
  ['notes', 'learning-rust', ['learning', 'code'], 6, `# Learning Rust

Working through the book, one chapter a week. The borrow checker stopped
fighting me around chapter 10.

Practice project: [[projects/side-project-recipe-graph]] — a small graph of
recipes and ingredients, which is suspiciously like work.
`],
  ['people', 'dad', ['family', 'personal'], 5, `# Dad

Call Sundays. Wants to visit Lisbon once we are there ([[projects/move-to-lisbon]]).
Asked about the garden again ([[projects/garden-2026]]).
`],
  ['people', 'mara', ['friends', 'personal'], 3, `# Mara

Climbing partner. Planning a September trip — dates depend on the
[[notes/running-plan]] taper.
`],
  ['people', 'dr-feld', ['health'], 9, `# Dr. Feld

Physio. Next appointment 12 September. Notes on the knee in
[[notes/running-plan]].
`],
  ['projects', 'move-to-lisbon', ['life', 'personal'], 2, `# Move to Lisbon

- [ ] Visa paperwork
- [x] Shortlist neighbourhoods
- [ ] Decide what to do with the office ([[notes/home-office-setup]])
- [ ] Tell [[people/dad]] the date

Weekly check-in via [[notes/weekly-review-2026-w35]].
`],
  ['projects', 'garden-2026', ['home', 'personal'], 8, `# Garden 2026

Two raised beds. Tomatoes did well, courgettes took over everything. Next
year: fewer courgettes. Sourdough herbs from here go into
[[notes/sourdough-log]].
`],
  ['projects', 'side-project-recipe-graph', ['code', 'learning'], 6, `# Side project — recipe graph

Rust CLI that builds a graph of recipes ↔ ingredients and finds what I can
cook from what is in the fridge. Learning vehicle for [[notes/learning-rust]].
`],
]

const vaults = []
const notesByVault = new Map()
const revisions = [] // { id, vaultId, noteId, notePath, actorType, actorId, action, createdAt }
const trashedVaults = []

function seedVault(name, ownerId, access, mergeable, fixtures) {
  const vault = { id: uuid(), name, ownerId, mergeable, access, deletedAt: null }
  vaults.push(vault)
  const list = []
  for (const [type, slug, tags, daysAgo, body] of fixtures) {
    const note = {
      id: uuid(),
      vaultId: vault.id,
      path: `${type}/${slug}`,
      type,
      name: slug,
      frontmatter: { type, tags, timestamp: ago(daysAgo + 20) },
      body,
      updatedAt: ago(daysAgo, Math.floor(rand() * 20)),
      deletedAt: null,
    }
    if (type === 'people') note.frontmatter.resource = `mailto:${slug.replace(/-/g, '.')}@example.com`
    list.push(note)
    seedRevisions(vault, note)
  }
  notesByVault.set(vault.id, list)
  return vault
}

function seedRevisions(vault, note) {
  const count = 2 + Math.floor(rand() * 5)
  const actors = [
    ['collab', vault.ownerId],
    ['collab', ADA.id],
    ['user', vault.ownerId],
    ['mcp', null],
    ['collab', GRACE.id],
  ]
  for (let i = 0; i < count; i++) {
    const [actorType, actorId] = i === 0 ? ['user', vault.ownerId] : pick(actors)
    revisions.push({
      id: uuid(),
      vaultId: vault.id,
      noteId: note.id,
      notePath: note.path,
      actorType,
      actorId,
      action: i === 0 ? 'create' : rand() < 0.15 ? 'revert' : 'update',
      createdAt: ago(30 - i * (30 / count), Math.floor(rand() * 12)),
    })
  }
}

const RESEARCH = seedVault('Research', ME.id, 'owner', true, RESEARCH_NOTES)
const PRODUCT = seedVault('Product', ADA.id, 'edit', true, PRODUCT_NOTES)
seedVault('Personal', ME.id, 'owner', false, PERSONAL_NOTES)

// A trashed vault so the trash page has something in it.
const ARCHIVE = { id: uuid(), name: 'Archive 2025', ownerId: ME.id, mergeable: false, access: 'owner', deletedAt: ago(6) }
notesByVault.set(ARCHIVE.id, [
  { id: uuid(), vaultId: ARCHIVE.id, path: 'notes/old-plan', type: 'notes', name: 'old-plan', frontmatter: { type: 'notes', tags: ['archive'], timestamp: ago(300) }, body: '# Old plan\n\nSuperseded.\n', updatedAt: ago(200), deletedAt: null },
])
trashedVaults.push(ARCHIVE)

// One trashed note in Research so the note trash is not empty.
{
  const list = notesByVault.get(RESEARCH.id)
  list.push({
    id: uuid(), vaultId: RESEARCH.id, path: 'notes/scratch-ideas', type: 'notes', name: 'scratch-ideas',
    frontmatter: { type: 'notes', tags: ['scratch'], timestamp: ago(40) },
    body: '# Scratch ideas\n\n- Try product quantisation\n- Ask Ada about distillation\n',
    updatedAt: ago(11), deletedAt: ago(2),
  })
}

const vaultGraphPreference = new Map() // vaultId -> boolean
vaultGraphPreference.set(RESEARCH.id, true)
vaultGraphPreference.set(PRODUCT.id, true)

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------
const TS_FILES = {
  'server/src/app.ts': `import Fastify from 'fastify'
import { registerAuthRoutes } from './auth/routes.js'
import { registerVaultRoutes } from './vaults/routes.js'
import { registerGraphRoutes } from './graph/routes.js'

export interface AppOptions {
  logger?: boolean
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? true })
  registerAuthRoutes(app)
  registerVaultRoutes(app)
  registerGraphRoutes(app)
  return app
}

export async function start(port: number) {
  const app = buildApp()
  await app.listen({ port, host: '0.0.0.0' })
  return app
}
`,
  'server/src/graph/assemble.ts': `import { louvain } from './louvain.js'

export type ResourceType = 'note' | 'code'

export interface GraphNode {
  id: string
  resourceType: ResourceType
  resourceId: string
  path: string
  type: string | null
  tags: string[]
  community: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: 'extracted' | 'structural' | 'semantic'
}

export const STRUCTURAL_GROUP_CAP = 200
export const COMMUNITY_MEMBER_CAP = 2500

export function assembleGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const communities = louvain(nodes.map((n) => n.id), edges)
  return {
    nodes: nodes.map((n) => ({ ...n, community: communities[n.id] ?? 0 })),
    edges,
  }
}

export function collapseToCommunities(graph: ReturnType<typeof assembleGraph>) {
  const byCommunity = new Map<number, GraphNode[]>()
  for (const n of graph.nodes) {
    const list = byCommunity.get(n.community) ?? []
    list.push(n)
    byCommunity.set(n.community, list)
  }
  return [...byCommunity.entries()].map(([community, members]) => ({
    id: \`community:\${community}\`,
    community,
    size: members.length,
  }))
}
`,
  'server/src/graph/louvain.ts': `export interface Edge {
  source: string
  target: string
}

function modularityGain(degree: number, total: number, inside: number) {
  return inside - (degree * degree) / (2 * total)
}

export function louvain(nodeIds: string[], edges: Edge[]): Record<string, number> {
  const community: Record<string, number> = {}
  nodeIds.forEach((id, i) => (community[id] = i))
  const degree: Record<string, number> = {}
  for (const e of edges) {
    degree[e.source] = (degree[e.source] ?? 0) + 1
    degree[e.target] = (degree[e.target] ?? 0) + 1
  }
  let moved = true
  while (moved) {
    moved = false
    for (const e of edges) {
      if (community[e.source] === community[e.target]) continue
      if (modularityGain(degree[e.source]!, edges.length, 1) > 0) {
        community[e.target] = community[e.source]!
        moved = true
      }
    }
  }
  return community
}
`,
  'server/src/notes/okf.ts': `export interface Frontmatter {
  type?: string
  tags?: string[]
  timestamp?: string
  resource?: string
  [key: string]: unknown
}

export class OkfValidationError extends Error {}

export function parseNote(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\\n([\\s\\S]*?)\\n?---\\n?([\\s\\S]*)$/)
  if (!match) throw new OkfValidationError('missing frontmatter fence')
  return { frontmatter: JSON.parse(match[1]!), body: match[2] ?? '' }
}

export function extractWikilinks(body: string): string[] {
  const links: string[] = []
  for (const m of body.matchAll(/\\[\\[([^\\]|#]+)(?:[|#][^\\]]*)?\\]\\]/g)) {
    links.push(m[1]!.trim())
  }
  return [...new Set(links)]
}
`,
  'server/src/notes/store.ts': `import { extractWikilinks } from './okf.js'

export interface NoteRow {
  id: string
  vaultId: string
  path: string
  type: string
  body: string
}

const notes = new Map<string, NoteRow>()

export function getNote(vaultId: string, path: string): NoteRow | undefined {
  return notes.get(\`\${vaultId}/\${path}\`)
}

export function createNote(input: Omit<NoteRow, 'id'>): NoteRow {
  const row = { ...input, id: crypto.randomUUID() }
  notes.set(\`\${row.vaultId}/\${row.path}\`, row)
  return row
}

export function linksOf(row: NoteRow): string[] {
  return extractWikilinks(row.body)
}
`,
  'server/src/search/routes.ts': `import type { FastifyInstance } from 'fastify'

export interface SearchHit {
  id: string
  path: string
  snippet: string
  score: number
}

const DEFAULT_LIMIT = 20

export function registerSearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q: string; limit?: string } }>('/search', async (req) => {
    const limit = Number(req.query.limit ?? DEFAULT_LIMIT)
    return searchAll(req.query.q, limit)
  })
}

export async function searchAll(q: string, limit: number): Promise<SearchHit[]> {
  void q
  void limit
  return []
}
`,
  'server/src/sync/collab-server.ts': `import { Hocuspocus } from '@hocuspocus/server'

export function parseDocName(name: string): { vaultId: string; path: string } {
  const slash = name.indexOf('/')
  return { vaultId: name.slice(0, slash), path: name.slice(slash + 1) }
}

export function createCollabServer() {
  return new Hocuspocus({
    async onAuthenticate({ token }) {
      if (!token) throw new Error('ticket required')
      return { userId: token }
    },
  })
}
`,
  'client/src/lib/api.ts': `export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    super(\`Request failed (\${status})\`)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`/api\${path}\`, { ...init, credentials: 'include' })
  const body = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}
`,
  'client/src/hooks/useGraph.ts': `import { useQuery } from '@tanstack/react-query'
import { fetchGraph } from '../api/graph.js'

export function useGraph(vaultId: string | null, community: number | null) {
  return useQuery({
    queryKey: ['graph', vaultId, community],
    queryFn: () => fetchGraph({ vaultId, community, filters: {} }),
  })
}
`,
  'client/src/components/graph/GraphCanvas.tsx': `import { useEffect, useRef } from 'react'
import { forceSimulation, forceLink, forceManyBody } from 'd3-force'

export interface GraphCanvasProps {
  nodes: { id: string }[]
  edges: { source: string; target: string }[]
}

export function GraphCanvas({ nodes, edges }: GraphCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const sim = forceSimulation(nodes as never)
      .force('link', forceLink(edges as never).id((d: { id: string }) => d.id))
      .force('charge', forceManyBody())
    return () => void sim.stop()
  }, [nodes, edges])
  return <canvas ref={ref} className="h-full w-full" />
}
`,
  'client/src/pages/HomePage.tsx': `import { GraphCanvas } from '../components/graph/GraphCanvas.js'
import { useGraph } from '../hooks/useGraph.js'

export function HomePage() {
  const graph = useGraph(null, null)
  if (graph.isPending) return null
  if (graph.isError) return <p>Could not load the graph.</p>
  return <GraphCanvas nodes={graph.data.nodes} edges={graph.data.edges} />
}
`,
  'shared/src/okf-types.ts': `export type NoteType = 'notes' | 'people' | 'projects'

export interface OkfNote {
  type: NoteType
  name: string
  tags: string[]
  timestamp: string
}

export const NOTE_TYPES: NoteType[] = ['notes', 'people', 'projects']
`,
  'scripts/seed.ts': `import { buildApp } from '../server/src/app.js'

async function main() {
  const app = buildApp({ logger: false })
  await app.ready()
  console.log('seeded')
}

void main()
`,
  'package.json': `{
  "name": "chapters",
  "private": true,
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  }
}
`,
  'README.md': `# Chapters

Notes, people and projects in vaults; code in repositories; one graph over
all of it.

## Development

    pnpm install
    pnpm --filter @chapters/server dev
    pnpm --filter @chapters/client dev
`,
  'docs/architecture.md': `# Architecture

- Fastify API with Postgres and pgvector.
- Hocuspocus relay on the same HTTP server (\`/collab\`).
- React client behind vite in development, nginx in production.
`,
}

const PY_FILES = {
  'pipeline/__init__.py': `"""Embedding and evaluation pipeline for Chapters search."""

__version__ = "0.4.1"
`,
  'pipeline/ingest.py': `from dataclasses import dataclass
from pathlib import Path

from .chunk import chunk_markdown


@dataclass
class Document:
    path: str
    text: str


def load_vault(root: Path) -> list[Document]:
    docs = []
    for file in sorted(root.rglob("*.md")):
        docs.append(Document(path=str(file.relative_to(root)), text=file.read_text()))
    return docs


def ingest(root: Path):
    for doc in load_vault(root):
        for chunk in chunk_markdown(doc.text):
            yield doc.path, chunk
`,
  'pipeline/chunk.py': `import re

HEADING = re.compile(r"^#{1,6} ", re.M)
MAX_TOKENS = 800
OVERLAP = 64


def chunk_markdown(text: str) -> list[str]:
    """Heading-aware chunks: one per section, split when a section is too long."""
    sections = HEADING.split(text)
    out = []
    for section in sections:
        words = section.split()
        if len(words) <= MAX_TOKENS:
            out.append(section.strip())
            continue
        for start in range(0, len(words), MAX_TOKENS - OVERLAP):
            out.append(" ".join(words[start : start + MAX_TOKENS]))
    return [c for c in out if c]
`,
  'pipeline/embed.py': `import numpy as np

DIM = 768


class Embedder:
    def __init__(self, model: str = "bge-base"):
        self.model = model

    def embed(self, texts: list[str]) -> np.ndarray:
        rng = np.random.default_rng(abs(hash(self.model)) % (2**32))
        return rng.standard_normal((len(texts), DIM)).astype("float32")


def normalise(vectors: np.ndarray) -> np.ndarray:
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
`,
  'pipeline/index.py': `import numpy as np

from .embed import normalise


class HnswIndex:
    def __init__(self, ef_search: int = 200):
        self.ef_search = ef_search
        self._vectors = None
        self._ids = []

    def add(self, ids: list[str], vectors: np.ndarray) -> None:
        self._ids.extend(ids)
        v = normalise(vectors)
        self._vectors = v if self._vectors is None else np.vstack([self._vectors, v])

    def query(self, vector: np.ndarray, k: int = 10) -> list[tuple[str, float]]:
        scores = self._vectors @ normalise(vector[None, :])[0]
        top = np.argsort(-scores)[:k]
        return [(self._ids[i], float(scores[i])) for i in top]
`,
  'pipeline/eval/__init__.py': ``,
  'pipeline/eval/recall.py': `def recall_at_k(ranked: list[str], relevant: set[str], k: int = 10) -> float:
    if not relevant:
        return 0.0
    hits = sum(1 for doc in ranked[:k] if doc in relevant)
    return hits / len(relevant)


def mrr(ranked: list[str], relevant: set[str]) -> float:
    for rank, doc in enumerate(ranked, start=1):
        if doc in relevant:
            return 1.0 / rank
    return 0.0
`,
  'pipeline/eval/harness.py': `import json
import time
from pathlib import Path

from .recall import mrr, recall_at_k


class Harness:
    def __init__(self, queries: Path, index):
        self.queries = json.loads(queries.read_text())
        self.index = index

    def run(self, embedder) -> dict:
        recalls, mrrs, latencies = [], [], []
        for q in self.queries:
            started = time.perf_counter()
            ranked = [doc for doc, _ in self.index.query(embedder.embed([q["text"]])[0])]
            latencies.append(time.perf_counter() - started)
            recalls.append(recall_at_k(ranked, set(q["relevant"])))
            mrrs.append(mrr(ranked, set(q["relevant"])))
        latencies.sort()
        return {
            "recall@10": sum(recalls) / len(recalls),
            "mrr": sum(mrrs) / len(mrrs),
            "p95_ms": latencies[int(len(latencies) * 0.95)] * 1000,
        }
`,
  'pipeline/cli.py': `import argparse
from pathlib import Path

from .embed import Embedder
from .eval.harness import Harness
from .index import HnswIndex
from .ingest import ingest


def main(argv=None):
    parser = argparse.ArgumentParser("pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ev = sub.add_parser("eval")
    ev.add_argument("--snapshot", required=True)
    ev.add_argument("--ef-search", type=int, default=200)
    args = parser.parse_args(argv)

    index = HnswIndex(ef_search=args.ef_search)
    embedder = Embedder()
    root = Path("snapshots") / args.snapshot
    chunks = list(ingest(root))
    index.add([f"{p}#{i}" for i, (p, _) in enumerate(chunks)], embedder.embed([c for _, c in chunks]))
    print(Harness(root / "queries.json", index).run(embedder))


if __name__ == "__main__":
    main()
`,
  'tests/test_chunk.py': `from pipeline.chunk import chunk_markdown


def test_splits_on_headings():
    chunks = chunk_markdown("# A\\nfoo\\n# B\\nbar")
    assert chunks == ["A\\nfoo", "B\\nbar"]


def test_drops_empty_sections():
    assert chunk_markdown("") == []
`,
  'tests/test_recall.py': `from pipeline.eval.recall import mrr, recall_at_k


def test_recall_counts_hits_in_top_k():
    assert recall_at_k(["a", "b", "c"], {"a", "c"}, k=2) == 0.5


def test_mrr_uses_first_hit():
    assert mrr(["x", "a"], {"a"}) == 0.5
`,
  'configs/default.yaml': `embedder: bge-base
ef_search: 200
chunk:
  max_tokens: 800
  overlap: 64
snapshots_dir: snapshots
`,
  'notebooks/recall_sweep.py': `# Sweep ef_search and plot recall@10 against p95 latency.
from pipeline.cli import main

for ef in (40, 80, 120, 200, 400):
    main(["eval", "--snapshot", "2026-08-20", "--ef-search", str(ef)])
`,
  'scripts/export_vectors.py': `import sys

import numpy as np


def export(path: str, vectors: np.ndarray) -> None:
    np.save(path, vectors)


if __name__ == "__main__":
    export(sys.argv[1], np.zeros((0, 768), dtype="float32"))
`,
  'pyproject.toml': `[project]
name = "ml-pipeline"
version = "0.4.1"
dependencies = ["numpy>=2.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
  'README.md': `# ml-pipeline

Chunk, embed, index and evaluate. Pushed into Chapters by the sync agent.

    pipeline eval --snapshot 2026-08-20
`,
}

function languageOf(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  return { ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', md: 'markdown', yaml: 'yaml', toml: 'toml' }[ext] ?? null
}

function symbolsOf(content, language) {
  const lines = content.split('\n')
  const found = []
  const re =
    language === 'typescript'
      ? /^export\s+(?:async\s+)?(function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
      : language === 'python'
        ? /^(def|class)\s+([A-Za-z_]\w*)/
        : null
  if (!re) return []
  lines.forEach((line, i) => {
    const m = re.exec(line)
    if (m) found.push({ name: m[2], kind: m[1] === 'def' ? 'function' : m[1], startLine: i + 1, endLine: lines.length })
  })
  for (let i = 0; i < found.length - 1; i++) found[i].endLine = Math.max(found[i].startLine, found[i + 1].startLine - 1)
  return found
}

const repositories = []
const filesByRepo = new Map()
const syncTokensByRepo = new Map()
const repoGraphPreference = new Map()

function seedRepository(repo, files) {
  repo.id = uuid()
  repositories.push(repo)
  const list = Object.entries(files).map(([path, content]) => {
    const language = languageOf(path)
    return {
      id: uuid(),
      repositoryId: repo.id,
      path,
      language,
      size: Buffer.byteLength(content),
      updatedAt: ago(Math.floor(rand() * 20), Math.floor(rand() * 20)),
      content,
      contentHash: sha(content),
      sourceModifiedAt: repo.ingestionMethod === 'git' ? ago(Math.floor(rand() * 30)) : null,
      symbols: symbolsOf(content, language),
    }
  })
  filesByRepo.set(repo.id, list)
  syncTokensByRepo.set(repo.id, [])
  return repo
}

const CHAPTERS_REPO = seedRepository(
  {
    name: 'chapters',
    ownerId: ME.id,
    ingestionMethod: 'git',
    gitUrl: 'https://github.com/successbyte/chapters.git',
    localPath: null,
    defaultBranch: 'main',
    mergeable: true,
    syncStatus: 'idle',
    lastSyncedAt: ago(0, 3),
    lastSyncError: null,
    lastWebhookAt: ago(0, 3),
    webhookConfigured: true,
    createdAt: ago(45),
    access: 'owner',
  },
  TS_FILES,
)
const PIPELINE_REPO = seedRepository(
  {
    name: 'ml-pipeline',
    ownerId: ME.id,
    ingestionMethod: 'agent_push',
    gitUrl: null,
    localPath: null,
    defaultBranch: null,
    mergeable: true,
    syncStatus: 'idle',
    lastSyncedAt: ago(2, 4),
    lastSyncError: null,
    lastWebhookAt: null,
    webhookConfigured: false,
    createdAt: ago(20),
    access: 'owner',
  },
  PY_FILES,
)
syncTokensByRepo.get(PIPELINE_REPO.id).push(
  { id: uuid(), createdAt: ago(20), lastUsedAt: ago(2, 4), revokedAt: null },
  { id: uuid(), createdAt: ago(30), lastUsedAt: ago(21), revokedAt: ago(20) },
)
repoGraphPreference.set(CHAPTERS_REPO.id, true)
repoGraphPreference.set(PIPELINE_REPO.id, false)

// ---------------------------------------------------------------------------
// Teams, shares, MCP connections, notifications, admin data
// ---------------------------------------------------------------------------
const teams = [{ id: uuid(), name: 'Platform', ownerId: ME.id }]
const teamMembers = new Map([[teams[0].id, [
  { userId: ME.id, role: 'owner' },
  { userId: ADA.id, role: 'member' },
  { userId: GRACE.id, role: 'member' },
]]])

const shares = [
  { id: uuid(), vaultId: RESEARCH.id, granteeType: 'user', granteeId: GRACE.id, permission: 'read', createdAt: ago(25) },
  { id: uuid(), vaultId: RESEARCH.id, granteeType: 'team', granteeId: teams[0].id, permission: 'edit', createdAt: ago(18) },
  { id: uuid(), vaultId: PRODUCT.id, granteeType: 'user', granteeId: ME.id, permission: 'edit', createdAt: ago(40) },
  { id: uuid(), vaultId: PRODUCT.id, granteeType: 'user', granteeId: LINUS.id, permission: 'read', createdAt: ago(12) },
]
const repoShares = [
  { id: uuid(), repositoryId: CHAPTERS_REPO.id, granteeType: 'team', granteeId: teams[0].id, createdAt: ago(10) },
  { id: uuid(), repositoryId: CHAPTERS_REPO.id, granteeType: 'user', granteeId: LINUS.id, createdAt: ago(3) },
]

const mcpConnections = [
  { id: uuid(), userId: ME.id, name: 'Claude Desktop', scope: 'account', vaultId: null, repositoryId: null, createdAt: ago(33), lastUsedAt: ago(0, 1), expiresAt: null, revokedAt: null },
  { id: uuid(), userId: ME.id, name: 'Research agent', scope: 'vault', vaultId: RESEARCH.id, repositoryId: null, createdAt: ago(14), lastUsedAt: ago(1), expiresAt: ago(-76), revokedAt: null },
  { id: uuid(), userId: ME.id, name: 'Code indexer', scope: 'repository', vaultId: null, repositoryId: CHAPTERS_REPO.id, createdAt: ago(9), lastUsedAt: ago(0, 3), expiresAt: null, revokedAt: null },
  { id: uuid(), userId: ME.id, name: 'Old laptop', scope: 'account', vaultId: null, repositoryId: null, createdAt: ago(80), lastUsedAt: ago(41), expiresAt: null, revokedAt: ago(40) },
  { id: uuid(), userId: ADA.id, name: 'Ada — Cursor', scope: 'vault', vaultId: PRODUCT.id, repositoryId: null, createdAt: ago(5), lastUsedAt: ago(0, 6), expiresAt: null, revokedAt: null },
]

const notifications = [
  { id: uuid(), recipientId: ME.id, type: 'share_granted', entityType: 'vault', entityId: PRODUCT.id, message: 'ada@chapters.dev shared the vault "Product" with you (edit).', readAt: null, createdAt: ago(0, 2) },
  { id: uuid(), recipientId: ME.id, type: 'note_reverted', entityType: 'note', entityId: notesByVault.get(RESEARCH.id)[3].id, message: 'Note notes/semantic-knn-recall was reverted to an earlier version.', readAt: null, createdAt: ago(0, 9) },
  { id: uuid(), recipientId: ME.id, type: 'team_member_added', entityType: 'team', entityId: teams[0].id, message: 'grace@chapters.dev was added to the team "Platform".', readAt: ago(1), createdAt: ago(1, 3) },
  { id: uuid(), recipientId: ME.id, type: 'repository_synced', entityType: 'repository', entityId: CHAPTERS_REPO.id, message: 'Repository "chapters" synced 15 files from main.', readAt: ago(2), createdAt: ago(2, 5) },
  { id: uuid(), recipientId: ME.id, type: 'user_pending_approval', entityType: 'user', entityId: PRIYA.id, message: 'priya.n@meridianlabs.io signed up and is waiting for approval.', readAt: ago(0, 4), createdAt: ago(0, 6) },
]

const preferences = { emailNotifications: true }
const exportLinks = new Map() // vaultId -> ExportLink[]

const securityEvents = []
{
  const kinds = [
    ['login_success', ME.id, null, '10.0.0.12'],
    ['login_failed', null, ADA.id, '203.0.113.7'],
    ['mfa_enabled', ADA.id, ADA.id, '10.0.0.31'],
    ['share_granted', ME.id, GRACE.id, '10.0.0.12'],
    ['user_approved', NOOR.id, LINUS.id, '10.0.0.5'],
    ['mcp_token_created', ME.id, null, '10.0.0.12'],
    ['password_changed', GRACE.id, GRACE.id, '198.51.100.23'],
    ['vault_ownership_transferred', NOOR.id, ADA.id, '10.0.0.5'],
    ['session_revoked', ME.id, OLD.id, '10.0.0.12'],
    ['export_link_created', ME.id, null, '10.0.0.12'],
  ]
  for (let i = 0; i < 64; i++) {
    const [type, actorUserId, subjectUserId, ip] = kinds[(i * 7) % kinds.length]
    securityEvents.push({
      id: uuid(),
      type,
      actorUserId,
      subjectUserId,
      mcpConnectionId: type === 'mcp_token_created' ? mcpConnections[0].id : null,
      ip,
      detail: type === 'share_granted' ? { vaultId: RESEARCH.id, permission: 'read' } : type === 'login_failed' ? { reason: 'invalid password' } : null,
      createdAt: ago(i * 0.6, Math.floor(rand() * 10)),
    })
  }
}

let mfaRequired = false
let loggedIn = true

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------
const userById = (id) => users.find((u) => u.id === id)
const emailOf = (id) => userById(id)?.email ?? 'unknown@chapters.dev'
const liveNotes = (vaultId) => (notesByVault.get(vaultId) ?? []).filter((n) => !n.deletedAt)
const findVault = (id) => vaults.find((v) => v.id === id && !v.deletedAt)
const findRepo = (id) => repositories.find((r) => r.id === id)

function publicVault(v) {
  return { id: v.id, name: v.name, ownerId: v.ownerId, mergeable: v.mergeable, access: v.access }
}
function publicRepo(r, withAccess = false) {
  const { access, ...rest } = r
  return withAccess ? { ...rest, access } : rest
}
function publicMcp(c) {
  const { userId, ...rest } = c
  void userId
  return rest
}
function summary(n) {
  return { id: n.id, path: n.path, type: n.type, name: n.name, frontmatter: n.frontmatter, updatedAt: n.updatedAt }
}
function expandShare(s) {
  const out = { ...s }
  if (s.granteeType === 'user') out.email = emailOf(s.granteeId)
  else out.members = (teamMembers.get(s.granteeId) ?? []).map((m) => ({ teamId: s.granteeId, userId: m.userId, email: emailOf(m.userId) }))
  return out
}
function expandRepoShare(s) {
  const out = { ...s }
  if (s.granteeType === 'team') out.members = (teamMembers.get(s.granteeId) ?? []).map((m) => ({ teamId: s.granteeId, userId: m.userId, email: emailOf(m.userId) }))
  return out
}
function teamRole(team) {
  return teamMembers.get(team.id)?.find((m) => m.userId === ME.id)?.role === 'owner' ? 'owner' : 'member'
}
function record(vault, note, actorType, actorId, action) {
  revisions.unshift({ id: uuid(), vaultId: vault.id, noteId: note.id, notePath: note.path, actorType, actorId, action, createdAt: now() })
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
const STRUCTURAL_GROUP_CAP = 10

/**
 * Fixture stand-in for Louvain: notes cluster by the theme of their first
 * recognised tag, code by repository. Gives ~6-8 communities on the merged
 * graph and 3-4 per vault, which is roughly what the real thing produces.
 */
const THEMES = {
  ml: 'ml', transformers: 'ml', rag: 'ml', reading: 'ml',
  search: 'search', bug: 'search', tooling: 'search', export: 'search',
  graph: 'graph', algorithms: 'graph', ui: 'graph',
  team: 'people', customers: 'people', friends: 'people', family: 'people', health: 'people', interview: 'people', pilot: 'people', support: 'people',
  growth: 'product', pricing: 'product', roadmap: 'product', release: 'product', teams: 'product', metrics: 'product', auth: 'product', sharing: 'product',
  code: 'code', learning: 'code',
  review: 'personal', cooking: 'personal', home: 'personal', life: 'personal', archive: 'personal', personal: 'personal',
}
function themeOf(tags, type) {
  for (const t of Array.isArray(tags) ? tags : []) if (THEMES[t]) return THEMES[t]
  return type === 'people' ? 'people' : 'notes'
}

function graphNodes(vaultIds, repoIds) {
  const nodes = []
  for (const vid of vaultIds) {
    for (const n of liveNotes(vid)) {
      nodes.push({
        id: n.id,
        resourceType: 'note',
        resourceId: vid,
        path: n.path,
        type: n.type,
        tags: Array.isArray(n.frontmatter.tags) ? n.frontmatter.tags : [],
        timestamp: typeof n.frontmatter.timestamp === 'string' ? n.frontmatter.timestamp : null,
        updatedAt: n.updatedAt,
        community: 0,
        _body: n.body,
        _key: themeOf(n.frontmatter.tags, n.type),
      })
    }
  }
  for (const rid of repoIds) {
    for (const f of filesByRepo.get(rid) ?? []) {
      nodes.push({
        id: f.id,
        resourceType: 'code',
        resourceId: rid,
        path: f.path,
        type: f.language,
        tags: [],
        timestamp: null,
        updatedAt: f.updatedAt,
        community: 0,
        _body: '',
        _key: `code:${rid}`,
      })
    }
  }
  return nodes
}

function applyFilters(nodes, q) {
  const types = q.get('types')?.split(',').filter(Boolean)
  const tags = q.get('tags')?.split(',').filter(Boolean)
  const since = q.get('since')
  const until = q.get('until')
  return nodes.filter((n) => {
    if (types?.length && !(n.type && types.includes(n.type))) return false
    if (tags?.length && !n.tags.some((t) => tags.includes(t))) return false
    const when = n.timestamp ?? n.updatedAt
    if (since && when && when < since) return false
    if (until && when && when > until) return false
    return true
  })
}

function assemble(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set()
  const edges = []
  const addEdge = (a, b, kind) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source: a, target: b, kind })
  }

  // Extracted: wikilinks resolved to a path within the same vault.
  const byVaultPath = new Map(nodes.filter((n) => n.resourceType === 'note').map((n) => [`${n.resourceId}:${n.path}`, n.id]))
  for (const n of nodes) {
    if (n.resourceType !== 'note') continue
    for (const m of n._body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = byVaultPath.get(`${n.resourceId}:${m[1].trim()}`)
      if (target) addEdge(n.id, target, 'extracted')
    }
  }
  // Extracted, code side: relative TS imports and Python package imports.
  const byRepoPath = new Map(nodes.filter((n) => n.resourceType === 'code').map((n) => [`${n.resourceId}:${n.path}`, n.id]))
  for (const n of nodes) {
    if (n.resourceType !== 'code') continue
    const content = filesByRepo.get(n.resourceId)?.find((f) => f.id === n.id)?.content ?? ''
    const dir = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '.'
    const candidates = []
    for (const m of content.matchAll(/from ['"](\.{1,2}\/[\w/.-]+?)(?:\.js)?['"]/g)) {
      const base = posix.join(dir, m[1])
      candidates.push(`${base}.ts`, `${base}.tsx`)
    }
    for (const m of content.matchAll(/^from (\.*)([\w.]+) import/gm)) {
      const base = m[1] ? posix.join(dir, m[2].replace(/\./g, '/')) : m[2].replace(/\./g, '/')
      candidates.push(`${base}.py`, `${base}/__init__.py`)
    }
    for (const c of candidates) {
      const target = byRepoPath.get(`${n.resourceId}:${c}`)
      if (target) addEdge(n.id, target, 'extracted')
    }
  }

  // Structural: shared tag / type (notes), language / top dir (code); capped.
  const groups = new Map()
  const addToGroup = (key, id) => groups.set(key, [...(groups.get(key) ?? []), id])
  for (const n of nodes) {
    if (n.resourceType === 'note') {
      for (const t of n.tags) addToGroup(`tag:${t}`, n.id)
      addToGroup(`type:${n.resourceId}:${n.type}`, n.id)
    } else {
      if (n.type) addToGroup(`language:${n.type}`, n.id)
      addToGroup(`dir:${n.resourceId}:${n.path.includes('/') ? n.path.split('/')[0] : '.'}`, n.id)
    }
  }
  const cappedGroups = []
  for (const [key, ids] of groups) {
    if (ids.length > STRUCTURAL_GROUP_CAP) {
      cappedGroups.push(key)
      continue
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j], 'structural')
  }

  // Semantic: a few deterministic cross-links between notes sharing a word in the path.
  const notesOnly = nodes.filter((n) => n.resourceType === 'note')
  for (let i = 0; i < notesOnly.length; i++) {
    const a = notesOnly[i]
    const wordsA = new Set(a.path.split(/[\/-]/))
    for (let j = i + 1; j < notesOnly.length; j++) {
      const b = notesOnly[j]
      if (b.resourceId === a.resourceId) continue
      if (b.path.split(/[\/-]/).some((w) => w.length > 3 && wordsA.has(w))) addEdge(a.id, b.id, 'semantic')
    }
  }
  // Semantic: link code about search/graph to the notes that discuss them.
  for (const c of nodes.filter((n) => n.resourceType === 'code')) {
    const topic = /graph|louvain/i.test(c.path) ? 'graph' : /search|recall|index|embed|chunk|eval/i.test(c.path) ? 'search' : null
    if (!topic) continue
    for (const n of notesOnly) if (n.tags.includes(topic) && rand() < 0.5) addEdge(c.id, n.id, 'semantic')
  }

  // Communities: dense renumbering of the fixture cluster key, in first-seen order.
  const communityIndex = new Map()
  const out = nodes.map((n) => {
    if (!communityIndex.has(n._key)) communityIndex.set(n._key, communityIndex.size)
    const { _body, _key, ...rest } = n
    void _body
    void _key
    return { ...rest, community: communityIndex.get(n._key) }
  })
  return { nodes: out, edges, cappedGroups }
}

function collapseToCommunities(graph) {
  const members = new Map()
  for (const n of graph.nodes) members.set(n.community, [...(members.get(n.community) ?? []), n])
  const nodes = [...members.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([community, list]) => ({
      id: `community:${community}`,
      community,
      size: list.length,
      noteCount: list.filter((n) => n.resourceType === 'note').length,
      codeCount: list.filter((n) => n.resourceType === 'code').length,
      lastActivity: list.map((n) => n.updatedAt).filter(Boolean).sort().at(-1) ?? null,
    }))
  const communityOf = new Map(graph.nodes.map((n) => [n.id, n.community]))
  const weights = new Map()
  for (const e of graph.edges) {
    const a = communityOf.get(e.source)
    const b = communityOf.get(e.target)
    if (a === b) continue
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    weights.set(key, (weights.get(key) ?? 0) + 1)
  }
  const edges = [...weights.entries()].map(([key, weight]) => {
    const [a, b] = key.split('|')
    return { source: `community:${a}`, target: `community:${b}`, weight }
  })
  return { aggregated: true, nodes, edges, cappedGroups: graph.cappedGroups }
}

function graphResponse(vaultIds, repoIds, query) {
  const graph = assemble(applyFilters(graphNodes(vaultIds, repoIds), query))
  if (query.get('aggregate') === 'community') return collapseToCommunities(graph)
  const community = query.get('community')
  if (community !== null) {
    const wanted = Number(community)
    const members = graph.nodes.filter((n) => n.community === wanted).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id))
    const ids = new Set(members.map((n) => n.id))
    return {
      nodes: members,
      edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      cappedGroups: graph.cappedGroups,
      memberTotal: members.length,
    }
  }
  return graph
}

function mergedScope() {
  const vaultIds = vaults.filter((v) => !v.deletedAt && v.mergeable && (vaultGraphPreference.get(v.id) ?? false)).map((v) => v.id)
  const repoIds = repositories.filter((r) => r.mergeable && (repoGraphPreference.get(r.id) ?? false)).map((r) => r.id)
  return { vaultIds, repoIds }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function snippetAround(text, term) {
  const i = text.toLowerCase().indexOf(term)
  if (i < 0) return text.slice(0, 160).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, i - 60)
  return (start > 0 ? '…' : '') + text.slice(start, start + 160).replace(/\s+/g, ' ').trim() + '…'
}

function runSearch(q, { vaultId, limit, query }) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const scope = vaultId ? { vaultIds: [vaultId], repoIds: [] } : { vaultIds: vaults.filter((v) => !v.deletedAt).map((v) => v.id), repoIds: repositories.map((r) => r.id) }
  const filtered = new Set(applyFilters(graphNodes(scope.vaultIds, scope.repoIds), query).map((n) => n.id))
  const results = []
  for (const vid of scope.vaultIds) {
    for (const n of liveNotes(vid)) {
      if (!filtered.has(n.id)) continue
      const hay = `${n.name} ${n.body}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (n.name.toLowerCase().includes(t)) score += 3
        score += Math.min(5, hay.split(t).length - 1) * 0.4
      }
      if (score > 0) results.push({ resourceType: 'note', id: n.id, containerId: vid, path: n.path, type: n.type, frontmatter: n.frontmatter, language: null, snippet: snippetAround(n.body, terms[0]), score: Number((score / 4).toFixed(3)) })
    }
  }
  for (const rid of scope.repoIds) {
    for (const f of filesByRepo.get(rid) ?? []) {
      if (!filtered.has(f.id)) continue
      const hay = `${f.path} ${f.content}`.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (f.path.toLowerCase().includes(t)) score += 2
        score += Math.min(5, hay.split(t).length - 1) * 0.3
      }
      if (score > 0) results.push({ resourceType: 'code', id: f.id, containerId: rid, path: f.path, type: null, language: f.language, snippet: snippetAround(f.content, terms[0]), score: Number((score / 4).toFixed(3)) })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const routes = []
function route(method, pattern, handler) {
  // `:id` matches one segment, `*path` the rest of the URL. One pass, so the
  // keys line up with the capture groups in positional order.
  const keys = []
  const re = new RegExp(
    '^' + pattern.replace(/([:*])(\w+)/g, (_, kind, k) => (keys.push(k), kind === '*' ? '(.+)' : '([^/]+)')) + '$',
  )
  routes.push({ method, re, keys, handler })
}
const get = (p, h) => route('GET', p, h)
const post = (p, h) => route('POST', p, h)
const put = (p, h) => route('PUT', p, h)
const patch = (p, h) => route('PATCH', p, h)
const del = (p, h) => route('DELETE', p, h)

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}
const notFound = (what = 'not found') => new HttpError(404, { error: what })
const forbidden = (what = 'forbidden') => new HttpError(403, { error: what })
const bad = (what) => new HttpError(400, { error: what })
const requireAdmin = () => {
  if (ME.role !== 'admin') throw forbidden('admin only')
}
const vaultOr404 = (id) => {
  const v = findVault(id)
  if (!v) throw notFound('vault not found')
  return v
}
const noteOr404 = (vault, path) => {
  const n = liveNotes(vault.id).find((x) => x.path === path)
  if (!n) throw notFound('note not found')
  return n
}
const repoOr404 = (id) => {
  const r = findRepo(id)
  if (!r) throw notFound('repository not found')
  return r
}

// --- auth -------------------------------------------------------------------
get('/me', () => {
  if (!loggedIn) throw new HttpError(401, { error: 'unauthenticated' })
  return { id: ME.id, email: ME.email, status: ME.status, role: ME.role, createdAt: ME.createdAt, mfaEnabledAt: ME.mfaEnabledAt, mfaRequired }
})
post('/setup', ({ body }) => {
  if (body?.email) ME.email = body.email
  loggedIn = true
  return { id: ME.id }
})
post('/signup', ({ body }) => {
  const email = body?.email ?? `new-${users.length}@example.com`
  if (!users.some((u) => u.email === email)) {
    users.push(mkUser(email, { status: 'pending_approval', emailVerifiedAt: null, createdAt: now() }))
  }
  return { status: 'pending_approval' }
})
post('/verify-email', ({ body }) => {
  const u = users.find((x) => x.email === body?.email)
  if (u) u.emailVerifiedAt = now()
  return { status: 'verified' }
})
post('/login', ({ body }) => {
  if (!body?.email || !body?.password) throw bad('email and password required')
  loggedIn = true
  return { id: ME.id, email: ME.email, role: ME.role }
})
post('/logout', () => {
  loggedIn = false
  return { status: 'logged_out' }
})
post('/request-password-reset', () => ({ status: 'ok' }))
post('/reset-password', () => ({ status: 'password_updated' }))

// --- account ----------------------------------------------------------------
post('/me/email', ({ body }) => {
  if (!body?.password) throw new HttpError(401, { error: 'password required' })
  if (users.some((u) => u.id !== ME.id && u.email === body.email)) throw new HttpError(409, { error: 'email already in use' })
  ME.email = body.email
  ME.emailVerifiedAt = null
  return { status: 'verification_sent' }
})
post('/me/password', ({ body }) => {
  if (!body?.currentPassword || !body?.newPassword) throw bad('currentPassword and newPassword required')
  return { status: 'password_changed' }
})
post('/mfa/setup', () => {
  const secret = randomBytes(10).toString('hex').toUpperCase().slice(0, 16)
  return { secret, uri: `otpauth://totp/Chapters:${encodeURIComponent(ME.email)}?secret=${secret}&issuer=Chapters` }
})
post('/mfa/enable', ({ body }) => {
  if (!/^\d{6}$/.test(body?.code ?? '')) throw bad('six-digit code required')
  ME.mfaEnabledAt = now()
  return { status: 'enabled', backupCodes: Array.from({ length: 8 }, () => randomBytes(5).toString('hex')) }
})
post('/mfa/disable', ({ body }) => {
  if (mfaRequired) throw forbidden('instance requires MFA')
  if (!/^\d{6}$/.test(body?.code ?? '')) throw bad('six-digit code required')
  ME.mfaEnabledAt = null
  return { status: 'disabled' }
})
get('/me/preferences', () => ({ ...preferences }))
put('/me/preferences', ({ body }) => {
  preferences.emailNotifications = Boolean(body?.emailNotifications)
  return { ...preferences }
})
get('/me/export', () => zip())

// --- vaults -----------------------------------------------------------------
get('/vaults', () => vaults.filter((v) => !v.deletedAt).map(publicVault))
post('/vaults', ({ body }) => {
  if (!body?.name?.trim()) throw bad('name required')
  const v = { id: randomUUID(), name: body.name.trim(), ownerId: ME.id, mergeable: false, access: 'owner', deletedAt: null }
  vaults.push(v)
  notesByVault.set(v.id, [])
  return publicVault(v)
})
get('/vaults/trash', () => trashedVaults.filter((v) => v.ownerId === ME.id).map((v) => ({ id: v.id, name: v.name, deletedAt: v.deletedAt })))
patch('/vaults/:id', ({ params, body }) => {
  const v = vaultOr404(params.id)
  if (v.access !== 'owner') throw forbidden('owner only')
  if (typeof body?.name === 'string' && body.name.trim()) v.name = body.name.trim()
  if (typeof body?.mergeable === 'boolean') v.mergeable = body.mergeable
  return publicVault(v)
})
del('/vaults/:id', ({ params }) => {
  const v = vaultOr404(params.id)
  if (v.access !== 'owner') throw notFound('vault not found')
  v.deletedAt = now()
  vaults.splice(vaults.indexOf(v), 1)
  trashedVaults.push(v)
  return { status: 'trashed', id: v.id }
})
post('/vaults/:id/restore', ({ params }) => {
  const i = trashedVaults.findIndex((v) => v.id === params.id)
  if (i < 0) throw notFound('vault not found')
  const [v] = trashedVaults.splice(i, 1)
  v.deletedAt = null
  vaults.push(v)
  return publicVault(v)
})
post('/vaults/:id/purge', ({ params }) => {
  const i = trashedVaults.findIndex((v) => v.id === params.id)
  if (i < 0) throw notFound('vault not found')
  trashedVaults.splice(i, 1)
  notesByVault.delete(params.id)
  return { status: 'purged' }
})
get('/vaults/:id/graph-preference', ({ params }) => (vaultOr404(params.id), { include: vaultGraphPreference.get(params.id) ?? false }))
put('/vaults/:id/graph-preference', ({ params, body }) => {
  vaultOr404(params.id)
  vaultGraphPreference.set(params.id, Boolean(body?.include))
  return { include: Boolean(body?.include) }
})
get('/vaults/:id/export', ({ params }) => (vaultOr404(params.id), zip()))
post('/vaults/:id/export-links', ({ params }) => {
  vaultOr404(params.id)
  const link = { id: randomUUID(), token: randomBytes(24).toString('base64url'), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() }
  exportLinks.set(params.id, [...(exportLinks.get(params.id) ?? []), link])
  return link
})
del('/vaults/:id/export-links/:linkId', ({ params }) => {
  const list = exportLinks.get(params.id) ?? []
  const i = list.findIndex((l) => l.id === params.linkId)
  if (i < 0) throw notFound('export link not found')
  list.splice(i, 1)
  return { status: 'revoked' }
})

// --- notes ------------------------------------------------------------------
get('/vaults/:id/tree', ({ params }) => {
  const tree = {}
  for (const n of liveNotes(vaultOr404(params.id).id).sort((a, b) => a.path.localeCompare(b.path))) {
    ;(tree[n.type] ??= []).push(summary(n))
  }
  return tree
})
post('/vaults/:id/notes', ({ params, body }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('read-only access')
  if (!body?.type || !body?.name) throw bad('type and name required')
  if (!/^[a-z0-9-]+$/.test(body.name)) throw bad('name must be lowercase letters, numbers and hyphens')
  const path = `${body.type}/${body.name}`
  if (liveNotes(v.id).some((n) => n.path === path)) throw new HttpError(409, { error: 'note already exists' })
  const title = body.name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  const note = { id: randomUUID(), vaultId: v.id, path, type: body.type, name: body.name, frontmatter: { type: body.type, tags: [], timestamp: now() }, body: `# ${title}\n\n`, updatedAt: now(), deletedAt: null }
  notesByVault.get(v.id).push(note)
  record(v, note, 'user', ME.id, 'create')
  return { id: note.id, path: note.path, type: note.type, name: note.name }
})
post('/vaults/:id/notes-rename', ({ params, body }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('read-only access')
  const note = noteOr404(v, body?.from ?? '')
  const to = String(body?.to ?? '')
  if (!/^[a-z0-9-]+$/.test(to)) throw bad('name must be lowercase letters, numbers and hyphens')
  const toPath = `${note.type}/${to}`
  if (liveNotes(v.id).some((n) => n.path === toPath)) throw new HttpError(409, { error: 'note already exists' })
  // Rewrite wikilinks that pointed at the old path.
  for (const other of liveNotes(v.id)) other.body = other.body.split(`[[${note.path}]]`).join(`[[${toPath}]]`)
  note.path = toPath
  note.name = to
  note.updatedAt = now()
  record(v, note, 'user', ME.id, 'rename')
  return { id: note.id, path: note.path, type: note.type, name: note.name }
})
get('/vaults/:id/notes/*path', ({ params }) => {
  const n = noteOr404(vaultOr404(params.id), params.path)
  return { path: n.path, frontmatter: n.frontmatter, body: n.body, updatedAt: n.updatedAt }
})
put('/vaults/:id/notes/*path', ({ params, body }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('read-only access')
  const n = noteOr404(v, params.path)
  if (body?.frontmatter && typeof body.frontmatter === 'object') n.frontmatter = body.frontmatter
  if (typeof body?.body === 'string') n.body = body.body
  n.updatedAt = now()
  record(v, n, 'user', ME.id, 'update')
  return { id: n.id, path: n.path, frontmatter: n.frontmatter, body: n.body, updatedAt: n.updatedAt }
})
del('/vaults/:id/notes/*path', ({ params }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('read-only access')
  const n = noteOr404(v, params.path)
  n.deletedAt = now()
  record(v, n, 'user', ME.id, 'delete')
  return { status: 'trashed', id: n.id }
})
get('/vaults/:id/trash', ({ params }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('edit access required')
  return (notesByVault.get(v.id) ?? []).filter((n) => n.deletedAt).map((n) => ({ id: n.id, path: n.path, type: n.type, name: n.name, deletedAt: n.deletedAt }))
})
post('/vaults/:id/trash/:noteId/restore', ({ params }) => {
  const v = vaultOr404(params.id)
  const n = (notesByVault.get(v.id) ?? []).find((x) => x.id === params.noteId && x.deletedAt)
  if (!n) throw notFound('note not found')
  n.deletedAt = null
  n.updatedAt = now()
  record(v, n, 'user', ME.id, 'restore')
  return { id: n.id, path: n.path }
})

// --- revisions --------------------------------------------------------------
get('/vaults/:id/history/*path', ({ params, query }) => {
  const v = vaultOr404(params.id)
  if (v.access === 'read') throw forbidden('edit access required')
  const n = noteOr404(v, params.path)
  const limit = Number(query.get('limit') ?? 50)
  const offset = Number(query.get('offset') ?? 0)
  return revisions
    .filter((r) => r.noteId === n.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit)
    .map(({ id, actorType, actorId, action, createdAt }) => ({ id, actorType, actorId, action, createdAt }))
})
post('/vaults/:id/revert/*path', ({ params, body }) => {
  const v = vaultOr404(params.id)
  const n = noteOr404(v, params.path)
  if (!revisions.some((r) => r.id === body?.revisionId && r.noteId === n.id)) throw notFound('revision not found')
  n.updatedAt = now()
  record(v, n, 'user', ME.id, 'revert')
  return { id: n.id, path: n.path }
})
del('/vaults/:id/revisions/:revisionId', ({ params }) => {
  const v = vaultOr404(params.id)
  if (v.access !== 'owner' && ME.role !== 'admin') throw forbidden('owner only')
  const i = revisions.findIndex((r) => r.id === params.revisionId && r.vaultId === v.id)
  if (i < 0) throw notFound('revision not found')
  revisions.splice(i, 1)
  return { status: 'purged' }
})

// --- collab / live ----------------------------------------------------------
post('/collab/ticket', () => {
  if (COLLAB === 'offline') throw new HttpError(503, { error: 'collab relay is not available in the mock server' })
  return { token: randomBytes(24).toString('base64url'), url: '/collab', expiresAt: new Date(Date.now() + 30_000).toISOString() }
})
get('/vaults/:id/live/*path', ({ params, res }) => {
  const n = noteOr404(vaultOr404(params.id), params.path)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(`data: ${JSON.stringify({ frontmatter: n.frontmatter, body: n.body })}\n\n`)
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000)
  res.on('close', () => clearInterval(beat))
  return STREAMING
})

// --- graph and search -------------------------------------------------------
get('/vaults/:id/graph', ({ params, query }) => graphResponse([vaultOr404(params.id).id], [], query))
get('/graph/merged', ({ query }) => {
  const { vaultIds, repoIds } = mergedScope()
  return graphResponse(vaultIds, repoIds, query)
})
get('/search', ({ query }) => runSearch(query.get('q') ?? '', { vaultId: null, limit: Number(query.get('limit') ?? 20), query }))
get('/vaults/:id/search', ({ params, query }) => runSearch(query.get('q') ?? '', { vaultId: vaultOr404(params.id).id, limit: Number(query.get('limit') ?? 20), query }))

// --- notifications ----------------------------------------------------------
get('/notifications', ({ query }) => {
  const limit = Number(query.get('limit') ?? 50)
  const offset = Number(query.get('offset') ?? 0)
  return notifications.filter((n) => n.recipientId === ME.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit)
})
post('/notifications/:id/read', ({ params }) => {
  const n = notifications.find((x) => x.id === params.id && x.recipientId === ME.id && x.readAt === null)
  if (!n) throw notFound('notification not found')
  n.readAt = now()
  return { status: 'read' }
})

// --- shares, users, teams ---------------------------------------------------
get('/users/lookup', ({ query }) => {
  const u = users.find((x) => x.email.toLowerCase() === (query.get('email') ?? '').toLowerCase() && x.status === 'active')
  if (!u) throw notFound('no active user with that email')
  return { id: u.id, email: u.email }
})
get('/vaults/:id/shares', ({ params }) => shares.filter((s) => s.vaultId === vaultOr404(params.id).id).map(expandShare))
post('/vaults/:id/shares', ({ params, body }) => {
  const v = vaultOr404(params.id)
  if (v.access !== 'owner') throw forbidden('owner only')
  if (!['user', 'team'].includes(body?.granteeType) || !body?.granteeId || !['read', 'edit'].includes(body?.permission)) throw bad('granteeType, granteeId and permission required')
  if (body.granteeType === 'user' && !userById(body.granteeId)) throw notFound('user not found')
  if (body.granteeType === 'team' && !teams.some((t) => t.id === body.granteeId)) throw notFound('team not found')
  const existing = shares.find((s) => s.vaultId === v.id && s.granteeType === body.granteeType && s.granteeId === body.granteeId)
  if (existing) {
    existing.permission = body.permission
    return expandShare(existing)
  }
  const s = { id: randomUUID(), vaultId: v.id, granteeType: body.granteeType, granteeId: body.granteeId, permission: body.permission, createdAt: now() }
  shares.push(s)
  return expandShare(s)
})
del('/vaults/:id/shares/:shareId', ({ params }) => {
  const i = shares.findIndex((s) => s.id === params.shareId && s.vaultId === params.id)
  if (i < 0) throw notFound('share not found')
  shares.splice(i, 1)
  return { status: 'revoked' }
})
get('/teams', () => teams.filter((t) => teamMembers.get(t.id)?.some((m) => m.userId === ME.id)).map((t) => ({ id: t.id, name: t.name, role: teamRole(t) })))
post('/teams', ({ body }) => {
  if (!body?.name?.trim()) throw bad('name required')
  const t = { id: randomUUID(), name: body.name.trim(), ownerId: ME.id }
  teams.push(t)
  teamMembers.set(t.id, [{ userId: ME.id, role: 'owner' }])
  return { id: t.id, name: t.name, role: 'owner' }
})
get('/teams/:id/members', ({ params }) => {
  if (!teams.some((t) => t.id === params.id)) throw notFound('team not found')
  return (teamMembers.get(params.id) ?? []).map((m) => ({ userId: m.userId, email: emailOf(m.userId), role: m.role }))
})
get('/teams/:id/stats', ({ params }) => {
  if (!teams.some((t) => t.id === params.id)) throw notFound('team not found')
  return (teamMembers.get(params.id) ?? []).map((m) => {
    const mine = revisions.filter((r) => r.actorId === m.userId)
    return {
      userId: m.userId,
      email: emailOf(m.userId),
      notesTouched: new Set(mine.map((r) => r.noteId)).size,
      vaultsTouched: new Set(mine.map((r) => r.vaultId)).size,
      lastActivityAt: mine.map((r) => r.createdAt).sort().at(-1) ?? null,
    }
  })
})
post('/teams/:id/members', ({ params, body }) => {
  const list = teamMembers.get(params.id)
  if (!list) throw notFound('team not found')
  if (!userById(body?.userId)) throw notFound('user not found')
  if (!list.some((m) => m.userId === body.userId)) list.push({ userId: body.userId, role: 'member' })
  return { status: 'added' }
})
del('/teams/:id/members/:userId', ({ params }) => {
  const list = teamMembers.get(params.id)
  if (!list) throw notFound('team not found')
  const i = list.findIndex((m) => m.userId === params.userId)
  if (i < 0) throw notFound('member not found')
  list.splice(i, 1)
  return { status: 'removed' }
})
del('/teams/:id', ({ params }) => {
  const i = teams.findIndex((t) => t.id === params.id)
  if (i < 0) throw notFound('team not found')
  teams.splice(i, 1)
  teamMembers.delete(params.id)
  for (let j = shares.length - 1; j >= 0; j--) if (shares[j].granteeType === 'team' && shares[j].granteeId === params.id) shares.splice(j, 1)
  return { status: 'deleted' }
})

// --- repositories -----------------------------------------------------------
get('/repositories', () => repositories.map((r) => publicRepo(r, true)))
post('/repositories', ({ body }) => {
  if (!body?.name?.trim() || !['git', 'local_path', 'agent_push'].includes(body?.ingestionMethod)) throw bad('name and ingestionMethod required')
  if (body.ingestionMethod === 'git' && !body.gitUrl) throw bad('gitUrl required')
  if (body.ingestionMethod === 'local_path' && !body.localPath) throw bad('localPath required')
  const repo = {
    id: randomUUID(),
    name: body.name.trim(),
    ownerId: ME.id,
    ingestionMethod: body.ingestionMethod,
    gitUrl: body.ingestionMethod === 'git' ? body.gitUrl : null,
    localPath: body.ingestionMethod === 'local_path' ? `/srv/repos/${body.localPath.replace(/^\/+/, '')}` : null,
    defaultBranch: null,
    mergeable: false,
    syncStatus: body.ingestionMethod === 'agent_push' ? 'idle' : 'syncing',
    lastSyncedAt: null,
    lastSyncError: null,
    lastWebhookAt: null,
    webhookConfigured: false,
    createdAt: now(),
    access: 'owner',
  }
  repositories.push(repo)
  filesByRepo.set(repo.id, [])
  syncTokensByRepo.set(repo.id, [])
  // Pretend the first sync finishes shortly after.
  if (repo.syncStatus === 'syncing') {
    setTimeout(() => {
      repo.syncStatus = 'idle'
      repo.lastSyncedAt = now()
      if (repo.ingestionMethod === 'git') repo.defaultBranch = 'main'
    }, 4000)
  }
  return publicRepo(repo)
})
patch('/repositories/:id', ({ params, body }) => {
  const r = repoOr404(params.id)
  if (typeof body?.name === 'string' && body.name.trim()) r.name = body.name.trim()
  if (typeof body?.mergeable === 'boolean') r.mergeable = body.mergeable
  return publicRepo(r)
})
del('/repositories/:id', ({ params }) => {
  const r = repoOr404(params.id)
  repositories.splice(repositories.indexOf(r), 1)
  filesByRepo.delete(r.id)
  syncTokensByRepo.delete(r.id)
  return { status: 'deleted' }
})
get('/repositories/:id/files', ({ params }) => (filesByRepo.get(repoOr404(params.id).id) ?? []).map(({ id, path, language, size, updatedAt }) => ({ id, path, language, size, updatedAt })))
get('/repositories/:id/files/content', ({ params, query }) => {
  const f = (filesByRepo.get(repoOr404(params.id).id) ?? []).find((x) => x.path === query.get('path'))
  if (!f) throw notFound('file not found')
  const { repositoryId, ...rest } = f
  void repositoryId
  return rest
})
get('/repositories/:id/shares', ({ params }) => repoShares.filter((s) => s.repositoryId === repoOr404(params.id).id).map(expandRepoShare))
post('/repositories/:id/shares', ({ params, body }) => {
  const r = repoOr404(params.id)
  if (!['user', 'team'].includes(body?.granteeType) || !body?.granteeId) throw bad('granteeType and granteeId required')
  const s = { id: randomUUID(), repositoryId: r.id, granteeType: body.granteeType, granteeId: body.granteeId, createdAt: now() }
  repoShares.push(s)
  return expandRepoShare(s)
})
del('/repositories/:id/shares/:shareId', ({ params }) => {
  const i = repoShares.findIndex((s) => s.id === params.shareId && s.repositoryId === params.id)
  if (i < 0) throw notFound('share not found')
  repoShares.splice(i, 1)
  return { status: 'revoked' }
})
post('/repositories/:id/webhook-secret', ({ params }) => {
  const r = repoOr404(params.id)
  r.webhookConfigured = true
  return { secret: randomBytes(24).toString('hex'), webhookPath: `/api/repositories/${r.id}/webhook` }
})
get('/repositories/:id/sync-tokens', ({ params }) => syncTokensByRepo.get(repoOr404(params.id).id) ?? [])
post('/repositories/:id/sync-tokens', ({ params }) => {
  const r = repoOr404(params.id)
  syncTokensByRepo.get(r.id).push({ id: randomUUID(), createdAt: now(), lastUsedAt: null, revokedAt: null })
  return { token: `chs_${randomBytes(24).toString('base64url')}` }
})
post('/repositories/:id/sync-tokens/:tokenId/revoke', ({ params }) => {
  const t = (syncTokensByRepo.get(repoOr404(params.id).id) ?? []).find((x) => x.id === params.tokenId)
  if (!t) throw notFound('token not found')
  t.revokedAt ??= now()
  return { status: 'revoked' }
})
get('/repositories/:id/graph-preference', ({ params }) => ({ include: repoGraphPreference.get(repoOr404(params.id).id) ?? false }))
put('/repositories/:id/graph-preference', ({ params, body }) => {
  repoGraphPreference.set(repoOr404(params.id).id, Boolean(body?.include))
  return { include: Boolean(body?.include) }
})

// --- mcp connections --------------------------------------------------------
get('/mcp-connections', () => mcpConnections.filter((c) => c.userId === ME.id).map(publicMcp))
post('/mcp-connections', ({ body }) => {
  if (!body?.name?.trim() || !['account', 'vault', 'repository'].includes(body?.scope)) throw bad('name and scope required')
  if (body.scope === 'vault') vaultOr404(body.vaultId)
  if (body.scope === 'repository') repoOr404(body.repositoryId)
  const c = { id: randomUUID(), userId: ME.id, name: body.name.trim(), scope: body.scope, vaultId: body.scope === 'vault' ? body.vaultId : null, repositoryId: body.scope === 'repository' ? body.repositoryId : null, createdAt: now(), lastUsedAt: null, expiresAt: null, revokedAt: null }
  mcpConnections.push(c)
  return { ...publicMcp(c), token: `mcp_${randomBytes(32).toString('base64url')}` }
})
post('/mcp-connections/:id/revoke', ({ params }) => {
  const c = mcpConnections.find((x) => x.id === params.id && x.userId === ME.id)
  if (!c) throw notFound('connection not found')
  c.revokedAt ??= now()
  return { status: 'revoked' }
})

// --- import -----------------------------------------------------------------
post('/import', ({ raw }) => {
  if (!raw.length) throw bad('archive required')
  const v = { id: randomUUID(), name: `Imported vault ${vaults.length + 1}`, ownerId: ME.id, mergeable: true, access: 'owner', deletedAt: null }
  vaults.push(v)
  notesByVault.set(v.id, [
    { id: randomUUID(), vaultId: v.id, path: 'notes/welcome', type: 'notes', name: 'welcome', frontmatter: { type: 'notes', tags: ['imported'], timestamp: now() }, body: '# Welcome\n\nImported from an archive. See [[projects/first-project]].\n', updatedAt: now(), deletedAt: null },
    { id: randomUUID(), vaultId: v.id, path: 'projects/first-project', type: 'projects', name: 'first-project', frontmatter: { type: 'projects', tags: ['imported'], timestamp: now() }, body: '# First project\n\n- [ ] Start\n', updatedAt: now(), deletedAt: null },
  ])
  return { vaultId: v.id, imported: 2, skipped: ['notes/broken: missing frontmatter fence'], unmatchedShares: ['reviewer@external.example'] }
})

// --- admin ------------------------------------------------------------------
const adminUser = ({ id, email, status, role, emailVerifiedAt, createdAt }) => ({ id, email, status, role, emailVerifiedAt, createdAt })
get('/admin/users', ({ query }) => {
  requireAdmin()
  const status = query.get('status')
  return users.filter((u) => !status || u.status === status).map(adminUser)
})
post('/admin/users/:id/approve', ({ params }) => {
  requireAdmin()
  const u = userById(params.id)
  if (!u) throw notFound('user not found')
  u.status = 'active'
  return { status: 'active' }
})
post('/admin/users/:id/promote', ({ params }) => {
  requireAdmin()
  const u = userById(params.id)
  if (!u) throw notFound('user not found')
  u.role = 'admin'
  return { role: 'admin' }
})
post('/admin/users/:id/deactivate', ({ params }) => {
  requireAdmin()
  const u = userById(params.id)
  if (!u) throw notFound('user not found')
  if (u.id === ME.id) throw bad('cannot deactivate yourself')
  u.status = 'deactivated'
  for (const list of teamMembers.values()) for (let i = list.length - 1; i >= 0; i--) if (list[i].userId === u.id) list.splice(i, 1)
  for (let i = shares.length - 1; i >= 0; i--) if (shares[i].granteeType === 'user' && shares[i].granteeId === u.id) shares.splice(i, 1)
  return { status: 'deactivated' }
})
post('/admin/vaults/:id/transfer-owner', ({ params, body }) => {
  requireAdmin()
  const v = vaultOr404(params.id)
  const u = userById(body?.newOwnerId)
  if (!u) throw notFound('user not found')
  v.ownerId = u.id
  v.access = u.id === ME.id ? 'owner' : v.access === 'owner' ? 'edit' : v.access
  return { ownerId: u.id }
})
get('/admin/stats', () => {
  requireAdmin()
  const counts = {}
  for (const u of users) counts[u.status] = (counts[u.status] ?? 0) + 1
  const allNotes = [...notesByVault.values()].flat().filter((n) => !n.deletedAt)
  return {
    usersByStatus: Object.entries(counts).map(([status, count]) => ({ status, count })),
    vaults: vaults.filter((v) => !v.deletedAt).length,
    teams: teams.length,
    notes: allNotes.length,
    storageBytes: allNotes.reduce((s, n) => s + Buffer.byteLength(n.body), 0) + [...filesByRepo.values()].flat().reduce((s, f) => s + f.size, 0) + 48_211_904,
    activeMcpConnections: mcpConnections.filter((c) => !c.revokedAt).length,
  }
})
get('/admin/vaults', () => {
  requireAdmin()
  return vaults.filter((v) => !v.deletedAt).map((v) => ({
    id: v.id,
    name: v.name,
    ownerEmail: emailOf(v.ownerId),
    mergeable: v.mergeable,
    noteCount: liveNotes(v.id).length,
    shareCount: shares.filter((s) => s.vaultId === v.id).length,
    lastActivity: liveNotes(v.id).map((n) => n.updatedAt).sort().at(-1) ?? null,
  }))
})
get('/admin/teams', () => (requireAdmin(), teams.map((t) => ({ id: t.id, name: t.name, memberCount: teamMembers.get(t.id)?.length ?? 0 }))))
get('/admin/shares', () => (requireAdmin(), shares.map(({ id, vaultId, granteeType, granteeId, permission, createdAt }) => ({ id, vaultId, granteeType, granteeId, permission, createdAt }))))
del('/admin/shares/:id', ({ params }) => {
  requireAdmin()
  const i = shares.findIndex((s) => s.id === params.id)
  if (i < 0) throw notFound('share not found')
  shares.splice(i, 1)
  return { status: 'revoked' }
})
get('/admin/mcp-connections', () => (requireAdmin(), mcpConnections.map((c) => ({ id: c.id, name: c.name, scope: c.scope, userEmail: emailOf(c.userId), vaultId: c.vaultId, repositoryId: c.repositoryId, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt, createdAt: c.createdAt }))))
post('/admin/mcp-connections/:id/revoke', ({ params }) => {
  requireAdmin()
  const c = mcpConnections.find((x) => x.id === params.id)
  if (!c) throw notFound('connection not found')
  c.revokedAt ??= now()
  return { status: 'revoked' }
})
get('/admin/security-events', ({ query }) => {
  requireAdmin()
  const limit = Number(query.get('limit') ?? 50)
  const offset = Number(query.get('offset') ?? 0)
  return securityEvents.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit)
})
get('/admin/audit-trail', ({ query }) => {
  requireAdmin()
  const limit = Number(query.get('limit') ?? 50)
  const offset = Number(query.get('offset') ?? 0)
  return revisions
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit)
    .map(({ id, notePath, vaultId, actorType, actorId, action, createdAt }) => ({ id, notePath, vaultId, actorType, actorId, action, createdAt }))
})
put('/admin/mfa-requirement', ({ body }) => {
  requireAdmin()
  mfaRequired = Boolean(body?.required)
  return { required: mfaRequired }
})
get('/admin/backup', () => (requireAdmin(), zip()))

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const STREAMING = Symbol('streaming')

/** A valid, empty zip (just the end-of-central-directory record). */
function zip() {
  return { binary: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]), contentType: 'application/zip' }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

function send(res, status, body) {
  if (body && body.binary) {
    res.writeHead(status, { 'Content-Type': body.contentType, 'Content-Length': body.binary.length, 'Content-Disposition': 'attachment; filename="export.zip"' })
    res.end(body.binary)
    return
  }
  const json = JSON.stringify(body ?? null)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) })
  res.end(json)
}

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url ?? '/', 'http://localhost')
  let status = 200
  const finish = (code, body) => {
    status = code
    send(res, code, body)
  }
  try {
    if (!url.pathname.startsWith('/api/')) throw notFound()
    const path = url.pathname.slice(4)
    const raw = await readBody(req)
    let body
    if (raw.length && /application\/json/i.test(req.headers['content-type'] ?? '')) {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        throw bad('invalid JSON body')
      }
    }
    let matchedPath = false
    for (const r of routes) {
      const m = r.re.exec(path)
      if (!m) continue
      matchedPath = true
      if (r.method !== req.method) continue
      const params = {}
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      const result = await r.handler({ params, query: url.searchParams, body, raw, req, res })
      if (result === STREAMING) {
        res.on('close', () => log(req, 200, started, 'stream closed'))
        log(req, 200, started, 'stream open')
        return
      }
      finish(200, result)
      log(req, status, started)
      return
    }
    throw matchedPath ? new HttpError(405, { error: 'method not allowed' }) : notFound()
  } catch (err) {
    if (err instanceof HttpError) finish(err.status, err.body)
    else {
      console.error(err)
      finish(500, { error: 'internal error' })
    }
    log(req, status, started)
  }
})

function log(req, status, started, note = '') {
  const colour = status >= 500 ? 31 : status >= 400 ? 33 : 32
  console.log(`${new Date().toISOString().slice(11, 19)} \x1b[${colour}m${status}\x1b[0m ${req.method} ${req.url} ${Date.now() - started}ms${note ? ` (${note})` : ''}`)
}

// The collab relay would ride /collab on this port; there is none here, so
// refuse the upgrade cleanly and let the client's provider keep retrying.
server.on('upgrade', (req, socket) => {
  console.log(`${new Date().toISOString().slice(11, 19)} \x1b[33m404\x1b[0m UPGRADE ${req.url} (no collab relay in mock)`)
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
})

// A browser dropping a connection mid-request (headless screenshots do this)
// must not take the whole server down.
server.on('connection', (socket) => socket.on('error', () => {}))
server.on('clientError', (_err, socket) => socket.destroy())

server.listen(PORT, () => {
  console.log(`chapters mock api listening on http://localhost:${PORT}`)
  console.log(`  session: ${ME.email} (${ME.role}); collab tickets: ${COLLAB}`)
  console.log(`  vaults: ${vaults.map((v) => `${v.name}=${v.id}`).join('  ')}`)
  console.log(`  repositories: ${repositories.map((r) => `${r.name}=${r.id}`).join('  ')}`)
})
