import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { repositories } from '../src/db/schema.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

async function makeGitRepoWithWebhook() {
  const owner = await createActiveUser()
  const cookie = await loginCookie(app, owner.email)
  const repo = (
    await app.inject({
      method: 'POST',
      url: '/api/repositories',
      headers: { cookie },
      body: { name: 'webhook-test', ingestionMethod: 'git', gitUrl: 'file:///nonexistent.git' },
    })
  ).json() as { id: string }
  const { secret } = (
    await app.inject({
      method: 'POST',
      url: `/api/repositories/${repo.id}/webhook-secret`,
      headers: { cookie },
    })
  ).json() as { secret: string }
  return { repoId: repo.id, secret }
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('git webhook receiver', () => {
  it('accepts a correctly-signed payload and updates lastWebhookAt', async () => {
    const { repoId, secret } = await makeGitRepoWithWebhook()
    const body = JSON.stringify({ ref: 'refs/heads/main' })
    const res = await app.inject({
      method: 'POST',
      url: `/repositories/${repoId}/webhook`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)))[0]
    expect(repo?.lastWebhookAt).toBeTruthy()
  })

  it('rejects a wrong signature without updating lastWebhookAt', async () => {
    const { repoId, secret } = await makeGitRepoWithWebhook()
    void secret
    const body = JSON.stringify({ ref: 'refs/heads/main' })
    const res = await app.inject({
      method: 'POST',
      url: `/repositories/${repoId}/webhook`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=wrong' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
    const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)))[0]
    expect(repo?.lastWebhookAt).toBeNull()
  })

  it('rejects a missing signature header', async () => {
    const { repoId } = await makeGitRepoWithWebhook()
    const res = await app.inject({
      method: 'POST',
      url: `/repositories/${repoId}/webhook`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(res.statusCode).toBe(401)
  })
})
