import { ApiError } from '../lib/api.js'

/** Why the import did not grant a share the archive's manifest lists. */
export type ShareSkipReason =
  | 'not_requested'
  | 'invalid_entry'
  | 'invalid_permission'
  | 'no_active_user'
  | 'importer'
  | 'no_team'
  | 'ambiguous_team'
  | 'duplicate'

/** One share from the archive's manifest and what the import did with it. */
export interface ShareOutcome {
  granteeType: string
  /** The user's email or the team's name. */
  grantee: string
  permission: string
  reason?: ShareSkipReason
}

/**
 * Import **always creates a new vault** — it never merges into an existing one
 * (`export/routes.ts` inserts, per the export spec). The caller becomes its
 * owner.
 */
export interface ImportResult {
  vaultId: string
  imported: number
  /**
   * One `"<path>: <reason>"` per note the OKF validator rejected — a list, not
   * a count. The reasons are the only place anything says why those notes did
   * not come through, so they are shown, not counted.
   */
  skipped: string[]
  /** Shares from the manifest the import granted. Empty unless `applyShares` was set. */
  appliedShares: ShareOutcome[]
  /**
   * Every manifest share that was not granted, with the reason. Without
   * `applyShares` that is all of them (`not_requested`): the archive alone
   * never gives anyone access (#621).
   */
  skippedShares: ShareOutcome[]
}

export interface ImportVaultInput {
  file: File
  /** Grant the archive's listed collaborators access again (existing active users and teams only). */
  applyShares: boolean
}

/**
 * multipart/form-data, so this does not go through `apiFetch`: setting a JSON
 * content-type would break the boundary, and the browser must set it itself.
 */
export async function importVault({ file, applyShares }: ImportVaultInput): Promise<ImportResult> {
  const body = new FormData()
  body.append('archive', file)
  const url = applyShares ? '/api/import?applyShares=true' : '/api/import'
  const res = await fetch(url, { method: 'POST', credentials: 'include', body })
  const parsed = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, parsed)
  return parsed as ImportResult
}
