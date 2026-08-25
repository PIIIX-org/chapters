import { ApiError } from '../lib/api.js'

/**
 * Import **always creates a new vault** — it never merges into an existing one
 * (`export/routes.ts` inserts, per the export spec). The caller becomes its
 * owner.
 */
export interface ImportResult {
  vaultId: string
  imported: number
  skipped: number
  /**
   * Shares in the archive's manifest whose email matches no account here.
   * Those people simply do not get access, and nothing else says so — which is
   * why this is surfaced as loudly as the note count.
   */
  unmatchedShares: string[]
}

/**
 * multipart/form-data, so this does not go through `apiFetch`: setting a JSON
 * content-type would break the boundary, and the browser must set it itself.
 */
export async function importVault(file: File): Promise<ImportResult> {
  const body = new FormData()
  body.append('archive', file)
  const res = await fetch('/api/import', { method: 'POST', credentials: 'include', body })
  const parsed = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, parsed)
  return parsed as ImportResult
}
