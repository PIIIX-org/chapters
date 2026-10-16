// Instance backup -> restore into a fresh database, then diff.
//
// Backups are enabled by lab/docker-compose.lab.yml (BACKUP_LOCAL_PATH=
// /data/backups, BACKUP_RETENTION_COUNT=3; config.ts backup.*). The test
// builds a realistic instance state (vault with nesting/unicode/links/
// attachments/revisions/trash/shares, a team, a trashed vault, a revoked
// and a live MCP token, an MFA-enabled user), triggers backups through
// POST /api/admin/backup/run (what the admin UI's "Run backup" calls),
// then restores the newest file with the documented CLI
// (`pnpm restore-backup <zip>`, server/src/scripts/restore-backup.ts):
//   1. against the live instance (must refuse),
//   2. into a fresh database `elara_restore` + DATA_DIR=/data/restore via a
//      one-off `docker compose run` of the same image.
// If the untouched backup does not restore, the failure is the finding; to
// still measure what a restore carries, known blockers are patched one at a
// time in a COPY of the archive (each patch is recorded) and retried.
// A second app container is then booted on the restored database (port 3001)
// to check logins, MFA, MCP tokens and attachments end to end.
import { createHmac } from 'node:crypto'
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import { waitHealthy, type ExecResult } from '../lib/docker.ts'
import { McpClient } from '../lib/mcp.ts'
import { RestSession } from '../lib/rest.ts'
import {
  assetSnapshot,
  getRaw,
  canon,
  makePdf,
  makePng,
  noteSnapshot,
  poll,
  postFile,
  psqlDb,
  psqlRowsDb,
  readZip,
  sha256,
  type NoteRow,
} from '../lib/portability.ts'

const RESTORE_DB = 'elara_restore'
const RESTORE_DIR = '/data/restore'
const RESTORED_PORT = 3001
const CLI_TIMEOUT_MS = Number(process.env.LAB_RESTORE_CLI_TIMEOUT_MS ?? 8 * 60_000)

function base32Decode(s: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(c)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >> bits) & 0xff)
      value &= (1 << bits) - 1
    }
  }
  return new Uint8Array(out)
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what otpauth's TOTP defaults to (auth/mfa.ts:10-16). */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const o = h[h.length - 1]! & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Signup -> mailpit code -> verify -> admin approve -> login (lab/bootstrap.ts flow). */
async function newUser(ctx: LabContext, email: string, password: string): Promise<{ id: string; session: RestSession }> {
  const signup = await new RestSession(ctx.baseUrl).post('/api/signup', { email, password })
  if (signup.status !== 200) throw new Error(`signup ${email}: ${signup.status} ${signup.text}`)
  const code = await poll(async () => {
    const list = (await (await fetch(`${ctx.env.mailpitUrl}/api/v1/messages`)).json()) as {
      messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>
    }
    const msg = list.messages.find((m) => m.To.some((t) => t.Address === email) && /verify/i.test(m.Subject))
    if (!msg) return undefined
    const full = (await (await fetch(`${ctx.env.mailpitUrl}/api/v1/message/${msg.ID}`)).json()) as { Text: string }
    return /verification code is (\S+)/.exec(full.Text)?.[1]
  }, 60_000, 1_000)
  if (!code) throw new Error(`no verification mail for ${email}`)
  const verify = await new RestSession(ctx.baseUrl).post('/api/verify-email', { email, code })
  if (verify.status !== 200) throw new Error(`verify ${email}: ${verify.status} ${verify.text}`)
  const pending = await ctx.rest('admin').must<Array<{ id: string; email: string }>>('GET', '/api/admin/users?status=pending_approval')
  const row = pending.find((u) => u.email === email)
  if (!row) throw new Error(`${email} not pending approval`)
  await ctx.rest('admin').must('POST', `/api/admin/users/${row.id}/approve`, {})
  return { id: row.id, session: await RestSession.login(ctx.baseUrl, email, password) }
}

interface Timed extends ExecResult {
  timedOut: boolean
}

/** A docker command with a hard deadline: on timeout the named container is removed. */
async function runWithDeadline(ctx: LabContext, container: string, args: string[], ms: number): Promise<Timed> {
  const running = ctx.docker.exec(args)
  let timer: Timer | undefined
  // Process control, not a test wait: the CLI may legitimately hang (embedding queue after sql.end()).
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  const first = await Promise.race([running, deadline])
  clearTimeout(timer)
  if (first === 'timeout') {
    await ctx.docker.exec(['docker', 'rm', '-f', container])
    return { ...(await running), timedOut: true }
  }
  return { ...first, timedOut: false }
}

const appExec = (ctx: LabContext, cmd: string) => ctx.docker.appExec(['sh', '-c', cmd])

