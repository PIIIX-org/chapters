// Do vault-pinned and repository-pinned MCP tokens stay inside their pin?
//
// Admin owns: pinned vault P, other vault O, pinned repo RP, other repo RO.
// The vault-pinned token (P) and repo-pinned token (RP) are driven through
// EVERY tool in tools/list:
//   other-vault / other-repo  vaultId=O / repositoryId=RO        expect deny
//   pinned                    vaultId=P (vault token) / RP (repo)  expect allow
//                             (owner-admin actions on the pin — share, delete,
//                             rename, purge — are expected DENY as policy:
//                             a content-scoped token should not be able to
//                             widen access to or destroy its resource)
//   omitted                   optional vaultId/repositoryId left out:
//                             expect allow, confined to the pin (no leak)
//   account-surface           tools with no vault/repo id: expect deny
// Admin is owner of everything, so any denial is the pin's doing, and
// any success with another id is a scope breach. Allowed results are also
// scanned for "leak markers" (ids, names and a body marker of the other
// resources). The account token re-runs the read-only "other" cases as a
// control proving the arguments are valid.
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { McpClient, type JsonSchema, type ToolInfo, type ToolResult } from '../lib/mcp.ts'

const OTHER_REPO_URL = process.env.LAB_SCOPE_OTHER_REPO_URL ?? 'https://github.com/PIIIX-org/git-a-profile'
const PINNED_REPO_URL = process.env.LAB_SCOPE_PINNED_REPO_URL ?? 'https://github.com/PIIIX-org/portfolio.me'
const MARK = { P: 'LABPINNEDVAULTMARKER', O: 'LABOTHERVAULTMARKER' }
const SCOPE_DENIAL = /pinned to a different|is scoped to a (vault|repository)|requires an account-scoped connection|account-scoped connections only/i

/** Owner/admin actions on the token's own resource: expected denied by policy, not by isolation. */
const POLICY_DENY = new Set([
  'share_vault',
  'revoke_vault_share',
  'delete_vault',
  'purge_vault',
  'restore_vault',
  'update_vault',
  'share_repository',
  'revoke_repository_share',
  'delete_repository',
  'update_repository',
  'purge_note',
  'purge_revision',
])

/** 0 = read-only, 1 = mutating, 2 = destroys a fixture; run in this order. */
const LEVEL: Record<string, number> = {
  create_vault: 1, update_vault: 1, set_vault_graph_preference: 1, update_vault_preferences: 1, share_vault: 1,
  create_note: 1, edit_note: 1, rename_note: 1, restore_note: 1, revert_note: 1, connect_repository: 1,
  sync_repository: 1, update_repository: 1, set_repository_graph_preference: 1, share_repository: 1,
  create_team: 1, add_team_member: 1, mark_notification_read: 1, save_graph_perspective: 1, restore_vault: 1,
  revoke_vault_share: 2, delete_note: 2, revoke_repository_share: 2, remove_team_member: 2,
  delete_graph_perspective: 2, purge_note: 3, purge_revision: 3, delete_team: 3, purge_vault: 3,
  delete_repository: 4, delete_vault: 4,
}

interface VaultFixture {
  id: string
  name: string
  probe: string
  renameFrom: string
  deletePath: string
  trashId: string
  purgeId: string
  revisionId: string
  shareId: string
  perspectiveId: string
}
interface RepoFixture {
  id: string
  name: string
  files: string[]
  shareId: string
}
interface Fixtures {
  P: VaultFixture
  O: VaultFixture
  RP: RepoFixture
  RO: RepoFixture
  memberId: string
  memberEmail: string
  teamId: string
  notificationId: string
  globalPerspectiveId: string
}

type CaseKind = 'other-vault' | 'other-repo' | 'pinned' | 'omitted' | 'account-surface'
interface Case {
  token: 'vault' | 'repo' | 'account-control'
  tool: string
  kind: CaseKind
  args: Record<string, unknown>
  expect: 'deny' | 'allow'
  policy: boolean
  level: number
}
interface Outcome extends Case {
  actual: 'denied-scope' | 'allowed' | 'error'
  message: string
  leaks: string[]
  ms: number
  ok: boolean | null
}

