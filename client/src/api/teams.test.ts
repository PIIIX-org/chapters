import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import { listTeamMembers, listTeams, listTeamStats } from './teams'

describe('teams api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listTeams calls GET /api/teams', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listTeams()

    expect(fetchMock).toHaveBeenCalledWith('/api/teams', expect.objectContaining({ credentials: 'include' }))
  })

  it('listTeamMembers calls GET /api/teams/:id/members', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listTeamMembers('t1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teams/t1/members',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('listTeamStats calls GET /api/teams/:id/stats', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, []))
    vi.stubGlobal('fetch', fetchMock)

    await listTeamStats('t1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teams/t1/stats',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
