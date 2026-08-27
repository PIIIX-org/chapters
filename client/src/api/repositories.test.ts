import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import {
  createRepository,
  createSyncToken,
  getRepositoryFileContent,
  gitHubFileUrl,
  listRepositoryFiles,
  syncHealth,
} from './repositories'
import type { Repository } from './repositories'

const gitRepo: Pick<Repository, 'ingestionMethod' | 'gitUrl' | 'defaultBranch'> = {
  ingestionMethod: 'git',
  gitUrl: 'https://github.com/PIIIX-org/chapters.git',
  defaultBranch: 'dev',
}

describe('repositories api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listRepositoryFiles GETs the metadata route, not the content one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listRepositoryFiles('r1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repositories/r1/files',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('getRepositoryFileContent sends the full path as an encoded query param', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { path: 'src/a b.ts', content: 'x', symbols: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await getRepositoryFileContent('r1', 'src/deep/a b.ts')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repositories/r1/files/content?path=src%2Fdeep%2Fa%20b.ts',
      expect.anything(),
    )
  })

  it('createRepository POSTs only the fields of the chosen ingestion method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'r1' }))
    vi.stubGlobal('fetch', fetchMock)

    await createRepository({ name: 'chapters', ingestionMethod: 'agent_push' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/repositories')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'chapters', ingestionMethod: 'agent_push' })
  })

  it('createSyncToken POSTs with no body, so Fastify does not reject an empty JSON declaration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { token: 'raw' }))
    vi.stubGlobal('fetch', fetchMock)

    await createSyncToken('r1')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/repositories/r1/sync-tokens')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})

describe('gitHubFileUrl', () => {
  it('builds a blob link at the default branch for an https remote', () => {
    expect(gitHubFileUrl(gitRepo, 'server/src/app.ts')).toBe(
      'https://github.com/PIIIX-org/chapters/blob/dev/server/src/app.ts',
    )
  })

  it('handles the ssh remote form', () => {
    expect(gitHubFileUrl({ ...gitRepo, gitUrl: 'git@github.com:PIIIX-org/chapters.git' }, 'a.ts')).toBe(
      'https://github.com/PIIIX-org/chapters/blob/dev/a.ts',
    )
  })

  it('falls back to HEAD when the repository has not synced a default branch yet', () => {
    expect(gitHubFileUrl({ ...gitRepo, defaultBranch: null }, 'a.ts')).toBe(
      'https://github.com/PIIIX-org/chapters/blob/HEAD/a.ts',
    )
  })

  it('returns null for local_path and agent_push — neither has a URL to link to', () => {
    expect(gitHubFileUrl({ ingestionMethod: 'local_path', gitUrl: null, defaultBranch: null }, 'a.ts')).toBeNull()
    expect(gitHubFileUrl({ ingestionMethod: 'agent_push', gitUrl: null, defaultBranch: null }, 'a.ts')).toBeNull()
  })

  it('keys off the ingestion method, not a leftover gitUrl', () => {
    // A non-git repository carrying a git URL must still get no link — the
    // spec's rule is "git-sourced only", and a null gitUrl is incidental.
    expect(gitHubFileUrl({ ...gitRepo, ingestionMethod: 'local_path' }, 'a.ts')).toBeNull()
  })

  it('returns null for a non-GitHub host rather than guessing its blob path', () => {
    expect(gitHubFileUrl({ ...gitRepo, gitUrl: 'https://gitlab.com/o/r.git' }, 'a.ts')).toBeNull()
  })
})

describe('syncHealth', () => {
  it('separates never-synced from synced-and-empty', () => {
    expect(syncHealth({ syncStatus: 'idle', lastSyncedAt: null }, 0)).toBe('never-synced')
    expect(syncHealth({ syncStatus: 'idle', lastSyncedAt: '2026-08-25T00:00:00Z' }, 0)).toBe('synced-empty')
  })

  it('reports a healthy sync when files are indexed', () => {
    expect(syncHealth({ syncStatus: 'idle', lastSyncedAt: '2026-08-25T00:00:00Z' }, 12)).toBe('synced')
  })

  it('reports an unknown file count as synced, never as empty', () => {
    expect(syncHealth({ syncStatus: 'idle', lastSyncedAt: '2026-08-25T00:00:00Z' })).toBe('synced')
  })

  it('lets an in-flight or failed sync win over the last-synced timestamp', () => {
    expect(syncHealth({ syncStatus: 'syncing', lastSyncedAt: '2026-08-25T00:00:00Z' }, 12)).toBe('syncing')
    expect(syncHealth({ syncStatus: 'error', lastSyncedAt: '2026-08-25T00:00:00Z' }, 12)).toBe('error')
  })
})
