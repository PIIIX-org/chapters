import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import AdmZip from 'adm-zip'
import { eq, inArray } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { db } from '../src/db/client.js'
import {
  mcpConnections,
  notifications,
  repositories,
  repositoryShares,
  repositorySyncTokens,
  sessions,
  teamMemberships,
  teams,
  users,
  vaultShares,
} from '../src/db/schema.js'
import { encryptCredential } from '../src/repositories/credentials.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { syncGitRepository } from '../src/repositories/git-sync.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import { listRevisionMeta, softDeleteNote, updateNote } from '../src/notes/store.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { TEST_PASSWORD, createActiveUser, loginCookie } from './helpers.js'

/*
 * #577: every MCP tool and prompt, called against a world seeded with real
 * secrets, must return none of them. #383 served GitHub tokens embedded in
 * git URLs through `list_repositories` for 86 days because no test looked at
 * what tools return. The tool list comes from `tools/list`, so a new tool
 * fails this file until it has a fixture step below.
 */

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['userinfo in a URL', /:\/\/[^/@\s]+:[^/@\s]+@/g],
  // A bare token as the URL username (`https://glpat-…@host`); `ssh://git@` is too short to match.
  ['token as URL username', /:\/\/[^/@\s:]{20,}@/g],
  ['token in a URL query or fragment', /[?&#][\w-]*(?:token|key|secret|password)[\w-]*=[^&#\s'"*]/gi],
  ['GitHub token', /gh[opsu]_[A-Za-z0-9]{20,}/g],
  ['x-access-token', /x-access-token/g],
  ['PEM block', /-----BEGIN/g],
  ['sk- API key', /sk-[A-Za-z0-9]{20,}/g],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/g],
  ['argon2 hash', /\$argon2/g],
  ['bcrypt hash', /\$2b\$/g],
]

interface ScanContext {
  /** Exact values that must never come back, whoever wrote them where. */
  secrets: readonly string[]
  /**
   * Text a user wrote (note bodies, file contents). A user may paste anything
   * into a note and get it back; a pattern match inside such text is allowed.
   * Exact fixture secrets are never allowed, wherever they appear.
   */
  userAuthored: readonly string[]
}

/** How much text around a match the scanned string must share with a user text. */
const USER_TEXT_CONTEXT = 8

/**
 * True when the match at `start` in `s` is part of text a user wrote: `s`
 * carries the match together with at least `USER_TEXT_CONTEXT` characters
 * around it exactly as a user text does. The matched substring alone is not
 * enough (#593): a note mentioning `x-access-token` must not let the same
 * word through in a sync error or any other field.
 */
function fromUserText(s: string, start: number, match: string, userAuthored: readonly string[]): boolean {
  const end = start + match.length
  for (const text of userAuthored) {
    for (let at = text.indexOf(match); at !== -1; at = text.indexOf(match, at + 1)) {
      let left = 0
      while (left < start && left < at && s[start - left - 1] === text[at - left - 1]) left++
      let right = 0
      const textEnd = at + match.length
      while (end + right < s.length && textEnd + right < text.length && s[end + right] === text[textEnd + right]) {
        right++
      }
      if (left + right >= USER_TEXT_CONTEXT) return true
    }
  }
  return false
}

/**
 * Every string in `value`, recursively: JSON inside strings is parsed and
 * base64 zips (`export_vault`) are unpacked, so nothing is scanned as an
 * opaque blob.
 */
function findSecrets(value: unknown, ctx: ScanContext): string[] {
  const findings = new Set<string>()
  const seen = new Set<string>()
  const visitString = (s: string): void => {
    if (seen.has(s)) return
    seen.add(s)
    for (const [label, pattern] of SECRET_PATTERNS) {
      for (const match of s.matchAll(pattern)) {
        if (fromUserText(s, match.index, match[0], ctx.userAuthored)) continue
        findings.add(`${label}: ${match[0]}`)
      }
    }
    for (const secret of ctx.secrets) {
      if (s.includes(secret)) findings.add(`fixture secret: ${secret}`)
    }
    const trimmed = s.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined) visit(parsed)
    }
    // "PK\x03\x04" in base64.
    if (/^UEsDB[A-Za-z0-9+/=]+$/.test(trimmed)) {
      for (const entry of new AdmZip(Buffer.from(trimmed, 'base64')).getEntries()) {
        visitString(entry.entryName)
        if (!entry.isDirectory) visitString(entry.getData().toString('utf8'))
      }
    }
  }
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      visitString(v)
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item)
    } else if (v && typeof v === 'object') {
      for (const [key, child] of Object.entries(v)) {
        visitString(key)
        visit(child)
      }
    }
  }
  visit(value)
  return [...findings]
}

