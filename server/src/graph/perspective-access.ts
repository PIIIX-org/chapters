// Who may see a graph perspective (#550), shared by the REST routes and the
// MCP tools so the two never drift. A vault perspective needs edit access to
// its vault to be saved or deleted (callers check that with `resolveAccess`);
// a global perspective (no vault) is personal: listed to and deleted by its
// creator only, and created only by an instance admin.
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { graphPerspectives } from '../db/schema.js'

const INSTANCE_ADMIN_ROLES: Record<string, true> = { admin: true, superadmin: true, owner: true }

export function isInstanceAdmin(role: string): boolean {
  return INSTANCE_ADMIN_ROLES[role] === true
}

/** The global perspectives a user may list: their own. */
export function visibleGlobalPerspectives(userId: string): SQL {
  // `and` of two defined conditions is never undefined; an undefined filter would list every perspective.
  return and(isNull(graphPerspectives.vaultId), eq(graphPerspectives.userId, userId))!
}
