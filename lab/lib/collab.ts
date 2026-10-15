// A Hocuspocus client that behaves like client/src/hooks/useCollabDoc.ts:
// it connects to `/collab` on the app's own origin, names the document
// `<vaultId>/<path>` (client/src/api/collab.ts collabDocName), and pays for
// every (re)connect with a fresh single-use ticket from POST /api/collab/ticket
// (server/src/sync/routes.ts:58) using the browser session cookie. The Y.Doc
// is owned by the caller so a reconnect can reuse it, as the hook does.
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { RestSession } from './rest.ts'

export interface CollabEvent {
  t: number
  kind: string
  detail?: string
}

export class CollabClient {
  provider: HocuspocusProvider | null = null
  status = 'new'
  synced = false
  authFailed: string | null = null
  ticketErrors = 0
  readonly events: CollabEvent[] = []
  private readonly t0 = Date.now()

  constructor(
    readonly baseUrl: string,
    readonly docName: string,
    /** Session the tickets are minted with; swap it to simulate a re-login. */
    public session: RestSession,
    public ydoc: Y.Doc = new Y.Doc(),
  ) {}

  private ev(kind: string, detail?: string) {
    this.events.push({ t: Date.now() - this.t0, kind, detail })
    if (this.events.length > 500) this.events.shift()
  }

  get body(): string {
    return this.ydoc.getText('body').toString()
  }

  get unsynced(): boolean {
    return Boolean(this.provider?.hasUnsyncedChanges)
  }

  /** New provider on the current ydoc (a mount of the hook). Resolves when synced or on timeout. */
  async connect(timeoutMs = 30_000): Promise<boolean> {
    this.synced = false
    this.authFailed = null
    const url = this.baseUrl.replace(/^http/, 'ws') + '/collab'
    this.provider = new HocuspocusProvider({
      url,
      name: this.docName,
      document: this.ydoc,
      // Faster than the browser's 30 s ceiling so crash/restart steps do not wait on backoff.
      maxDelay: 3000,
      token: async () => {
        const r = await this.session.request<{ token: string }>('POST', '/api/collab/ticket')
        if (r.status !== 200 || !r.json?.token) {
          this.ticketErrors++
          this.ev('ticket-failed', `HTTP ${r.status}`)
          throw new Error(`ticket HTTP ${r.status}`)
        }
        return r.json.token
      },
      onStatus: ({ status }) => {
        this.status = status
        this.ev('status', status)
      },
      onSynced: ({ state }) => {
        this.synced = state
        this.ev('synced', String(state))
      },
      onAuthenticationFailed: ({ reason }) => {
        this.authFailed = reason
        this.ev('auth-failed', reason)
      },
      onClose: ({ event }) => this.ev('close', `${event.code} ${event.reason}`),
    } as ConstructorParameters<typeof HocuspocusProvider>[0])
    return this.waitSynced(timeoutMs)
  }

  async waitSynced(timeoutMs = 30_000): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (this.synced && this.status === WebSocketStatus.Connected) return true
      if (this.authFailed) return false
      await Bun.sleep(50)
    }
    return false
  }

  /** Waits until the server acknowledged every local update. */
  async waitAcked(timeoutMs = 15_000): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (this.provider && !this.provider.hasUnsyncedChanges && this.status === WebSocketStatus.Connected) return true
      await Bun.sleep(25)
    }
    return false
  }

  /** Network blip: drop the socket, keep provider + ydoc. */
  disconnect() {
    this.synced = false
    this.provider?.disconnect()
  }

  /** Re-open the socket of the existing provider. */
  async reconnect(timeoutMs = 30_000): Promise<boolean> {
    this.synced = false
    this.authFailed = null
    // connect() resolves only once a socket attempt succeeds and retries forever
    // otherwise (e.g. every ticket refused after logout), so never await it.
    void this.provider?.connect()
    return this.waitSynced(timeoutMs)
  }

  /** Unmount: destroy the provider (flushes pending updates), keep the ydoc. */
  destroy() {
    this.provider?.destroy()
    this.provider = null
    this.synced = false
    this.status = 'destroyed'
  }

  /** Types `text` at the end of the body (or at `at`). */
  type(text: string, at?: number) {
    const t = this.ydoc.getText('body')
    t.insert(at ?? t.length, text)
  }
}

export { Y }