let counter = 0
const seq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

/** Arguments for `tool` aimed at vault fixture v and/or repo fixture r. */
function argsFor(tool: string, fx: Fixtures, v: VaultFixture | undefined, r: RepoFixture | undefined, schema: ToolInfo['inputSchema']) {
  const vaultId = v?.id
  const repositoryId = r?.id
  const builders: Record<string, () => Record<string, unknown>> = {
    browse_vault: () => ({ vaultId }),
    update_vault: () => ({ vaultId, mergeable: false }),
    get_vault_graph_preference: () => ({ vaultId }),
    set_vault_graph_preference: () => ({ vaultId, include: true }),
    delete_vault: () => ({ vaultId }),
    restore_vault: () => ({ vaultId }),
    purge_vault: () => ({ vaultId }),
    list_vault_shares: () => ({ vaultId }),
    share_vault: () => ({ vaultId, granteeType: 'user', granteeId: fx.memberId, permission: 'read' }),
    revoke_vault_share: () => ({ vaultId, shareId: v?.shareId ?? crypto.randomUUID() }),
    read_note: () => ({ vaultId, path: v?.probe ?? 'concepts/lab-scope-probe' }),
    create_note: () => ({ vaultId, path: `concepts/lab-created-${seq()}`, frontmatter: { type: 'concepts' }, body: 'created by scope test' }),
    edit_note: () => ({ vaultId, path: v?.probe ?? 'concepts/lab-scope-probe', body: `${v === fx.O ? MARK.O : MARK.P}\nedited ${seq()}` }),
    rename_note: () => ({ vaultId, from: v?.renameFrom ?? 'concepts/lab-rename-probe', toName: `lab-renamed-${seq()}` }),
    delete_note: () => ({ vaultId, path: v?.deletePath ?? 'concepts/lab-delete-probe' }),
    list_trash: () => ({ vaultId }),
    restore_note: () => ({ vaultId, noteId: v?.trashId ?? crypto.randomUUID() }),
    purge_note: () => ({ vaultId, noteId: v?.purgeId ?? crypto.randomUUID() }),
    note_history: () => ({ vaultId, path: v?.probe ?? 'concepts/lab-scope-probe' }),
    revert_note: () => ({ vaultId, path: v?.probe ?? 'concepts/lab-scope-probe', revisionId: v?.revisionId ?? crypto.randomUUID() }),
    purge_revision: () => ({ vaultId, revisionId: v?.revisionId ?? crypto.randomUUID() }),
    export_vault: () => ({ vaultId }),
    export_note: () => ({ vaultId, path: v?.probe ?? 'concepts/lab-scope-probe' }),
    audit_okf_conformance: () => ({ vaultId }),
    list_graph_perspectives: () => ({ vaultId }),
    save_graph_perspective: () => ({ vaultId, name: `lab-perspective-${seq()}` }),
    search: () => ({ query: 'lab marker probe', vaultId, repositoryId, symbols: true, limit: 50 }),
    graph: () => ({ vaultId, repositoryId }),
    find_graph_path: () =>
      v
        ? { vaultId, source: v.probe, target: v.renameFrom }
        : { repositoryId, source: r?.files[0] ?? 'README.md', target: r?.files[1] ?? 'README.md' },
    find_symbols: () => ({ query: 'function', repositoryId, limit: 50 }),
    browse_repository: () => ({ repositoryId }),
    read_file: () => ({ repositoryId, path: r?.files[0] ?? 'README.md' }),
    repository_status: () => ({ repositoryId }),
    sync_repository: () => ({ repositoryId, force: true }),
    update_repository: () => ({ repositoryId, mergeable: false }),
    get_repository_graph_preference: () => ({ repositoryId }),
    set_repository_graph_preference: () => ({ repositoryId, include: true }),
    delete_repository: () => ({ repositoryId }),
    list_repository_shares: () => ({ repositoryId }),
    share_repository: () => ({ repositoryId, granteeType: 'user', granteeId: fx.memberId }),
    revoke_repository_share: () => ({ repositoryId, shareId: r?.shareId ?? crypto.randomUUID() }),
    // account surfaces
    list_vaults: () => ({}),
    create_vault: () => ({ name: `lab-scope-created-${seq()}` }),
    get_vault_preferences: () => ({}),
    update_vault_preferences: () => ({ vaultColors: { [fx.P.id]: '#00ff00', [fx.O.id]: '#ff0000' } }),
    list_repositories: () => ({}),
    connect_repository: () => ({ name: `lab-scope-connected-${seq()}`, ingestionMethod: 'git', gitUrl: OTHER_REPO_URL }),
    list_teams: () => ({}),
    create_team: () => ({ name: `lab-scope-team-${seq()}` }),
    list_team_members: () => ({ teamId: fx.teamId }),
    add_team_member: () => ({ teamId: fx.teamId, userId: fx.memberId }),
    remove_team_member: () => ({ teamId: fx.teamId, userId: fx.memberId }),
    delete_team: () => ({ teamId: fx.teamId }),
    lookup_user: () => ({ email: fx.memberEmail }),
    list_notifications: () => ({}),
    mark_notification_read: () => ({ notificationId: fx.notificationId }),
    delete_graph_perspective: () => ({ id: v ? v.perspectiveId : fx.globalPerspectiveId }),
  }
  const built = builders[tool]?.() ?? synthesize(schema, fx)
  // Drop undefined ids so "omitted" really omits them.
  return Object.fromEntries(Object.entries(built).filter(([, val]) => val !== undefined))
}

