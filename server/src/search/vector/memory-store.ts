import type {
  FileVectorMeta,
  NeighborResult,
  NoteVectorMeta,
  SymbolVectorMeta,
  SymbolVectorResult,
  VectorSearchResult,
  VectorStore,
} from './vector-store.js'

function dotProduct(a: number[], b: number[]): number {
  let sum = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!
  }
  return sum
}

function norm(a: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * a[i]!
  }
  return Math.sqrt(sum) || 1
}

function cosineSimilarity(a: number[], b: number[]): number {
  const d = dotProduct(a, b)
  const nA = norm(a)
  const nB = norm(b)
  return d / (nA * nB)
}

interface NoteRecord {
  id: string
  embedding: number[]
  meta: NoteVectorMeta
  doc?: string
}

interface FileRecord {
  id: string
  embedding: number[]
  meta: FileVectorMeta
  doc?: string
}

interface SymbolRecord {
  id: string
  embedding: number[]
  meta: SymbolVectorMeta
  snippet?: string
}

export class MemoryVectorStore implements VectorStore {
  private notes = new Map<string, NoteRecord>()
  private files = new Map<string, FileRecord>()
  private symbols = new Map<string, SymbolRecord>()

  async init(): Promise<void> {
    // No-op for in-memory store
  }

  async upsertNote(id: string, embedding: number[], meta: NoteVectorMeta, doc?: string): Promise<void> {
    this.notes.set(id, { id, embedding, meta, doc })
  }

  async deleteNote(id: string): Promise<void> {
    this.notes.delete(id)
  }

  async deleteNotesByVault(vaultId: string): Promise<void> {
    for (const [id, rec] of this.notes.entries()) {
      if (rec.meta.vaultId === vaultId) {
        this.notes.delete(id)
      }
    }
  }

  async upsertFile(id: string, embedding: number[], meta: FileVectorMeta, doc?: string): Promise<void> {
    this.files.set(id, { id, embedding, meta, doc })
  }

  async deleteFile(id: string): Promise<void> {
    this.files.delete(id)
  }

  async deleteFilesByRepository(repositoryId: string): Promise<void> {
    for (const [id, rec] of this.files.entries()) {
      if (rec.meta.repositoryId === repositoryId) {
        this.files.delete(id)
      }
    }
  }

  async upsertSymbols(
    symbols: Array<{ id: string; embedding: number[]; meta: SymbolVectorMeta; snippet?: string }>,
  ): Promise<void> {
    for (const s of symbols) {
      this.symbols.set(s.id, { id: s.id, embedding: s.embedding, meta: s.meta, snippet: s.snippet })
    }
  }

  async deleteSymbols(symbolIds: string[]): Promise<void> {
    for (const id of symbolIds) {
      this.symbols.delete(id)
    }
  }

  async deleteSymbolsByRepository(repositoryId: string): Promise<void> {
    for (const [id, rec] of this.symbols.entries()) {
      if (rec.meta.repositoryId === repositoryId) {
        this.symbols.delete(id)
      }
    }
  }

  async queryNotes(
    embedding: number[],
    vaultIds: string[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult[]> {
    const vaultSet = new Set(vaultIds)
    const matches: Array<{ rec: NoteRecord; sim: number }> = []

    for (const rec of this.notes.values()) {
      if (!vaultSet.has(rec.meta.vaultId)) continue
      if (filter && typeof filter.type === 'string' && rec.meta.type !== filter.type) continue

      const sim = cosineSimilarity(embedding, rec.embedding)
      matches.push({ rec, sim })
    }

    matches.sort((a, b) => b.sim - a.sim)
    return matches.slice(0, limit).map((m) => ({
      id: m.rec.id,
      containerId: m.rec.meta.vaultId,
      path: m.rec.meta.path,
      score: m.sim,
      snippet: m.rec.doc?.slice(0, 200),
    }))
  }

  async queryFiles(
    embedding: number[],
    repositoryIds: string[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const repoSet = new Set(repositoryIds)
    const matches: Array<{ rec: FileRecord; sim: number }> = []

    for (const rec of this.files.values()) {
      if (!repoSet.has(rec.meta.repositoryId)) continue
      const sim = cosineSimilarity(embedding, rec.embedding)
      matches.push({ rec, sim })
    }

    matches.sort((a, b) => b.sim - a.sim)
    return matches.slice(0, limit).map((m) => ({
      id: m.rec.id,
      containerId: m.rec.meta.repositoryId,
      path: m.rec.meta.path,
      score: m.sim,
      snippet: m.rec.doc?.slice(0, 200),
    }))
  }

  async querySymbols(
    embedding: number[],
    repositoryIds: string[],
    limit: number,
    kind?: string,
  ): Promise<SymbolVectorResult[]> {
    const repoSet = new Set(repositoryIds)
    const matches: Array<{ rec: SymbolRecord; sim: number }> = []

    for (const rec of this.symbols.values()) {
      if (!repoSet.has(rec.meta.repositoryId)) continue
      if (kind && rec.meta.kind !== kind) continue
      const sim = cosineSimilarity(embedding, rec.embedding)
      matches.push({ rec, sim })
    }

    matches.sort((a, b) => b.sim - a.sim)
    return matches.slice(0, limit).map((m) => ({
      id: m.rec.id,
      containerId: m.rec.meta.repositoryId,
      fileId: m.rec.meta.fileId,
      path: m.rec.meta.path,
      name: m.rec.meta.name,
      kind: m.rec.meta.kind,
      startLine: m.rec.meta.startLine,
      endLine: m.rec.meta.endLine,
      score: m.sim,
      snippet: m.rec.snippet,
    }))
  }

  async knn(
    embedding: number[],
    excludeType: 'note' | 'code',
    excludeId: string,
    limit: number,
  ): Promise<NeighborResult[]> {
    const neighbors: NeighborResult[] = []

    for (const rec of this.notes.values()) {
      if (excludeType === 'note' && rec.id === excludeId) continue
      const similarity = cosineSimilarity(embedding, rec.embedding)
      neighbors.push({ type: 'note', id: rec.id, similarity })
    }

    for (const rec of this.files.values()) {
      if (excludeType === 'code' && rec.id === excludeId) continue
      const similarity = cosineSimilarity(embedding, rec.embedding)
      neighbors.push({ type: 'code', id: rec.id, similarity })
    }

    neighbors.sort((a, b) => b.similarity - a.similarity)
    return neighbors.slice(0, limit)
  }
}
