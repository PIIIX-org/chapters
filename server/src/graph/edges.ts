import { inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes, repositories, vaults } from '../db/schema.js'
import { compareCodeUnits, location } from '../mcp/response.js'
import { bodyStartLine, type Frontmatter } from '../notes/okf.js'
import type { EdgeKind, EdgeRelation, GraphEdge, GraphResourceSet, InternalNode } from './assemble.js'

/**
 * The edge row of ADR-004 §2.8 (#558): how MCP `graph` and
 * `find_graph_path` show an edge. It names its ends instead of giving their
 * ids, says whether it has a direction (`from` links to or imports `to`),
 * how it was found (`kind`), why it exists (`relation`), how sure it is
 * (`confidence`: `resolved`, or a semantic edge's similarity to 2
 * decimals) and where it is written (`evidence`): `path#La-Lb` of the
 * wikilink (whole-file lines of the note) or `path#Ln` of the import (null
 * for an import extracted before migration 0031, until #453 extracts it
 * again), the shared group of a structural edge (`type:`, `tag:`,
 * `language:`, `folder:`), null for a semantic edge. REST graph routes keep
 * `GraphEdge` (ids, for the canvas).
 */
export interface Endpoint {
  /** A note path (no `.md`) or a repository file path. */
  path: string
  /** The vault or repository name, only when the answer spans more than one. */
  in?: string
}

export interface EdgeRow {
  from: Endpoint
  to: Endpoint
  directed: boolean
  kind: EdgeKind
  relation: EdgeRelation
  confidence: 'resolved' | number
  evidence: string | null
}

type Named = Pick<InternalNode, 'id' | 'resourceType' | 'resourceId' | 'path'>

/** A row's identity in a page guard and in the order rows are listed: its ends and relation. */
export const edgeRowKey = (r: EdgeRow): string => JSON.stringify([r.from, r.to, r.relation])

/**
 * `edges` as rows, in their order. Every end must be in `nodes`. Reads the
 * vault and repository names (when `resources` spans several) and the
 * frontmatter of the notes whose links are listed: stored link lines are
 * body-relative (ADR-004 §2.2), the evidence counts lines of the whole note
 * file.
 */
export async function edgeRows(edges: readonly GraphEdge[], nodes: Iterable<Named>, resources: GraphResourceSet): Promise<EdgeRow[]> {
  const byId = new Map<string, Named>()
  for (const n of nodes) byId.set(n.id, n)
  const node = (id: string) => byId.get(id)!

  const names = new Map<string, string>()
  if (resources.vaultIds.length + resources.repositoryIds.length > 1) {
    const used = new Set(edges.flatMap((e) => [node(e.source).resourceId, node(e.target).resourceId]))
    const vaultIds = resources.vaultIds.filter((id) => used.has(id))
    const repositoryIds = resources.repositoryIds.filter((id) => used.has(id))
    if (vaultIds.length > 0) {
      for (const v of await db.select({ id: vaults.id, name: vaults.name }).from(vaults).where(inArray(vaults.id, vaultIds))) names.set(v.id, v.name)
    }
    if (repositoryIds.length > 0) {
      for (const r of await db.select({ id: repositories.id, name: repositories.name }).from(repositories).where(inArray(repositories.id, repositoryIds))) names.set(r.id, r.name)
    }
  }

  const linked = [...new Set(edges.filter((e) => e.relation === 'link' && Array.isArray(e.evidence)).map((e) => e.source))]
  const bodyStart = new Map<string, number>()
  if (linked.length > 0) {
    for (const n of await db.select({ id: notes.id, frontmatter: notes.frontmatter }).from(notes).where(inArray(notes.id, linked))) {
      bodyStart.set(n.id, bodyStartLine(n.frontmatter as Frontmatter))
    }
  }

  const endpoint = (id: string): Endpoint => {
    const n = node(id)
    const container = names.get(n.resourceId)
    return container === undefined ? { path: n.path } : { path: n.path, in: container }
  }
  const evidence = (e: GraphEdge): string | null => {
    if (!Array.isArray(e.evidence)) return (e.evidence as string | null) ?? null
    const [first, last] = e.evidence as readonly [number, number]
    // A link's lines are body-relative: the body starts at line `bodyStart` of the file.
    const offset = e.relation === 'link' ? bodyStart.get(e.source)! - 1 : 0
    return location(node(e.source).path, first + offset, last + offset)
  }
  return edges.map((e): EdgeRow => {
    let [from, to] = [endpoint(e.source), endpoint(e.target)]
    // No direction: the ends in name order, so every view lists the pair alike.
    if (!e.directed && compareCodeUnits(JSON.stringify(to), JSON.stringify(from)) < 0) [from, to] = [to, from]
    const confidence = typeof e.confidence === 'number' ? Math.round(e.confidence * 100) / 100 : e.confidence
    return { from, to, directed: e.directed, kind: e.kind, relation: e.relation, confidence, evidence: evidence(e) }
  })
}
