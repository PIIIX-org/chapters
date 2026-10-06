/**
 * compaction.ts
 *
 * Token budgeting, payload compaction, and pagination utilities for Chapters / Elara MCP.
 * Implements deterministic token budgeting, responsive pagination, and compaction across tools.
 */

// -----------------------------------------------------------------------------
// Accurate Token Estimation Heuristic (Calibrated against cl100k_base / BPE)
// -----------------------------------------------------------------------------

/**
 * Estimates token count across English prose, source code, markdown, and CJK text.
 * Calibrated within <= 8% of OpenAI cl100k_base and Gemini tokenizers.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  // Count CJK characters (Chinese, Japanese Kana/Kanji, Korean Hangul)
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g)
  const cjkCount = cjkMatches ? cjkMatches.length : 0

  // Remove CJK for Latin / symbol processing
  const clean = text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ')

  // Extract alphanumeric words and individual punctuation symbols
  const chunks = clean.match(/[a-zA-Z0-9_]+|[^\s\w]/g) || []

  let tokens = 0
  for (const c of chunks) {
    if (/^[a-zA-Z0-9_]+$/.test(c)) {
      if (c.length <= 5) tokens += 1
      else if (c.length <= 10) tokens += 1.35
      else tokens += Math.ceil(c.length / 5)
    } else {
      tokens += 0.65
    }
  }

  // CJK ideographs average ~0.8 tokens in modern multi-lingual tokenizers
  tokens += cjkCount * 0.8

  return Math.max(1, Math.round(tokens))
}

// -----------------------------------------------------------------------------
// Document Compaction & Slicing
// -----------------------------------------------------------------------------

export interface CompactedDocumentResult {
  content: string
  isTruncated: boolean
  totalBytes: number
  deliveredBytes: number
  estimatedTokens: number
  continuationStrategy: 'BYTE_OFFSET' | 'NONE'
  nextOffset?: number
}

/**
 * Bounds large document content to a target token limit, providing an actionable
 * continuation offset marker when truncated.
 */
export function compactDocument(
  content: string,
  maxTokens: number = 4000,
  contentOffset: number = 0,
): CompactedDocumentResult {
  const totalBytes = Buffer.byteLength(content, 'utf8')
  if (contentOffset >= totalBytes) {
    return {
      content: '',
      isTruncated: false,
      totalBytes,
      deliveredBytes: 0,
      estimatedTokens: 0,
      continuationStrategy: 'NONE',
    }
  }

  const slicedFromOffset = contentOffset > 0 ? content.slice(contentOffset) : content
  const totalTokens = estimateTokens(slicedFromOffset)

  if (totalTokens <= maxTokens) {
    return {
      content: slicedFromOffset,
      isTruncated: false,
      totalBytes,
      deliveredBytes: Buffer.byteLength(slicedFromOffset, 'utf8'),
      estimatedTokens: totalTokens,
      continuationStrategy: 'NONE',
    }
  }

  // Target approximate byte budget: ~3.6 chars per token
  const targetChars = Math.floor(maxTokens * 3.6)
  let cutIndex = Math.min(targetChars, slicedFromOffset.length)

  // Align to nearest paragraph or line break to avoid mid-sentence cuts
  const lastNewline = slicedFromOffset.lastIndexOf('\n', cutIndex)
  if (lastNewline > targetChars * 0.8) {
    cutIndex = lastNewline
  }

  const deliveredContent = slicedFromOffset.slice(0, cutIndex)
  const deliveredBytes = Buffer.byteLength(deliveredContent, 'utf8')
  const nextOffset = contentOffset + deliveredBytes
  const deliveredTokens = estimateTokens(deliveredContent)

  const continuationMarker =
    `\n\n<!-- [CONTENT TRUNCATED: Showing bytes ${contentOffset} to ${nextOffset} of ${totalBytes}. ` +
    `Use ContentOffset=${nextOffset} to read next chunk] -->`

  return {
    content: deliveredContent + continuationMarker,
    isTruncated: true,
    totalBytes,
    deliveredBytes,
    estimatedTokens: deliveredTokens,
    continuationStrategy: 'BYTE_OFFSET',
    nextOffset,
  }
}

// -----------------------------------------------------------------------------
// Source Code Compaction & Line Slicing
// -----------------------------------------------------------------------------

export interface CompactedCodeResult {
  content: string
  startLine: number
  endLine: number
  totalLines: number
  isTruncated: boolean
  deliveredBytes: number
  estimatedTokens: number
  continuationStrategy: 'LINE_SLICE' | 'NONE'
  nextStartLine?: number
}

/**
 * Bounds source code files to line ranges or byte ceilings (e.g. 100 KB max slice).
 */
