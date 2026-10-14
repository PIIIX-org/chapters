// Brings a fresh lab instance to a usable state, through the same routes a
// human would use, and writes lab-env.json (runner only — holds tokens):
//   1. /api/setup with the SETUP_TOKEN from ./.env  -> admin (session cookie)
//   2. /api/signup member -> verification code read from mailpit ->
//      /api/verify-email -> admin approves via /api/admin/users/:id/approve
//      -> /api/login member
//   3. pinned vault + pinned repository for admin (REST)
//   4. MCP tokens via POST /api/mcp-connections (what Settings > MCP uses):
//      account-scoped for both users, vault-pinned + repository-pinned for admin
import { readFileSync, writeFileSync } from 'node:fs'
import { waitHealthy } from './lib/docker.ts'
import { RestSession } from './lib/rest.ts'
import type { LabEnv } from './lib/context.ts'

const baseUrl = process.env.LAB_BASE_URL ?? 'http://localhost:3000'
const mailpitUrl = process.env.LAB_MAILPIT_URL ?? 'http://localhost:8025'
const pinnedRepositoryUrl = process.env.LAB_PINNED_REPO_URL ?? 'https://github.com/PIIIX-org/portfolio.me'

const dotenv = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const setupToken = process.env.SETUP_TOKEN ?? dotenv.SETUP_TOKEN
if (!setupToken) throw new Error('SETUP_TOKEN missing from env and ./.env')

const password = `Lab-${crypto.randomUUID()}`
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`)
const adminEmail = 'admin@example.com'
const memberEmail = 'member@example.com'

const t0 = performance.now()
const healthyMs = await waitHealthy(baseUrl, 600_000)
console.log(`healthy after ${Math.round(healthyMs)} ms`)

// 1. First admin through the one-time setup token.
const admin = new RestSession(baseUrl)
const setup = await admin.post<{ id: string }>('/api/setup', { token: setupToken, email: adminEmail, password })
if (setup.status !== 200 || !setup.json) throw new Error(`setup failed: ${setup.status} ${setup.text}`)
const adminId = setup.json.id
console.log(`admin created ${adminId}`)

// 2. Second user: signup -> email code -> verify -> approval -> login.
const signup = await new RestSession(baseUrl).post('/api/signup', { email: memberEmail, password })
if (signup.status !== 200) throw new Error(`signup failed: ${signup.status} ${signup.text}`)

interface MailpitList {
  messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>
}
let code: string | undefined
for (let i = 0; i < 60 && !code; i++) {
  const list = (await (await fetch(`${mailpitUrl}/api/v1/messages`)).json()) as MailpitList
  const msg = list.messages.find((m) => m.To.some((t) => t.Address === memberEmail) && /verify/i.test(m.Subject))
  if (msg) {
    const full = (await (await fetch(`${mailpitUrl}/api/v1/message/${msg.ID}`)).json()) as { Text: string }
    code = /verification code is (\S+)/.exec(full.Text)?.[1]
  } else {
    await Bun.sleep(1_000)
  }
}
if (!code) throw new Error('verification mail never reached mailpit')

const verify = await new RestSession(baseUrl).post('/api/verify-email', { email: memberEmail, code })
if (verify.status !== 200) throw new Error(`verify-email failed: ${verify.status} ${verify.text}`)

const pending = await admin.must<Array<{ id: string; email: string }>>('GET', '/api/admin/users?status=pending_approval')
const memberRow = pending.find((u) => u.email === memberEmail)
if (!memberRow) throw new Error(`member not in approval queue: ${JSON.stringify(pending)}`)
await admin.must('POST', `/api/admin/users/${memberRow.id}/approve`, {})
const member = await RestSession.login(baseUrl, memberEmail, password)
console.log(`member created, verified, approved, logged in ${memberRow.id}`)

// 3. Pinned resources.
const vault = await admin.must<{ id: string }>('POST', '/api/vaults', { name: 'lab-pinned' })
const repo = await admin.must<{ id: string }>('POST', '/api/repositories', {
  name: 'lab-pinned-repo',
  ingestionMethod: 'git',
  gitUrl: pinnedRepositoryUrl,
})

// 4. MCP tokens.
type Scope = 'account' | 'vault' | 'repository'
async function mint(s: RestSession, name: string, scope: Scope, ids: Record<string, string> = {}) {
  const c = await s.must<{ id: string; token: string }>('POST', '/api/mcp-connections', { name, scope, ...ids })
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${c.token}`)
  return { id: c.id, token: c.token, scope }
}
const tokens: LabEnv['tokens'] = {
  adminAccount: await mint(admin, 'lab admin account', 'account'),
  memberAccount: await mint(member, 'lab member account', 'account'),
  adminVaultPinned: await mint(admin, 'lab admin vault-pinned', 'vault', { vaultId: vault.id }),
  adminRepoPinned: await mint(admin, 'lab admin repo-pinned', 'repository', { repositoryId: repo.id }),
}

const env: LabEnv = {
  baseUrl,
  mailpitUrl,
  users: {
    admin: { id: adminId, email: adminEmail, password, cookie: admin.cookie },
    member: { id: memberRow.id, email: memberEmail, password, cookie: member.cookie },
  },
  tokens,
  pinnedVaultId: vault.id,
  pinnedRepositoryId: repo.id,
  pinnedRepositoryUrl,
}
writeFileSync('lab-env.json', JSON.stringify(env, null, 2))
console.log(`bootstrap done in ${Math.round(performance.now() - t0)} ms; wrote lab-env.json`)
