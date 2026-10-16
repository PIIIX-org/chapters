// Who may see a graph perspective (#550), shared by the REST routes and the
// MCP tools so the two never drift. A vault perspective needs edit access to
// its vault to be saved or deleted (callers check that with `resolveAccess`);
// a global perspective (no vault) is personal: listed to its creator and to
// instance admins, deleted only by its creator, created only by an admin.
import { and, eq, isNull, type SQL } from 'drizzle-orm'
import { graphPerspectives } from '../db/schema.js'

const INSTANCE_ADMIN_ROLES: Record<string, true> = { admin: true, superadmin: true, owner: true }

export function isInstanceAdmin(role: string): boolean {
  return INSTANCE_ADMIN_ROLES[role] === true
}

/** The global perspectives a user may list: their own, or every one for an instance admin. */
export function visibleGlobalPerspectives(user: { id: string; role: string }): SQL | undefined {
  return isInstanceAdmin(user.role)
    ? isNull(graphPerspectives.vaultId)
    : and(isNull(graphPerspectives.vaultId), eq(graphPerspectives.userId, user.id))
}
