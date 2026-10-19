// Every MCP tool against a vault-pinned and a repository-pinned token (#546, #547).
//
// The owner owns everything: pinned vault P, other vault O, pinned repository
// RP, other repository RO. So a denial can only come from the pin, and a
// success with another id is a breach. For every tool in tools/list:
//   other id   vaultId=O / repositoryId=RO             expect a scope refusal
//   no id      the tool fits the token's pin           expect confinement: not
//                                                       refused, and the response
//                                                       names nothing outside the pin
//              otherwise                               expect a scope refusal
//   everywhere tools that take it                      expect a scope refusal
// Arguments that name an object (a note path, a share, a revision) name one
// that exists only in O / RO, so a confined call answers "not found".
// A tool without a case here fails the test: a new tool needs a case.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.js'
import { buildMcpServer } from '../src/mcp/server.js'
import { resetRateLimits } from '../src/mcp/rate-limit.js'
import { syncRepositoryFiles } from '../src/repositories/store.js'
import { flushExtraction } from '../src/repositories/extraction-queue.js'
import type { McpAuth } from '../src/vaults/mcp-connection-routes.js'
import { createActiveUser, loginCookie } from './helpers.js'

type Args = Record<string, unknown>
type Token = 'vault' | 'repo'

/** How the pin applies to a tool, as the tool's contract states it. */
type Kind =
  | 'account' // account-scoped connections only
  | 'vault' // one vault: the vault pin, nothing else
  | 'repository' // one repository: the repository pin, nothing else
  | 'vault-or-repo' // vaults and/or repositories: each token's own pin
  | 'perspective-id' // delete_graph_perspective: the perspective's vault is the pin

interface Fixtures {
  P: { id: string }
  O: { id: string; onlyPath: string; trashedId: string; revisionId: string; shareId: string; perspectiveId: string }
  RP: { id: string }
  RO: { id: string; onlyPath: string; shareId: string }
  memberId: string
  memberEmail: string
  globalPerspectiveId: string
}

interface ScopeCase {
  kind: Kind
  /** Arguments without vaultId/repositoryId. */
  args?: (fx: Fixtures) => Args | Promise<Args>
  /** Destroys the token's pin when confined: runs after every other case. */
  last?: true
  /** Text a confined (no id) call must return for that token: proof it works inside the pin. */
  finds?: Partial<Record<Token, string[]>>
}

const MARK = { P: 'SCOPEPINNEDVAULTMARK', O: 'SCOPEOTHERVAULTMARK' }
const SYMBOL = { RP: 'scopeProbePinned', RO: 'scopeProbeOther' }
// Links from a note in the pinned vault into the other repository: one file missing, one present.
const REPO_LINK = { missing: 'repo:scope-other-repo/missing.ts', present: 'repo:scope-other-repo/src/other-only.ts' }
const SCOPE_DENIAL =
  /pinned to a different|is scoped to a (vault|repository)|requires an account-scoped connection/i

let seq = 0
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