/** Fallback for tools added after this test was written: required props only. */
function synthesize(schema: ToolInfo['inputSchema'], fx: Fixtures): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of schema?.required ?? []) out[key] = sample(schema?.properties?.[key] ?? {}, fx)
  return out
}
function sample(s: JsonSchema, fx: Fixtures): unknown {
  if (s.enum) return s.enum[0]
  const type = Array.isArray(s.type) ? s.type[0] : s.type
  if (type === 'string') return s.format === 'uuid' ? crypto.randomUUID() : s.format === 'email' ? fx.memberEmail : 'lab'
  if (type === 'number' || type === 'integer') return s.minimum ?? 1
  if (type === 'boolean') return false
  if (type === 'array') return []
  if (type === 'object') return {}
  return 'lab'
}

function classify(c: Case, r: ToolResult): { actual: Outcome['actual']; message: string } {
  if (r.ok) return { actual: 'allowed', message: r.text.slice(0, 160) }
  // A perspective outside the pin answers "not found", like a missing id (no existence oracle).
  // prepare() makes a fresh perspective right before such a case, so here it is a denial.
  const hidden = c.tool === 'delete_graph_perspective' && c.expect === 'deny' && /^Error: not found$/.test(r.text)
  return { actual: hidden || SCOPE_DENIAL.test(r.text) ? 'denied-scope' : 'error', message: r.text.slice(0, 240) }
}

