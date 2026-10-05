import { ChromaClient, type Collection, type Metadata, type Where } from 'chromadb'
import type {
  FileVectorMeta,
  NeighborResult,
  NoteVectorMeta,
  SymbolVectorMeta,
  SymbolVectorResult,
  VectorSearchResult,
  VectorStore,
} from './vector-store.js'

export interface ChromaStoreOptions {
  url?: string
  authToken?: string
  prefix?: string
}

export class ChromaVectorStore implements VectorStore {
  private client: ChromaClient
  private prefix: string
  private notesCol: Collection | null = null
  private codeCol: Collection | null = null
  private symbolsCol: Collection | null = null

  constructor(options?: ChromaStoreOptions) {
    this.prefix = options?.prefix ?? 'elara'
    const u = new URL(options?.url ?? 'http://localhost:8000')
    const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80
    this.client = new ChromaClient({
      ssl: u.protocol === 'https:',
      host: u.hostname,
      port,
      auth: options?.authToken
        ? {
            provider: 'token',
            credentials: options.authToken,
            tokenHeaderType: 'AUTHORIZATION',
          }
        : undefined,
    })
  }

  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.notesCol && this.codeCol && this.symbolsCol) return
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const spaceConfig = { 'hnsw:space': 'cosine' }

        this.notesCol = await this.client.getOrCreateCollection({
          name: `${this.prefix}_notes`,
          metadata: spaceConfig,
          embeddingFunction: null as unknown as undefined,
        })

        this.codeCol = await this.client.getOrCreateCollection({
          name: `${this.prefix}_code_files`,
          metadata: spaceConfig,
          embeddingFunction: null as unknown as undefined,
        })

        this.symbolsCol = await this.client.getOrCreateCollection({
          name: `${this.prefix}_symbols`,
          metadata: spaceConfig,
          embeddingFunction: null as unknown as undefined,
        })
      })()
    }
    await this.initPromise
  }

  private async getNotes(): Promise<Collection> {
    if (!this.notesCol) await this.init()
    return this.notesCol!
  }

  private async getCode(): Promise<Collection> {
    if (!this.codeCol) await this.init()
    return this.codeCol!
  }

  private async getSymbols(): Promise<Collection> {
    if (!this.symbolsCol) await this.init()
    return this.symbolsCol!
  }

  async upsertNote(id: string, embedding: number[], meta: NoteVectorMeta, doc?: string): Promise<void> {
    const notes = await this.getNotes()
    await notes.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [meta as unknown as Metadata],
      documents: [doc ?? ''],
    })
  }

  async deleteNote(id: string): Promise<void> {
    const notes = await this.getNotes()
    await notes.delete({ ids: [id] })
  }

  async deleteNotesByVault(vaultId: string): Promise<void> {
    const notes = await this.getNotes()
    await notes.delete({ where: { vaultId: { $eq: vaultId } } })
  }

  async upsertFile(id: string, embedding: number[], meta: FileVectorMeta, doc?: string): Promise<void> {
    const code = await this.getCode()
    await code.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [meta as unknown as Metadata],
      documents: [doc ?? ''],
    })
  }

  async deleteFile(id: string): Promise<void> {
    const code = await this.getCode()
    await code.delete({ ids: [id] })
  }

  async deleteFilesByRepository(repositoryId: string): Promise<void> {
    const code = await this.getCode()
    await code.delete({ where: { repositoryId: { $eq: repositoryId } } })
  }

  async upsertSymbols(
    symbols: Array<{ id: string; embedding: number[]; meta: SymbolVectorMeta; snippet?: string }>,
  ): Promise<void> {
    if (symbols.length === 0) return
    const syms = await this.getSymbols()
    await syms.upsert({
      ids: symbols.map((s) => s.id),
      embeddings: symbols.map((s) => s.embedding),
      metadatas: symbols.map((s) => s.meta as unknown as Metadata),
      documents: symbols.map((s) => s.snippet ?? s.meta.name),
    })
  }

  async deleteSymbols(symbolIds: string[]): Promise<void> {
    if (symbolIds.length === 0) return
    const syms = await this.getSymbols()
    await syms.delete({ ids: symbolIds })
  }

  async deleteSymbolsByRepository(repositoryId: string): Promise<void> {
    const syms = await this.getSymbols()
    await syms.delete({ where: { repositoryId: { $eq: repositoryId } } })
  }

  async queryNotes(
    embedding: number[],
    vaultIds: string[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<VectorSearchResult[]> {
    if (vaultIds.length === 0 || limit <= 0) return []

    const whereClauses: Where[] = []
    if (vaultIds.length === 1 && vaultIds[0]) {
      whereClauses.push({ vaultId: { $eq: vaultIds[0] } })
    } else {
      whereClauses.push({ vaultId: { $in: vaultIds } })
    }

    if (filter && typeof filter.type === 'string') {
      whereClauses.push({ type: { $eq: filter.type } })
    }

    const where: Where | undefined =
      whereClauses.length === 1 ? whereClauses[0] : whereClauses.length > 1 ? { $and: whereClauses } : undefined

    const notes = await this.getNotes()
    const res = await notes.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where,
    })

    const ids = res.ids[0] ?? []
    const distances = res.distances?.[0] ?? []
    const metadatas = res.metadatas?.[0] ?? []
    const documents = res.documents?.[0] ?? []

    const results: VectorSearchResult[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const meta = metadatas[i] as unknown as NoteVectorMeta | undefined
      const dist = distances[i] ?? 1
      const doc = documents[i] ?? ''
      const similarity = Math.max(0, 1 - dist)

      results.push({
        id,
        containerId: meta?.vaultId ?? '',
        path: meta?.path ?? '',
        score: similarity,
        snippet: doc ? doc.slice(0, 200) : undefined,
      })
    }
    return results
  }

  async queryFiles(
    embedding: number[],
    repositoryIds: string[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    if (repositoryIds.length === 0 || limit <= 0) return []

    const firstRepId = repositoryIds[0]
    if (!firstRepId) return []

    const where: Where =
      repositoryIds.length === 1
        ? { repositoryId: { $eq: firstRepId } }
        : { repositoryId: { $in: repositoryIds } }

    const code = await this.getCode()
    const res = await code.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where,
    })

    const ids = res.ids[0] ?? []
    const distances = res.distances?.[0] ?? []
    const metadatas = res.metadatas?.[0] ?? []
    const documents = res.documents?.[0] ?? []

    const results: VectorSearchResult[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const meta = metadatas[i] as unknown as FileVectorMeta | undefined
      const dist = distances[i] ?? 1
      const doc = documents[i] ?? ''
      const similarity = Math.max(0, 1 - dist)

      results.push({
        id,
        containerId: meta?.repositoryId ?? '',
        path: meta?.path ?? '',
        score: similarity,
        snippet: doc ? doc.slice(0, 200) : undefined,
      })
    }
    return results
  }

  async querySymbols(
    embedding: number[],
    repositoryIds: string[],
    limit: number,
    kind?: string,
  ): Promise<SymbolVectorResult[]> {
    if (repositoryIds.length === 0 || limit <= 0) return []

    const whereClauses: Where[] = []
    if (repositoryIds.length === 1 && repositoryIds[0]) {
      whereClauses.push({ repositoryId: { $eq: repositoryIds[0] } })
    } else {
      whereClauses.push({ repositoryId: { $in: repositoryIds } })
    }

    if (kind) {
      whereClauses.push({ kind: { $eq: kind } })
    }

    const where: Where | undefined =
      whereClauses.length === 1 ? whereClauses[0] : whereClauses.length > 1 ? { $and: whereClauses } : undefined

    const syms = await this.getSymbols()
    const res = await syms.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where,
    })

    const ids = res.ids[0] ?? []
    const distances = res.distances?.[0] ?? []
    const metadatas = res.metadatas?.[0] ?? []
    const documents = res.documents?.[0] ?? []

    const results: SymbolVectorResult[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!
      const meta = metadatas[i] as unknown as SymbolVectorMeta | undefined
      const dist = distances[i] ?? 1
      const doc = documents[i] ?? ''
      const similarity = Math.max(0, 1 - dist)

      results.push({
        id,
        containerId: meta?.repositoryId ?? '',
        fileId: meta?.fileId ?? '',
        path: meta?.path ?? '',
        name: meta?.name ?? '',
        kind: meta?.kind ?? '',
        startLine: meta?.startLine ?? 0,
        endLine: meta?.endLine ?? 0,
        score: similarity,
        snippet: doc || undefined,
      })
    }
    return results
  }

  async knn(
    embedding: number[],
    excludeType: 'note' | 'code',
    excludeId: string,
    limit: number,
  ): Promise<NeighborResult[]> {
    const fetchLimit = limit + 1
    const [notesCol, codeCol] = await Promise.all([this.getNotes(), this.getCode()])
    const [notesRes, codeRes] = await Promise.all([
      notesCol.query({ queryEmbeddings: [embedding], nResults: fetchLimit }),
      codeCol.query({ queryEmbeddings: [embedding], nResults: fetchLimit }),
    ])

    const neighbors: NeighborResult[] = []

    const noteIds = notesRes.ids[0] ?? []
    const noteDists = notesRes.distances?.[0] ?? []
    for (let i = 0; i < noteIds.length; i++) {
      const id = noteIds[i]!
      if (excludeType === 'note' && id === excludeId) continue
      const dist = noteDists[i] ?? 1
      neighbors.push({
        type: 'note',
        id,
        similarity: Math.max(0, 1 - dist),
      })
    }

    const codeIds = codeRes.ids[0] ?? []
    const codeDists = codeRes.distances?.[0] ?? []
    for (let i = 0; i < codeIds.length; i++) {
      const id = codeIds[i]!
      if (excludeType === 'code' && id === excludeId) continue
      const dist = codeDists[i] ?? 1
      neighbors.push({
        type: 'code',
        id,
        similarity: Math.max(0, 1 - dist),
      })
    }

    neighbors.sort((a, b) => b.similarity - a.similarity)
    return neighbors.slice(0, limit)
  }
}
