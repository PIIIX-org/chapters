export interface NoteVectorMeta {
  vaultId: string
  path: string
  type: string
  updatedAt?: string
}

export interface FileVectorMeta {
  repositoryId: string
  path: string
  language: string | null
}

export interface SymbolVectorMeta {
  fileId: string
  repositoryId: string
  name: string
  kind: string
  path: string
  startLine: number
  endLine: number
}

export interface VectorSearchResult {
  id: string
  containerId: string
  path: string
  score: number
  snippet?: string
}

export interface SymbolVectorResult extends VectorSearchResult {
  name: string
  kind: string
  startLine: number
  endLine: number
  fileId: string
}

export interface NeighborResult {
  type: 'note' | 'code'
  id: string
  similarity: number
}

export interface VectorStore {
  init(): Promise<void>
  close?(): Promise<void>

  upsertNote(id: string, embedding: number[], meta: NoteVectorMeta, doc?: string): Promise<void>
  deleteNote(id: string): Promise<void>
  deleteNotesByVault(vaultId: string): Promise<void>

  upsertFile(id: string, embedding: number[], meta: FileVectorMeta, doc?: string): Promise<void>
  deleteFile(id: string): Promise<void>
  deleteFilesByRepository(repositoryId: string): Promise<void>

  upsertSymbols(symbols: Array<{ id: string; embedding: number[]; meta: SymbolVectorMeta; snippet?: string }>): Promise<void>
  deleteSymbols(symbolIds: string[]): Promise<void>
  deleteSymbolsByRepository(repositoryId: string): Promise<void>

  queryNotes(embedding: number[], vaultIds: string[], limit: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]>
  queryFiles(embedding: number[], repositoryIds: string[], limit: number): Promise<VectorSearchResult[]>
  querySymbols(embedding: number[], repositoryIds: string[], limit: number, kind?: string): Promise<SymbolVectorResult[]>

  knn(embedding: number[], excludeType: 'note' | 'code', excludeId: string, limit: number): Promise<NeighborResult[]>
}