function buildCases(tools: ToolInfo[], fx: Fixtures): Case[] {
  const cases: Case[] = []
  for (const token of ['vault', 'repo'] as const) {
    for (const t of tools) {
      const props = t.inputSchema?.properties ?? {}
      const required = t.inputSchema?.required ?? []
      const hasV = 'vaultId' in props
      const hasR = 'repositoryId' in props
      const level = LEVEL[t.name] ?? 0
      const add = (kind: CaseKind, args: Record<string, unknown>, expect: Case['expect'], policy = false) =>
        cases.push({ token, tool: t.name, kind, args, expect, policy, level })
      if (t.name === 'delete_graph_perspective') {
        add('other-vault', { id: fx.O.perspectiveId }, 'deny')
        add('account-surface', { id: fx.globalPerspectiveId }, 'deny')
        if (token === 'vault') add('pinned', { id: fx.P.perspectiveId }, 'allow')
        continue
      }
      if (!hasV && !hasR) {
        add('account-surface', argsFor(t.name, fx, undefined, undefined, t.inputSchema), 'deny')
        continue
      }
      if (hasV) add('other-vault', argsFor(t.name, fx, fx.O, undefined, t.inputSchema), 'deny')
      if (hasR) add('other-repo', argsFor(t.name, fx, undefined, fx.RO, t.inputSchema), 'deny')
      const mineV = token === 'vault' && hasV
      const mineR = token === 'repo' && hasR
      if (mineV || mineR) {
        const policy = POLICY_DENY.has(t.name)
        add('pinned', argsFor(t.name, fx, mineV ? fx.P : undefined, mineR ? fx.RP : undefined, t.inputSchema), policy ? 'deny' : 'allow', policy)
      }
      const idOptional = (!hasV || !required.includes('vaultId')) && (!hasR || !required.includes('repositoryId'))
      if (idOptional) {
        // Omitted id: should resolve to the pin when the tool fits the token's resource kind, else be refused.
        const fits = mineV || mineR
        const policy = fits && POLICY_DENY.has(t.name)
        const fxV = token === 'vault' ? fx.P : undefined
        const fxR = token === 'repo' ? fx.RP : undefined
        const args = argsFor(t.name, fx, fxV, fxR, t.inputSchema)
        delete args.vaultId
        delete args.repositoryId
        add('omitted', args, fits && !policy ? 'allow' : 'deny', policy)
        // `everywhere: true` (search, find_symbols) is an account-wide surface by definition.
        if ('everywhere' in props) add('account-surface', { ...args, everywhere: true }, 'deny')
      }
    }
  }
  // Read-only "other" cases again with the account token: proves the args are valid.
  for (const c of [...cases]) {
    if (c.level === 0 && (c.kind === 'other-vault' || c.kind === 'other-repo') && c.token === 'vault') {
      cases.push({ ...c, token: 'account-control', expect: 'allow' })
    }
  }
  // Least destructive first; within a level "other"/surface, then the explicit pin, then the omitted id.
  const kindOrder: Record<CaseKind, number> = { 'other-vault': 0, 'other-repo': 0, 'account-surface': 1, pinned: 2, omitted: 3 }
  return cases.sort((a, b) => a.level - b.level || kindOrder[a.kind] - kindOrder[b.kind])
}

/**
 * Consuming tools (rename, delete, restore, purge, revoke) get a fresh target
 * made by the account token right before the case, so every case acts on an
 * object that exists and an earlier breach cannot make a later case vacuous.
 */
async function prepare(c: Case, acct: McpClient, fx: Fixtures, memberId: string): Promise<Record<string, unknown>> {
  const own = c.kind === 'pinned' || c.kind === 'omitted'
  const v = c.kind === 'other-vault' || c.token === 'account-control' ? fx.O : own && c.token === 'vault' ? fx.P : undefined
  const r = c.kind === 'other-repo' ? fx.RO : own && c.token === 'repo' ? fx.RP : undefined
  const args = { ...c.args }
  const freshNote = async (vaultId: string) => {
    const path = `concepts/lab-fresh-${seq()}`
    await acct.must('create_note', { vaultId, path, frontmatter: { type: 'concepts' }, body: 'fresh' })
    return path
  }
  const trashedNoteId = async (vaultId: string) => {
    const path = await freshNote(vaultId)
    await acct.must('delete_note', { vaultId, path })
    const trash = await acct.must<Array<{ id: string; path: string }>>('list_trash', { vaultId, limit: 100 })
    return trash.find((t) => t.path === path)!.id
  }
  if (v && c.tool === 'rename_note') args.from = await freshNote(v.id)
  if (v && c.tool === 'delete_note') args.path = await freshNote(v.id)
  if (v && (c.tool === 'restore_note' || c.tool === 'purge_note')) args.noteId = await trashedNoteId(v.id)
  if (v && c.tool === 'purge_revision') {
    const path = await freshNote(v.id)
    args.revisionId = (await acct.must<Array<{ id: string }>>('note_history', { vaultId: v.id, path }))[0]!.id
  }
  if (v && c.tool === 'revoke_vault_share') {
    await acct.must('share_vault', { vaultId: v.id, granteeType: 'user', granteeId: memberId, permission: 'read' })
    args.shareId = (await acct.must<Array<{ id: string }>>('list_vault_shares', { vaultId: v.id }))[0]!.id
  }
  if (r && c.tool === 'revoke_repository_share') {
    await acct.must('share_repository', { repositoryId: r.id, granteeType: 'user', granteeId: memberId })
    args.shareId = (await acct.must<Array<{ id: string }>>('list_repository_shares', { repositoryId: r.id }))[0]!.id
  }
  if (c.tool === 'delete_graph_perspective') {
    const vaultId = c.kind === 'account-surface' ? undefined : v?.id
    args.id = (await acct.must<{ id: string }>('save_graph_perspective', { vaultId, name: `lab-fresh-perspective-${seq()}` })).id
  }
  return args
}

