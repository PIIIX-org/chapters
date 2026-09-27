import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'
import {
  listAssets,
  readAsset,
  sanitizeAssetFilename,
  saveAsset,
} from '../src/notes/store.js'

function multipartPayload(filename: string, contentType: string, data: Buffer) {
  const boundary = '----testboundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  }
}

let app: FastifyInstance
let ownerCookie: string
let readerCookie: string
let strangerCookie: string
let vaultId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const owner = await createActiveUser()
  const reader = await createActiveUser()
  const stranger = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  readerCookie = await loginCookie(app, reader.email)
  strangerCookie = await loginCookie(app, stranger.email)

  const vaultRes = await app.inject({
    method: 'POST',
    url: '/api/vaults',
    headers: { cookie: ownerCookie },
    body: { name: 'Assets Vault' },
  })
  vaultId = (vaultRes.json() as { id: string }).id

  await app.inject({
    method: 'POST',
    url: `/api/vaults/${vaultId}/shares`,
    headers: { cookie: ownerCookie },
    body: { granteeType: 'user', granteeId: reader.id, permission: 'read' },
  })
})

afterAll(async () => app.close())

describe('asset store functions', () => {
  it('sanitizes unsafe filenames and preserves valid extensions', () => {
    const safe1 = sanitizeAssetFilename('My Screenshot #1 (Draft)!.png')
    expect(safe1).toMatch(/^my-screenshot-1-draft-\d+-[a-f0-9]+\.png$/)

    const safe2 = sanitizeAssetFilename('../../etc/passwd')
    expect(safe2).not.toContain('..')
    expect(safe2).not.toContain('/')
  })

  it('saves an asset to disk and lists it', async () => {
    const buffer = Buffer.from('fake image content 12345')
    const saved = await saveAsset(vaultId, 'diagram.svg', buffer)

    expect(saved.fileName).toContain('.svg')
    expect(saved.mimeType).toBe('image/svg+xml')
    expect(saved.size).toBe(buffer.length)

    const readBack = await readAsset(vaultId, saved.fileName)
    expect(readBack).not.toBeNull()
    expect(readBack!.mimeType).toBe('image/svg+xml')
    expect(readBack!.buffer.toString('utf8')).toBe('fake image content 12345')

    const list = await listAssets(vaultId)
    expect(list.some((a) => a.fileName === saved.fileName)).toBe(true)
  })

  it('rejects path traversal in readAsset', async () => {
    const traverse1 = await readAsset(vaultId, '../secret.txt')
    expect(traverse1).toBeNull()

    const traverse2 = await readAsset(vaultId, '..\\secret.txt')
    expect(traverse2).toBeNull()

    const traverse3 = await readAsset(vaultId, 'sub/image.png')
    expect(traverse3).toBeNull()
  })
})

describe('asset API routes', () => {
  it('allows owner to upload an image and returns asset metadata', async () => {
    const { headers, payload } = multipartPayload(
      'architecture.svg',
      'image/svg+xml',
      Buffer.from('<svg></svg>'),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/assets`,
      headers: {
        cookie: ownerCookie,
        ...headers,
      },
      payload,
    })

    expect(res.statusCode).toBe(200)
    const json = res.json() as { fileName: string; url: string; path: string; size: number; mimeType: string }
    expect(json.fileName).toContain('.svg')
    expect(json.url).toBe(`/api/vaults/${vaultId}/assets/${json.fileName}`)
    expect(json.path).toBe(`assets/${json.fileName}`)
    expect(json.mimeType).toBe('image/svg+xml')
    expect(json.size).toBe(11)

    // Verify it is readable via GET endpoint
    const getRes = await app.inject({
      method: 'GET',
      url: json.url,
      headers: { cookie: ownerCookie },
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.headers['content-type']).toBe('image/svg+xml')
    expect(getRes.body).toBe('<svg></svg>')
  })

  it('allows reader to download an asset', async () => {
    const { headers, payload } = multipartPayload(
      'sample.png',
      'image/png',
      Buffer.from('reader-asset-data'),
    )

    const uploadRes = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/assets`,
      headers: {
        cookie: ownerCookie,
        ...headers,
      },
      payload,
    })
    const json = uploadRes.json() as { fileName: string; url: string }

    const getRes = await app.inject({
      method: 'GET',
      url: json.url,
      headers: { cookie: readerCookie },
    })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.headers['content-type']).toBe('image/png')
    expect(getRes.body).toBe('reader-asset-data')
  })

  it('denies reader from uploading an asset (needs edit permission)', async () => {
    const { headers, payload } = multipartPayload(
      'forbidden.png',
      'image/png',
      Buffer.from('unauthorized'),
    )

    const res = await app.inject({
      method: 'POST',
      url: `/api/vaults/${vaultId}/assets`,
      headers: {
        cookie: readerCookie,
        ...headers,
      },
      payload,
    })
    expect(res.statusCode).toBe(404)
  })

  it('denies stranger from accessing assets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/assets`,
      headers: { cookie: strangerCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('lists assets for readers and owners', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/vaults/${vaultId}/assets`,
      headers: { cookie: readerCookie },
    })
    expect(res.statusCode).toBe(200)
    const json = res.json() as { assets: { fileName: string; size: number }[] }
    expect(Array.isArray(json.assets)).toBe(true)
    expect(json.assets.length).toBeGreaterThan(0)
  })
})
