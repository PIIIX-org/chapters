import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { config } from '../src/config.js'
import { createActiveUser, loginCookie } from './helpers.js'
import { signS3Request, uploadS3Object, listS3Objects, deleteS3Object } from '../src/export/s3.js'
import {
  executeBackup,
  getBackupStatus,
  pruneLocalBackups,
  pruneS3Backups,
} from '../src/export/backup-service.js'

let app: FastifyInstance
let adminCookie: string
let regularCookie: string
const testBackupDir = join(process.cwd(), 'scratch/test-backups')

beforeAll(async () => {
  app = await buildApp()
  await app.ready()

  const admin = await createActiveUser({ role: 'admin' })
  const regular = await createActiveUser({ role: 'member' })
  adminCookie = await loginCookie(app, admin.email)
  regularCookie = await loginCookie(app, regular.email)

  await mkdir(testBackupDir, { recursive: true })
})

afterAll(async () => {
  await rm(testBackupDir, { recursive: true, force: true }).catch(() => {})
  await app.close()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  await rm(testBackupDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(testBackupDir, { recursive: true })
})

describe('S3 SigV4 Client', () => {
  const s3Config = {
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKIA_TEST_KEY',
    secretAccessKey: 'test_secret_key_12345',
  }

  it('generates valid AWS SigV4 authorization headers', () => {
    const fixedDate = new Date('2026-09-27T12:00:00.000Z')
    const { url, headers } = signS3Request(
      s3Config,
      'PUT',
      'chapters-backups/test.zip',
      {},
      Buffer.from('test data'),
      'application/zip',
      fixedDate,
    )

    expect(url).toContain('test-bucket/chapters-backups/test.zip')
    expect(headers['x-amz-date']).toBe('20260927T120000Z')
    expect(headers['content-type']).toBe('application/zip')
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA_TEST_KEY\/20260927\/us-east-1\/s3\/aws4_request/)
    expect(headers.authorization).toContain('SignedHeaders=')
    expect(headers.authorization).toContain('Signature=')
  })

  it('supports path-style and query parameters', () => {
    const fixedDate = new Date('2026-09-27T12:00:00.000Z')
    const { url } = signS3Request(
      { ...s3Config, forcePathStyle: true },
      'GET',
      '',
      { 'list-type': '2', prefix: 'backups/' },
      Buffer.alloc(0),
      undefined,
      fixedDate,
    )

    expect(url).toContain('/test-bucket?list-type=2&prefix=backups%2F')
  })

  it('parses S3 XML list response and deletes old objects', async () => {
    const xmlResponse = `
      <ListBucketResult>
        <Contents>
          <Key>chapters-backups/chapters-backup-2026-09-25.zip</Key>
          <LastModified>2026-09-25T12:00:00.000Z</LastModified>
        </Contents>
        <Contents>
          <Key>chapters-backups/chapters-backup-2026-09-26.zip</Key>
          <LastModified>2026-09-26T12:00:00.000Z</LastModified>
        </Contents>
        <Contents>
          <Key>chapters-backups/chapters-backup-2026-09-27.zip</Key>
          <LastModified>2026-09-27T12:00:00.000Z</LastModified>
        </Contents>
      </ListBucketResult>
    `

    const deletedKeys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletedKeys.push(url)
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return Promise.resolve(new Response(xmlResponse, { status: 200 }))
      }),
    )

    const pruned = await pruneS3Backups(s3Config, 'chapters-backups/', 2)
    expect(pruned).toBe(1)
    expect(deletedKeys.length).toBe(1)
    expect(deletedKeys[0]).toContain('chapters-backup-2026-09-25.zip')
  })

  it('performs S3 upload, list, and delete operations via fetch', async () => {
    let uploadedKey = ''
    let uploadedMethod = ''
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        uploadedKey = url
        uploadedMethod = init?.method ?? 'GET'
        if (uploadedMethod === 'GET') {
          return Promise.resolve(
            new Response(
              '<ListBucketResult><Contents><Key>backups/snap.zip</Key></Contents></ListBucketResult>',
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    )

    await uploadS3Object(s3Config, 'backups/snap.zip', Buffer.from('test'))
    expect(uploadedMethod).toBe('PUT')
    expect(uploadedKey).toContain('backups/snap.zip')

    const list = await listS3Objects(s3Config, 'backups/')
    expect(list.length).toBe(1)
    expect(list[0]?.key).toBe('backups/snap.zip')

    await deleteS3Object(s3Config, 'backups/snap.zip')
    expect(uploadedMethod).toBe('DELETE')
  })
})


