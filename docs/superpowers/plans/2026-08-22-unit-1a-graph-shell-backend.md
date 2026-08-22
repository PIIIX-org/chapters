# Unit 1a — Backend Additions for the Graph Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three backend capabilities the graph-as-Home shell needs and
cannot be built without: reading a graph preference, a community-aggregated
graph, and vault deletion.

**Architecture:** Aggregation is a new `aggregate=community` query parameter
handled inside `buildGraph()`, so all three existing graph endpoints
(`/vaults/:id/graph`, `/graph/merged`, `/repositories/:id/graph`) gain it
without touching their handlers. Drill-down is a sibling `community=<n>`
filter. Vault deletion mirrors the note lifecycle: a soft delete that hides the
vault, then a separate purge that cascades.

**Tech Stack:** Fastify, Drizzle ORM, Postgres, vitest against a real database.
No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-remaining-ui-design.md` — backend
additions 1, 2 and 5. Additions 3 and 4 (repository file content,
`defaultBranch`) belong to unit 7 and are **not** in this plan.

## Global Constraints

- **This is slice 1a of unit 1.** The remaining slices are 1b (shell, routing,
  vault lifecycle UI, empty state, axe gate), 1c (graph canvas), 1d (⌘K), 1e
  (notifications). Do not build client code in this plan.
- Relative imports **must** end in `.js` (`verbatimModuleSyntax`).
- ESLint here rejects unused `_`-prefixed destructure vars — never write
  `const { a: _a, ...rest }`.
- Tests live in `server/test/*.test.ts`, run against a real Postgres
  (`chapters_test`), `fileParallelism: false`. Vitest globals are NOT enabled —
  import `{ describe, it, expect, beforeAll, afterAll }` from `'vitest'`.
- Requires colima + `docker compose up -d db` before `pnpm test`.
- Root `pnpm lint` and `pnpm -r typecheck` clean before every commit.
- **Aggregation reduces payload and render cost, not server compute.**
  `buildGraph()` still does its full ~500ms of work at 10k notes (measured, see
  `implementation.md`). Do not claim or expect a speedup; caching is issue #93
  territory and explicitly out of scope here.

---

### Task 1: `GET` graph preference for vaults and repositories

Only `PUT` exists, so the merged-view toggle cannot read its own state.

**Files:**
- Modify: `server/src/vaults/routes.ts` (beside the `PUT` at line ~246)
- Modify: `server/src/repositories/routes.ts` (beside the `PUT` at line ~355)
- Test: `server/test/graph-preference.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAccess`, `atLeast` from `../vaults/permissions.js`; the
  `vaultGraphPreferences` / `repositoryGraphPreferences` tables.
- Produces: `GET /api/vaults/:id/graph-preference` → `{ include: boolean }` and
  `GET /api/repositories/:id/graph-preference` → `{ include: boolean }`.
  Absent row means `{ include: false }`, matching the column default.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie },
      body: { name: 'Pref vault' },
    })).json() as { id: string }
  ).id
})

afterAll(async () => app.close())

describe('graph preference read', () => {
  it('defaults to include:false when no row exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ include: false })
  })

  it('reads back what PUT wrote', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
      body: { include: true },
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie },
    })
    expect(res.json()).toEqual({ include: true })
  })

  it('404s for a vault the caller cannot reach', async () => {
    const stranger = await createActiveUser()
    const strangerCookie = await loginCookie(app, stranger.email)
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph-preference`,
      headers: { cookie: strangerCookie },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && pnpm exec vitest run test/graph-preference.test.ts`
Expected: FAIL — the first two cases 404 because the route does not exist.

- [ ] **Step 3: Add the vault handler**

In `server/src/vaults/routes.ts`, directly above the existing
`PUT '/vaults/:id/graph-preference'`:

```ts
  app.get<{ Params: { id: string } }>(
    '/vaults/:id/graph-preference',
    async (req, reply) => {
      const access = await resolveAccess(req.user!.id, req.params.id)
      if (!atLeast(access, 'read')) return reply.code(404).send({ error: 'not found' })
      const rows = await db
        .select({ include: vaultGraphPreferences.include })
        .from(vaultGraphPreferences)
        .where(
          and(
            eq(vaultGraphPreferences.userId, req.user!.id),
            eq(vaultGraphPreferences.vaultId, req.params.id),
          ),
        )
      // No row is not an error — the column defaults to false.
      return { include: rows[0]?.include ?? false }
    },
  )
```

Add `vaultGraphPreferences` to the existing `../db/schema.js` import and `and`
to the `drizzle-orm` import if they are not already there.

- [ ] **Step 4: Add the repository handler**

In `server/src/repositories/routes.ts`, above the existing `PUT`:

```ts
  app.get<{ Params: { id: string } }>(
    '/repositories/:id/graph-preference',
    async (req, reply) => {
      const access = await resolveRepositoryAccess(req.user!.id, req.params.id)
      if (!access) return reply.code(404).send({ error: 'not found' })
      const rows = await db
        .select({ include: repositoryGraphPreferences.include })
        .from(repositoryGraphPreferences)
        .where(
          and(
            eq(repositoryGraphPreferences.userId, req.user!.id),
            eq(repositoryGraphPreferences.repositoryId, req.params.id),
          ),
        )
      return { include: rows[0]?.include ?? false }
    },
  )
```

Use whatever access helper the neighbouring `PUT` in that file already uses —
read it first and match it exactly rather than assuming the name above.

- [ ] **Step 5: Run tests and lint**

Run: `cd server && pnpm exec vitest run test/graph-preference.test.ts` → PASS.
Then from the repo root: `pnpm lint && pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add server/src/vaults/routes.ts server/src/repositories/routes.ts server/test/graph-preference.test.ts
git commit -m "Add GET graph-preference for vaults and repositories

Only PUT existed, so the merged-view toggle had no way to read its own
state. Absent row returns include:false, matching the column default."
```

---

### Task 2: Community-aggregated graph

`buildGraph()` returns ~285k edges at 10k notes. The shell renders Louvain
communities as super-nodes and expands one on demand.

**Files:**
- Modify: `server/src/graph/assemble.ts`
- Modify: `server/src/graph/routes.ts` (filter parsing + query schema)
- Test: `server/test/graph-aggregate.test.ts` (create)

**Interfaces:**
- Consumes: the existing `buildGraph(resources, filters)` and its `VaultGraph`
  return type; `GraphFilters` from `./assemble.js`.
- Produces: `GraphFilters` gains `aggregate?: 'community'`. When set,
  `buildGraph` returns `CommunityGraph`:

```ts
export interface CommunityNode {
  id: string          // `community:${n}`
  community: number
  size: number        // member node count
  noteCount: number
  codeCount: number
  lastActivity: string | null  // max updatedAt among members, ISO, for ink-fade
}

export interface CommunityEdge {
  source: string      // `community:${n}`
  target: string
  weight: number      // underlying edges collapsed into this pair
}

export interface CommunityGraph {
  aggregated: true
  nodes: CommunityNode[]
  edges: CommunityEdge[]
  cappedGroups: string[]
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { flushEmbeddings } from '../src/search/embedding-queue.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let cookie: string
let vaultId: string

interface CommunityGraphResponse {
  aggregated?: boolean
  nodes: Array<{ id: string; community: number; size: number; lastActivity: string | null }>
  edges: Array<{ source: string; target: string; weight: number }>
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  cookie = await loginCookie(app, owner.email)
  vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie },
      body: { name: 'Aggregate vault' },
    })).json() as { id: string }
  ).id

  for (const [name, body] of [
    ['apollo', 'Rocket engine design. See [[people/wernher]].'],
    ['wernher', 'Chief rocket engine designer for apollo.'],
    ['grocery', 'Buy milk and coffee beans tomorrow.'],
  ] as const) {
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/notes`,
      headers: { cookie },
      body: { type: 'notes', name, body, frontmatter: { type: 'notes' } },
    })
  }
  await flushEmbeddings()
})

afterAll(async () => app.close())

describe('community-aggregated graph', () => {
  it('returns community super-nodes instead of individual notes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?aggregate=community`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const graph = res.json() as CommunityGraphResponse
    expect(graph.aggregated).toBe(true)
    expect(graph.nodes.length).toBeGreaterThan(0)
    for (const n of graph.nodes) {
      expect(n.id).toMatch(/^community:\d+$/)
      expect(n.size).toBeGreaterThan(0)
    }
    // Member counts must account for every node in the unaggregated graph.
    const plain = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph`,
        headers: { cookie },
      })
    ).json() as { nodes: unknown[] }
    const total = graph.nodes.reduce((sum, n) => sum + n.size, 0)
    expect(total).toBe(plain.nodes.length)
  })

  it('collapses edges between the same community pair into one weighted edge', async () => {
    const graph = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph?aggregate=community`,
        headers: { cookie },
      })
    ).json() as CommunityGraphResponse
    const seen = new Set<string>()
    for (const e of graph.edges) {
      const key = [e.source, e.target].sort().join('|')
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(e.weight).toBeGreaterThan(0)
      expect(e.source).not.toBe(e.target) // self-loops are dropped
    }
  })

  it('is unchanged without the parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph`,
      headers: { cookie },
    })
    const graph = res.json() as CommunityGraphResponse
    expect(graph.aggregated).toBeUndefined()
    expect(graph.nodes.every((n) => !n.id.startsWith('community:'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && pnpm exec vitest run test/graph-aggregate.test.ts`
Expected: FAIL — `aggregated` is undefined and nodes are still individual notes,
because the parameter is ignored.

- [ ] **Step 3: Extend the filter type and add the collapse function**

In `server/src/graph/assemble.ts`, extend `GraphFilters` and add the types and
collapse helper. Place the helper immediately above `buildGraph`:

```ts
export interface GraphFilters {
  types?: string[]
  tags?: string[]
  since?: string
  until?: string
  aggregate?: 'community'
}

export interface CommunityNode {
  id: string
  community: number
  size: number
  noteCount: number
  codeCount: number
  lastActivity: string | null
}

export interface CommunityEdge {
  source: string
  target: string
  weight: number
}

export interface CommunityGraph {
  aggregated: true
  nodes: CommunityNode[]
  edges: CommunityEdge[]
  cappedGroups: string[]
}

/**
 * Collapses an assembled graph into one node per Louvain community. This
 * shrinks the payload and what the client has to draw; it does NOT make
 * buildGraph cheaper — the full assembly still runs (see issue #93).
 */
