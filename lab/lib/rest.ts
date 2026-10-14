// REST client holding one Elara browser session (the `elara_session` cookie
// that /api/setup and /api/login set; server/src/auth/plugin.ts). Sessions
// live in Postgres for 30 days, so they survive app restarts.
import { parseJson } from './mcp.ts'

export interface RestResponse<T = unknown> {
  status: number
  /** Parsed JSON body, undefined when the body is not JSON. */
  json: T | undefined
  text: string
  ms: number
}

export class RestSession {
  constructor(
    readonly baseUrl: string,
    public cookie = '',
  ) {}

  /** POST /api/login and keep the session cookie. Throws on non-200. */
  static async login(baseUrl: string, email: string, password: string): Promise<RestSession> {
    const s = new RestSession(baseUrl)
    const r = await s.request('POST', '/api/login', { email, password })
    if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${r.text}`)
    return s
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<RestResponse<T>> {
    const t0 = performance.now()
    const headers: Record<string, string> = {}
    if (this.cookie) headers.Cookie = this.cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    })
    // The cookie is `Secure` under NODE_ENV=production; fetch does not keep a
    // jar anyway, so carry it by hand over plain http://localhost.
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!
      if (pair.startsWith('elara_session=')) this.cookie = pair
    }
    const text = await res.text()
    return { status: res.status, json: parseJson(text) as T | undefined, text, ms: performance.now() - t0 }
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path)
  }

  post<T = unknown>(path: string, body: unknown = {}) {
    return this.request<T>('POST', path, body)
  }

  /** request() that throws on any non-2xx; returns the parsed body. */
  async must<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body)
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 500)}`)
    return r.json as T
  }
}