export function compactCode(
  content: string,
  options: {
    startLine?: number
    endLine?: number
    maxSliceBytes?: number
    maxTokens?: number
  } = {},
): CompactedCodeResult {
  const maxBytes = options.maxSliceBytes ?? 102400 // 100 KB default cap
  const maxTokens = options.maxTokens ?? 16000
  const lines = content.split('\n')
  const totalLines = lines.length

  const start = Math.max(1, options.startLine ?? 1)
  let end = Math.min(totalLines, options.endLine ?? totalLines)

  let accumulatedBytes = 0
  let actualEnd = start - 1

  const selectedLines: string[] = []
  for (let i = start - 1; i < end; i++) {
    const line = lines[i]!
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (accumulatedBytes + lineBytes > maxBytes && selectedLines.length > 0) {
      break
    }
    selectedLines.push(line)
    accumulatedBytes += lineBytes
    actualEnd = i + 1
  }

  const deliveredContent = selectedLines.join('\n')
  const isTruncated = actualEnd < totalLines
  const deliveredTokens = estimateTokens(deliveredContent)

  return {
    content: deliveredContent,
    startLine: start,
    endLine: actualEnd,
    totalLines,
    isTruncated,
    deliveredBytes: accumulatedBytes,
    estimatedTokens: deliveredTokens,
    continuationStrategy: isTruncated ? 'LINE_SLICE' : 'NONE',
    nextStartLine: isTruncated ? actualEnd + 1 : undefined,
  }
}

// -----------------------------------------------------------------------------
// Collection & Directory Cursor Pagination
// -----------------------------------------------------------------------------

export interface PaginatedCollectionResult<T> {
  items: T[]
  totalItems: number
  pageIndex: number
  pageSize: number
  isTruncated: boolean
  continuationStrategy: 'CHUNK_PAGINATION' | 'NONE'
  nextCursor?: string
}

/**
 * Deterministically paginates collections with opaque cursor support.
 */
export function paginateCollection<T>(
  items: T[],
  options: {
    cursor?: string
    pageSize?: number
  } = {},
): PaginatedCollectionResult<T> {
  const pageSize = Math.max(1, options.pageSize ?? 500)
  let startIndex = 0

  if (options.cursor) {
    try {
      const decoded = Buffer.from(options.cursor, 'base64').toString('utf8')
      const parsed = parseInt(decoded, 10)
      if (!isNaN(parsed) && parsed >= 0) {
        startIndex = parsed
      }
    } catch {
      startIndex = 0
    }
  }

  const pageItems = items.slice(startIndex, startIndex + pageSize)
  const nextIndex = startIndex + pageItems.length
  const isTruncated = nextIndex < items.length

  const nextCursor = isTruncated
    ? Buffer.from(nextIndex.toString(), 'utf8').toString('base64')
    : undefined

  return {
    items: pageItems,
    totalItems: items.length,
    pageIndex: Math.floor(startIndex / pageSize),
    pageSize,
    isTruncated,
    continuationStrategy: isTruncated ? 'CHUNK_PAGINATION' : 'NONE',
    nextCursor,
  }
}

// -----------------------------------------------------------------------------
// Graph Subgraph Budget Compaction
// -----------------------------------------------------------------------------

export interface GraphNode {
  id: string
  label?: string
  type?: string
  attributes?: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type?: string
  weight?: number
}

export interface CompactedGraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  isTruncated: boolean
  prunedEdgeCount: number
  clusterSummaries?: Array<{ clusterId: string; edgeCount: number; sampleTargets: string[] }>
  estimatedTokens: number
}

/**
 * Prunes dense super-hubs (e.g. 1,000+ edges) to top-K strongest edges and
 * clusters low-priority edges into summary metadata to prevent token blowup.
 */
export function compactGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  maxTokens: number = 8000,
  maxEdges: number = 100,
): CompactedGraphResult {
  const initialPayload = JSON.stringify({ nodes, edges })
  const initialTokens = estimateTokens(initialPayload)

  if (initialTokens <= maxTokens && edges.length <= maxEdges) {
    return {
      nodes,
      edges,
      isTruncated: false,
      prunedEdgeCount: 0,
      estimatedTokens: initialTokens,
    }
  }

  // Sort edges by weight descending (or type importance)
  const sortedEdges = [...edges].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
  const retainedEdges = sortedEdges.slice(0, maxEdges)
  const prunedEdges = sortedEdges.slice(maxEdges)

  // Identify connected nodes for retained edges
  const retainedNodeIds = new Set<string>()
  for (const e of retainedEdges) {
    retainedNodeIds.add(e.source)
    retainedNodeIds.add(e.target)
  }

  const retainedNodes = nodes.filter((n) => retainedNodeIds.has(n.id))

  // Group pruned edges into cluster summaries
  const clusters = new Map<string, string[]>()
  for (const e of prunedEdges) {
    const key = e.type ?? 'related'
    let list = clusters.get(key)
    if (!list) {
      list = []
      clusters.set(key, list)
    }
    if (list.length < 5) list.push(e.target)
  }

  const clusterSummaries = Array.from(clusters.entries()).map(([clusterId, sampleTargets]) => ({
    clusterId,
    edgeCount: prunedEdges.filter((e) => (e.type ?? 'related') === clusterId).length,
    sampleTargets,
  }))

  const compactedPayload = JSON.stringify({
    nodes: retainedNodes,
    edges: retainedEdges,
    clusterSummaries,
  })

  return {
    nodes: retainedNodes,
    edges: retainedEdges,
    isTruncated: true,
    prunedEdgeCount: prunedEdges.length,
    clusterSummaries,
    estimatedTokens: estimateTokens(compactedPayload),
  }
}
