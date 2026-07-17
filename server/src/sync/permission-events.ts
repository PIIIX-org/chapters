import { EventEmitter } from 'node:events'

// ponytail: in-process bus; needs pg NOTIFY or similar if multi-process
export interface PermissionChange {
  /** Vaults whose access rules changed (share/transfer). */
  vaultIds?: string[]
  /** Users whose access anywhere may have changed (deactivation, membership). */
  userIds?: string[]
}

const bus = new EventEmitter()
bus.setMaxListeners(100)

export function emitPermissionChange(change: PermissionChange): void {
  bus.emit('change', change)
}

export function onPermissionChange(fn: (change: PermissionChange) => void): () => void {
  bus.on('change', fn)
  return () => bus.off('change', fn)
}

/** True if a connection identified by (userId, vaultId) is affected. */
export function affects(change: PermissionChange, userId: string, vaultId: string): boolean {
  if (change.userIds?.includes(userId)) return true
  if (change.vaultIds?.includes(vaultId)) return true
  return false
}
