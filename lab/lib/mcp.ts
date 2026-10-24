// Minimal MCP client for the lab: stateless Streamable HTTP, JSON responses
// (server/src/mcp/routes.ts uses enableJsonResponse + no session id), so one
// POST per JSON-RPC call, no initialize handshake needed.

export interface McpCallRecord {
  label: string
  tool: string
  ms: number
  chars: number
  httpStatus: number
  isError: boolean
  retries429: number
}

/** Every MCP call made in this process; run.ts slices it per test. */
export const mcpCallLog: McpCallRecord[] = []

export interface ToolResult {
  /** HTTP status of the final attempt; 0 = network failure (server down). */
  httpStatus: number
  /** True when the tool answered (HTTP 200, JSON-RPC result, isError false). */
  ok: boolean
  /** The tool ran and returned isError: true (Elara's error envelope `{"error":{"code",...}}`, #439). */
  isError: boolean
  /** Concatenated text content, or the HTTP/RPC/network error text. */
  text: string
  /** `text` parsed as JSON when it parses, else undefined. */
  json?: unknown
  ms: number
  retries429: number
}

export interface ToolInfo {
  name: string
  description?: string
  inputSchema?: { type?: string; properties?: Record<string, JsonSchema>; required?: string[] }
}

export interface JsonSchema {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  minimum?: number
  minLength?: number
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  anyOf?: JsonSchema[]
}

/** One row of a note_history page: metadata only (#411). */
export interface RevisionMeta {
  id: string
  actorType: 'user' | 'mcp' | 'collab'
  actorId: string | null
  action: string
  createdAt: string
  bodyBytes: number
}

/** The block every budgeted tool's answer ends with (#422): false, or what was left out and the next page's cursor. */
export type Truncated = false | { shown: Record<string, number>; total: Record<string, number | string>; dropped: Record<string, number>; cursor: string | null }

/** `truncated.cursor` of a budgeted tool's answer, or null on its last page. */
export function nextCursor(json: unknown): string | null {
  const truncated: unknown = json && typeof json === 'object' ? Reflect.get(json, 'truncated') : undefined
  const cursor: unknown = truncated && typeof truncated === 'object' ? Reflect.get(truncated, 'cursor') : undefined
  return typeof cursor === 'string' ? cursor : null
}

/** note_history's result: one page, newest first. */
export interface HistoryPage {
  revisions: RevisionMeta[]
  truncated: Truncated
}

/** get_revision's result: one revision with its content. */
export interface RevisionContent extends Omit<RevisionMeta, 'bodyBytes'> {
  noteId: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

interface RpcBody {
  result?: { tools?: ToolInfo[]; content?: Array<{ text?: string }>; isError?: boolean }
  error?: unknown
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `json[key]` when json is an object and the value is a string (e.g. read_note's `body`). */
export function stringField(json: unknown, key: string): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const value: unknown = Reflect.get(json, key)
  return typeof value === 'string' ? value : undefined
}

function parseRpcBody(text: string): RpcBody | undefined {
  // JSON response mode; fall back to an SSE frame in case the server streams.
  const direct = parseJson(text)
  const value =
    direct ??
    parseJson(
      text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5))
        .join(''),
    )
  return value && typeof value === 'object' ? (value as RpcBody) : undefined
}