// Built by concatenation so no scanner mistakes this file for a leak.
const ghToken = (kind: 'o' | 'p', label: string): string => `gh${kind}_${label}`.padEnd(40, '0')

const CLONE_TOKEN = ghToken('o', 'cloneUrlFixture')
const AGENT_TOKEN = ghToken('o', 'agentUrlFixture')
const LEGACY_TOKEN = ghToken('o', 'legacyUrlFixture')
const EXPLICIT_CREDENTIAL = ghToken('p', 'explicitCredentialFixture')
const LEGACY_WEBHOOK_SECRET = 'legacy-webhook-secret-fixture-5f2c9a1e'
const LEGACY_URL = `https://x-access-token:${LEGACY_TOKEN}@github.com/acme/legacy.git`
// #593: tokens that are neither `gh*_` nor in a `user:password` userinfo.
const TOKEN_ONLY_TOKEN = ['glpat', 'tokenOnlyUrlFixture0'].join('-')
const QUERY_TOKEN = ['glpat', 'queryStringFixture00'].join('-')
const FRAGMENT_TOKEN = ['frag', 'accessTokenFixture00'].join('-')
const SSH_PASSWORD = 'ssh-password-fixture-7c1d'
const SSH_URL = `ssh://git:${SSH_PASSWORD}@127.0.0.1:1/acme/ssh.git`

// What a user pasted into their own notes and code. Comes back as written.
const USER_NOTE = [
  'Credentials page, pasted by the owner:',
  '- wiki login: https://alice:wiki-pass-from-notes@wiki.example.com/page',
  `- staging key: sk-${'userPastedStagingKey'.padEnd(30, '0')}`,
].join('\n')
const USER_NOTE_EDITED = `${USER_NOTE}\nRotated last week.`
const ROADMAP_NOTE = 'Roadmap for the quarter. Credentials live in [[docs/credentials]].'
const SERVICE_FILE = [
  "import './helper'",
  `export const AWS_EXAMPLE_KEY = '${'AKIA' + 'IOSFODNN7EXAMPLE'}'`,
  'export function run() { return 1 }',
].join('\n')
const HELPER_FILE = 'export const helper = 1'

interface Fixture {
  ownerId: string
  viewerId: string
  viewerEmail: string
  otherId: string
  vaultId: string
  teamId: string
  trashedNoteId: string
  notificationId: string
  cloneRepoId: string
  explicitRepoId: string
  legacyRepoId: string
  tokenOnlyRepoId: string
  queryRepoId: string
  sshRepoId: string
  pushRepoId: string
  pushRepoName: string
  // Filled by write steps, consumed by destructive ones.
  throwawayVaultId?: string
  vaultShareId?: string
  agentRepoId?: string
  repositoryShareId?: string
  throwawayTeamId?: string
  perspectiveId?: string
  agentNoteId?: string
}

let app: FastifyInstance
let baseUrl: string
const fx = {} as Fixture
const secrets: string[] = [
  CLONE_TOKEN,
  AGENT_TOKEN,
  LEGACY_TOKEN,
  EXPLICIT_CREDENTIAL,
  LEGACY_WEBHOOK_SECRET,
  TOKEN_ONLY_TOKEN,
  QUERY_TOKEN,
  FRAGMENT_TOKEN,
  SSH_PASSWORD,
  TEST_PASSWORD,
]
const scanContext: ScanContext = {
  secrets,
  userAuthored: [USER_NOTE, USER_NOTE_EDITED, ROADMAP_NOTE, SERVICE_FILE, HELPER_FILE],
}

const clients: Client[] = []
const callers: Array<{ who: string; client: Client; isOwnerAccount: boolean }> = []

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'secret-scan', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  resetRateLimits()
  await client.connect(transport)
  clients.push(client)
  return client
}

async function createConnection(cookie: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie }, body })
  const { token } = res.json() as { token: string }
  secrets.push(token)
  return token
}