async function waitIndexed(ctx: LabContext, repoIds: string[]) {
  const t0 = Date.now()
  for (;;) {
    const rows = await ctx.docker.psqlRows<{ id: string; status: string; files: number; embedded: number }>(`
      select r.id, r.sync_status as status,
        (select count(*) from repository_files f where f.repository_id = r.id)::int as files,
        (select count(*) from repository_files f where f.repository_id = r.id and f.embedding is not null)::int as embedded
      from repositories r where r.id in (${repoIds.map((id) => `'${id}'`).join(',')})`)
    if (rows.length === repoIds.length && rows.every((r) => r.status === 'idle' && r.files > 0 && r.embedded === r.files)) return rows
    if (Date.now() - t0 > 15 * 60_000) return rows
    // Real time on purpose: waiting on a live server's indexing queue.
    await Bun.sleep(3_000)
  }
}

async function vaultFixture(acct: McpClient, id: string, name: string, marker: string): Promise<Omit<VaultFixture, 'shareId' | 'perspectiveId'>> {
  const note = (path: string) => acct.must('create_note', { vaultId: id, path, frontmatter: { type: 'concepts', title: path }, body: `${marker}\n${path}` })
  await note('concepts/lab-scope-probe')
  await acct.must('edit_note', { vaultId: id, path: 'concepts/lab-scope-probe', body: `${marker}\nsecond revision` })
  await note('concepts/lab-rename-probe')
  await note('concepts/lab-delete-probe')
  await note('concepts/lab-trash-probe')
  await note('concepts/lab-purge-probe')
  await acct.must('delete_note', { vaultId: id, path: 'concepts/lab-trash-probe' })
  await acct.must('delete_note', { vaultId: id, path: 'concepts/lab-purge-probe' })
  const trash = await acct.must<Array<{ id: string; path: string }>>('list_trash', { vaultId: id })
  const history = await acct.must<Array<{ id: string }>>('note_history', { vaultId: id, path: 'concepts/lab-scope-probe' })
  return {
    id,
    name,
    probe: 'concepts/lab-scope-probe',
    renameFrom: 'concepts/lab-rename-probe',
    deletePath: 'concepts/lab-delete-probe',
    trashId: trash.find((t) => t.path.includes('lab-trash-probe'))!.id,
    purgeId: trash.find((t) => t.path.includes('lab-purge-probe'))!.id,
    revisionId: history.at(-1)!.id,
  }
}

