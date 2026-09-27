import { apiFetch } from '../lib/api.js'

export interface UploadedAsset {
  fileName: string
  url: string
  path: string
  size: number
  mimeType: string
}

export interface AssetMeta {
  fileName: string
  size: number
  modifiedAt: string
}

export async function uploadAsset(
  vaultId: string,
  file: File | Blob,
  filename?: string,
): Promise<UploadedAsset> {
  const formData = new FormData()
  if (file instanceof File) {
    formData.append('file', file)
  } else {
    formData.append('file', file, filename || 'image.png')
  }

  const res = await fetch(`/api/vaults/${encodeURIComponent(vaultId)}/assets`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  })

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error((errorBody as { error?: string }).error || `Upload failed with status ${res.status}`)
  }

  return res.json() as Promise<UploadedAsset>
}

export async function listAssets(vaultId: string): Promise<{ assets: AssetMeta[] }> {
  return apiFetch<{ assets: AssetMeta[] }>(`/vaults/${encodeURIComponent(vaultId)}/assets`)
}