async function createRepository(cookie: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/repositories', headers: { cookie }, body })
  if (res.statusCode !== 200) throw new Error(`repository create failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

async function createNote(cookie: string, name: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/vaults/${fx.vaultId}/notes`,
    headers: { cookie },
    body: { type: 'docs', name, body },
  })
  if (res.statusCode !== 200) throw new Error(`note create failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`fixture value ${name} is missing: the step that creates it failed`)
  return value
}

function idOf(result: unknown): string {
  if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') return result.id
  throw new Error(`expected a result with an id, got ${JSON.stringify(result)}`)
}

async function revisionIds(path: string): Promise<string[]> {
  const revisions = await listRevisionMeta(fx.vaultId, path, 200, 0)
  if (!revisions || revisions.length === 0) throw new Error(`no revisions for ${path}`)
  return revisions.map((r) => r.id)
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const owner = await createActiveUser()
  const viewer = await createActiveUser()
  const other = await createActiveUser()
  fx.ownerId = owner.id
  fx.viewerId = viewer.id
  fx.viewerEmail = viewer.email
  fx.otherId = other.id
  const ownerCookie = await loginCookie(app, owner.email)
  const viewerCookie = await loginCookie(app, viewer.email)
  for (const cookie of [ownerCookie, viewerCookie]) secrets.push(cookie.split('=')[1]!)

  // A TOTP secret on the owner, provisioned the way the UI does it.
  const mfa = await app.inject({ method: 'POST', url: '/api/mfa/setup', headers: { cookie: ownerCookie } })
  secrets.push((mfa.json() as { secret: string }).secret)

  fx.vaultId = (
    (await app.inject({
      method: 'POST',
      url: '/api/vaults',
      headers: { cookie: ownerCookie },
      body: { name: 'secret-scan vault' },
    })).json() as { id: string }
  ).id
  await createNote(ownerCookie, 'roadmap', ROADMAP_NOTE)
  await createNote(ownerCookie, 'credentials', USER_NOTE)
  await updateNote(fx.vaultId, 'docs/credentials', { body: USER_NOTE_EDITED }, { type: 'user', id: owner.id })
  await createNote(ownerCookie, 'scratch', 'Scratch note headed for the trash.')
  fx.trashedNoteId = idOf(await softDeleteNote(fx.vaultId, 'docs/scratch', { type: 'user', id: owner.id }))

  // A git remote with a token in the URL; its first sync fails for real
  // (nothing listens on port 1) and records git's own error text.
  fx.cloneRepoId = await createRepository(ownerCookie, {
    name: 'clone-remote',
    ingestionMethod: 'git',
    gitUrl: `https://x-access-token:${CLONE_TOKEN}@127.0.0.1:1/acme/private.git`,
  })
  const webhook = await app.inject({
    method: 'POST',
    url: `/api/repositories/${fx.cloneRepoId}/webhook-secret`,
    headers: { cookie: ownerCookie },
  })
  secrets.push((webhook.json() as { secret: string }).secret)
  fx.explicitRepoId = await createRepository(ownerCookie, {
    name: 'explicit-credential-remote',
    ingestionMethod: 'git',
    gitUrl: 'https://127.0.0.1:1/acme/explicit.git',
    gitCredential: EXPLICIT_CREDENTIAL,
  })
  // #593: a bare non-GitHub token as the URL username, and one in the query
  // string (stored as given: it is not userinfo, so nothing moves it).
  fx.tokenOnlyRepoId = await createRepository(ownerCookie, {
    name: 'token-only-remote',
    ingestionMethod: 'git',
    gitUrl: `https://${TOKEN_ONLY_TOKEN}@127.0.0.1:1/acme/gitlab.git`,
  })
  fx.queryRepoId = await createRepository(ownerCookie, {
    name: 'query-token-remote',
    ingestionMethod: 'git',
    gitUrl: `https://127.0.0.1:1/acme/query.git?private_token=${QUERY_TOKEN}#access_token=${FRAGMENT_TOKEN}`,
  })
  // Creation starts a sync in the background without exposing it; one more,
  // awaited, guarantees git's error text is on the row before anything reads it.
  for (const id of [fx.cloneRepoId, fx.explicitRepoId, fx.tokenOnlyRepoId, fx.queryRepoId]) {
    await syncGitRepository(id).catch(() => {})
  }

  // A row stored before #383 was fixed and never scrubbed (the boot scrub
  // leaves a row alone when no encryption key is set): the token is still in
  // the URL and in the clone error git wrote at the time, once on its own.
  const [legacy] = await db
    .insert(repositories)
    .values({
      name: 'legacy-remote',
      ownerId: owner.id,
      ingestionMethod: 'git',
      gitUrl: LEGACY_URL,
      syncStatus: 'error',
      lastSyncError: `fatal: unable to access '${LEGACY_URL}/': The requested URL returned error: 403\nremote: token ${LEGACY_TOKEN} is revoked`,
      webhookSecretEncrypted: encryptCredential(LEGACY_WEBHOOK_SECRET),
    })
    .returning()
  fx.legacyRepoId = legacy!.id
  // The same for an ssh:// remote with a password, inserted directly: a
  // background ssh sync could wait on a prompt.
  const [ssh] = await db
    .insert(repositories)
    .values({
      name: 'ssh-password-remote',
      ownerId: owner.id,
      ingestionMethod: 'git',
      gitUrl: SSH_URL,
      syncStatus: 'error',
      lastSyncError: `fatal: Could not read from remote repository '${SSH_URL}'`,
    })
    .returning()
  fx.sshRepoId = ssh!.id

  fx.pushRepoName = 'push-repo'
  fx.pushRepoId = await createRepository(ownerCookie, { name: fx.pushRepoName, ingestionMethod: 'agent_push' })
  await syncRepositoryFiles(
    fx.pushRepoId,
    [
      { path: 'src/service.ts', content: SERVICE_FILE },
      { path: 'src/helper.ts', content: HELPER_FILE },
    ],
    ['src/service.ts', 'src/helper.ts'],
  )
  await flushExtraction()
  const syncToken = await app.inject({
    method: 'POST',
    url: `/api/repositories/${fx.pushRepoId}/sync-tokens`,
    headers: { cookie: ownerCookie },
  })
  secrets.push((syncToken.json() as { token: string }).token)

  // Sharing, so viewer-tier serialization and member listings are exercised.
  const [team] = await db.insert(teams).values({ name: 'secret-scan team' }).returning()
  fx.teamId = team!.id
  await db.insert(teamMemberships).values([
    { teamId: fx.teamId, userId: owner.id, role: 'owner' },
    { teamId: fx.teamId, userId: viewer.id, role: 'member' },
  ])
  await db.insert(vaultShares).values([
    { vaultId: fx.vaultId, granteeType: 'user', granteeId: viewer.id, permission: 'read' },
    { vaultId: fx.vaultId, granteeType: 'team', granteeId: fx.teamId, permission: 'read' },
  ])
  await db.insert(repositoryShares).values([
    { repositoryId: fx.cloneRepoId, granteeType: 'user', granteeId: viewer.id },
    { repositoryId: fx.legacyRepoId, granteeType: 'user', granteeId: viewer.id },
    { repositoryId: fx.tokenOnlyRepoId, granteeType: 'user', granteeId: viewer.id },
    { repositoryId: fx.queryRepoId, granteeType: 'user', granteeId: viewer.id },
    { repositoryId: fx.sshRepoId, granteeType: 'user', granteeId: viewer.id },
    { repositoryId: fx.pushRepoId, granteeType: 'team', granteeId: fx.teamId },
  ])
  const [notification] = await db
    .insert(notifications)
    .values({
      recipientId: owner.id,
      type: 'vault_shared',
      entityType: 'vault',
      entityId: fx.vaultId,
      message: 'Vault "secret-scan vault" was shared with you (read).',
    })
    .returning()
  fx.notificationId = notification!.id

  const ownerAccount = await createConnection(ownerCookie, { name: 'scan-account', scope: 'account' })
  const viewerAccount = await createConnection(viewerCookie, { name: 'scan-viewer', scope: 'account' })
  const ownerVault = await createConnection(ownerCookie, { name: 'scan-vault', scope: 'vault', vaultId: fx.vaultId })
  const ownerRepo = await createConnection(ownerCookie, {
    name: 'scan-repo',
    scope: 'repository',
    repositoryId: fx.pushRepoId,
  })

  // Everything stored in place of a secret is a secret too: hashes and ciphertexts.
  const userIds = [owner.id, viewer.id, other.id]
  for (const u of await db.select({ hash: users.passwordHash }).from(users).where(inArray(users.id, userIds))) {
    secrets.push(u.hash)
  }
  for (const s of await db.select({ hash: sessions.tokenHash }).from(sessions).where(inArray(sessions.userId, userIds))) {
    secrets.push(s.hash)
  }
  for (const c of await db
    .select({ hash: mcpConnections.tokenHash })
    .from(mcpConnections)
    .where(inArray(mcpConnections.userId, userIds))) {
    secrets.push(c.hash)
  }
  for (const t of await db
    .select({ hash: repositorySyncTokens.tokenHash })
    .from(repositorySyncTokens)
    .where(eq(repositorySyncTokens.repositoryId, fx.pushRepoId))) {
    secrets.push(t.hash)
  }
  for (const r of await db
    .select({ credential: repositories.gitCredentialEncrypted, webhook: repositories.webhookSecretEncrypted })
    .from(repositories)
    .where(
      inArray(repositories.id, [
        fx.cloneRepoId,
        fx.explicitRepoId,
        fx.legacyRepoId,
        fx.tokenOnlyRepoId,
        fx.queryRepoId,
        fx.sshRepoId,
        fx.pushRepoId,
      ]),
    )) {
    if (r.credential) secrets.push(r.credential)
    if (r.webhook) secrets.push(r.webhook)
  }

  callers.push(
    { who: 'owner (account)', client: await mcpClient(ownerAccount), isOwnerAccount: true },
    { who: 'viewer (account)', client: await mcpClient(viewerAccount), isOwnerAccount: false },
    { who: 'owner (vault-scoped)', client: await mcpClient(ownerVault), isOwnerAccount: false },
    { who: 'owner (repository-scoped)', client: await mcpClient(ownerRepo), isOwnerAccount: false },
  )
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

