import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import { teamMemberships, teams, users, vaults, vaultShares } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { resolveAccess } from '../src/vaults/permissions.js'
import { createActiveUser } from './helpers.js'

let app: FastifyInstance
beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})
afterAll(async () =>
  app.close())

async function makeVault(ownerId: string, name = 'v') {
  const [vault] = await db.insert(vaults).values({ name, ownerId }).returning()
  return vault!
}

describe('resolveAccess', () => {
  it('owner resolves as owner', async () => {
    const owner = await createActiveUser()
    const vault = await makeVault(owner.id)
    expect(await resolveAccess(owner.id, vault.id)).toBe('owner')
  })

  it('no relationship resolves as null', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const vault = await makeVault(owner.id)
    expect(await resolveAccess(stranger.id, vault.id)).toBeNull()
  })

  it('direct share grants its permission', async () => {
    const owner = await createActiveUser()
    const reader = await createActiveUser()
    const vault = await makeVault(owner.id)
    await db.insert(vaultShares).values({
      vaultId: vault.id,
      granteeType: 'user',
      granteeId: reader.id,
      permission: 'read',
    })
    expect(await resolveAccess(reader.id, vault.id)).toBe('read')
  })

  it('team share grants access to members; highest grant wins', async () => {
    const owner = await createActiveUser()
    const member = await createActiveUser()
    const vault = await makeVault(owner.id)
    const [team] = await db.insert(teams).values({ name: 't' }).returning()
    await db.insert(teamMemberships).values({ teamId: team!.id, userId: member.id })
    await db.insert(vaultShares).values({
      vaultId: vault.id,
      granteeType: 'team',
      granteeId: team!.id,
      permission: 'read',
    })
    expect(await resolveAccess(member.id, vault.id)).toBe('read')

    // A direct edit share outranks the team read share.
    await db.insert(vaultShares).values({
      vaultId: vault.id,
      granteeType: 'user',
      granteeId: member.id,
      permission: 'edit',
    })
    expect(await resolveAccess(member.id, vault.id)).toBe('edit')
  })

  it('deactivated users resolve null everywhere, even as owner', async () => {
    const owner = await createActiveUser()
    const vault = await makeVault(owner.id)
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.id, owner.id))
    expect(await resolveAccess(owner.id, vault.id)).toBeNull()
  })

  it('revoking a share revokes access immediately', async () => {
    const owner = await createActiveUser()
    const reader = await createActiveUser()
    const vault = await makeVault(owner.id)
    const [share] = await db
      .insert(vaultShares)
      .values({
        vaultId: vault.id,
        granteeType: 'user',
        granteeId: reader.id,
        permission: 'edit',
      })
      .returning()
    expect(await resolveAccess(reader.id, vault.id)).toBe('edit')
    await db.delete(vaultShares).where(eq(vaultShares.id, share!.id))
    expect(await resolveAccess(reader.id, vault.id)).toBeNull()
  })

  it('leaving a team revokes team-granted access', async () => {
    const owner = await createActiveUser()
    const member = await createActiveUser()
    const vault = await makeVault(owner.id)
    const [team] = await db.insert(teams).values({ name: 't2' }).returning()
    await db.insert(teamMemberships).values({ teamId: team!.id, userId: member.id })
    await db.insert(vaultShares).values({
      vaultId: vault.id,
      granteeType: 'team',
      granteeId: team!.id,
      permission: 'edit',
    })
    expect(await resolveAccess(member.id, vault.id)).toBe('edit')
    await db.delete(teamMemberships).where(eq(teamMemberships.userId, member.id))
    expect(await resolveAccess(member.id, vault.id)).toBeNull()
  })
})