const CASES: Record<string, ScopeCase> = {
  // account surfaces
  list_vaults: { kind: 'account' },
  create_vault: { kind: 'account', args: () => ({ name: `scope-created-${next()}` }) },
  get_vault_preferences: { kind: 'account' },
  update_vault_preferences: { kind: 'account', args: (fx) => ({ favorites: { [fx.P.id]: true } }) },
  restore_vault: { kind: 'account', args: (fx) => ({ vaultId: fx.O.id }) },
  purge_vault: { kind: 'account', args: (fx) => ({ vaultId: fx.O.id }) },
  list_repositories: { kind: 'account' },
  connect_repository: {
    kind: 'account',
    args: () => ({ name: `scope-connect-${next()}`, ingestionMethod: 'git', gitUrl: 'https://example.com/o/r.git' }),
  },
  list_teams: { kind: 'account' },
  create_team: { kind: 'account', args: () => ({ name: `scope-team-${next()}` }) },
  list_team_members: { kind: 'account', args: () => ({ teamId: randomUUID() }) },
  add_team_member: { kind: 'account', args: (fx) => ({ teamId: randomUUID(), userId: fx.memberId }) },
  remove_team_member: { kind: 'account', args: (fx) => ({ teamId: randomUUID(), userId: fx.memberId }) },
  delete_team: { kind: 'account', args: () => ({ teamId: randomUUID() }) },
  lookup_user: { kind: 'account', args: (fx) => ({ email: fx.memberEmail }) },
  list_notifications: { kind: 'account' },
  mark_notification_read: { kind: 'account', args: () => ({ notificationId: randomUUID() }) },

  // one vault
  browse_vault: { kind: 'vault', finds: { vault: ['docs/probe'] } },
  update_vault: { kind: 'vault', args: () => ({ mergeable: false }) },
  get_vault_graph_preference: { kind: 'vault' },
  set_vault_graph_preference: { kind: 'vault', args: () => ({ include: false }) },
  delete_vault: { kind: 'vault', last: true },
  list_vault_shares: { kind: 'vault' },
  share_vault: {
    kind: 'vault',
    args: (fx) => ({ granteeType: 'user', granteeId: fx.memberId, permission: 'read' }),
  },
  revoke_vault_share: { kind: 'vault', args: (fx) => ({ shareId: fx.O.shareId }) },
  read_note: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath }) },
  create_note: { kind: 'vault', args: () => ({ type: 'docs', name: `scope-created-${next()}`, body: 'created' }) },
  edit_note: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath, body: 'overwritten' }) },
  rename_note: { kind: 'vault', args: (fx) => ({ from: fx.O.onlyPath, toName: `renamed-${next()}` }) },
  delete_note: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath }) },
  list_trash: { kind: 'vault' },
  restore_note: { kind: 'vault', args: (fx) => ({ noteId: fx.O.trashedId }) },
  purge_note: { kind: 'vault', args: (fx) => ({ noteId: fx.O.trashedId }) },
  note_history: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath }) },
  get_revision: { kind: 'vault', args: (fx) => ({ revisionId: fx.O.revisionId }) },
  revert_note: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath, revisionId: fx.O.revisionId }) },
  purge_revision: { kind: 'vault', args: (fx) => ({ revisionId: fx.O.revisionId }) },
  export_vault: { kind: 'vault' },
  export_note: { kind: 'vault', args: (fx) => ({ path: fx.O.onlyPath }) },
  // Repo links in the pinned vault are reported, never resolved outside the pin: both show up as broken.
  audit_okf_conformance: { kind: 'vault', finds: { vault: [REPO_LINK.missing, REPO_LINK.present] } },
  list_graph_perspectives: { kind: 'vault' },
  save_graph_perspective: { kind: 'vault', args: () => ({ name: `scope-perspective-${next()}` }) },

  // one repository
  browse_repository: { kind: 'repository', finds: { repo: ['src/pinned.ts'] } },
  read_file: { kind: 'repository', args: (fx) => ({ path: fx.RO.onlyPath }) },
  repository_status: { kind: 'repository' },
  sync_repository: { kind: 'repository' },
  update_repository: { kind: 'repository', args: () => ({ mergeable: false }) },
  get_repository_graph_preference: { kind: 'repository' },
  set_repository_graph_preference: { kind: 'repository', args: () => ({ include: false }) },
  delete_repository: { kind: 'repository', last: true },
  list_repository_shares: { kind: 'repository' },
  share_repository: { kind: 'repository', args: (fx) => ({ granteeType: 'user', granteeId: fx.memberId }) },
  revoke_repository_share: { kind: 'repository', args: (fx) => ({ shareId: fx.RO.shareId }) },
  find_symbols: { kind: 'repository', args: () => ({ query: 'scopeProbe' }), finds: { repo: [SYMBOL.RP] } },

  // vaults and/or repositories
  search: { kind: 'vault-or-repo', args: () => ({ query: 'scope probe marker' }), finds: { vault: [MARK.P] } },
  graph: { kind: 'vault-or-repo' },
  find_graph_path: { kind: 'vault-or-repo', args: (fx) => ({ source: fx.O.onlyPath, target: fx.RO.onlyPath }) },

  // by perspective id
  delete_graph_perspective: { kind: 'perspective-id' },
}