type Args = Record<string, unknown>
interface Step {
  tool: string
  args: () => Args | Promise<Args>
  capture?: (result: unknown) => void | Promise<void>
  /**
   * Text the owner account's response must contain: a tool that returns
   * nothing has nothing to leak, so an empty result must not pass the scan.
   */
  contains?: string
}

// Reads run first, as every caller; nothing they touch has been changed yet.
const readSteps: Step[] = [
  { tool: 'list_vaults', args: () => ({}), contains: 'secret-scan vault' },
  { tool: 'browse_vault', args: () => ({ vaultId: fx.vaultId }), contains: 'docs' },
  { tool: 'browse_vault', args: () => ({ vaultId: fx.vaultId, path: 'docs' }), contains: 'credentials' },
  { tool: 'get_vault_graph_preference', args: () => ({ vaultId: fx.vaultId }) },
  { tool: 'get_vault_preferences', args: () => ({}) },
  { tool: 'list_vault_shares', args: () => ({ vaultId: fx.vaultId }) },
  { tool: 'read_note', args: () => ({ vaultId: fx.vaultId, path: 'docs/credentials' }), contains: 'wiki login' },
  { tool: 'note_history', args: () => ({ vaultId: fx.vaultId, path: 'docs/credentials' }), contains: '"bodyBytes"' },
  {
    tool: 'get_revision',
    args: async () => ({
      vaultId: fx.vaultId,
      path: 'docs/credentials',
      revisionId: (await revisionIds('docs/credentials')).at(-1),
    }),
    contains: 'wiki login',
  },
  { tool: 'list_trash', args: () => ({ vaultId: fx.vaultId }), contains: 'docs/scratch' },
  { tool: 'export_vault', args: () => ({ vaultId: fx.vaultId }), contains: 'UEsDB' },
  { tool: 'export_note', args: () => ({ vaultId: fx.vaultId, path: 'docs/credentials' }) },
  { tool: 'audit_okf_conformance', args: () => ({ vaultId: fx.vaultId }) },
  { tool: 'list_repositories', args: () => ({}), contains: 'ssh-password-remote' },
  { tool: 'browse_repository', args: () => ({ repositoryId: fx.pushRepoId }), contains: 'service.ts' },
  {
    tool: 'read_file',
    args: () => ({ repositoryId: fx.pushRepoId, path: 'src/service.ts' }),
    contains: 'AWS_EXAMPLE_KEY',
  },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.cloneRepoId }) },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.explicitRepoId }) },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.legacyRepoId }), contains: 'revoked' },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.tokenOnlyRepoId }), contains: 'unable to access' },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.queryRepoId }), contains: 'unable to access' },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.sshRepoId }), contains: 'Could not read' },
  { tool: 'repository_status', args: () => ({ repositoryId: fx.pushRepoId }) },
  { tool: 'get_repository_graph_preference', args: () => ({ repositoryId: fx.pushRepoId }) },
  { tool: 'list_repository_shares', args: () => ({ repositoryId: fx.cloneRepoId }) },
  { tool: 'list_repository_shares', args: () => ({ repositoryId: fx.legacyRepoId }) },
  { tool: 'list_teams', args: () => ({}), contains: 'secret-scan team' },
  { tool: 'list_team_members', args: () => ({ teamId: fx.teamId }) },
  { tool: 'lookup_user', args: () => ({ email: fx.viewerEmail }) },
  { tool: 'list_notifications', args: () => ({}), contains: 'was shared with you' },
  {
    tool: 'search',
    args: () => ({ query: 'credentials', vaultId: fx.vaultId }),
    contains: 'docs/credentials',
  },
  { tool: 'search', args: () => ({ query: 'helper', repositoryId: fx.pushRepoId }), contains: 'src/helper.ts' },
  { tool: 'search', args: () => ({ query: 'credentials', everywhere: true }), contains: 'docs/credentials' },
  { tool: 'find_symbols', args: () => ({ query: 'run', everywhere: true }), contains: '"name":"run"' },
  { tool: 'graph', args: () => ({ vaultId: fx.vaultId }), contains: 'docs/credentials' },
  { tool: 'graph', args: () => ({ repositoryId: fx.pushRepoId }), contains: 'src/service.ts' },
  {
    tool: 'find_graph_path',
    args: () => ({ vaultId: fx.vaultId, source: 'docs/roadmap', target: 'docs/credentials' }),
    contains: 'docs/roadmap',
  },
  { tool: 'list_graph_perspectives', args: () => ({ vaultId: fx.vaultId }) },
  { tool: 'list_graph_perspectives', args: () => ({}) },
]

