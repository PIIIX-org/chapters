import { beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import { db } from '../src/db/client.js'
import { mcpConnections, repositories, vaults } from '../src/db/schema.js'
import { generateToken, hashToken } from '../src/auth/tokens.js'
import { buildInstanceBackup } from '../src/export/archive.js'
import { resolveMcpToken } from '../src/vaults/mcp-connection-routes.js'
import { createActiveUser, uniqueEmail, wipeInstance } from './helpers.js'

// #500: what the restore CLI says about MCP tokens must match what restore does with them.
// Each case spawns the CLI (a tsx start of about a second on a CI runner).
describe('restore-backup CLI: MCP tokens after restore', { timeout: 60_000 }, () => {
  beforeEach(wipeInstance)

  async function runRestore(archive: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'restore-tokens-'))
    try {
      const path = join(dir, 'backup.zip')
      await writeFile(path, archive)
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/scripts/restore-backup.ts', path], {
        cwd: join(import.meta.dirname, '..'),
        env: process.env,
      })
      return stdout
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('says MCP tokens keep working, and account, vault and repository tokens authenticate after restore', async () => {
    const owner = await createActiveUser()
    const [vault] = await db.insert(vaults).values({ name: 'Tokens', ownerId: owner.id }).returning()
    const [repo] = await db.insert(repositories).values({ name: 'tokens', ownerId: owner.id, ingestionMethod: 'agent_push' }).returning()
    const tokens = { account: generateToken(), vault: generateToken(), repository: generateToken() }
    await db.insert(mcpConnections).values([
      { userId: owner.id, name: 'a', scope: 'account', access: 'admin', tokenHash: hashToken(tokens.account) },
      { userId: owner.id, name: 'v', scope: 'vault', vaultId: vault!.id, access: 'write', tokenHash: hashToken(tokens.vault) },
      { userId: owner.id, name: 'r', scope: 'repository', repositoryId: repo!.id, access: 'write', tokenHash: hashToken(tokens.repository) },
    ])
    const archive = await buildInstanceBackup()
    await wipeInstance()

    const stdout = await runRestore(archive)
    expect(stdout).toMatch(/MCP tokens keep working/)
    expect(stdout).not.toMatch(/token\(s\) left out/)
    for (const token of Object.values(tokens)) expect((await resolveMcpToken(token))?.user.id).toBe(owner.id)
  })

  it('on a format-1 archive, names the repository tokens left out and says the rest keep working', async () => {
    const userId = randomUUID()
    const now = new Date().toISOString()
    const account = generateToken()
    const pinned = generateToken()
    const connection = (scope: 'account' | 'repository', token: string) => ({
      id: randomUUID(),
      userId,
      name: scope,
      scope,
      vaultId: null,
      repositoryId: scope === 'repository' ? randomUUID() : null,
      tokenHash: hashToken(token),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
    })
    const zip = new AdmZip()
    const dump = {
      users: [{ id: userId, email: uniqueEmail('tokens'), passwordHash: 'x', status: 'active', role: 'admin', emailVerifiedAt: now, createdAt: now }],
      teams: [],
      teamMemberships: [],
      vaults: [],
      vaultShares: [],
      mcpConnections: [connection('account', account), connection('repository', pinned)],
      securityEvents: [],
      notifications: [],
    }
    zip.addFile('account-dump.json', Buffer.from(JSON.stringify(dump), 'utf8'))

    const stdout = await runRestore(zip.toBuffer())
    expect(stdout).toMatch(/warning: 1 repository-scoped MCP token\(s\) left out/)
    expect(stdout).toMatch(/MCP tokens keep working/)
    expect((await resolveMcpToken(account))?.user.id).toBe(userId)
    expect(await resolveMcpToken(pinned)).toBeNull()
  })
})