let app: FastifyInstance
let baseUrl: string
let ownerCookie: string
let fx: Fixtures
const tokens: Record<Token, string> = { vault: '', repo: '' }
const clients: Client[] = []
let acct: Client

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'scope-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

async function call(client: Client, name: string, args: Args): Promise<{ isError: boolean; text: string }> {
  resetRateLimits()
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('') }
}

async function must<T>(client: Client, name: string, args: Args): Promise<T> {
  const r = await call(client, name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return JSON.parse(r.text) as T
}

async function mint(body: Args): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/mcp-connections', headers: { cookie: ownerCookie }, body })
  const created: { token: string } = res.json()
  return created.token
}

async function repo(name: string, files: Array<{ path: string; content: string }>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    headers: { cookie: ownerCookie },
    body: { name, ingestionMethod: 'agent_push' },
  })
  const created: { id: string } = res.json()
  await syncRepositoryFiles(created.id, files, files.map((f) => f.path))
  return created.id
}

beforeAll(async () => {
  app = await buildApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  // An instance admin, so global perspectives exist and nothing is denied for lack of a role.
  const owner = await createActiveUser({ role: 'admin' })
  const member = await createActiveUser()
  ownerCookie = await loginCookie(app, owner.email)
  acct = await mcpClient(await mint({ name: 'scope-account', scope: 'account' }))

  const P = await must<{ id: string }>(acct, 'create_vault', { name: 'scope-pinned' })
  const O = await must<{ id: string }>(acct, 'create_vault', { name: 'scope-other' })
  await must(acct, 'create_note', { vaultId: P.id, type: 'docs', name: 'probe', body: `${MARK.P} scope probe marker` })
  // Deep links from the pinned vault into the other repository (created below).
  await must(acct, 'create_note', {
    vaultId: P.id,
    type: 'docs',
    name: 'repo-links',
    body: `Code: [[${REPO_LINK.missing}]] and [[${REPO_LINK.present}]].`,
  })
  await must(acct, 'create_note', { vaultId: O.id, type: 'docs', name: 'probe', body: `${MARK.O} scope probe marker` })
  await must(acct, 'create_note', { vaultId: O.id, type: 'docs', name: 'other-only', body: MARK.O })
  await must(acct, 'create_note', { vaultId: O.id, type: 'docs', name: 'other-trashed', body: MARK.O })
  await must(acct, 'delete_note', { vaultId: O.id, path: 'docs/other-trashed' })
  const trash = await must<Array<{ id: string; path: string }>>(acct, 'list_trash', { vaultId: O.id })
  const { revisions } = await must<{ revisions: Array<{ id: string }> }>(acct, 'note_history', { vaultId: O.id, path: 'docs/other-only' })
  await must(acct, 'share_vault', { vaultId: O.id, granteeType: 'user', granteeId: member.id, permission: 'read' })
  const vaultShares = await must<Array<{ id: string }>>(acct, 'list_vault_shares', { vaultId: O.id })
  const oPerspective = await must<{ id: string }>(acct, 'save_graph_perspective', { vaultId: O.id, name: 'scope-other' })
  const globalPerspective = await must<{ id: string }>(acct, 'save_graph_perspective', { name: 'scope-global' })
  // Account-wide preferences that name the other vault.
  await must(acct, 'update_vault_preferences', { favorites: { [O.id]: true }, vaultColors: { [O.id]: '#ff0000' } })

  const RP = await repo('scope-pinned-repo', [
    { path: 'src/pinned.ts', content: `export function ${SYMBOL.RP}() { return 'pinned' }` },
  ])
  const RO = await repo('scope-other-repo', [
    { path: 'src/other-only.ts', content: `export function ${SYMBOL.RO}() { return 'other' }` },
  ])
  await flushExtraction()
  await must(acct, 'share_repository', { repositoryId: RO, granteeType: 'user', granteeId: member.id })
  const repoShares = await must<Array<{ id: string }>>(acct, 'list_repository_shares', { repositoryId: RO })

  fx = {
    P: { id: P.id },
    O: {
      id: O.id,
      onlyPath: 'docs/other-only',
      trashedId: trash.find((t) => t.path === 'docs/other-trashed')!.id,
      revisionId: revisions[0]!.id,
      shareId: vaultShares[0]!.id,
      perspectiveId: oPerspective.id,
    },
    RP: { id: RP },
    RO: { id: RO, onlyPath: 'src/other-only.ts', shareId: repoShares[0]!.id },
    memberId: member.id,
    memberEmail: member.email,
    globalPerspectiveId: globalPerspective.id,
  }
  // Admin, so the admin tools (share, delete, purge) are confined by the pin too, not refused by the access level.
  tokens.vault = await mint({ name: 'scope-vault', scope: 'vault', vaultId: P.id, access: 'admin' })
  tokens.repo = await mint({ name: 'scope-repo', scope: 'repository', repositoryId: RP, access: 'admin' })
}, 60_000)

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => {})
  await app.close()
})