const PATCH_JS = `
const AdmZip = require('adm-zip')
const z = new AdmZip(process.env.SRC)
const d = JSON.parse(z.getEntry('account-dump.json').getData().toString('utf8'))
const p = process.env.PATCHES.split(',')
const changed = {}
if (p.includes('vault-deletedAt-null')) changed.vaultsUntrashed = d.vaults.filter((v) => v.deletedAt).map((v) => { v.deletedAt = null; return v.id })
if (p.includes('drop-repo-mcp')) { const before = d.mcpConnections.length; d.mcpConnections = d.mcpConnections.filter((c) => !c.repositoryId); changed.mcpDropped = before - d.mcpConnections.length }
z.updateFile('account-dump.json', Buffer.from(JSON.stringify(d, null, 2), 'utf8'))
require('fs').mkdirSync(require('path').dirname(process.env.DST), { recursive: true })
z.writeZip(process.env.DST)
console.log(JSON.stringify(changed))
`

/** Known restore blockers -> the minimal archive patch that gets past each (recorded, never silent). */
function patchFor(err: string): string | undefined {
  if (/toISOString/.test(err)) return 'vault-deletedAt-null'
  if (/mcp_connections_repository_id|repository_id.*foreign key|foreign key.*repositor/i.test(err)) return 'drop-repo-mcp'
  return undefined
}

interface Attempt {
  n: number
  archive: string
  patches: string[]
  patchOutput?: string
  command: string
  code: number
  timedOut: boolean
  ms: number
  stdout: string
  stderr: string
  error?: string
}

