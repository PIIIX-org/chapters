import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryShares, teamMemberships, teams, users } from '../src/db/schema.js'
import { resolveRepositoryAccess } from '../src/repositories/permissions.js'
import { createActiveUser } from './helpers.js'

async function makeRepo(ownerId: string, name = 'repo') {
  const [repo] = await db
    .insert(repositories)
    .values({ name, ownerId, ingestionMethod: 'agent_push' })
    .returning()
  return repo!
}

describe('resolveRepositoryAccess', () => {
  it('owner resolves as owner', async () => {
    const owner = await createActiveUser()
    const repo = await makeRepo(owner.id)
    expect(await resolveRepositoryAccess(owner.id, repo.id)).toBe('owner')
  })

  it('no relationship resolves as null', async () => {
    const owner = await createActiveUser()
    const stranger = await createActiveUser()
    const repo = await makeRepo(owner.id)
    expect(await resolveRepositoryAccess(stranger.id, repo.id)).toBeNull()
  })

  it('direct share grants viewer', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const repo = await makeRepo(owner.id)
    await db.insert(repositoryShares).values({
      repositoryId: repo.id,
      granteeType: 'user',
      granteeId: viewer.id,
    })
    expect(await resolveRepositoryAccess(viewer.id, repo.id)).toBe('viewer')
  })

  it('team share grants viewer to members', async () => {
    const owner = await createActiveUser()
    const member = await createActiveUser()
    const repo = await makeRepo(owner.id)
    const [team] = await db.insert(teams).values({ name: 't' }).returning()
    await db.insert(teamMemberships).values({ teamId: team!.id, userId: member.id })
    await db.insert(repositoryShares).values({
      repositoryId: repo.id,
      granteeType: 'team',
      granteeId: team!.id,
    })
    expect(await resolveRepositoryAccess(member.id, repo.id)).toBe('viewer')
  })

  it('deactivated users resolve null everywhere, even as owner', async () => {
    const owner = await createActiveUser()
    const repo = await makeRepo(owner.id)
    await db.update(users).set({ status: 'deactivated' }).where(eq(users.id, owner.id))
    expect(await resolveRepositoryAccess(owner.id, repo.id)).toBeNull()
  })

  it('revoking a share revokes access immediately', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const repo = await makeRepo(owner.id)
    const [share] = await db
      .insert(repositoryShares)
      .values({ repositoryId: repo.id, granteeType: 'user', granteeId: viewer.id })
      .returning()
    expect(await resolveRepositoryAccess(viewer.id, repo.id)).toBe('viewer')
    await db.delete(repositoryShares).where(eq(repositoryShares.id, share!.id))
    expect(await resolveRepositoryAccess(viewer.id, repo.id)).toBeNull()
  })

  it('leaving a team revokes team-granted access immediately', async () => {
    const owner = await createActiveUser()
    const member = await createActiveUser()
    const repo = await makeRepo(owner.id)
    const [team] = await db.insert(teams).values({ name: 't2' }).returning()
    await db.insert(teamMemberships).values({ teamId: team!.id, userId: member.id })
    await db.insert(repositoryShares).values({
      repositoryId: repo.id,
      granteeType: 'team',
      granteeId: team!.id,
    })
    expect(await resolveRepositoryAccess(member.id, repo.id)).toBe('viewer')
    await db.delete(teamMemberships).where(eq(teamMemberships.userId, member.id))
    expect(await resolveRepositoryAccess(member.id, repo.id)).toBeNull()
  })
})