/** Strings that must not appear in a confined response, per token. */
function leakMarkers(token: Token): Record<string, string> {
  const shared = {
    [fx.O.id]: 'other vault id',
    [fx.RO.id]: 'other repository id',
    [MARK.O]: 'other vault note',
    [SYMBOL.RO]: 'other repository symbol',
    [fx.globalPerspectiveId]: 'global perspective',
  }
  return token === 'vault'
    ? { ...shared, [fx.RP.id]: 'repository id', [SYMBOL.RP]: 'repository symbol', '"vaultId":null': 'account-wide perspective' }
    : { ...shared, [fx.P.id]: 'vault id', [MARK.P]: 'vault note' }
}

interface Probe {
  token: Token
  tool: string
  label: string
  args: () => Promise<Args>
  /** refuse: a scope refusal. hide: "not found", as for an id that does not exist. confine: works inside the pin. */
  expect: 'refuse' | 'hide' | 'confine'
  finds: string[]
  last: boolean
}

function probesFor(tool: string, c: ScopeCase, takesEverywhere: boolean): Probe[] {
  const base = async () => (c.args ? await c.args(fx) : {})
  const probes: Probe[] = []
  for (const token of ['vault', 'repo'] as const) {
    const add = (label: string, args: () => Promise<Args>, expect: Probe['expect'], finds: string[] = []) =>
      probes.push({ token, tool, label, args, expect, finds, last: expect === 'confine' && c.last === true })
    const fits =
      c.kind === 'vault-or-repo' || (c.kind === 'vault' && token === 'vault') || (c.kind === 'repository' && token === 'repo')
    switch (c.kind) {
      case 'account':
        add('account surface', base, 'refuse')
        break
      case 'perspective-id':
        // A perspective outside the pin answers like one that does not exist: no existence oracle.
        add('other vault perspective', async () => ({ id: fx.O.perspectiveId }), 'hide')
        add('global perspective', async () => ({ id: fx.globalPerspectiveId }), 'hide')
        add(
          'pinned vault perspective',
          async () => {
            const p = await must<{ id: string }>(acct, 'save_graph_perspective', { vaultId: fx.P.id, name: `scope-${next()}` })
            return { id: p.id }
          },
          token === 'vault' ? 'confine' : 'hide',
          token === 'vault' ? ['"ok":true'] : [],
        )
        break
      default:
        if (c.kind !== 'repository') add('other vault', async () => ({ ...(await base()), vaultId: fx.O.id }), 'refuse')
        if (c.kind !== 'vault') add('other repository', async () => ({ ...(await base()), repositoryId: fx.RO.id }), 'refuse')
        add('no id', base, fits ? 'confine' : 'refuse', fits ? (c.finds?.[token] ?? []) : [])
    }
    if (takesEverywhere) add('everywhere', async () => ({ ...(await base()), everywhere: true }), 'refuse')
  }
  return probes
}