const test: LabTest = {
  name: 'backup-restore',
  description: 'Local backups via BACKUP_LOCAL_PATH; POST /api/admin/backup/run; pnpm restore-backup into a fresh DB; diff + boot restored instance.',
  async run(ctx) {
    const checks: Check[] = []
    const admin = ctx.rest('admin')
    const member = ctx.rest('member')
    const mcp = ctx.mcp('adminAccount')
    const base = ctx.baseUrl

    // ------------------------------------------------------- config
    const status = await admin.get<{ configured: boolean; destinations: string[]; localPath?: string; retentionCount: number; intervalHours: number }>(
      '/api/admin/backup/status',
    )
    const memberStatus = await member.get('/api/admin/backup/status')
    checks.push({
      name: 'backup status reports the local destination from env',
      expected: 'configured, destinations [local], /data/backups, retention 3',
      actual: JSON.stringify(status.json),
      ok: Boolean(status.json?.configured && status.json.destinations.includes('local') && status.json.localPath === '/data/backups' && status.json.retentionCount === 3),
      severity: 'high',
    })
    checks.push({ name: 'non-admin cannot read backup status', expected: '403', actual: String(memberStatus.status), ok: memberStatus.status === 403, severity: 'high' })

    // ------------------------------------------------------ fixture
    const vault = await ctx.createVault('admin', ctx.uniq('br-src'))
    const V = vault.id
    const pngBytes = makePng(20, 10, 11)
    const pdfBytes = makePdf('backup restore attachment')
    const upPng = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'diagram.png', pngBytes, 'image/png')
    const upPdf = await postFile(base, `/api/vaults/${V}/assets`, admin.cookie, 'spec.pdf', pdfBytes, 'application/pdf')
    // Shape: notes/routes.ts:314-320.
    const pngName = (upPng.json as { fileName: string }).fileName
    const pdfName = (upPdf.json as { fileName: string }).fileName
    const notes: Array<{ path: string; frontmatter: Record<string, unknown>; body: string }> = [
      { path: 'concepts/a/b/c/d/e/f/deep', frontmatter: { type: 'concepts', title: 'Eight segments' }, body: 'deep\n' },
      {
        path: 'concepts/persian',
        frontmatter: { type: 'concepts', title: 'یادداشت فارسی 🚀', tags: ['فارسی', 'emoji-🎉'], status: 'stable', verified: { tier: 'human-reviewed', by: 'human:lab' } },
        body: 'متن فارسی با نیم‌فاصله، ی و ک.\r\nEmoji 👨‍👩‍👧 and 𝔘.\n',
      },
      {
        path: 'concepts/links',
        frontmatter: { type: 'concepts', sources: [{ resource: 'repo:lab-pinned-repo/README.md' }] },
        body: `[[concepts/persian]] [[concepts/a/b/c/d/e/f/deep|deep]] [[repo:lab-pinned-repo/README.md#top]]\n![diagram](/api/vaults/${V}/assets/${pngName})\n[spec](/api/vaults/${V}/assets/${pdfName})\n`,
      },
      { path: 'concepts/edited', frontmatter: { type: 'concepts' }, body: 'one\n' },
      { path: 'concepts/trashed', frontmatter: { type: 'concepts' }, body: 'in the trash\n' },
    ]
    for (const n of notes) await mcp.must('create_note', { vaultId: V, ...n })
    await mcp.must('edit_note', { vaultId: V, path: 'concepts/edited', body: 'two\n' })
    await mcp.must('edit_note', { vaultId: V, path: 'concepts/edited', body: 'three\n' })
    await mcp.must('delete_note', { vaultId: V, path: 'concepts/trashed' })
    await mcp.must('share_vault', { vaultId: V, granteeType: 'user', granteeId: ctx.env.users.member.id, permission: 'read' })
    const team = await mcp.must<{ id: string }>('create_team', { name: ctx.uniq('br-team') })
    await mcp.must('add_team_member', { teamId: team.id, userId: ctx.env.users.member.id })
    await mcp.must('share_vault', { vaultId: V, granteeType: 'team', granteeId: team.id, permission: 'edit' })
    const trashedVault = await ctx.createVault('admin', ctx.uniq('br-trashed-vault'))
    await mcp.must('create_note', { vaultId: trashedVault.id, path: 'concepts/inside-trashed-vault', frontmatter: { type: 'concepts' }, body: 'x\n' })
    await mcp.must('delete_vault', { vaultId: trashedVault.id })
    const liveToken = await ctx.mintToken('admin', 'br-live-token')
    const revokedToken = await ctx.mintToken('admin', 'br-revoked-token')
    await admin.must('POST', `/api/mcp-connections/${revokedToken.id}/revoke`, {})
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${liveToken.token}\n::add-mask::${revokedToken.token}`)

    const mfaEmail = `${ctx.uniq('mfa')}@example.com`
    const mfaPassword = `Lab-${crypto.randomUUID()}`
    if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${mfaPassword}`)
    const mfaUser = await newUser(ctx, mfaEmail, mfaPassword)
    const setup = await mfaUser.session.post<{ secret: string }>('/api/mfa/setup', {})
    const secret = setup.json?.secret ?? ''
    if (process.env.GITHUB_ACTIONS && secret) console.log(`::add-mask::${secret}`)
    const enable = await mfaUser.session.post('/api/mfa/enable', { code: totp(secret) })
    const mfaLoginSource = await new RestSession(base).post('/api/login', { email: mfaEmail, password: mfaPassword, totp: totp(secret) })
    checks.push({
      name: 'fixture: MFA user enrolled and can log in with TOTP on the source instance',
      expected: 'enable 200, login 200',
      actual: `setup ${setup.status}, enable ${enable.status}, login ${mfaLoginSource.status}`,
      ok: enable.status === 200 && mfaLoginSource.status === 200,
      severity: 'info',
    })
    await poll(async () => {
      const r = await ctx.docker.psqlRows<{ n: number }>(`select count(*)::int as n from note_revisions r join notes n on n.id = r.note_id where n.vault_id = '${V}'`)
      return (r[0]?.n ?? 0) >= 8 ? true : undefined
    }, 20_000)

    // -------------------------------------------- source ground truth
    const sourceTables = {
      users: await ctx.docker.psqlRows<Record<string, unknown>>(
        `select id, email, password_hash, role, status, mfa_enabled_at is not null as mfa, totp_secret is not null as has_totp from users order by id`,
      ),
      teams: await ctx.docker.psqlRows(`select id, name from teams order by id`),
      team_memberships: await ctx.docker.psqlRows(`select team_id, user_id, role from team_memberships order by team_id, user_id`),
      vaults: await ctx.docker.psqlRows(`select id, name, owner_id, mergeable, deleted_at is not null as trashed from vaults order by id`),
      vault_shares: await ctx.docker.psqlRows(`select id, vault_id, grantee_type, grantee_id, permission from vault_shares order by id`),
      mcp_connections: await ctx.docker.psqlRows(
        `select id, user_id, name, scope, vault_id, repository_id, token_hash, access, allowed_tools, floor(extract(epoch from expires_at) * 1000)::bigint as expires_at_ms, revoked_at is not null as revoked from mcp_connections order by id`,
      ),
      repositories: await ctx.docker.psqlRows(`select id, name from repositories order by id`),
      mfa_backup_codes: await ctx.docker.psqlRows(`select user_id, count(*)::int as n from mfa_backup_codes group by user_id order by user_id`),
      sessions: await ctx.docker.psqlRows(`select count(*)::int as n from sessions`),
      security_events: await ctx.docker.psqlRows(`select count(*)::int as n from security_events`),
      notifications: await ctx.docker.psqlRows(`select count(*)::int as n from notifications`),
    }
    const allVaultIds = (sourceTables.vaults as Array<{ id: string }>).map((v) => v.id)

    // -------------------------------------------------------- backups
    const runs: Array<{ status: number; body: unknown }> = []
    for (let i = 0; i < 4; i++) {
      const r = await admin.post<{ success: boolean; result: { filename: string; sizeBytes: number; prunedCount: number } }>('/api/admin/backup/run', {})
      runs.push({ status: r.status, body: r.json ?? r.text })
    }
    const lastRun = runs.at(-1)?.body as { result?: { filename: string; sizeBytes: number } } | undefined
    const file = lastRun?.result?.filename
    const listing = (await appExec(ctx, 'ls -1 /data/backups 2>/dev/null; true')).stdout.split('\n').filter(Boolean)
    const fileStat = file ? (await appExec(ctx, `stat -c '%a %U %s' /data/backups/${file}`)).stdout.trim() : ''
    const memberRun = await member.post('/api/admin/backup/run', {})
    checks.push({
      name: 'POST /api/admin/backup/run writes a zip to BACKUP_LOCAL_PATH',
      expected: '4 x 200, file present',
      actual: `${runs.map((r) => r.status).join(',')}; ${file ?? 'no filename'} (${fileStat})`,
      ok: runs.every((r) => r.status === 200) && Boolean(file && listing.includes(file)),
      severity: 'critical',
    })
    checks.push({
      name: 'retention prunes to BACKUP_RETENTION_COUNT',
      expected: '3 elara-backup-*.zip after 4 runs',
      actual: `${listing.filter((f) => /^elara-backup-.*\.zip$/.test(f)).length}: ${listing.join(', ')}`,
      ok: listing.filter((f) => /^elara-backup-.*\.zip$/.test(f)).length === 3,
      severity: 'medium',
    })
    checks.push({ name: 'non-admin cannot trigger a backup', expected: '403', actual: String(memberRun.status), ok: memberRun.status === 403, severity: 'high' })
    checks.push({
      name: 'backup file (holds password + token hashes) is not world-readable',
      expected: 'mode 600/640',
      actual: fileStat,
      ok: /^6[04]0 /.test(fileStat),
      severity: 'low',
    })
    if (!file) throw new Error(`backup run failed: ${JSON.stringify(runs)}`)

    // Content of the archive.
    const b64 = await appExec(ctx, `base64 -w0 /data/backups/${file}`)
    const zip = readZip(new Uint8Array(Buffer.from(b64.stdout.trim(), 'base64')))
    const dumpEntry = zip.find((e) => e.name === 'account-dump.json')
    const dump = dumpEntry ? (JSON.parse(new TextDecoder().decode(dumpEntry.data)) as Record<string, Array<Record<string, unknown>>>) : {}
    const archiveSummary = {
      entries: zip.length,
      notes: zip.filter((e) => /^vaults\/[^/]+\/.+\.md$/.test(e.name)).length,
      assets: zip.filter((e) => /^vaults\/[^/]+\/assets\//.test(e.name)).length,
      dumpTables: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])),
      hasPasswordHashes: (dump.users ?? []).some((u) => typeof u.passwordHash === 'string' && u.passwordHash.length > 0),
      mfaUserTotpInDump: (dump.users ?? []).find((u) => u.email === mfaEmail)?.totpSecret ?? null,
      mfaUserMfaEnabledAtInDump: (dump.users ?? []).find((u) => u.email === mfaEmail)?.mfaEnabledAt ?? null,
      missingTables: ['repositories', 'note_revisions', 'note_links', 'mfa_backup_codes', 'sessions', 'repository_shares', 'graph_perspectives', 'user_vault_preferences', 'export_links'].filter(
        (t) => !(t.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()) in dump),
      ),
    }
    const download = await getRaw(base, '/api/admin/backup', admin.cookie)
    const downloadZip = download.status === 200 ? readZip(download.bytes) : []
    checks.push({
      name: 'UI download (GET /api/admin/backup) has the same entry set as the scheduled/local file',
      expected: 'same entry names',
      actual: `download ${download.status} ${downloadZip.length} entries vs file ${zip.length}`,
      ok: download.status === 200 && downloadZip.map((e) => e.name).sort().join() === zip.map((e) => e.name).sort().join(),
      severity: 'low',
    })

    // ------------------------------------- restore 1: the live instance
    const liveRestore = await runWithDeadline(
      ctx,
      'lab-restore-live',
      [...ctx.docker.COMPOSE, 'exec', '-T', '-e', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'app', 'pnpm', 'restore-backup', `/data/backups/${file}`],
      CLI_TIMEOUT_MS,
    )
    const liveUsersAfter = await ctx.docker.psql('select count(*) from users')
    checks.push({
      name: 'documented `docker compose exec app pnpm restore-backup` refuses a non-empty instance',
      expected: 'non-zero exit, "Refusing to restore", data untouched',
      actual: `exit ${liveRestore.code}; ${(liveRestore.stderr + liveRestore.stdout).trim().slice(-200)}; users ${liveUsersAfter}`,
      ok: liveRestore.code !== 0 && /Refusing to restore/.test(liveRestore.stderr + liveRestore.stdout) && Number(liveUsersAfter) === sourceTables.users.length,
      severity: 'high',
    })

    // ---------------------------------- restore 2: fresh DB, ladder
    const attempts: Attempt[] = []
    let archive = `/data/backups/${file}`
    const patches: string[] = []
    let restored: Attempt | undefined
    let useNodeFallback = false
    for (let n = 1; n <= 5 && !restored; n++) {
      await psqlDb('"$POSTGRES_DB"', `drop database if exists ${RESTORE_DB} with (force);`)
      await psqlDb('"$POSTGRES_DB"', `create database ${RESTORE_DB};`)
      await appExec(ctx, `rm -rf ${RESTORE_DIR}`)
      const cli = useNodeFallback ? 'node --import tsx src/scripts/restore-backup.ts' : 'pnpm restore-backup'
      const command = `export DATABASE_URL="\${DATABASE_URL%/*}/${RESTORE_DB}" COREPACK_ENABLE_DOWNLOAD_PROMPT=0; ${cli} ${archive}`
      const t0 = performance.now()
      const r = await runWithDeadline(
        ctx,
        `lab-restore-cli-${n}`,
        [...ctx.docker.COMPOSE, 'run', '--rm', '--no-deps', '-T', '--name', `lab-restore-cli-${n}`, '-e', `DATA_DIR=${RESTORE_DIR}`, '-e', `LOCAL_REPOS_ROOT=${RESTORE_DIR}/local-repos`, 'app', 'sh', '-c', command],
        CLI_TIMEOUT_MS,
      )
      const attempt: Attempt = {
        n,
        archive,
        patches: [...patches],
        command: command.replace(/DATABASE_URL="[^"]*"/, 'DATABASE_URL=<...>/elara_restore'),
        code: r.code,
        timedOut: r.timedOut,
        ms: Math.round(performance.now() - t0),
        stdout: r.stdout.slice(-4000),
        stderr: r.stderr.slice(-4000),
      }
      attempts.push(attempt)
      ctx.log(`restore attempt ${n}: exit ${r.code} timedOut ${r.timedOut} ${attempt.ms} ms`)
      if (/Restore complete/.test(r.stdout)) {
        restored = attempt
        break
      }
      const err = `${r.stderr}\n${r.stdout}`
      if (!useNodeFallback && /pnpm|corepack/i.test(err) && !/restore\.ts|drizzle|postgres|violates|toISOString/i.test(err)) {
        useNodeFallback = true
        attempt.error = 'pnpm unavailable in the image; retrying with node --import tsx'
        continue
      }
      const patch = patchFor(err)
      if (!patch || patches.includes(patch)) {
        attempt.error = 'no known patch for this failure'
        break
      }
      patches.push(patch)
      const dst = `/data/backups-patched/attempt-${n + 1}.zip`
      const p = await ctx.docker.exec([
        ...ctx.docker.COMPOSE,
        'exec',
        '-T',
        '-e',
        `SRC=/data/backups/${file}`,
        '-e',
        `DST=${dst}`,
        '-e',
        `PATCHES=${patches.join(',')}`,
        'app',
        'node',
        '-e',
        PATCH_JS,
      ])
      attempt.patchOutput = `${p.code} ${p.stdout.trim()} ${p.stderr.slice(0, 300)}`
      archive = dst
    }
    const first = attempts[0]
    checks.push({
      name: 'unmodified backup restores into a fresh database (pnpm restore-backup)',
      expected: 'Restore complete',
      actual: first ? `exit ${first.code}${first.timedOut ? ' (timed out)' : ''}: ${(first.stderr || first.stdout).split('\n').filter((l) => /Error|error|violat|toISOString|Refus/.test(l)).slice(0, 2).join(' | ').slice(0, 260)}` : 'not run',
      ok: restored?.n === 1 && restored.patches.length === 0,
      severity: 'critical',
      detail: attempts,
    })
    for (const p of patches) {
      const why =
        p === 'drop-repo-mcp'
          ? 'mcp_connections rows pinned to a repository reference repositories, which the dump does not contain (archive.ts:96-109) -> FK violation; any instance with a repository-scoped MCP token cannot be restored'
          : 'restore.ts:91 converts only vaults.createdAt; a trashed vault (deletedAt string) makes drizzle call toISOString on a string'
      checks.push({ name: `restore blocker needed patch "${p}"`, expected: 'no patch needed', actual: why, ok: false, severity: 'critical' })
    }
    if (restored && (restored.timedOut || restored.code !== 0)) {
      checks.push({
        name: 'restore CLI exits cleanly after "Restore complete"',
        expected: 'exit 0 promptly',
        actual: `exit ${restored.code}, timedOut ${restored.timedOut}, ${restored.ms} ms`,
        ok: false,
        severity: 'medium',
      })
    }

    // ------------------------------------------------------------ diff
    const diffTable: Array<Record<string, unknown>> = []
    let restoredNotes: NoteRow[] = []
    let srcNotes: NoteRow[] = []
    const restoredChecks: Record<string, unknown> = {}
    if (restored) {
      const rq = <T = Record<string, unknown>>(q: string) => psqlRowsDb<T>(RESTORE_DB, q)
      const restoredTables = {
        users: await rq(`select id, email, password_hash, role, status, mfa_enabled_at is not null as mfa, totp_secret is not null as has_totp from users order by id`),
        teams: await rq(`select id, name from teams order by id`),
        team_memberships: await rq(`select team_id, user_id, role from team_memberships order by team_id, user_id`),
        vaults: await rq(`select id, name, owner_id, mergeable, deleted_at is not null as trashed from vaults order by id`),
        vault_shares: await rq(`select id, vault_id, grantee_type, grantee_id, permission from vault_shares order by id`),
        mcp_connections: await rq(`select id, user_id, name, scope, vault_id, repository_id, token_hash, access, allowed_tools, floor(extract(epoch from expires_at) * 1000)::bigint as expires_at_ms, revoked_at is not null as revoked from mcp_connections order by id`),
        repositories: await rq(`select id, name from repositories order by id`),
        mfa_backup_codes: await rq(`select user_id, count(*)::int as n from mfa_backup_codes group by user_id order by user_id`),
        sessions: await rq(`select count(*)::int as n from sessions`),
        security_events: await rq(`select count(*)::int as n from security_events`),
        notifications: await rq(`select count(*)::int as n from notifications`),
      }
      for (const [table, rows] of Object.entries(sourceTables) as Array<[keyof typeof sourceTables, Array<Record<string, unknown>>]>) {
        const other = restoredTables[table] as Array<Record<string, unknown>>
        const key = (r: Record<string, unknown>) => JSON.stringify(r)
        const otherKeys = new Set(other.map(key))
        const srcKeys = new Set(rows.map(key))
        diffTable.push({
          table,
          source: rows.length === 1 && 'n' in rows[0]! ? rows[0]!.n : rows.length,
          restored: other.length === 1 && 'n' in other[0]! ? other[0]!.n : other.length,
          missingOrChanged: rows.filter((r) => !otherKeys.has(key(r))).length,
          extra: other.filter((r) => !srcKeys.has(key(r))).length,
          sampleMissing: rows.filter((r) => !otherKeys.has(key(r))).slice(0, 3).map((r) => ({ ...r, password_hash: r.password_hash ? '<hash>' : undefined, token_hash: r.token_hash ? '<hash>' : undefined })),
        })
      }
      srcNotes = await noteSnapshot(null, allVaultIds)
      restoredNotes = await noteSnapshot(RESTORE_DB, allVaultIds)
      const k = (r: NoteRow) => `${r.vault_id}/${r.path}${r.trashed ? ' (trash)' : ''}`
      const restoredByKey = new Map(restoredNotes.map((r) => [k(r), r]))
      const noteDiff = srcNotes.map((s) => {
        const r = restoredByKey.get(k(s))
        return {
          note: k(s),
          present: Boolean(r),
          sameId: r?.id === s.id,
          frontmatterEqual: r ? canon(r.frontmatter) === canon(s.frontmatter) : false,
          bodyEqual: r ? r.body === s.body : false,
          revisions: `${s.revisions} -> ${r?.revisions ?? 0}`,
          links: `${s.links.length} -> ${r?.links.length ?? 0}`,
        }
      })
      const live = noteDiff.filter((d) => !d.note.endsWith('(trash)'))
      diffTable.push({ table: 'notes (live)', source: live.length, restored: restoredNotes.filter((r) => !r.trashed).length, missingOrChanged: live.filter((d) => !d.present || !d.frontmatterEqual || !d.bodyEqual).length, extra: 0 })
      diffTable.push({ table: 'notes (trash)', source: srcNotes.filter((r) => r.trashed).length, restored: restoredNotes.filter((r) => r.trashed).length, missingOrChanged: noteDiff.filter((d) => d.note.endsWith('(trash)') && !d.present).length, extra: 0 })
      diffTable.push({ table: 'note ids preserved', source: live.length, restored: live.filter((d) => d.sameId).length, missingOrChanged: live.filter((d) => !d.sameId).length, extra: 0 })
      diffTable.push({
        table: 'note_revisions',
        source: srcNotes.reduce((n, r) => n + r.revisions, 0),
        restored: restoredNotes.reduce((n, r) => n + r.revisions, 0),
        missingOrChanged: srcNotes.reduce((n, r) => n + r.revisions, 0) - restoredNotes.reduce((n, r) => n + r.revisions, 0),
        extra: 0,
      })
      diffTable.push({ table: 'note_links', source: srcNotes.reduce((n, r) => n + r.links.length, 0), restored: restoredNotes.reduce((n, r) => n + r.links.length, 0), missingOrChanged: 0, extra: 0 })
      const sumAssets = async (root: string) =>
        (await appExec(ctx, `cd ${root} 2>/dev/null && find . -path '*/assets/*' -type f -exec sha256sum {} + 2>/dev/null | sort -k2; true`)).stdout
          .split('\n')
          .filter(Boolean)
      const srcAssetFiles = await sumAssets('/data/elara/vaults')
      const restoredAssetFiles = await sumAssets(`${RESTORE_DIR}/vaults`)
      diffTable.push({
        table: 'attachments (files on disk)',
        source: srcAssetFiles.length,
        restored: restoredAssetFiles.length,
        missingOrChanged: srcAssetFiles.filter((l) => !restoredAssetFiles.includes(l)).length,
        extra: restoredAssetFiles.filter((l) => !srcAssetFiles.includes(l)).length,
      })
      const row = (t: string) => diffTable.find((d) => d.table === t)!
      const same = (t: string) => row(t).missingOrChanged === 0 && row(t).extra === 0 && row(t).source === row(t).restored
      const patchNote: Record<string, string> = {
        vaults: patches.includes('vault-deletedAt-null') ? ' (trashed vault came back live: effect of patch vault-deletedAt-null)' : '',
        mcp_connections: patches.includes('drop-repo-mcp') ? ' (repository-pinned token missing: effect of patch drop-repo-mcp)' : '',
        users: ' (users differ in has_totp: see MFA check)',
      }
      for (const t of ['users', 'teams', 'team_memberships', 'vaults', 'vault_shares', 'mcp_connections']) {
        const note = same(t) ? '' : (patchNote[t] ?? '')
        checks.push({ name: `restored ${t} identical (ids, hashes, flags)`, expected: `${row(t).source}`, actual: `${row(t).restored} restored, ${row(t).missingOrChanged} missing/changed${note}`, ok: same(t), severity: t === 'vaults' || t === 'users' ? 'high' : 'medium', detail: row(t) })
      }
      const cliNoise = restored.stderr.match(/CONNECTION_ENDED|embedding failed|permanently failed/g) ?? []
      checks.push({
        name: 'restore CLI finishes without errors after "Restore complete"',
        expected: 'clean stderr',
        actual: `${cliNoise.length} error markers (embedding queue scheduled by createNote runs after sql.end(): ${[...new Set(cliNoise)].join(', ')})`,
        ok: cliNoise.length === 0,
        severity: 'low',
      })
      checks.push({ name: 'restored live notes: frontmatter + body identical', expected: `${row('notes (live)').source}`, actual: `${row('notes (live)').restored} restored, ${row('notes (live)').missingOrChanged} missing/changed`, ok: row('notes (live)').missingOrChanged === 0, severity: 'critical', detail: noteDiff })
      checks.push({ name: 'restored trash', expected: `${row('notes (trash)').source} trashed notes`, actual: `${row('notes (trash)').restored}`, ok: same('notes (trash)'), severity: 'medium' })
      checks.push({ name: 'restored revision history', expected: `${row('note_revisions').source} revisions`, actual: `${row('note_revisions').restored}`, ok: row('note_revisions').missingOrChanged === 0, severity: 'high' })
      checks.push({ name: 'restored attachments', expected: `${srcAssetFiles.length} files`, actual: `${restoredAssetFiles.length} files (restore.ts walks only vaults/<id>/*.md)`, ok: same('attachments (files on disk)'), severity: 'high' })
      checks.push({ name: 'restored repositories (repo: links, pinned tokens)', expected: `${row('repositories').source}`, actual: `${row('repositories').restored}`, ok: same('repositories'), severity: 'medium' })
      checks.push({ name: 'restored MFA state usable (secret + backup codes)', expected: 'mfa users keep a TOTP secret', actual: JSON.stringify({ src: row('mfa_backup_codes'), dumpTotp: archiveSummary.mfaUserTotpInDump === null ? 'null (archive.ts:97-100 strips totpSecret)' : 'present' }), ok: archiveSummary.mfaUserTotpInDump !== null, severity: 'high' })

      // ------------------------------- boot the restored instance
      await ctx.docker.exec(['docker', 'rm', '-f', 'lab-restored'])
      const boot = await ctx.docker.exec([
        ...ctx.docker.COMPOSE,
        'run',
        '-d',
        '--no-deps',
        '--name',
        'lab-restored',
        '-p',
        `${RESTORED_PORT}:3000`,
        '-e',
        `DATA_DIR=${RESTORE_DIR}`,
        '-e',
        `LOCAL_REPOS_ROOT=${RESTORE_DIR}/local-repos`,
        'app',
        'sh',
        '-c',
        `export DATABASE_URL="\${DATABASE_URL%/*}/${RESTORE_DB}"; exec node --import tsx src/index.ts`,
      ])
      const restoredUrl = `http://localhost:${RESTORED_PORT}`
      let healthyMs: number | string = 'n/a'
      try {
        healthyMs = Math.round(await waitHealthy(restoredUrl, 240_000))
      } catch (err) {
        healthyMs = String(err)
      }
      if (typeof healthyMs === 'number') {
        const adminLogin = await new RestSession(restoredUrl).post('/api/login', { email: ctx.env.users.admin.email, password: ctx.env.users.admin.password })
        const oldCookie = await new RestSession(restoredUrl, admin.cookie).get('/api/me')
        const mfaLogin = await new RestSession(restoredUrl).post('/api/login', { email: mfaEmail, password: mfaPassword, totp: totp(secret) })
        const adminTok = await new McpClient(restoredUrl, ctx.env.tokens.adminAccount.token, 'restored-admin').call('list_vaults')
        const liveTok = await new McpClient(restoredUrl, liveToken.token, 'restored-live').call('list_vaults')
        const revokedTok = await new McpClient(restoredUrl, revokedToken.token, 'restored-revoked').call('list_vaults')
        const readBack = await new McpClient(restoredUrl, ctx.env.tokens.adminAccount.token, 'restored-admin').call('read_note', { vaultId: V, path: 'concepts/persian' })
        const t0 = performance.now()
        const reembedded = await poll(async () => {
          const r = await psqlRowsDb<{ missing: number }>(RESTORE_DB, 'select count(*)::int as missing from notes where deleted_at is null and embedding is null')
          return r[0]?.missing === 0 ? true : undefined
        }, 240_000, 3_000)
        checks.push({
          name: 'restored instance re-embeds restored notes on boot (search works again)',
          expected: 'all live notes embedded',
          actual: reembedded ? `yes after ${Math.round(performance.now() - t0)} ms` : 'not within 240 s',
          ok: Boolean(reembedded),
          severity: 'medium',
        })
        const restoredSession = new RestSession(restoredUrl)
        if (adminLogin.status === 200) {
          const login2 = await RestSession.login(restoredUrl, ctx.env.users.admin.email, ctx.env.users.admin.password).catch(() => undefined)
          if (login2) restoredSession.cookie = login2.cookie
        }
        const restoredAssets = restoredSession.cookie ? await assetSnapshot(restoredUrl, restoredSession.cookie, V).catch((e) => String(e)) : 'no session'
        const linkedPng = restoredSession.cookie ? (await getRaw(restoredUrl, `/api/vaults/${V}/assets/${pngName}`, restoredSession.cookie)).status : 0
        const srcPersian = srcNotes.find((n) => n.vault_id === V && n.path === 'concepts/persian')
        // Shape: read_note (mcp/server.ts:644).
        const readBody = readBack.json as { body?: string } | undefined
        Object.assign(restoredChecks, {
          healthyMs,
          adminLogin: adminLogin.status,
          oldSession: oldCookie.status,
          mfaLogin: `${mfaLogin.status} ${mfaLogin.text.slice(0, 120)}`,
          adminToken: adminTok.httpStatus,
          liveToken: liveTok.httpStatus,
          revokedToken: revokedTok.httpStatus,
          readNoteMatches: readBody?.body === srcPersian?.body,
          restoredAssets,
          linkedPng,
        })
        checks.push({ name: 'restored instance: password login works', expected: '200', actual: String(adminLogin.status), ok: adminLogin.status === 200, severity: 'critical' })
        checks.push({
          name: 'restored instance: MFA user can log in with password + TOTP',
          expected: '200',
          actual: `${mfaLogin.status} ${mfaLogin.text.slice(0, 120)}`,
          ok: mfaLogin.status === 200,
          severity: 'high',
          detail: { code: 'archive.ts:97-100 nulls totpSecret but keeps mfaEnabledAt; mfa_backup_codes not dumped; mfa.ts:63 returns false without a secret' },
        })
        checks.push({
          name: 'restored instance: MCP tokens behave as before (live works, revoked refused)',
          expected: 'admin 200, live 200, revoked 401 (CLI prints "tokens unusable")',
          actual: `admin ${adminTok.httpStatus}${adminTok.ok ? '' : ' ' + adminTok.text.slice(0, 60)}, live ${liveTok.httpStatus}, revoked ${revokedTok.httpStatus}`,
          ok: adminTok.ok && liveTok.ok && revokedTok.httpStatus === 401,
          severity: 'medium',
          detail: { cliClaim: 'restore-backup.ts:40 "MCP connections (metadata only, tokens unusable)"' },
        })
        checks.push({ name: 'restored instance: note content readable over MCP', expected: 'identical body', actual: String(readBody?.body === srcPersian?.body), ok: readBody?.body === srcPersian?.body, severity: 'high' })
        checks.push({ name: 'restored instance: attachment linked from a note downloads', expected: '200', actual: String(linkedPng), ok: linkedPng === 200, severity: 'high' })
      } else {
        checks.push({ name: 'restored instance boots', expected: 'healthy', actual: String(healthyMs), ok: false, severity: 'high' })
      }
      restoredChecks.boot = { code: boot.code, stderr: boot.stderr.slice(0, 500) }
      restoredChecks.logs = (await ctx.docker.exec(['docker', 'logs', '--tail', '80', 'lab-restored'])).stdout.slice(-6000)
      await ctx.docker.exec(['docker', 'rm', '-f', 'lab-restored'])
    }

    const failed = checks.filter((c) => c.ok === false)
    return {
      summary:
        `Backup ${file} (${lastRun?.result?.sizeBytes} B, ${archiveSummary.notes} note files, ${archiveSummary.assets} asset files; dump lacks ${archiveSummary.missingTables.join(', ')}). ` +
        `Restore attempts: ${attempts.map((a) => `#${a.n}${a.patches.length ? `[${a.patches.join('+')}]` : ''} exit ${a.code}`).join(', ')}; ` +
        `${restored ? `restored after ${restored.patches.length} archive patch(es)` : 'never restored'}. ` +
        `Diff: ${diffTable.map((d) => `${d.table} ${d.source}->${d.restored}`).join('; ')}. ${failed.length} failed checks.`,
      checks,
      data: {
        backupStatus: status.json,
        runs,
        listing,
        fileStat,
        archiveSummary,
        attempts,
        diffTable,
        restoredInstance: restoredChecks,
        fixture: { vaultId: V, trashedVaultId: trashedVault.id, teamId: team.id, liveTokenId: liveToken.id, revokedTokenId: revokedToken.id, mfaUserId: mfaUser.id, assets: [pngName, pdfName] },
        sourceNotes: srcNotes.map((r) => ({ vault: r.vault_id, path: r.path, trashed: r.trashed, revisions: r.revisions, links: r.links.length })),
        restoredNotes: restoredNotes.map((r) => ({ vault: r.vault_id, path: r.path, trashed: r.trashed, revisions: r.revisions, links: r.links.length })),
        sha: { png: sha256(pngBytes), pdf: sha256(pdfBytes) },
      },
    }
  },
}
export default test
