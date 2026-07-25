import { apiFetch } from '../lib/api.js'

export interface SearchResult {
  resourceType: 'note' | 'code'
  id: string
  containerId: string
  path: string
  snippet: string
  score: number
}

export function search(query: string, limit = 20): Promise<SearchResult[]> {
  return apiFetch(`/search?q=${encodeURIComponent(query)}&limit=${limit}`)
}