describe('MCP tools respect a pinned token (#546, #547)', () => {
  it('a vault-pinned token deletes perspectives of its own vault and no other', async () => {
    const vault = await mcpClient(tokens.vault)
    const mine = await must<{ id: string }>(acct, 'save_graph_perspective', { vaultId: fx.P.id, name: `scope-${next()}` })
    const deleted = await call(vault, 'delete_graph_perspective', { id: mine.id })
    expect(deleted.isError, deleted.text).toBe(false)

    const other = await call(vault, 'delete_graph_perspective', { id: fx.O.perspectiveId })
    expect(other.isError).toBe(true)
    expect(other.text).toBe('Error: not found')
    const listed = await must<Array<{ id: string }>>(acct, 'list_graph_perspectives', { vaultId: fx.O.id })
    expect(listed.map((p) => p.id)).toContain(fx.O.perspectiveId)
  })

  // Runs last among the MCP calls: its final cases trash the pinned vault and delete the pinned repository.
  it('every tool confines a vault-pinned and a repository-pinned token to its pin', async () => {
    const { tools } = await acct.listTools()
    const names = tools.map((t) => t.name)
    expect(names.filter((n) => !CASES[n]), 'tools without a scope case in mcp-scope.test.ts').toEqual([])
    expect(Object.keys(CASES).filter((n) => !names.includes(n)), 'scope cases for unregistered tools').toEqual([])

    const pinned = { vault: await mcpClient(tokens.vault), repo: await mcpClient(tokens.repo) }
    const probes = tools.flatMap((t) => probesFor(t.name, CASES[t.name]!, 'everywhere' in (t.inputSchema.properties ?? {})))
    const ordered = [...probes.filter((p) => !p.last), ...probes.filter((p) => p.last)]
    const failures: string[] = []
    for (const p of ordered) {
      const args = await p.args()
      const r = await call(pinned[p.token], p.tool, args)
      const where = `${p.token}-pinned ${p.tool} [${p.label}]`
      if (p.expect === 'refuse') {
        if (!r.isError || !SCOPE_DENIAL.test(r.text)) failures.push(`${where}: expected a scope refusal, got ${r.text.slice(0, 160)}`)
        continue
      }
      if (p.expect === 'hide') {
        if (r.text !== 'Error: not found') failures.push(`${where}: expected "not found", got ${r.text.slice(0, 160)}`)
        continue
      }
      if (r.isError && SCOPE_DENIAL.test(r.text)) {
        failures.push(`${where}: refused inside its own pin: ${r.text.slice(0, 160)}`)
        continue
      }
      if (r.isError && /input validation|invalid arguments/i.test(r.text)) {
        failures.push(`${where}: test arguments rejected: ${r.text.slice(0, 160)}`)
        continue
      }
      const leaks = Object.entries(leakMarkers(p.token))
        .filter(([needle]) => r.text.includes(needle))
        .map(([, what]) => what)
      if (leaks.length) failures.push(`${where}: response leaks ${leaks.join(', ')}`)
      const missing = p.finds.filter((needle) => !r.text.includes(needle))
      if (missing.length) failures.push(`${where}: confined call did not return ${missing.join(', ')}: ${r.text.slice(0, 160)}`)
    }
    expect(failures).toEqual([])
  }, 120_000)

  it('a tool registered without a scope declaration fails when the server is built', () => {
    // Building the server reads only these fields; nothing here touches the database.
    const auth = {
      connection: { id: randomUUID(), scope: 'account', vaultId: null, repositoryId: null },
      user: { id: randomUUID(), role: 'member' },
    } as unknown as McpAuth
    const server = buildMcpServer(auth)
    expect(() =>
      server.registerTool('unscoped_probe', { description: 'no scope', inputSchema: {} }, async () => ({ content: [] })),
    ).toThrow(/scope/)
    expect(() => server.tool('unscoped_probe', async () => ({ content: [] }))).toThrow(/scope/)
    // Resources would be a second way to serve data without the scope check.
    expect(() =>
      server.registerResource('unscoped_probe', 'elara://probe', {}, async () => ({ contents: [] })),
    ).toThrow(/scope/)
    expect(() => server.resource('unscoped_probe', 'elara://probe', async () => ({ contents: [] }))).toThrow(/scope/)
  })
})
