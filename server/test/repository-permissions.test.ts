import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryShares, teamMemberships, teams, users } from '../src/db/schema.js'
import {
  listAccessibleRepositories,
  resolveRepositoryAccess,
} from '../src/repositories/permissions.js'
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

/**
 * `listAccessibleRepositories` is the one shape a viewer ever sees — the list
 * route serves it verbatim and so does the `list_repositories` MCP tool — so
 * this is where the owner/viewer field split has to hold. Every case here runs
 * an owner *and* a viewer against the same rows: a fixture with only an owner
 * is what let a shared mapper hand out `gitUrl` and `localPath` unnoticed.
 */
describe('listAccessibleRepositories field visibility', () => {
  const CREDENTIALED_URL = 'https://chapters:ghp_not_a_real_token@github.com/piiix-org/chapters.git'
  const FOLDER = '/srv/chapters-repos/notes'

  async function ownerAndViewerRepos() {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    // Two rows, one per owner-tier field: redacting only `gitUrl` (or only
    // `localPath`) still fails this fixture.
    const [git] = await db
      .insert(repositories)
      .values({
        name: 'remote',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: CREDENTIALED_URL,
        defaultBranch: 'dev',
      })
      .returning()
    const [local] = await db
      .insert(repositories)
      .values({
        name: 'folder',
        ownerId: owner.id,
        ingestionMethod: 'local_path',
        localPath: FOLDER,
      })
      .returning()
    for (const repo of [git!, local!]) {
      await db.insert(repositoryShares).values({
        repositoryId: repo.id,
        granteeType: 'user',
        granteeId: viewer.id,
      })
    }
    return { owner, viewer, git: git!, local: local! }
  }

  it('serves the connection config to the owner', async () => {
    const { owner, git, local } = await ownerAndViewerRepos()
    const listed = await listAccessibleRepositories(owner.id)
    const listedGit = listed.find((r) => r.id === git.id)!
    const listedLocal = listed.find((r) => r.id === local.id)!

    expect(listedGit.access).toBe('owner')
    expect(listedGit.gitUrl).toBe(CREDENTIALED_URL)
    expect(listedLocal.access).toBe('owner')
    expect(listedLocal.localPath).toBe(FOLDER)
  })

  it('strips the credential from a viewer’s remote and hides localPath entirely', async () => {
    const { viewer, git, local } = await ownerAndViewerRepos()
    const listed = await listAccessibleRepositories(viewer.id)
    const listedGit = listed.find((r) => r.id === git.id)!
    const listedLocal = listed.find((r) => r.id === local.id)!

    expect(listedGit.access).toBe('viewer')
    // The credential in the remote's userinfo is the reason this matters…
    expect(JSON.stringify(listed)).not.toContain('ghp_not_a_real_token')
    expect(JSON.stringify(listed)).not.toContain('/srv/chapters-repos')
    // …but host, owner and name are not secret, and are the whole input to
    // "Open on GitHub". Redacting them to null took the link away from every
    // viewer of a git repository.
    expect(listedGit.gitUrl).toBe('https://github.com/piiix-org/chapters.git')
    // Null, not absent: the client reads a missing key as a bug and `null` as
    // "there is nothing to deep-link to".
    expect(listedLocal).toHaveProperty('localPath')
    expect(listedLocal.localPath).toBeNull()
    // A folder repository has no remote either way — nothing to link to.
    expect(listedLocal.gitUrl).toBeNull()

    // A viewer still needs everything it takes to read the code and judge how
    // fresh the index is.
    expect(listedGit.name).toBe('remote')
    expect(listedGit.ingestionMethod).toBe('git')
    expect(listedGit.defaultBranch).toBe('dev')
  })

  /**
   * Owner and viewer on one row, asserted against each other: the fields the
   * deep link is built from (`ingestionMethod`, host/owner/name, `defaultBranch`)
   * must agree, and only the credentialed original and the server's own path
   * may differ.
   */
  it('gives an owner and a viewer of one git repository the same deep-link inputs', async () => {
    const { owner, viewer, git } = await ownerAndViewerRepos()
    const asOwner = (await listAccessibleRepositories(owner.id)).find((r) => r.id === git.id)!
    const asViewer = (await listAccessibleRepositories(viewer.id)).find((r) => r.id === git.id)!

    expect(asOwner.ingestionMethod).toBe(asViewer.ingestionMethod)
    expect(asOwner.defaultBranch).toBe(asViewer.defaultBranch)
    // Same GitHub owner/repo — this is what `gitHubFileUrl` parses out.
    const ownerRepo = (url: string) => /github\.com[/:](.+?)(?:\.git)?$/.exec(url)![1]
    expect(ownerRepo(asViewer.gitUrl!)).toBe(ownerRepo(asOwner.gitUrl!))
    // And only the two owner-tier fields differ.
    expect(asOwner.gitUrl).toBe(CREDENTIALED_URL)
    expect(asViewer.gitUrl).not.toBe(CREDENTIALED_URL)
    expect(asViewer.gitUrl).not.toContain('@')
  })

  it('sanitizes an scp-style remote and withholds one it cannot parse', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const [scp] = await db
      .insert(repositories)
      .values({
        name: 'scp',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: 'git@github.com:piiix-org/chapters.git',
      })
      .returning()
    const [odd] = await db
      .insert(repositories)
      .values({
        name: 'odd',
        ownerId: owner.id,
        ingestionMethod: 'git',
        // Not a URL and not scp-style — a link built from it would be a guess.
        gitUrl: 'not a remote at all',
      })
      .returning()
    for (const repo of [scp!, odd!]) {
      await db
        .insert(repositoryShares)
        .values({ repositoryId: repo.id, granteeType: 'user', granteeId: viewer.id })
    }

    const listed = await listAccessibleRepositories(viewer.id)
    expect(listed.find((r) => r.id === scp!.id)!.gitUrl).toBe(
      'https://github.com/piiix-org/chapters.git',
    )
    expect(listed.find((r) => r.id === odd!.id)!.gitUrl).toBeNull()
  })

  it('keeps the owner an owner when the repository is also shared back to them', async () => {
    const owner = await createActiveUser()
    const [repo] = await db
      .insert(repositories)
      .values({
        name: 'self-shared',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: CREDENTIALED_URL,
      })
      .returning()
    await db.insert(repositoryShares).values({
      repositoryId: repo!.id,
      granteeType: 'user',
      granteeId: owner.id,
    })

    const listed = await listAccessibleRepositories(owner.id)
    // One row, and it is the owner's own view — a share row must not demote
    // the owner into the redacted branch, nor list the repository twice.
    expect(listed.filter((r) => r.id === repo!.id)).toHaveLength(1)
    expect(listed.find((r) => r.id === repo!.id)!.gitUrl).toBe(CREDENTIALED_URL)
  })
})