const test: LabTest = {
  name: 'scoped-tokens',
  tier: 'fast',
  description: 'Vault-pinned and repo-pinned MCP tokens against every tool with other ids, omitted ids and account surfaces.',
  async run(ctx) {
    const env = ctx.env
    const acct = ctx.mcp('adminAccount')
    const memberAcct = ctx.mcp('memberAccount')

    // ---- fixtures (own pinned vault/repo/tokens: destructive cases must not touch bootstrap's)
    const pinnedVault = await ctx.createVault('admin', 'lab-scope-pinned')
    const pinnedRepo = await ctx.connectRepo('admin', 'lab-scope-pinned-repo', PINNED_REPO_URL)
    const otherVault = await ctx.createVault('admin', 'lab-other-vault')
    const otherRepo = await ctx.connectRepo('admin', 'lab-other-repo', OTHER_REPO_URL)
    const vaultToken = await ctx.mintToken('admin', 'lab scope vault-pinned', 'vault', { vaultId: pinnedVault.id })
    const repoToken = await ctx.mintToken('admin', 'lab scope repo-pinned', 'repository', { repositoryId: pinnedRepo.id })
    const P0 = await vaultFixture(acct, pinnedVault.id, 'lab-scope-pinned', MARK.P)
    const O0 = await vaultFixture(acct, otherVault.id, 'lab-other-vault', MARK.O)
    const shareIdFor = async (vaultId: string) => {
      await acct.must('share_vault', { vaultId, granteeType: 'user', granteeId: env.users.member.id, permission: 'read' })
      const shares = await acct.must<Array<{ id: string }>>('list_vault_shares', { vaultId })
      return shares[0]!.id
    }
    const perspective = async (vaultId?: string) =>
      (await acct.must<{ id: string }>('save_graph_perspective', { vaultId, name: `lab-${vaultId ? 'vault' : 'global'}-perspective` })).id
    const P: VaultFixture = { ...P0, shareId: await shareIdFor(P0.id), perspectiveId: await perspective(P0.id) }
    const O: VaultFixture = { ...O0, shareId: await shareIdFor(O0.id), perspectiveId: await perspective(O0.id) }
    const globalPerspectiveId = await perspective()

    const indexed = await waitIndexed(ctx, [pinnedRepo.id, otherRepo.id])
    const repoFixture = async (id: string, name: string): Promise<RepoFixture> => {
      await acct.must('share_repository', { repositoryId: id, granteeType: 'user', granteeId: env.users.member.id })
      const shares = await acct.must<Array<{ id: string }>>('list_repository_shares', { repositoryId: id })
      const files = await acct.must<Array<{ path: string; language: string | null }>>('browse_repository', { repositoryId: id })
      const code = files.filter((f) => f.language === 'python' || f.language === 'typescript' || f.language === 'javascript')
      return {
        id,
        name,
        files: (code.length >= 2 ? code : files).slice(0, 2).map((f) => f.path),
        shareId: shares[0]!.id,
      }
    }
    const RP = await repoFixture(pinnedRepo.id, 'lab-scope-pinned-repo')
    const RO = await repoFixture(otherRepo.id, 'lab-other-repo')

    const team = await acct.must<{ id: string }>('create_team', { name: 'lab-scope-team' })
    await acct.must('add_team_member', { teamId: team.id, userId: env.users.member.id })
    await acct.must('update_vault_preferences', { vaultColors: { [P.id]: '#00ff00', [O.id]: '#ff0000' }, favorites: { [O.id]: true } })
    const memberVault = await memberAcct.must<{ id: string }>('create_vault', { name: 'lab-member-vault' })
    await memberAcct.must('share_vault', { vaultId: memberVault.id, granteeType: 'user', granteeId: env.users.admin.id, permission: 'read' })
    const notifications = await acct.must<Array<{ id: string }>>('list_notifications', {})

    const fx: Fixtures = {
      P, O, RP, RO,
      memberId: env.users.member.id,
      memberEmail: env.users.member.email,
      teamId: team.id,
      notificationId: notifications[0]?.id ?? crypto.randomUUID(),
      globalPerspectiveId,
    }

    // Leak markers: every vault/repo id on the instance except the token's own pin (other tests'
    // repos and vaults included), the other-vault body marker and the global perspective.
    const allVaults = await ctx.docker.psqlRows<{ id: string }>('select id from vaults')
    const allRepos = await ctx.docker.psqlRows<{ id: string }>('select id from repositories')
    const markersExcept = (pin: string, extra: Record<string, string>) => ({
      ...Object.fromEntries(allVaults.filter((x) => x.id !== pin).map((x) => [x.id, x.id === O.id ? 'other vault id' : 'a vault id'])),
      ...Object.fromEntries(allRepos.filter((x) => x.id !== pin).map((x) => [x.id, x.id === RO.id ? 'other repo id' : 'a repository id'])),
      [MARK.O]: 'other vault note body',
      [globalPerspectiveId]: 'global perspective',
      ...extra,
    })
    const markers = {
      vault: markersExcept(P.id, {}),
      repo: markersExcept(RP.id, { [MARK.P]: 'vault note body (repo token)' }),
    }

    // ---- matrix
    const tools = await acct.listTools()
    const cases = buildCases(tools, fx)
    const clients = {
      vault: ctx.mcp(vaultToken.token, 'vault-pinned'),
      repo: ctx.mcp(repoToken.token, 'repo-pinned'),
      'account-control': acct,
    }
    const outcomes: Outcome[] = []
    for (const c of cases) {
      const args = await prepare(c, acct, fx, env.users.member.id)
      const r = await clients[c.token].call(c.tool, args)
      const { actual, message } = classify(c, r)
      const scan = c.token === 'account-control' ? {} : markers[c.token]
      const leaks = r.ok ? Object.entries(scan).filter(([needle]) => r.text.includes(needle)).map(([, what]) => what) : []
      // An omitted vaultId that creates/lists GLOBAL perspectives has escaped the pin even without a marker.
      if (r.ok && c.token === 'vault' && c.tool.includes('graph_perspective') && r.text.includes('"vaultId":null')) {
        leaks.push('account-wide perspective (vaultId null)')
      }
      let ok: boolean | null
      if (c.expect === 'deny') ok = actual === 'denied-scope' ? true : actual === 'allowed' ? false : null
      else ok = actual === 'allowed' ? leaks.length === 0 : actual === 'denied-scope' ? false : null
      outcomes.push({ ...c, args, actual, message, leaks, ms: Math.round(r.ms), ok })
      // Keep fixtures alive for later cases when a breach destroyed one.
      if (actual === 'allowed' && c.tool === 'delete_vault') await acct.call('restore_vault', { vaultId: String(r.text.match(/[0-9a-f-]{36}/)?.[0]) })
    }

    // ---- checks
    const checks: Check[] = outcomes
      .filter((o) => o.token !== 'account-control')
      .map((o) => ({
        name: `${o.token}-pinned ${o.tool} [${o.kind}]`,
        expected: o.expect === 'deny' ? (o.policy ? 'deny (policy)' : 'deny') : 'allow, no leak',
        actual: `${o.actual}${o.leaks.length ? ` LEAKS: ${o.leaks.join(', ')}` : ''} — ${o.message.slice(0, 120)}`,
        ok: o.ok,
        severity: o.ok !== false ? 'info' : o.policy ? 'medium' : o.level >= 2 || o.leaks.length > 0 ? 'critical' : 'high',
        detail: o.args,
      }))
    const control = outcomes.filter((o) => o.token === 'account-control')
    checks.push({
      name: 'account-token control: read-only other-resource cases succeed',
      expected: `${control.length} allowed`,
      actual: `${control.filter((o) => o.actual === 'allowed').length} allowed; failing: ${control.filter((o) => o.actual !== 'allowed').map((o) => `${o.tool}(${o.message.slice(0, 60)})`).join('; ')}`,
      ok: control.every((o) => o.actual === 'allowed') ? true : null,
      severity: 'info',
    })

    const pinnedOnly = outcomes.filter((o) => o.token !== 'account-control')
    const breaches = pinnedOnly.filter((o) => o.ok === false && !o.policy)
    const policy = pinnedOnly.filter((o) => o.ok === false && o.policy)
    const inconclusive = pinnedOnly.filter((o) => o.ok === null)
    return {
      summary:
        `${tools.length} tools, ${pinnedOnly.length} pinned-token cases. Isolation breaches (allowed outside the pin, or leaked other resources): ${breaches.length}` +
        (breaches.length ? ` — ${breaches.map((b) => `${b.token}:${b.tool}[${b.kind}]`).join(', ')}` : '') +
        `. Policy (owner actions on the pin allowed): ${policy.length}` +
        (policy.length ? ` — ${policy.map((b) => `${b.token}:${b.tool}`).join(', ')}` : '') +
        `. Inconclusive (non-scope error): ${inconclusive.length}.`,
      checks,
      data: {
        ids: { P: P.id, O: O.id, RP: RP.id, RO: RO.id, team: team.id, globalPerspectiveId, memberVault: memberVault.id },
        indexed,
        tools: tools.map((t) => t.name),
        matrix: outcomes.map(({ token, tool, kind, expect, policy: pol, level, actual, leaks, ok, ms, message, args }) => ({ token, tool, kind, expect, policy: pol, level, actual, leaks, ok, ms, message, args })),
      },
    }
  },
}
export default test