// Then writes, as the owner. Each creates what a later step may destroy.
const writeSteps: Step[] = [
  {
    tool: 'create_vault',
    args: () => ({ name: 'secret-scan throwaway' }),
    capture: (r) => {
      fx.throwawayVaultId = idOf(r)
    },
  },
  { tool: 'update_vault', args: () => ({ vaultId: fx.vaultId, mergeable: true }) },
  { tool: 'set_vault_graph_preference', args: () => ({ vaultId: fx.vaultId, include: true }) },
  { tool: 'update_vault_preferences', args: () => ({ favorites: { [fx.vaultId]: true } }) },
  {
    tool: 'share_vault',
    args: () => ({ vaultId: fx.vaultId, granteeType: 'user', granteeId: fx.otherId, permission: 'read' }),
    capture: (r) => {
      fx.vaultShareId = idOf(r)
    },
  },
  {
    tool: 'create_note',
    args: () => ({ vaultId: fx.vaultId, path: 'docs/agent-made', body: 'Written by the agent.' }),
  },
  { tool: 'edit_note', args: () => ({ vaultId: fx.vaultId, path: 'docs/agent-made', body: 'Edited by the agent.' }) },
  { tool: 'rename_note', args: () => ({ vaultId: fx.vaultId, from: 'docs/agent-made', toName: 'agent-renamed' }) },
  { tool: 'restore_note', args: () => ({ vaultId: fx.vaultId, noteId: fx.trashedNoteId }) },
  {
    tool: 'revert_note',
    args: async () => ({
      vaultId: fx.vaultId,
      path: 'docs/credentials',
      revisionId: (await revisionIds('docs/credentials')).at(-1),
    }),
  },
  {
    tool: 'connect_repository',
    args: () => ({
      name: 'agent-connected',
      ingestionMethod: 'git',
      gitUrl: `https://x-access-token:${AGENT_TOKEN}@127.0.0.1:1/acme/agent.git`,
    }),
    capture: async (r) => {
      fx.agentRepoId = idOf(r)
      const [row] = await db
        .select({ credential: repositories.gitCredentialEncrypted })
        .from(repositories)
        .where(eq(repositories.id, fx.agentRepoId))
      if (row?.credential) secrets.push(row.credential)
    },
  },
  { tool: 'sync_repository', args: () => ({ repositoryId: fx.cloneRepoId, force: true }) },
  { tool: 'update_repository', args: () => ({ repositoryId: fx.legacyRepoId, name: 'legacy-remote-renamed' }) },
  { tool: 'set_repository_graph_preference', args: () => ({ repositoryId: fx.pushRepoId, include: true }) },
  {
    tool: 'share_repository',
    args: () => ({ repositoryId: fx.legacyRepoId, granteeType: 'user', granteeId: fx.otherId }),
    capture: (r) => {
      fx.repositoryShareId = idOf(r)
    },
  },
  {
    tool: 'create_team',
    args: () => ({ name: 'secret-scan throwaway team' }),
    capture: (r) => {
      fx.throwawayTeamId = idOf(r)
    },
  },
  {
    tool: 'add_team_member',
    args: () => ({ teamId: need(fx.throwawayTeamId, 'throwawayTeamId'), userId: fx.otherId }),
  },
  { tool: 'mark_notification_read', args: () => ({ notificationId: fx.notificationId }) },
  {
    tool: 'save_graph_perspective',
    args: () => ({ name: 'secret-scan perspective', vaultId: fx.vaultId, filters: { types: ['docs'] } }),
    capture: (r) => {
      fx.perspectiveId = idOf(r)
    },
  },
]