function collapseToCommunities(graph: VaultGraph): CommunityGraph {
  const byCommunity = new Map<number, CommunityNode>()
  const communityOf = new Map<string, number>()

  for (const n of graph.nodes) {
    communityOf.set(n.id, n.community)
    let c = byCommunity.get(n.community)
    if (!c) {
      c = {
        id: `community:${n.community}`,
        community: n.community,
        size: 0,
        noteCount: 0,
        codeCount: 0,
        lastActivity: null,
      }
      byCommunity.set(n.community, c)
    }
    c.size += 1
    if (n.resourceType === 'code') c.codeCount += 1
    else c.noteCount += 1
    const ts = n.updatedAt ?? null
    if (ts && (c.lastActivity === null || ts > c.lastActivity)) c.lastActivity = ts
  }

  const weights = new Map<string, CommunityEdge>()
  for (const e of graph.edges) {
    const a = communityOf.get(e.source)
    const b = communityOf.get(e.target)
    if (a === undefined || b === undefined) continue
    if (a === b) continue // intra-community edges are already implied by size
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const key = `${lo}|${hi}`
    const existing = weights.get(key)
    if (existing) existing.weight += 1
    else
      weights.set(key, { source: `community:${lo}`, target: `community:${hi}`, weight: 1 })
  }

  return {
    aggregated: true,
    nodes: [...byCommunity.values()].sort((x, y) => y.size - x.size),
    edges: [...weights.values()],
    cappedGroups: graph.cappedGroups,
  }
}
```

`GraphNode` has **no** `updatedAt` today — only `timestamp`, which is the OKF
frontmatter field and is `null` for code. Ink-fade decay needs real
modification time, so add it in this step:

1. Add `updatedAt: string | null` to the `GraphNode` interface (`assemble.ts`
   line ~21), and to `InternalNode`.
2. Add `updatedAt: notes.updatedAt` to the `.select({...})` on the `notes`
   query (~line 97) and `updatedAt: repositoryFiles.updatedAt` to the one on
   `repositoryFiles` (~line 122).
3. In both `.map((r) => ({...}))` blocks that build internal nodes, carry it
   through as `updatedAt: r.updatedAt?.toISOString() ?? null` — the column is a
   `timestamp with time zone`, so Drizzle hands back a `Date`.
4. Carry it into the final `nodes` objects alongside `community`.

Comparing ISO-8601 strings with `>` is correct here because they are all UTC
and same-length, which is what `collapseToCommunities` relies on.

- [ ] **Step 4: Return the collapsed graph from `buildGraph`**

Change `buildGraph`'s signature and its two return points:

```ts
export async function buildGraph(
  resources: GraphResourceSet,
  filters: GraphFilters = {},
): Promise<VaultGraph | CommunityGraph> {
```

At the early-exit for an empty resource set:

```ts
  if (vaultIds.length === 0 && repositoryIds.length === 0) {
    const empty: VaultGraph = { nodes: [], edges: [], cappedGroups: [] }
    return filters.aggregate === 'community' ? collapseToCommunities(empty) : empty
  }
```

And at the final return, wrap whatever object is currently returned:

```ts
  const assembled: VaultGraph = { nodes, edges, cappedGroups }
  return filters.aggregate === 'community' ? collapseToCommunities(assembled) : assembled
```

- [ ] **Step 5: Accept the query parameter**

In `server/src/graph/routes.ts`, add to `parseFilters` and the schema:

```ts
function parseFilters(q: {
  types?: string
  tags?: string
  since?: string
  until?: string
  aggregate?: string
}): GraphFilters {
  return {
    types: q.types ? q.types.split(',').filter(Boolean) : undefined,
    tags: q.tags ? q.tags.split(',').filter(Boolean) : undefined,
    since: q.since,
    until: q.until,
    aggregate: q.aggregate === 'community' ? 'community' : undefined,
  }
}

const filterQuerySchema = {
  type: 'object',
  properties: {
    types: { type: 'string' },
    tags: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    aggregate: { type: 'string', enum: ['community'] },
  },
} as const
```

Add `aggregate?: string` to the `Querystring` generic on all three route
handlers in this file, and to `/repositories/:id/graph` if it lives elsewhere —
grep for `buildGraph(` to find every caller.

- [ ] **Step 6: Run tests, lint, typecheck**

Run: `cd server && pnpm exec vitest run test/graph-aggregate.test.ts` → PASS.
Then `cd server && pnpm test` to confirm nothing else broke — `graph-search.test.ts`
and `repository-graph.test.ts` both assert on the unaggregated shape.
Then from the root: `pnpm lint && pnpm -r typecheck`.

- [ ] **Step 7: Commit**

```bash
git add server/src/graph/assemble.ts server/src/graph/routes.ts server/test/graph-aggregate.test.ts
git commit -m "Add community-aggregated graph via aggregate=community

buildGraph returns ~285k edges at 10k notes, which no 2D renderer draws.
Collapsing to one node per Louvain community shrinks payload and render
cost. Server compute is unchanged — the full assembly still runs (#93)."
```

---

### Task 3: Community drill-down

Expanding a super-node needs its members.

**Files:**
- Modify: `server/src/graph/assemble.ts`
- Modify: `server/src/graph/routes.ts`
- Test: `server/test/graph-aggregate.test.ts` (extend)

**Interfaces:**
- Consumes: `GraphFilters`, `collapseToCommunities` from Task 2.
- Produces: `GraphFilters` gains `community?: number`. When set (and
  `aggregate` is not), `buildGraph` returns a normal `VaultGraph` containing
  only nodes in that community and only edges whose endpoints are both in it.

- [ ] **Step 1: Write the failing test**

Append to `server/test/graph-aggregate.test.ts`:

```ts
describe('community drill-down', () => {
  it('returns only the members of one community', async () => {
    const agg = (
      await app.inject({
        method: 'GET',
        url: `/api/vaults/${vaultId}/graph?aggregate=community`,
        headers: { cookie },
      })
    ).json() as CommunityGraphResponse
    const first = agg.nodes[0]!

    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=${first.community}`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const members = res.json() as { nodes: Array<{ id: string; community: number }>; edges: Array<{ source: string; target: string }> }
    expect(members.nodes).toHaveLength(first.size)
    expect(members.nodes.every((n) => n.community === first.community)).toBe(true)

    const ids = new Set(members.nodes.map((n) => n.id))
    for (const e of members.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
  })

  it('returns an empty graph for a community that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/graph?community=99999`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { nodes: unknown[] }).nodes).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && pnpm exec vitest run test/graph-aggregate.test.ts -t "drill-down"`
Expected: FAIL — `community` is ignored, so the full graph comes back and the
length assertion fails.

- [ ] **Step 3: Implement the filter**

In `assemble.ts`, add `community?: number` to `GraphFilters`, and add this
immediately before the final return (after communities are assigned, so nodes
already carry `community`):

```ts
  const assembled: VaultGraph = { nodes, edges, cappedGroups }
  if (filters.aggregate === 'community') return collapseToCommunities(assembled)
  if (filters.community !== undefined) {
    const members = assembled.nodes.filter((n) => n.community === filters.community)
    const ids = new Set(members.map((n) => n.id))
    return {
      nodes: members,
      edges: assembled.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      cappedGroups: assembled.cappedGroups,
    }
  }
  return assembled
```

- [ ] **Step 4: Accept the query parameter**

In `routes.ts`, add to `parseFilters`:

```ts
    community:
      q.community !== undefined && q.community !== '' && Number.isInteger(Number(q.community))
        ? Number(q.community)
        : undefined,
```

and to the schema: `community: { type: 'string' }`. Add `community?: string` to
each handler's `Querystring` generic.

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `cd server && pnpm test` → all pass. Root: `pnpm lint && pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add server/src/graph/assemble.ts server/src/graph/routes.ts server/test/graph-aggregate.test.ts
git commit -m "Add community drill-down via community=<n>

Expanding a super-node returns its members and only the edges whose
endpoints are both inside it."
```

---

### Task 4: Vault soft delete

There is no vault delete endpoint at all. Users can create vaults and never
remove them.

**Files:**
- Modify: `server/src/db/schema.ts` (add `deletedAt` to `vaults`)
- Create: `server/drizzle/0011_*.sql` (via `pnpm db:generate`)
- Modify: `server/src/vaults/routes.ts`
- Modify: `server/src/vaults/permissions.ts`
- Test: `server/test/vault-delete.test.ts` (create)

**Interfaces:**
- Consumes: `resolveAccess`, `atLeast`.
- Produces: `DELETE /api/vaults/:id` → `{ status: 'trashed', id }`, owner only.
  A soft-deleted vault disappears from `listAccessibleVaults`, from
  `GET /api/vaults`, and from graph and search results.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
let ownerCookie: string
let otherCookie: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const other = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  otherCookie = await loginCookie(app, other.email)
})

afterAll(async () => app.close())

async function makeVault(cookie: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie },
    body: { name },
  })
  return (res.json() as { id: string }).id
}

describe('vault soft delete', () => {
  it('hides the vault from the owner’s list', async () => {
    const id = await makeVault(ownerCookie, 'Doomed')
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${id}`,
      headers: { cookie: ownerCookie },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ status: 'trashed', id })

    const list = (
      await app.inject({ method: 'GET', url: '/api/vaults', headers: { cookie: ownerCookie } })
    ).json() as Array<{ id: string }>
    expect(list.some((v) => v.id === id)).toBe(false)
  })

  it('makes the vault unreachable afterwards', async () => {
    const id = await makeVault(ownerCookie, 'Also doomed')
    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })
    const tree = await app.inject({
      method: 'GET',
      url: `/api/vaults/${id}/tree`,
      headers: { cookie: ownerCookie },
    })
    expect(tree.statusCode).toBe(404)
  })

  it('refuses a non-owner', async () => {
    const id = await makeVault(ownerCookie, 'Not yours')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/vaults/${id}`,
      headers: { cookie: otherCookie },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && pnpm exec vitest run test/vault-delete.test.ts`
Expected: FAIL — `DELETE` returns 404, the route does not exist.

- [ ] **Step 3: Add the column and generate the migration**

In `server/src/db/schema.ts`, inside the `vaults` table definition, after
`createdAt`:

```ts
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
```

Then: `cd server && pnpm db:generate`

This is an additive nullable column, so drizzle-kit will **not** prompt. If it
does prompt for anything, stop — something else changed and the plan is stale.

- [ ] **Step 4: Exclude soft-deleted vaults from access resolution**

In `server/src/vaults/permissions.ts`, add `isNull(vaults.deletedAt)` to the
`where` clause of both `resolveAccess` and `listAccessibleVaults`. Read the file
first — both functions query `vaults`, and this single change is what makes the
tree, graph and search cases in the test pass without touching those routes.
Import `isNull` from `drizzle-orm` if it is not already imported.

- [ ] **Step 5: Add the route**

In `server/src/vaults/routes.ts`:

```ts
  app.delete<{ Params: { id: string } }>('/vaults/:id', async (req, reply) => {
    const access = await resolveAccess(req.user!.id, req.params.id)
    // Owner-only, and a non-owner must not learn the vault exists.
    if (access !== 'owner') return reply.code(404).send({ error: 'not found' })
    await db
      .update(vaults)
      .set({ deletedAt: new Date() })
      .where(eq(vaults.id, req.params.id))
    return { status: 'trashed', id: req.params.id }
  })
```

- [ ] **Step 6: Run the whole suite**

Run: `cd server && pnpm test`

The soft-delete filter touches shared permission helpers, so the whole suite is
the check here, not just the new file. Then root: `pnpm lint && pnpm -r typecheck`.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/src/vaults/permissions.ts server/src/vaults/routes.ts server/test/vault-delete.test.ts
git commit -m "Add vault soft delete

No vault delete endpoint existed; users could create vaults and never
remove them. Filtering deletedAt in resolveAccess and
listAccessibleVaults hides a trashed vault from listings, tree, graph
and search in one place rather than per-route."
```

---

### Task 5: Vault purge

**Files:**
- Modify: `server/src/vaults/routes.ts`
- Test: `server/test/vault-delete.test.ts` (extend)

**Interfaces:**
- Consumes: `deleteSemanticEdgesFor` from `../search/semantic-edges.js`; the
  `notes` table; `config.dataDir`.
- Produces: `POST /api/vaults/:id/purge` → `{ status: 'purged', id }`, owner
  only, and **only** for an already-soft-deleted vault (409 otherwise), matching
  `purgeNote`'s contract.

- [ ] **Step 1: Write the failing test**

Append to `server/test/vault-delete.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { notes, semanticEdges, vaults } from '../src/db/schema.js'

describe('vault purge', () => {
  it('refuses to purge a vault that is not trashed', async () => {
    const id = await makeVault(ownerCookie, 'Still live')
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/purge`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(409)
  })

  it('removes the vault, its notes, and their semantic edges', async () => {
    const id = await makeVault(ownerCookie, 'Purge me')
    await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/notes`,
      headers: { cookie: ownerCookie },
      body: { type: 'notes', name: 'doomed', body: 'x', frontmatter: { type: 'notes' } },
    })
    const noteRows = await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, id))
    const noteId = noteRows[0]!.id
    // semanticEdges has no FK, so it cannot cascade. Seed BOTH directions
    // against a synthetic other end — a row where the purged note is the
    // TARGET is the one a naive cleanup misses.
    const other = randomUUID()
    await db.insert(semanticEdges).values([
      { sourceType: 'note', sourceId: noteId, targetType: 'note', targetId: other, similarity: 0.9 },
      { sourceType: 'note', sourceId: other, targetType: 'note', targetId: noteId, similarity: 0.9 },
    ])

    await app.inject({ method: 'DELETE', url: `/api/vaults/${id}`, headers: { cookie: ownerCookie } })
    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${id}/purge`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)

    expect(await db.select().from(vaults).where(eq(vaults.id, id))).toEqual([])
    expect(await db.select().from(notes).where(eq(notes.vaultId, id))).toEqual([])
    const edges = await db
      .select()
      .from(semanticEdges)
      .where(
        or(
          and(eq(semanticEdges.sourceType, 'note'), eq(semanticEdges.sourceId, noteId)),
          and(eq(semanticEdges.targetType, 'note'), eq(semanticEdges.targetId, noteId)),
        ),
      )
    expect(edges).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && pnpm exec vitest run test/vault-delete.test.ts -t "purge"`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Implement the route**

In `server/src/vaults/routes.ts`:

```ts
  app.post<{ Params: { id: string } }>('/vaults/:id/purge', async (req, reply) => {
    const rows = await db
      .select({ id: vaults.id, ownerId: vaults.ownerId, deletedAt: vaults.deletedAt })
      .from(vaults)
      .where(eq(vaults.id, req.params.id))
    const vault = rows[0]
    if (!vault || vault.ownerId !== req.user!.id) {
      return reply.code(404).send({ error: 'not found' })
    }
    // Same contract as purgeNote: purge only what is already trashed.
    if (!vault.deletedAt) {
      return reply.code(409).send({ error: 'vault is not trashed' })
    }

    // semanticEdges is polymorphic with no FK, so it does not cascade (#92).
    // Collect note ids BEFORE deleting the vault row.
    const noteIds = (
      await db.select({ id: notes.id }).from(notes).where(eq(notes.vaultId, req.params.id))
    ).map((n) => n.id)
    await deleteSemanticEdgesFor('note', noteIds)

    // Everything else referencing the vault cascades via FK.
    await db.delete(vaults).where(eq(vaults.id, req.params.id))
    await rm(join(config.dataDir, 'vaults', req.params.id), { recursive: true, force: true })

    return { status: 'purged', id: req.params.id }
  })
```

Add the imports this needs at the top of the file if absent: `rm` from
`node:fs/promises`, `join` from `node:path`, `config` from `../config.js`,
`notes` from `../db/schema.js`, and `deleteSemanticEdgesFor` from
`../search/semantic-edges.js`.

- [ ] **Step 4: Run the whole suite**

Run: `cd server && pnpm test` → all pass. Root: `pnpm lint && pnpm -r typecheck`.

- [ ] **Step 5: Update the docs**

Add the two endpoints to `README.md` wherever vault operations are described,
and note in `docs/agents/STATE.md` that unit 1a is done. Keep STATE.md under 40
lines.

- [ ] **Step 6: Commit**

```bash
git add server/src/vaults/routes.ts server/test/vault-delete.test.ts README.md docs/agents/STATE.md
git commit -m "Add vault purge

Owner-only, and only for an already-trashed vault, matching purgeNote.
Vault-referencing tables cascade via FK, but semanticEdges is
polymorphic with no FK, so its rows are cleared explicitly before the
vault row goes (#92). Removes the vault's directory from disk too."
```

---

## Done when

- `pnpm test` green in `server/`, root `pnpm lint` and `pnpm -r typecheck` clean.
- `GET /api/vaults/:id/graph?aggregate=community` returns super-nodes whose
  sizes sum to the unaggregated node count.
- `GET /api/vaults/:id/graph?community=<n>` returns exactly that community.
- A vault can be trashed and purged, and purging leaves no notes, no semantic
  edges and no directory on disk.
- One PR targeting `dev`, opened from the `sadeqisaidmohaddes-star` account per
  `docs/agents/github-workflow.md`.
