import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { argsFingerprint, compareCodeUnits } from '../mcp/response.js'
import type { ToolCapability, ToolProfile } from '../mcp/server.js'
import { versionsKey } from '../repositories/extraction-queue.js'
import type { McpAuth } from '../vaults/mcp-connection-routes.js'

/**
 * The caching contract (ADR-004 §2.9, #680; backend-reference.md, "Caching
 * contract"). Every cache in Elara keys its entries with `cacheKey`, built
 * from epochs read with `readEpochs` before the answer's own queries, and
 * looks an entry up only after the call's live checks (token, capability,
 * scope, access) passed. Nothing is cached yet: #685 adds the first cache.
 */

/** The vaults and repositories an answer is computed over: the call's resolved set, `everywhere` expanded. */
export interface CacheResources {
  vaultIds: readonly string[]
  repositoryIds: readonly string[]
}

/**
 * Epochs as decimal strings (`bigint` columns): `permission` from
 * `instance_state.permission_epoch`, one index epoch per vault and
 * repository (`index_epochs`, migration 0041; 0 without a row). A resource
 * with no entry does not exist.
 */
export interface Epochs {
  permission: string
  vaults: Readonly<Record<string, string>>
  repositories: Readonly<Record<string, string>>
}

/** Who asks, as far as it can change an answer: the account and the token's scope, pin, access, profile and allow-list. */
export interface CacheCaller {
  userId: string
  scope: 'account' | `vault:${string}` | `repo:${string}`
  access: ToolCapability
  profile: ToolProfile
  /** Sorted; null: every tool the access level and profile allow. */
  allowedTools: readonly string[] | null
}

export function cacheCaller(auth: McpAuth): CacheCaller {
  const c = auth.connection
  return {
    userId: auth.user.id,
    scope: c.scope === 'vault' ? `vault:${c.vaultId}` : c.scope === 'repository' ? `repo:${c.repositoryId}` : 'account',
    access: c.access,
    profile: c.profile,
    allowedTools: c.allowedTools ? [...c.allowedTools].sort(compareCodeUnits) : null,
  }
}

/**
 * The epochs of `resources`, in one statement. Read them before the queries
 * of the answer they will key (or in its snapshot): a write that commits in
 * between then leaves a newer answer under the older key, never an older
 * answer under the newer one. Missing (deleted) resources are absent.
 */
export async function readEpochs(resources: CacheResources): Promise<Epochs> {
  const [row] = (await db.execute(sql`
    SELECT
      coalesce((SELECT permission_epoch::text FROM instance_state WHERE id = 'singleton'), '0') AS permission,
      (SELECT coalesce(jsonb_object_agg(v.id, coalesce(e.epoch, 0)::text), '{}'::jsonb) FROM vaults v
        LEFT JOIN index_epochs e ON e.scope = 'vault' AND e.scope_id = v.id
        WHERE v.id = ANY(${`{${resources.vaultIds.join(',')}}`}::uuid[])) AS vaults,
      (SELECT coalesce(jsonb_object_agg(r.id, coalesce(e.epoch, 0)::text), '{}'::jsonb) FROM repositories r
        LEFT JOIN index_epochs e ON e.scope = 'repository' AND e.scope_id = r.id
        WHERE r.id = ANY(${`{${resources.repositoryIds.join(',')}}`}::uuid[])) AS repositories`)) as unknown as [Epochs]
  return row
}

const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort(compareCodeUnits)

/**
 * The key of `tool`'s answer to `args` over `resources` for `caller`: the
 * sha256 (hex) of the tool, the caller, each resource with its index epoch,
 * the derived-artifact versions (`versionsKey`), the permission epoch and
 * the argument fingerprint (`argsFingerprint`, which
 * leaves out `cursor` and `budget_tokens`: an entry holds the whole result,
 * paged and budgeted per call). Null when `epochs` lacks a resource: the
 * answer is computed and not cached.
 */
export function cacheKey(
  tool: string,
  args: Record<string, unknown>,
  resources: CacheResources,
  epochs: Epochs,
  caller: CacheCaller,
): string | null {
  const vaultIds = sortedUnique(resources.vaultIds)
  const repositoryIds = sortedUnique(resources.repositoryIds)
  const vaults = vaultIds.map((id) => [id, epochs.vaults[id]])
  const repositories = repositoryIds.map((id) => [id, epochs.repositories[id]])
  if ([...vaults, ...repositories].some(([, epoch]) => epoch === undefined)) return null
  const record = [
    'v1',
    tool,
    caller.userId,
    caller.scope,
    caller.access,
    caller.profile,
    caller.allowedTools === null ? null : sortedUnique(caller.allowedTools),
    vaults,
    repositories,
    versionsKey(),
    epochs.permission,
    argsFingerprint(args, { vaultIds, repositoryIds }),
  ]
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}