export class McpClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    /** Free-form name used in the call log (e.g. 'admin-account', 'vault-pinned'). */
    readonly label = 'mcp',
    readonly path = '/mcp',
  ) {}

  async rpc(method: string, params: unknown = {}, timeoutMs = 180_000) {
    let retries429 = 0
    for (;;) {
      const t0 = performance.now()
      let res: Response
      try {
        res = await fetch(this.baseUrl + this.path, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        return { status: 0, body: undefined, text: String(err), ms: performance.now() - t0, retries429 }
      }
      const text = await res.text()
      const ms = performance.now() - t0
      if (res.status === 429 && retries429 < 8) {
        retries429++
        await Bun.sleep(Math.min(30_000, 1_000 * 2 ** retries429))
        continue
      }
      return { status: res.status, body: parseRpcBody(text), text, ms, retries429 }
    }
  }

  async listTools(): Promise<ToolInfo[]> {
    const r = await this.rpc('tools/list')
    const tools = r.body?.result?.tools
    if (r.status !== 200 || !tools) throw new Error(`tools/list failed: HTTP ${r.status} ${r.text.slice(0, 300)}`)
    return tools
  }

  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolResult> {
    const r = await this.rpc('tools/call', { name: tool, arguments: args }, timeoutMs)
    let out: ToolResult
    if (r.status !== 200) {
      out = { httpStatus: r.status, ok: false, isError: false, text: `HTTP ${r.status}: ${r.text.slice(0, 2000)}`, ms: r.ms, retries429: r.retries429 }
    } else if (!r.body || r.body.error || !r.body.result) {
      out = { httpStatus: 200, ok: false, isError: false, text: `RPC ERROR ${JSON.stringify(r.body?.error ?? r.text.slice(0, 2000))}`, ms: r.ms, retries429: r.retries429 }
    } else {
      const result = r.body.result
      const text = (result.content ?? []).map((c) => c.text ?? '').join('\n')
      out = { httpStatus: 200, ok: !result.isError, isError: Boolean(result.isError), text, ms: r.ms, retries429: r.retries429 }
    }
    out.json = parseJson(out.text)
    mcpCallLog.push({
      label: this.label,
      tool,
      ms: Math.round(out.ms),
      chars: out.text.length,
      httpStatus: out.httpStatus,
      isError: !out.ok,
      retries429: out.retries429,
    })
    return out
  }

  /**
   * call() that throws unless the tool succeeded; returns the parsed JSON.
   * T is the caller's statement of the tool's documented result shape
   * (server/src/mcp/server.ts) — unchecked, lab code only.
   */
  async must<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.call(tool, args)
    if (!r.ok) throw new Error(`${this.label} ${tool} failed: ${r.text.slice(0, 500)}`)
    return (r.json ?? r.text) as T
  }

  /**
   * The revisions of a note recorded after `sinceIso` (every revision when
   * omitted), newest first, each with its content: note_history pages
   * (metadata only, #411) until a revision at or before `sinceIso`, then one
   * get_revision per revision kept. Throws when a call fails.
   */
  async revisionsSince(vaultId: string, path: string, sinceIso = ''): Promise<RevisionContent[]> {
    const kept: RevisionMeta[] = []
    let cursor: string | null = null
    do {
      // The largest budget keeps a page of 100 revisions at `full` (#421): a stepped-down page drops `createdAt`
      // (`locations`) or the list itself (`counts`, `total`).
      const page: HistoryPage = await this.must('note_history', { vaultId, path, limit: 100, budget_tokens: 25_000, ...(cursor ? { cursor } : {}) })
      const newer = page.revisions.filter((r) => r.createdAt > sinceIso)
      kept.push(...newer)
      cursor = newer.length === page.revisions.length ? nextCursor(page) : null
    } while (cursor)
    const out: RevisionContent[] = []
    for (const r of kept) out.push(await this.whole<RevisionContent>('get_revision', { vaultId, path, revisionId: r.id }, 'body'))
    return out
  }

  /**
   * A read tool's answer with its text field `field` whole (read_note and
   * get_revision `body`, read_file `content`): a long text comes in pages
   * (#420), followed here with the largest budget. The other fields are the
   * first page's. Throws when a call fails.
   */
  async whole<T>(tool: string, args: Record<string, unknown>, field: string): Promise<T> {
    const first = await this.must<Record<string, unknown>>(tool, { budget_tokens: 25_000, ...args })
    let text = stringField(first, field) ?? ''
    for (let cursor = nextCursor(first); cursor; ) {
      const page = await this.must<Record<string, unknown>>(tool, { budget_tokens: 25_000, ...args, cursor })
      text += stringField(page, field) ?? ''
      cursor = nextCursor(page)
    }
    return { ...first, [field]: text } as T
  }
}
