import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { repositories, repositoryShares, teamMemberships, teams, users } from '../src/db/schema.js'
import {
  isSafeGitUrl,
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
  // A remote stored before #383 was fixed (or left unscrubbed for lack of an
  // encryption key): the token is in the row, and must reach nobody.
  const CREDENTIALED_URL = 'https://chapters:ghp_not_a_real_token@github.com/piiix-org/chapters.git'
  const CLEAN_URL = 'https://github.com/piiix-org/chapters.git'
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

  it('serves the connection config to the owner, minus any credential in the remote', async () => {
    const { owner, git, local } = await ownerAndViewerRepos()
    const listed = await listAccessibleRepositories(owner.id)
    const listedGit = listed.find((r) => r.id === git.id)!
    const listedLocal = listed.find((r) => r.id === local.id)!

    expect(listedGit.access).toBe('owner')
    // #383: owners got the token back here, and an owner-scoped MCP
    // connection with it, so the owner tier is no exception.
    expect(listedGit.gitUrl).toBe(CLEAN_URL)
    expect(JSON.stringify(listed)).not.toContain('ghp_not_a_real_token')
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
   * must agree, and neither may carry the credential.
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
    expect(asOwner.gitUrl).not.toContain('@')
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

  // #593: a token can sit outside the userinfo. A query value is served to
  // viewers by the deep-link URL and to everyone by the sync error, and an
  // ssh:// password came back to the owner in `gitUrl`.
  it('serves no query-string token and no ssh password, to the owner or a viewer', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const queryUrl = 'https://gitlab.example.com/acme/r.git?private_token=glpat-query-token-593#access_token=frag-token-593'
    const [query] = await db
      .insert(repositories)
      .values({
        name: 'query-token',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: queryUrl,
        lastSyncError: `fatal: unable to access '${queryUrl}/': The requested URL returned error: 403`,
      })
      .returning()
    const sshUrl = 'ssh://git:ssh-password-593@git.example.com/acme/r.git'
    const [ssh] = await db
      .insert(repositories)
      .values({
        name: 'ssh-password',
        ownerId: owner.id,
        ingestionMethod: 'git',
        gitUrl: sshUrl,
        lastSyncError: `fatal: could not read from '${sshUrl}': ssh-password-593 rejected`,
      })
      .returning()
    for (const repo of [query!, ssh!]) {
      await db
        .insert(repositoryShares)
        .values({ repositoryId: repo.id, granteeType: 'user', granteeId: viewer.id })
    }

    const asOwner = await listAccessibleRepositories(owner.id)
    const asViewer = await listAccessibleRepositories(viewer.id)
    for (const listed of [asOwner, asViewer]) {
      const served = JSON.stringify(listed.filter((r) => r.id === query!.id || r.id === ssh!.id))
      expect(served).toContain('query-token')
      expect(served).not.toContain('glpat-query-token-593')
      expect(served).not.toContain('ssh-password-593')
      expect(served).not.toContain('frag-token-593')
    }
    // The deep link needs host and path only; the owner keeps the parameter
    // names of the remote they configured.
    expect(asViewer.find((r) => r.id === query!.id)!.gitUrl).toBe('https://gitlab.example.com/acme/r.git')
    expect(asOwner.find((r) => r.id === query!.id)!.gitUrl).toBe(
      'https://gitlab.example.com/acme/r.git?private_token=***#access_token=***',
    )
    expect(asOwner.find((r) => r.id === ssh!.id)!.gitUrl).toBe('ssh://git.example.com/acme/r.git')
  })

  // Review of #643: rows with an invalid percent sequence in the password were
  // accepted and stored; decoding it threw, so listing them failed for the
  // owner and every viewer.
  it('lists remotes whose password holds an invalid percent sequence, ssh and https, without the password', async () => {
    const owner = await createActiveUser()
    const viewer = await createActiveUser()
    const remotes = [
      ['ssh://git:%zz-ssh-pw@git.example.com/acme/r.git', '%zz-ssh-pw'],
      ['https://user:50%off-https-pw@git.example.com/acme/r.git', '50%off-https-pw'],
    ] as const
    const ids: string[] = []
    for (const [url, password] of remotes) {
      const [row] = await db
        .insert(repositories)
        .values({
          name: 'bad-percent',
          ownerId: owner.id,
          ingestionMethod: 'git',
          gitUrl: url,
          lastSyncError: `fatal: unable to access '${url}/': ${password} rejected`,
        })
        .returning()
      ids.push(row!.id)
      await db.insert(repositoryShares).values({ repositoryId: row!.id, granteeType: 'user', granteeId: viewer.id })
    }

    for (const user of [owner, viewer]) {
      const listed = (await listAccessibleRepositories(user.id)).filter((r) => ids.includes(r.id))
      expect(listed).toHaveLength(2)
      const served = JSON.stringify(listed)
      expect(served).toContain('unable to access')
      expect(served).not.toContain('ssh-pw')
      expect(served).not.toContain('https-pw')
    }
    const asOwner = await listAccessibleRepositories(owner.id)
    expect(ids.map((id) => asOwner.find((r) => r.id === id)!.gitUrl)).toEqual([
      'ssh://git.example.com/acme/r.git',
      'https://git.example.com/acme/r.git',
    ])
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
    // the owner into the viewer tier, nor list the repository twice.
    const own = listed.filter((r) => r.id === repo!.id)
    expect(own).toHaveLength(1)
    expect(own[0]!.access).toBe('owner')
    expect(own[0]!.gitUrl).toBe(CLEAN_URL)
  })
})

describe('isSafeGitUrl (SEC-03 SSRF & Git Argument Injection prevention)', () => {
  it('rejects argument injection starting with leading dash', () => {
    expect(isSafeGitUrl('--upload-pack=evil')).toBe(false)
    expect(isSafeGitUrl('-u')).toBe(false)
    expect(isSafeGitUrl('  --config=core.sshCommand=evil')).toBe(false)
  })

  it('rejects control characters and newlines', () => {
    expect(isSafeGitUrl('https://github.com/org/repo.git\r\n')).toBe(false)
    expect(isSafeGitUrl('https://github.com/org/repo.git\0evil')).toBe(false)
  })

  it('rejects cloud metadata endpoints', () => {
    expect(isSafeGitUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isSafeGitUrl('https://169.254.169.254/secret.git')).toBe(false)
    expect(isSafeGitUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(false)
  })

  it('accepts legitimate https and ssh/scp git URLs', () => {
    expect(isSafeGitUrl('https://github.com/piiix-org/chapters.git')).toBe(true)
    expect(isSafeGitUrl('https://gitlab.com/group/project.git')).toBe(true)
    expect(isSafeGitUrl('git@github.com:piiix-org/chapters.git')).toBe(true)
    expect(isSafeGitUrl('ssh://git@github.com/piiix-org/chapters.git')).toBe(true)
  })
})
