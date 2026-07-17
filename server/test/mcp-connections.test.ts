import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { users } from '../src/db/schema.js'
import { resolveMcpToken } from '../src/vaults/mcp-connection-routes.js'
import { createActiveUser, loginCookie } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () => app.close())

describe('MCP connections', () => {
  it('issues a token once, resolves it live, and revocation stops it', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)

    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie },
      body: { name: 'assistant', scope: 'account' },
    })
    expect(created.statusCode).toBe(200)
    const { id, token } = created.json() as { id: string; token: string }
    expect(token).toBeTruthy()

    // Listing never exposes the token again.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/mcp-connections',
      headers: { cookie },
    })
    expect(JSON.stringify(listed.json())).not.toContain(token)

    expect((await resolveMcpToken(token))?.user.id).toBe(user.id)

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/mcp-connections/${id}/revoke`,
      headers: { cookie },
    })
    expect(revoke.statusCode).toBe(200)
    expect(await resolveMcpToken(token)).toBeNull()
  })

  it('vault-scoped creation requires current access to that vault', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const ownerCookie = await loginCookie(app, owner.email)
    const strangerCookie = await loginCookie(app, stranger.email)
    const vault = (
      await app.inject({
        method: 'POST',
        url: '/api/vaults',
        headers: { cookie: ownerCookie },
        body: { name: 'Scoped' },
      })
    ).json() as { id: string }

    const denied = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: strangerCookie },
      body: { name: 'probe', scope: 'vault', vaultId: vault.id },
    })
    expect(denied.statusCode).toBe(404)

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/mcp-connections',
      headers: { cookie: ownerCookie },
      body: { name: 'mine', scope: 'vault', vaultId: vault.id },
    })
    expect(allowed.statusCode).toBe(200)
  })

  it('deactivating the owner stops token resolution immediately', async () => {
    const user = await createActiveUser()
    const cookie = await loginCookie(app, user.email)
    const { token } = (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-connections',
        headers: { cookie },
        body: { name: 'assistant', scope: 'account' },
      })
    ).json() as { token: string }

    expect(await resolveMcpToken(token)).not.toBeNull()
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.id, user.id))
    expect(await resolveMcpToken(token)).toBeNull()
  })
})
