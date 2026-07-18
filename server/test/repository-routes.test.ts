import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('repository CRUD + shares', () => {
  it('creates each ingestion-method shape and never echoes the credential back', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)

    const git = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: {
        name: 'Git repo',
        ingestionMethod: 'git',
        gitUrl: 'https://example.com/repo.git',
        gitCredential: 'ghp_secret',
      },
    })
    expect(git.statusCode).toBe(200)
    expect(git.body).not.toContain('ghp_secret')
    expect(git.json()).not.toHaveProperty('gitCredentialEncrypted')

    const push = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Push repo', ingestionMethod: 'agent_push' },
    })
    expect(push.statusCode).toBe(200)

    const missingGitUrl = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Bad', ingestionMethod: 'git' },
    })
    expect(missingGitUrl.statusCode).toBe(400)
  })

  it('rejects a local path outside the configured root', async () => {
    const owner = await createActiveUser()
    const cookie = await loginCookie(app, owner.email)
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'Escape', ingestionMethod: 'local_path', localPath: '../../etc' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('owner shares, grantee sees it, non-owner cannot manage shares', async () => {
    const owner = await createActiveUser()
    const grantee = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const granteeCookie = await loginCookie(app, grantee.email)

    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'Shared', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    let list = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access?: string }>
    expect(list.find((r) => r.id === repo.id)).toBeUndefined()

    const share = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/shares`,
      headers: { cookie: ownerCookie },
      body: { granteeType: 'user', granteeId: grantee.id },
    })
    expect(share.statusCode).toBe(200)

    list = (
      await app.inject({ method: 'GET', url: '/api/repositories', headers: { cookie: granteeCookie } })
    ).json() as Array<{ id: string; access: string }>
    expect(list.find((r) => r.id === repo.id)?.access).toBe('viewer')

    const reshare = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/shares`,
      headers: { cookie: granteeCookie },
      body: { granteeType: 'user', granteeId: owner.id },
    })
    expect(reshare.statusCode).toBe(404)
  })

  it('graph preference requires current access', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const repo = (
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        headers: { cookie: ownerCookie },
        body: { name: 'Private', ingestionMethod: 'agent_push' },
      })
    ).json() as { id: string }

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: strangerCookie },
      body: { include: true },
    })
    expect(denied.statusCode).toBe(404)

    const allowed = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repo.id}/graph-preference`,
      headers: { cookie: ownerCookie },
      body: { include: true },
    })
    expect(allowed.statusCode).toBe(200)
  })
})
