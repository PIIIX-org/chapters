import { inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { notes } from '../db/schema.js'
import { getLiveNote } from '../notes/store.js'
import { backlinksOf, neighborhood, type Backlink } from './neighbors.js'
import { noteNode } from './assemble.js'

/**
 * The REST local graph of a note (`GET /vaults/:id/local-graph/*`) and its
 * backlinks with lines (#472): both answer from the walk MCP `graph`
 * (`neighborsOf`) makes in SQL (`neighborhood`, `backlinksOf`), not from every
 * note of the vault loaded into memory. The graph is the note's wikilink and
 * semantic edges within its vault, nearest first, at most 50 nodes.
 */
export const LOCAL_GRAPH_NODES = 50

export interface LocalGraphNode {
  id: string
  path: string
  name: string
  title: string | null
  type: string | null
  resourceType: 'note' | 'code'
  resourceId: string
  isCenter: boolean
  depth: number
}

export interface LocalGraphEdge {
  source: string
  target: string
  kind: 'extracted' | 'semantic'
  similarity?: number
}

export interface LocalGraphData {
  center: LocalGraphNode
  nodes: LocalGraphNode[]
  edges: LocalGraphEdge[]
}

/** null when the vault has no such live note. */
export async function getLocalGraph(vaultId: string, path: string, depth: number): Promise<LocalGraphData | null> {
  const note = await getLiveNote(vaultId, path)
  if (!note) return null
  const local = await neighborhood({ vaultIds: [vaultId], repositoryIds: [] }, noteNode(note), {
    depth,
    edgeTypes: ['extracted', 'semantic'],
    limit: LOCAL_GRAPH_NODES,
  })
  const rows = await db
    .select({ id: notes.id, name: notes.name, frontmatter: notes.frontmatter })
    .from(notes)
    .where(inArray(notes.id, local.nodes.map((n) => n.id)))
  const named = new Map(rows.map((r) => [r.id, r]))
  const nodes = local.nodes.map((n): LocalGraphNode => {
    const row = named.get(n.id)
    const title = (row?.frontmatter as { title?: unknown } | undefined)?.title
    return {
      id: n.id,
      path: n.path,
      name: row?.name ?? n.path.slice(n.path.lastIndexOf('/') + 1),
      title: typeof title === 'string' ? title : null,
      type: n.type,
      resourceType: 'note',
      resourceId: vaultId,
      isCenter: n.id === note.id,
      depth: n.distance,
    }
  })
  return {
    center: nodes.find((n) => n.isCenter)!,
    nodes,
    // One edge per pair and kind, as before: the walk lists a link once per line it is written on.
    edges: [...new Map(local.edges.map((e) => [`${e.source}>${e.target}:${e.kind}`, e])).values()].map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind === 'semantic' ? 'semantic' : 'extracted',
      ...(typeof e.confidence === 'number' ? { similarity: e.confidence } : {}),
    })),
  }
}

/** The links to a note, one per line they are written on (`location` is `path#La`, lines of the linking note's file). */
export async function getBacklinkLines(vaultId: string, path: string): Promise<Backlink[] | null> {
  const note = await getLiveNote(vaultId, path)
  return note ? backlinksOf(noteNode(note), {}) : null
}