describe('pruneLocalBackups', () => {
  it('prunes oldest backup files exceeding retention count', async () => {
    const filenames = [
      'chapters-backup-2026-09-21-00-00-00.zip',
      'chapters-backup-2026-09-22-00-00-00.zip',
      'chapters-backup-2026-09-23-00-00-00.zip',
      'chapters-backup-2026-09-24-00-00-00.zip',
      'chapters-backup-2026-09-25-00-00-00.zip',
    ]

    for (const name of filenames) {
      await writeFile(join(testBackupDir, name), 'dummy-zip')
    }

    const prunedCount = await pruneLocalBackups(testBackupDir, 3)
    expect(prunedCount).toBe(2)

    const remaining = await readdir(testBackupDir)
    expect(remaining.sort()).toEqual([
      'chapters-backup-2026-09-23-00-00-00.zip',
      'chapters-backup-2026-09-24-00-00-00.zip',
      'chapters-backup-2026-09-25-00-00-00.zip',
    ])
  })
})

describe('executeBackup & backup routes', () => {
  it('executes backup to configured local directory and creates valid zip', async () => {
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(testBackupDir)

    const result = await executeBackup()
    expect(result.destinations).toContain('local')
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.filename).toMatch(/^chapters-backup-.*\.zip$/)

    const files = await readdir(testBackupDir)
    expect(files).toContain(result.filename)

    // Verify it is a valid zip containing account dump
    const zip = new AdmZip(join(testBackupDir, result.filename))
    const entryNames = zip.getEntries().map((e) => e.entryName)
    expect(entryNames).toContain('account-dump.json')

    const status = getBackupStatus()
    expect(status.configured).toBe(true)
    expect(status.lastStatus).toBe('success')
    expect(status.lastFilename).toBe(result.filename)
  })

  it('GET /api/admin/backup/status is admin-only', async () => {
    const regularRes = await app.inject({
      method: 'GET',
      url: '/api/admin/backup/status',
      headers: { cookie: regularCookie },
    })
    expect(regularRes.statusCode).toBe(403)

    const adminRes = await app.inject({
      method: 'GET',
      url: '/api/admin/backup/status',
      headers: { cookie: adminCookie },
    })
    expect(adminRes.statusCode).toBe(200)
    const body = adminRes.json() as ReturnType<typeof getBackupStatus>
    expect(typeof body.retentionCount).toBe('number')
    expect(Array.isArray(body.destinations)).toBe(true)
  })

  it('POST /api/admin/backup/run triggers backup for admin only', async () => {
    vi.spyOn(config.backup, 'localPath', 'get').mockReturnValue(testBackupDir)

    const regularRes = await app.inject({
      method: 'POST',
      url: '/api/admin/backup/run',
      headers: { cookie: regularCookie },
    })
    expect(regularRes.statusCode).toBe(403)

    const adminRes = await app.inject({
      method: 'POST',
      url: '/api/admin/backup/run',
      headers: { cookie: adminCookie },
    })
    expect(adminRes.statusCode).toBe(200)
    const body = adminRes.json() as { success: boolean; result: { filename: string } }
    expect(body.success).toBe(true)
    expect(body.result.filename).toMatch(/^chapters-backup-.*\.zip$/)
  })
})
