import { apiFetch } from '../lib/api.js'

export interface ExportLink {
  id: string
  token: string
  expiresAt: string
}

/**
 * The zip endpoint itself is NOT called through here — it is a byte stream,
 * not JSON, and apiFetch's res.json() would throw on it. Trigger it with a
 * plain <a href={exportDownloadUrl(id)} download> instead; this export names
 * the URL for that anchor so it isn't hand-built in two places.
 */
export function exportDownloadUrl(vaultId: string): string {
  return `/api/vaults/${vaultId}/export`
}

export function createExportLink(vaultId: string): Promise<ExportLink> {
  return apiFetch(`/vaults/${vaultId}/export-links`, { method: 'POST' })
}

export function revokeExportLink(vaultId: string, linkId: string): Promise<{ status: 'revoked' }> {
  return apiFetch(`/vaults/${vaultId}/export-links/${linkId}`, { method: 'DELETE' })
}
