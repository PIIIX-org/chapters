// Shared types and the context object every lab test receives.
import { readFileSync } from 'node:fs'
import * as docker from './docker.ts'
import { McpClient } from './mcp.ts'
import { poll } from './portability.ts'
import { RestSession } from './rest.ts'

export type UserKey = 'admin' | 'member'
export type TokenKey = 'adminAccount' | 'memberAccount' | 'adminVaultPinned' | 'adminRepoPinned'

/** Shape of lab-env.json, written by lab/bootstrap.ts inside the runner only. */
export interface LabEnv {
  baseUrl: string
  mailpitUrl: string
  users: Record<UserKey, { id: string; email: string; password: string; cookie: string }>
  tokens: Record<TokenKey, { id: string; token: string; scope: 'account' | 'vault' | 'repository' }>
  /** Resources the pinned tokens are pinned to (owned by admin). */
  pinnedVaultId: string
  pinnedRepositoryId: string
  pinnedRepositoryUrl: string
}

export function loadEnv(file = process.env.LAB_ENV_FILE ?? 'lab-env.json'): LabEnv {
  return JSON.parse(readFileSync(file, 'utf8')) as LabEnv
}

/** One expectation of a test. ok=null means inconclusive (precondition broke). */
export interface Check {
  name: string
  expected: string
  actual: string
  ok: boolean | null
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
  detail?: unknown
}

export interface TestOutput {
  /** One paragraph: what was measured and the headline result. */
  summary: string
  checks: Check[]
  /** Raw measurements, written verbatim to lab-results/<test>.json. */
  data?: unknown
}

/** fast = runs on PRs to dev (minutes); full = nightly and on promotions. */
export type Tier = 'fast' | 'full'

export interface LabTest {
  name: string
  description: string
  /** 'fast': also selected in the fast tier. Omitted: full tier only. */
  tier?: 'fast'
  run(ctx: LabContext): Promise<TestOutput>
}

export class LabContext {
  readonly env: LabEnv
  readonly docker = docker
  readonly startedAt = Date.now()
  private readonly sessions = new Map<UserKey, RestSession>()

  constructor(
    env: LabEnv,
    readonly testName: string,
    /** The tier this run belongs to; a fast-tier test skips its long parts when 'fast'. */
    readonly tier: Tier = 'full',
  ) {
    this.env = env
  }

  get baseUrl() {
    return this.env.baseUrl
  }

  /** MCP client for a bootstrap token key, or for a raw token minted by the test. */
  mcp(token: TokenKey | string, label?: string): McpClient {
    const known = (this.env.tokens as Record<string, { token: string } | undefined>)[token]
    return new McpClient(this.env.baseUrl, known ? known.token : token, label ?? (known ? token : 'minted'))
  }

  /** REST session (cookie from bootstrap) for a user. */
  rest(user: UserKey): RestSession {
    let s = this.sessions.get(user)
    if (!s) {
      s = new RestSession(this.env.baseUrl, this.env.users[user].cookie)
      this.sessions.set(user, s)
    }
    return s
  }

  /** Mints an MCP connection through the same REST route the Settings UI uses. */
  async mintToken(
    user: UserKey,
    name: string,
    scope: 'account' | 'vault' | 'repository' = 'account',
    options: {
      vaultId?: string
      repositoryId?: string
      access?: 'read' | 'write' | 'admin'
      /** The tool profile (#428); omitted: `admin`, every tool `access` allows. */
      profile?: 'reader' | 'writer' | 'admin'
      allowedTools?: string[]
      expiresAt?: string
    } = {},
  ): Promise<{ id: string; token: string }> {
    return this.rest(user).must('POST', '/api/mcp-connections', { name, scope, ...options })
  }

  /** Creates a vault through REST (POST /api/vaults). */
  async createVault(user: UserKey, name: string): Promise<{ id: string; name: string }> {
    return this.rest(user).must('POST', '/api/vaults', { name })
  }

  /** Connects a public git repository through REST; the first sync starts immediately. */
  async connectRepo(user: UserKey, name: string, gitUrl: string): Promise<{ id: string; name: string }> {
    return this.rest(user).must('POST', '/api/repositories', { name, ingestionMethod: 'git', gitUrl })
  }

  /** A new active user through the real flow: signup -> mailpit code -> verify -> admin approval -> login. */
  async signupUser(email: string, password: string): Promise<{ id: string; session: RestSession }> {
    const signup = await new RestSession(this.baseUrl).post('/api/signup', { email, password })
    if (signup.status !== 200) throw new Error(`signup ${email}: ${signup.status} ${signup.text}`)
    const code = await poll(async () => {
      const list = (await (await fetch(`${this.env.mailpitUrl}/api/v1/messages`)).json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }>
      }
      const msg = list.messages.find((m) => m.To.some((t) => t.Address === email) && /verify/i.test(m.Subject))
      if (!msg) return undefined
      const full = (await (await fetch(`${this.env.mailpitUrl}/api/v1/message/${msg.ID}`)).json()) as { Text: string }
      return /verification code is (\S+)/.exec(full.Text)?.[1]
    }, 60_000, 1_000)
    if (!code) throw new Error(`no verification mail for ${email}`)
    const verify = await new RestSession(this.baseUrl).post('/api/verify-email', { email, code })
    if (verify.status !== 200) throw new Error(`verify ${email}: ${verify.status} ${verify.text}`)
    const pending = await this.rest('admin').must<Array<{ id: string; email: string }>>('GET', '/api/admin/users?status=pending_approval')
    const row = pending.find((u) => u.email === email)
    if (!row) throw new Error(`${email} not pending approval`)
    await this.rest('admin').must('POST', `/api/admin/users/${row.id}/approve`, {})
    return { id: row.id, session: await RestSession.login(this.baseUrl, email, password) }
  }

  log(...args: unknown[]) {
    const t = ((Date.now() - this.startedAt) / 1000).toFixed(1).padStart(7)
    console.log(`[${this.testName} +${t}s]`, ...args)
  }

  /** Unique, slug-safe suffix for resource names. */
  uniq(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }
}