// Last, destructive calls, only ever on fixtures the writes above created
// (plus one revision of the fixture note).
const destructiveSteps: Step[] = [
  {
    tool: 'revoke_vault_share',
    args: () => ({ vaultId: fx.vaultId, shareId: need(fx.vaultShareId, 'vaultShareId') }),
  },
  {
    tool: 'delete_note',
    args: () => ({ vaultId: fx.vaultId, path: 'docs/agent-renamed' }),
    capture: (r) => {
      fx.agentNoteId = idOf(r)
    },
  },
  { tool: 'purge_note', args: () => ({ vaultId: fx.vaultId, noteId: need(fx.agentNoteId, 'agentNoteId') }) },
  {
    tool: 'purge_revision',
    args: async () => ({ vaultId: fx.vaultId, revisionId: (await revisionIds('docs/credentials'))[0] }),
  },
  {
    tool: 'revoke_repository_share',
    args: () => ({ repositoryId: fx.legacyRepoId, shareId: need(fx.repositoryShareId, 'repositoryShareId') }),
  },
  {
    tool: 'remove_team_member',
    args: () => ({ teamId: need(fx.throwawayTeamId, 'throwawayTeamId'), userId: fx.otherId }),
  },
  { tool: 'delete_team', args: () => ({ teamId: need(fx.throwawayTeamId, 'throwawayTeamId') }) },
  { tool: 'delete_graph_perspective', args: () => ({ id: need(fx.perspectiveId, 'perspectiveId') }) },
  { tool: 'delete_repository', args: () => ({ repositoryId: need(fx.agentRepoId, 'agentRepoId') }) },
  { tool: 'delete_vault', args: () => ({ vaultId: need(fx.throwawayVaultId, 'throwawayVaultId') }) },
  { tool: 'restore_vault', args: () => ({ vaultId: need(fx.throwawayVaultId, 'throwawayVaultId') }) },
  { tool: 'delete_vault', args: () => ({ vaultId: need(fx.throwawayVaultId, 'throwawayVaultId') }) },
  { tool: 'purge_vault', args: () => ({ vaultId: need(fx.throwawayVaultId, 'throwawayVaultId') }) },
]

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.map((c) => c.text ?? '').join('')
}

/** A value for a prompt argument, by name: real fixture ids where it matters. */
function promptArgument(name: string): string {
  if (name === 'vaultId') return fx.vaultId
  if (name === 'repositoryName') return fx.pushRepoName
  if (/(Path|Node|File)$/.test(name)) return 'docs/credentials'
  return 'credentials roadmap'
}

describe('MCP secret scan (#577)', () => {
  it('the scanner flags every pattern and fixture secret, and lets user-authored text through', () => {
    const ctx: ScanContext = {
      secrets: ['exact-fixture-secret-value'],
      userAuthored: ['pasted https://bob:hunter2@intranet.example.com/x here'],
    }
    const samples = [
      'https://user:pass@github.com/o/r.git',
      `https://${['glpat', 'x'.repeat(20)].join('-')}@gitlab.com/o/r.git`,
      'https://gitlab.com/o/r.git?private_token=abc',
      'https://gitlab.com/o/r.git#access_token=abc',
      ghToken('o', 'sample'),
      `ghs_${'s'.repeat(30)}`,
      'x-access-token',
      `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`,
      `sk-${'k'.repeat(24)}`,
      `AKIA${'Q'.repeat(16)}`,
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      '$2b$10$abcdefghijklmnopqrstuv',
      'see exact-fixture-secret-value here',
    ]
    for (const sample of samples) {
      expect(findSecrets({ nested: JSON.stringify({ text: sample }) }, ctx), sample).not.toEqual([])
    }
    const zip = new AdmZip()
    zip.addFile('docs/note.md', Buffer.from(`token: ${ghToken('p', 'zipped')}`))
    expect(findSecrets({ zipBase64: zip.toBuffer().toString('base64') }, ctx)).not.toEqual([])
    expect(findSecrets('pasted https://bob:hunter2@intranet.example.com/x', ctx)).toEqual([])
  })

  // #593: the allowance belonged to the matched substring, so one note
  // mentioning `x-access-token` let that word through in every response.
  it('lets a pattern match through only in the text a user wrote, not in another field', () => {
    const note = 'The deploy note says x-access-token is the username for the bot.'
    const ctx: ScanContext = {
      secrets: ['exact-fixture-secret-value'],
      userAuthored: [note, 'pasted exact-fixture-secret-value'],
    }
    expect(findSecrets({ body: note }, ctx)).toEqual([])
    expect(findSecrets(JSON.stringify({ body: note }), ctx)).toEqual([])
    expect(findSecrets({ body: note, lastSyncError: 'auth failed for x-access-token' }, ctx)).toEqual([
      'x-access-token: x-access-token',
    ])
    // Exact fixture values are never allowed, not even inside user text.
    expect(findSecrets('pasted exact-fixture-secret-value', ctx)).not.toEqual([])
  })

  it('every registered tool has a fixture step', async () => {
    const owner = callers[0]!.client
    resetRateLimits()
    const listed = await owner.listTools()
    expect(findSecrets(listed, scanContext)).toEqual([])
    const names = listed.tools.map((t) => t.name)
    const covered = new Set([...readSteps, ...writeSteps, ...destructiveSteps].map((s) => s.tool))
    expect(
      names.filter((n) => !covered.has(n)),
      'tools without a fixture step in mcp-secret-scan.test.ts',
    ).toEqual([])
    expect(
      [...covered].filter((n) => !names.includes(n)),
      'fixture steps for tools that are no longer registered',
    ).toEqual([])
  })

  it('no prompt returns a secret', async () => {
    const findings: string[] = []
    const failures: string[] = []
    for (const { who, client, isOwnerAccount } of callers) {
      resetRateLimits()
      const { prompts } = await client.listPrompts()
      expect(prompts.length).toBeGreaterThan(0)
      findings.push(...findSecrets(prompts, scanContext).map((f) => `prompts/list as ${who}: ${f}`))
      for (const prompt of prompts) {
        const args = Object.fromEntries((prompt.arguments ?? []).map((a) => [a.name, promptArgument(a.name)]))
        resetRateLimits()
        let response: unknown
        try {
          response = await client.getPrompt({ name: prompt.name, arguments: args })
        } catch (err) {
          response = err instanceof Error ? err.message : String(err)
          if (isOwnerAccount) failures.push(`${prompt.name}: ${String(response)}`)
        }
        findings.push(...findSecrets(response, scanContext).map((f) => `${prompt.name} as ${who}: ${f}`))
      }
    }
    expect(failures, 'prompts that failed for the owner account').toEqual([])
    expect(findings).toEqual([])
  }, 60_000)

  it('no tool returns a secret: reads as every caller, then writes and destructive calls as the owner', async () => {
    const findings: string[] = []
    const failures: string[] = []
    const run = async (step: Step, who: string, client: Client, mustSucceed: boolean): Promise<void> => {
      let args: Args
      try {
        args = await step.args()
      } catch (err) {
        failures.push(`${step.tool}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      resetRateLimits()
      const result = await client.callTool({ name: step.tool, arguments: args })
      findings.push(...findSecrets(result, scanContext).map((f) => `${step.tool} as ${who}: ${f}`))
      if (!mustSucceed) return
      if (result.isError) {
        failures.push(`${step.tool}: ${textOf(result)}`)
        return
      }
      if (step.contains && !textOf(result).includes(step.contains)) {
        failures.push(`${step.tool}: expected "${step.contains}" in ${textOf(result).slice(0, 300)}`)
      }
      if (step.capture) {
        try {
          await step.capture(JSON.parse(textOf(result)))
        } catch (err) {
          failures.push(`${step.tool} capture: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    for (const step of readSteps) {
      for (const { who, client, isOwnerAccount } of callers) await run(step, who, client, isOwnerAccount)
    }
    const owner = callers[0]!
    for (const step of [...writeSteps, ...destructiveSteps]) await run(step, owner.who, owner.client, true)

    expect(failures, 'fixture steps that failed for the owner account').toEqual([])
    expect(findings).toEqual([])
  }, 120_000)
})
