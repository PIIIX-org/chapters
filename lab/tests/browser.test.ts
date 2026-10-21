// Real browser (Playwright/Chromium) on the web editor while an MCP agent
// edits the same note (study tests 4 and 34).
//
// The editor is a Yjs document on the Hocuspocus relay
// (client/src/hooks/useCollabDoc.ts); MCP edit_note goes through
// server/src/sync/crdt-write.ts, which replaces the WHOLE Y.Text body
// (delete 0..len, insert new body) and then writes file + DB directly. An
// agent's "append" is therefore read_note (served from the FILE, which the
// relay only rewrites after a 2 s debounce, max 10 s) + edit_note(full body).
//
// Desktop (1280x800): UI login -> open note -> steps; after each step the
// editor text (EditorView state and DOM lines), the file on disk, the notes
// row and a screenshot are captured once the three converge (or time out):
//   S1  user types 40 tokens while the agent appends twice mid-typing (the
//       race: the agent reads a file that lags the editor)
//   S2  agent appends while the user is idle, then the user types
//   S3  user types, (typing on disk) agent appends, Ctrl+Z x2
//   S4  second tab on the same note (presence control), then another page in
//       front while the agent appends, back, type
//   S5  type, navigate to another note in-app at once, (typing on disk)
//       agent appends, back
//   S6a type, reload at once; S6b reload while the agent appends
//   S7  type, log out via the account menu, (typing on disk) agent appends,
//       log in via UI
//   S8a context.setOffline(true): type + agent append; how long until the UI
//       notices; back online
//   S8b real socket drop (routeWebSocket closes both sides, refuses
//       reconnects, HTTP offline): type + agent append, back online
//   S8c relay unreachable (collab sockets refused, HTTP up): type, reload
//       (beforeunload prompt accepted), the typing is restored from the
//       browser's IndexedDB copy, relay back, typing on disk once (#720)
// "(typing on disk)" = the agent waits for the relay's store, so its read is
// fresh and the step isolates the transition from the S1 race.
// Mobile (iPhone 13 emulation on Chromium): login, home, vaults, vault, note,
// type, (typing on disk) agent append; screenshots of each screen.
//
// Secrets: credentials come from ctx.env and are only typed into the login
// form (no screenshot after fill). No Playwright trace is recorded because a
// trace stores request headers (session cookies); a video per page is.
//
// Real sleeps are deliberate: this drives a live server whose relay store
// debounce (2 s, max 10 s), socket reconnect backoff and typing cadence are
// the subject under test; there is no clock to fake across the process gap.
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, devices, type BrowserContext, type Page, type WebSocketRoute } from 'playwright'
import type { Check, LabContext, LabTest } from '../lib/context.ts'

const OUT = 'lab-results/browser'
const TYPE_DELAY_MS = 35
const SETTLE_TIMEOUT_MS = 30_000
const BASE = ['BASE-LINE-1', 'BASE-LINE-2']

const sha = (s: string | null) => (s === null ? null : createHash('sha256').update(s).digest('hex').slice(0, 12))
const tokens = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)
const typedText = (toks: string[]) => toks.map((t) => ` ${t}`).join('')
const marker = (step: string) => `AGENT-${step}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`

function count(text: string | null, needle: string): number {
  if (text === null) return 0
  let n = 0
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++
  return n
}

// In-page probes are plain JS strings: Playwright serialises functions with
// toString(), and transpiled TypeScript is not guaranteed to survive that.
// @codemirror/view 6.43 keeps its view on `.cm-content`.cmTile.root.view
// (EditorView.findFromDOM); the DOM lines are read as well.
const READ_EDITOR = `(() => {
  const content = document.querySelector('.cm-content')
  if (!content) return { text: null, dom: null, source: 'none', head: null, editable: null }
  const dom = [...content.querySelectorAll('.cm-line')].map((l) => l.textContent || '').join('\\n')
  const editable = content.getAttribute('contenteditable')
  const tile = content.cmTile
  const legacy = content.cmView
  const views = [tile && tile.root && tile.root.view, legacy && (legacy.view || (legacy.rootView && legacy.rootView.view))]
  for (const v of views) {
    if (v && v.state && v.state.doc) {
      return { text: v.state.doc.toString(), dom, source: 'EditorView.state', head: v.state.selection.main.head, editable }
    }
  }
  return { text: dom, dom, source: 'cm-line', head: null, editable }
})()`

const READ_CHROME = `(() => ({
  peers: [...document.querySelectorAll('ul[aria-label="In this note now"] li')].map((e) => e.getAttribute('aria-label') || ''),
  status: [...document.querySelectorAll('[role=status]')].map((e) => (e.textContent || '').trim()).filter(Boolean),
  visibility: document.visibilityState,
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
}))()`

interface EditorRead {
  text: string | null
  dom: string | null
  source: string
  head: number | null
  editable: string | null
}
interface ChromeRead {
  peers: string[]
  status: string[]
  visibility: string
  overflowX: boolean
}

async function readEditor(page: Page): Promise<EditorRead> {
  try {
    return (await page.evaluate(READ_EDITOR)) as EditorRead
  } catch {
    return { text: null, dom: null, source: 'evaluate-failed', head: null, editable: null }
  }
}
async function readChrome(page: Page): Promise<ChromeRead> {
  try {
    return (await page.evaluate(READ_CHROME)) as ChromeRead
  } catch {
    return { peers: [], status: [], visibility: 'unknown', overflowX: false }
  }
}

interface Snap {
  step: string
  at: string
  editor: string | null
  editorDom: string | null
  editorSource: string
  editable: string | null
  head: number | null
  disk: string | null
  db: string | null
  peers: string[]
  status: string[]
  visibility: string
  converged: boolean
  settleMs: number
  screenshot: string | null
}

interface Expect {
  user: string[]
  agent: string[]
  /** Tokens already reported lost, with the step that lost them. */
  gone: Array<{ token: string; step: string }>
}

interface Row {
  step: string
  editorHash: string | null
  diskHash: string | null
  dbHash: string | null
  converged: boolean
  expectConverged: boolean
  duplicates: string[]
  lostUser: string[]
  lostAgent: string[]
  reappeared: string[]
  screenshot: string | null
}

interface AgentWrite {
  step: string
  marker: string
  ok: boolean
  error?: string
  readMs: number
  editMs: number
  readBodyHash: string | null
  editorAtRead: string | null
  readBody: string
  /** Tokens the editor showed when the agent read, but read_note did not return. */
  missingFromRead: string[]
  /**
   * The editor was cut off from the relay when the agent read (S8a/S8b): its
   * typing had not reached the server, so no read can return it. Where that
   * typing lands after the reconnect is #485's subject, not #474's.
   */
  editorOffline: boolean
  peersDuring: string[][]
}

const test: LabTest = {
  name: 'browser',
  description:
    'Playwright/Chromium on the collab editor while MCP edit_note appends: typing races, undo, tab switch, navigation, reload, logout, offline, mobile.',
  async run(ctx) {
    const secrets = [
      ctx.env.users.admin.password,
      ctx.env.users.member.password,
      ctx.env.users.admin.cookie,
      ctx.env.users.member.cookie,
      ...Object.values(ctx.env.tokens).map((t) => t.token),
    ].filter((s) => s.length > 0)
    const redact = (s: string) => secrets.reduce((acc, x) => acc.split(x).join('***'), s)
    try {
      return await runBrowser(ctx, redact)
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
      throw new Error(redact(msg))
    }
  },
}
export default test

// The playwright package comes from lab/package.json; the browser binary is
// installed here, so only runs that include this test pay for it (~30 s).
async function installChromium(ctx: LabContext) {
  const r = await ctx.docker.exec(['sh', '-c', 'cd lab && bun node_modules/playwright/cli.js install --with-deps chromium'])
  if (r.code !== 0) {
    throw new Error(`playwright install failed (${r.code}): ${r.stderr.slice(-2000)}\n${r.stdout.slice(-2000)}`)
  }
  ctx.log(`chromium installed in ${Math.round(r.ms)} ms`)
  return Math.round(r.ms)
}

async function runBrowser(ctx: LabContext, redact: (s: string) => string) {
  mkdirSync(OUT, { recursive: true })
  const checks: Check[] = []
  const installMs = await installChromium(ctx)

  // Fixture: own vault, note A (edited) and note B (navigation target).
  const agent = ctx.mcp('adminAccount', 'agent')
  const vault = await ctx.createVault('admin', ctx.uniq('browser'))
  const created = await agent.must<{ path: string }>('create_note', {
    vaultId: vault.id,
    path: 'concepts/browser-lab',
    frontmatter: { type: 'concepts' },
    body: `${BASE[0]} the shared note\n${BASE[1]} second line\n`,
  })
  const createdB = await agent.must<{ path: string }>('create_note', {
    vaultId: vault.id,
    path: 'concepts/browser-lab-b',
    frontmatter: { type: 'concepts' },
    body: 'BASE-B other note\n',
  })
  const path = created.path
  const pathB = createdB.path
  const noteUrl = `${ctx.baseUrl}/vaults/${vault.id}/notes/${path}`
  const noteBHref = `/vaults/${vault.id}/notes/${pathB}`
  const file = `/data/elara/vaults/${vault.id}/${path}.md`
  ctx.log(`vault ${vault.id}, note ${path}`)

  const diskBody = async (): Promise<string | null> => {
    const r = await ctx.docker.appExec(['cat', file])
    if (r.code !== 0) return null
    const m = r.stdout.match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/)
    return m ? (m[2] ?? '') : null
  }
  const dbBody = async (): Promise<string | null> => {
    const rows = await ctx.docker.psqlRows<{ body: string }>(
      `select body from notes where vault_id = '${vault.id}' and path = '${path}' and deleted_at is null`,
    )
    return rows[0]?.body ?? null
  }

  const browser = await chromium.launch()
  const browserVersion = browser.version()
  const consoleErrors: string[] = []
  // "Leave site?" prompts (#720: shown while typed text is unacknowledged).
  // Playwright dismisses dialogs nobody handles, and a dismissed beforeunload
  // cancels the reload or navigation, so they are accepted and recorded.
  const beforeUnloadPrompts: Array<{ page: string; at: string }> = []
  const watch = (page: Page, label: string) => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(redact(`[${label}] ${m.text()}`).slice(0, 400))
    })
    page.on('pageerror', (e) => consoleErrors.push(redact(`[${label}] pageerror ${e.message}`).slice(0, 400)))
    page.on('dialog', (d) => {
      if (d.type() === 'beforeunload') {
        beforeUnloadPrompts.push({ page: label, at: new Date().toISOString() })
        void d.accept().catch(() => {})
      } else {
        void d.dismiss().catch(() => {})
      }
    })
  }

  const uiLogin = async (page: Page): Promise<number> => {
    const t0 = performance.now()
    await page.goto(`${ctx.baseUrl}/login`)
    await page.locator('#login-email').fill(ctx.env.users.admin.email)
    await page.locator('#login-password').fill(ctx.env.users.admin.password)
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    return Math.round(performance.now() - t0)
  }

  const waitReady = async (page: Page, mustInclude = BASE[0]!, timeoutMs = 30_000): Promise<number> => {
    const t0 = performance.now()
    await page.waitForSelector('.cm-content[contenteditable="true"]', { timeout: timeoutMs })
    for (;;) {
      const e = await readEditor(page)
      if (e.text?.includes(mustInclude)) return Math.round(performance.now() - t0)
      if (performance.now() - t0 > timeoutMs) throw new Error(`editor never showed ${mustInclude}: ${e.source}`)
      await Bun.sleep(150)
    }
  }

  /** ms until the file on disk contains every needle (the relay's debounced store landed), null on timeout. */
  const waitDiskIncludes = async (needles: string[], timeoutMs = 15_000): Promise<number | null> => {
    const t0 = performance.now()
    for (;;) {
      const d = await diskBody()
      if (d !== null && needles.every((n) => d.includes(n))) return Math.round(performance.now() - t0)
      if (performance.now() - t0 > timeoutMs) return null
      await Bun.sleep(250)
    }
  }

  const waitEditorIncludes = async (page: Page, needle: string, timeoutMs = 15_000): Promise<number | null> => {
    const t0 = performance.now()
    for (;;) {
      if ((await readEditor(page)).text?.includes(needle)) return Math.round(performance.now() - t0)
      if (performance.now() - t0 > timeoutMs) return null
      await Bun.sleep(100)
    }
  }

  const typeAtEnd = async (page: Page, text: string) => {
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text, { delay: TYPE_DELAY_MS })
  }

  let shot = 0
  const screenshot = async (page: Page, prefix: string, label: string): Promise<string | null> => {
    const p = join(OUT, `${prefix}-${String(++shot).padStart(2, '0')}-${label}.png`)
    try {
      await page.screenshot({ path: p, fullPage: false })
      return p
    } catch (err) {
      ctx.log(`screenshot ${label} failed: ${String(err).slice(0, 200)}`)
      return null
    }
  }

  /** Captures editor/disk/DB; polls until the three agree and `waitFor` markers are in the editor. */
  const settle = async (
    page: Page | null,
    step: string,
    opts: { waitFor?: string[]; expectConverged?: boolean; timeoutMs?: number; prefix?: string } = {},
  ): Promise<Snap> => {
    const t0 = performance.now()
    const expectConverged = opts.expectConverged ?? true
    let e: EditorRead = { text: null, dom: null, source: 'no-page', head: null, editable: null }
    let disk: string | null = null
    let db: string | null = null
    let converged = false
    for (;;) {
      if (page) e = await readEditor(page)
      disk = await diskBody()
      db = await dbBody()
      converged = e.text !== null && e.text === disk && disk === db
      const waited = (opts.waitFor ?? []).every((m) => e.text?.includes(m))
      if (!expectConverged || (converged && waited)) break
      if (performance.now() - t0 > (opts.timeoutMs ?? SETTLE_TIMEOUT_MS)) break
      await Bun.sleep(500)
    }
    const chrome = page ? await readChrome(page) : { peers: [], status: [], visibility: 'none', overflowX: false }
    return {
      step,
      at: new Date().toISOString(),
      editor: e.text,
      editorDom: e.dom,
      editorSource: e.source,
      editable: e.editable,
      head: e.head,
      disk,
      db,
      peers: chrome.peers,
      status: chrome.status,
      visibility: chrome.visibility,
      converged,
      settleMs: Math.round(performance.now() - t0),
      screenshot: page ? await screenshot(page, opts.prefix ?? 'desktop', step) : null,
    }
  }

  const snaps: Snap[] = []
  const rows: Row[] = []
  const exp: Expect = { user: [...BASE], agent: [], gone: [] }
  /**
   * Losses are charged to the step where they first show: a token missing
   * from a converged snapshot leaves the expectation list (into `gone`), so
   * later rows report only their own losses, and a `gone` token that comes
   * back is reported as reappeared. Editor-only rows (socket cut) don't prune.
   */
  const evaluate = (
    s: Snap,
    expectConverged = true,
    sources: Array<'editor' | 'disk' | 'db'> = ['editor', 'disk', 'db'],
    /** Agent markers written while the editor is cut off: it cannot have them yet. */
    inFlight: string[] = [],
  ) => {
    const texts = { editor: s.editor, disk: s.disk, db: s.db }
    const row: Row = {
      step: s.step,
      editorHash: sha(s.editor),
      diskHash: sha(s.disk),
      dbHash: sha(s.db),
      converged: s.converged,
      expectConverged,
      duplicates: [],
      lostUser: [],
      lostAgent: [],
      reappeared: [],
      screenshot: s.screenshot,
    }
    const lostUser = new Set<string>()
    const lostAgent = new Set<string>()
    for (const name of ['editor', 'disk', 'db'] as const) {
      const text = texts[name]
      if (text === null) {
        row.lostUser.push(`(${name} unreadable)`)
        continue
      }
      for (const m of [...exp.user, ...exp.agent]) {
        const n = count(text, m)
        if (n > 1) row.duplicates.push(`${m}@${name}x${n}`)
      }
      if (!sources.includes(name)) continue
      for (const m of exp.user) if (count(text, m) === 0) lostUser.add(m)
      for (const m of exp.agent) if (!inFlight.includes(m) && count(text, m) === 0) lostAgent.add(m)
      for (const g of exp.gone) if (count(text, g.token) > 0) row.reappeared.push(`${g.token}@${name} (lost in ${g.step})`)
    }
    const where = (m: string) =>
      `${m}@${sources.filter((n) => texts[n] !== null && count(texts[n], m) === 0).join('+')}`
    row.lostUser.push(...[...lostUser].map(where))
    row.lostAgent.push(...[...lostAgent].map(where))
    if (expectConverged) {
      exp.user = exp.user.filter((m) => !lostUser.has(m))
      exp.agent = exp.agent.filter((m) => !lostAgent.has(m))
      exp.gone.push(...[...lostUser, ...lostAgent].map((token) => ({ token, step: s.step })))
    }
    snaps.push(s)
    rows.push(row)
    ctx.log(
      `${s.step}: editor ${row.editorHash} disk ${row.diskHash} db ${row.dbHash} converged=${s.converged} dup=${row.duplicates.length} lostUser=${row.lostUser.length} lostAgent=${row.lostAgent.length}`,
    )
    return row
  }

  const agentWrites: AgentWrite[] = []
  /** The realistic agent append: read_note, then edit_note with the full body + one line. */
  const agentAppend = async (step: string, m: string, watchPage: Page | null, editorOffline = false): Promise<AgentWrite> => {
    const peersDuring: string[][] = []
    let sampling = watchPage !== null
    const sampler = (async () => {
      while (sampling && watchPage) {
        peersDuring.push((await readChrome(watchPage)).peers)
        await Bun.sleep(100)
      }
    })()
    const editorAtRead = watchPage ? (await readEditor(watchPage)).text : null
    const t0 = performance.now()
    const read = await agent.call('read_note', { vaultId: vault.id, path })
    const readMs = Math.round(performance.now() - t0)
    const readBody = (read.json as { body?: string } | undefined)?.body ?? ''
    const base = readBody.endsWith('\n') || readBody.length === 0 ? readBody : `${readBody}\n`
    const t1 = performance.now()
    const edit = read.ok ? await agent.call('edit_note', { vaultId: vault.id, path, body: `${base}${m}\n` }) : read
    const editMs = Math.round(performance.now() - t1)
    if (watchPage) await Bun.sleep(1000)
    sampling = false
    await sampler
    const userToks = editorAtRead ? (editorAtRead.match(/\b[a-z]\d\d\b/g) ?? []) : []
    const w: AgentWrite = {
      step,
      marker: m,
      ok: read.ok && edit.ok,
      error: read.ok && edit.ok ? undefined : redact(edit.text).slice(0, 300),
      readMs,
      editMs,
      readBodyHash: sha(readBody),
      editorAtRead,
      readBody,
      missingFromRead: userToks.filter((t) => !readBody.includes(t)),
      editorOffline,
      peersDuring,
    }
    agentWrites.push(w)
    exp.agent.push(m)
    ctx.log(`agent ${step} ${w.ok ? 'ok' : 'FAILED'} read ${readMs} ms edit ${editMs} ms missingFromRead=${w.missingFromRead.length}`)
    return w
  }

  // ---------------------------------------------------------------- desktop
  const videos: string[] = []
  const desktop: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: join(OUT, 'video-raw'), size: { width: 1280, height: 800 } },
  })
  const page = await desktop.newPage()
  watch(page, 'desktop')
  const timings: Record<string, unknown> = {}
  timings.login1Ms = await uiLogin(page)
  await screenshot(page, 'desktop', 'after-login')
  await page.goto(noteUrl)
  timings.openNoteMs = await waitReady(page)
  evaluate(await settle(page, 'S0-open'))

  // S1: user typing races two agent appends.
  const s1Tokens = tokens('a', 40)
  const s1Samples: Array<{ t: number; len: number; head: number | null; dupTokens: string[]; agentSeen: number }> = []
  {
    const m1 = marker('S1')
    const m2 = marker('S1B')
    let typing = true
    const t0 = performance.now()
    const sampler = (async () => {
      while (typing) {
        const e = await readEditor(page)
        s1Samples.push({
          t: Math.round(performance.now() - t0),
          len: e.text?.length ?? -1,
          head: e.head,
          dupTokens: s1Tokens.filter((t) => count(e.text, t) > 1),
          agentSeen: [m1, m2].filter((m) => e.text?.includes(m)).length,
        })
        await Bun.sleep(150)
      }
    })()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await Promise.all([
      page.keyboard.type(typedText(s1Tokens), { delay: TYPE_DELAY_MS }),
      (async () => {
        await Bun.sleep(1500)
        await agentAppend('S1', m1, page)
        await Bun.sleep(800)
        await agentAppend('S1B', m2, page)
      })(),
    ])
    exp.user.push(...s1Tokens)
    const s = await settle(page, 'S1-type-while-agent-appends', { waitFor: [m1, m2] })
    typing = false
    await sampler
    evaluate(s)
  }
  const s1Final = snaps.at(-1)?.editor ?? ''
  const s1Contiguous = s1Final.includes(typedText(s1Tokens))

  // S2: agent appends while the user is idle; then the user types.
  {
    const m = marker('S2')
    await agentAppend('S2', m, page)
    timings.s2AgentToEditorMs = await waitEditorIncludes(page, m)
    const t = tokens('b', 10)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    evaluate(await settle(page, 'S2-agent-then-type', { waitFor: [m] }))
  }

  // S3: undo after an agent append. The agent reads only once c01..c05 are
  // on disk, so its write is not stale and any change is the undo's doing.
  const undo: Record<string, unknown> = {}
  const undoSteps: Array<{ label: string; changed: boolean; undone: string[]; agentMissing: string[] }> = []
  {
    const t = tokens('c', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    undo.typingOnDiskMs = await waitDiskIncludes(t)
    const m = marker('S3')
    await agentAppend('S3', m, page)
    await waitEditorIncludes(page, m)
    await Bun.sleep(500)
    // The caret once the agent's line is in, before the click below moves it:
    // still where the user stopped typing (#483), not at the top.
    const afterAppend = await readEditor(page)
    const typedAt = afterAppend.text?.indexOf(typedText(t)) ?? -1
    undo.caretAfterAppend = afterAppend.head
    undo.typingEndsAt = typedAt < 0 ? null : typedAt + typedText(t).length
    const texts: Array<string | null> = [afterAppend.text]
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    for (const label of ['S3-undo-1', 'S3-undo-2']) {
      const prev = texts.at(-1) ?? null
      await page.keyboard.press('Control+z')
      await Bun.sleep(1500)
      const now = (await readEditor(page)).text
      texts.push(now)
      // What the user's own undo removed is not a loss.
      const undone = exp.user.filter((x) => count(prev, x) > 0 && count(now, x) === 0)
      exp.user = exp.user.filter((x) => !undone.includes(x))
      undoSteps.push({ label, changed: prev !== now, undone, agentMissing: exp.agent.filter((x) => count(now, x) === 0) })
      evaluate(await settle(page, label, { waitFor: exp.agent }))
    }
    undo.cTokensAfterUndo1 = t.filter((x) => count(texts[1] ?? null, x) > 0)
    undo.steps = undoSteps
    undo.texts = texts
  }

  // S4: presence control (same note in a 2nd tab), then another page in front.
  const presence: Record<string, unknown> = {}
  {
    const page2 = await desktop.newPage()
    watch(page2, 'tab2')
    await page2.goto(noteUrl)
    await waitReady(page2)
    await Bun.sleep(2000)
    presence.controlPeersOnTab1 = (await readChrome(page)).peers
    await screenshot(page, 'desktop', 'S4-presence-control')
    await page2.goto(`${ctx.baseUrl}/vaults`)
    await page2.bringToFront()
    await Bun.sleep(1000)
    presence.tab1VisibilityWhileBehind = (await readChrome(page)).visibility
    await screenshot(page2, 'desktop', 'S4-other-tab')
    const m = marker('S4')
    await agentAppend('S4', m, page)
    await Bun.sleep(2000)
    await page.bringToFront()
    timings.s4BackToTabSeesAgentMs = await waitEditorIncludes(page, m)
    const t = tokens('e', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    evaluate(await settle(page, 'S4-tab-switch', { waitFor: [m] }))
    const tab2Video = page2.video()
    await page2.close()
    if (tab2Video) {
      const p = join(OUT, 'desktop-tab2.webm')
      await tab2Video.saveAs(p)
      await tab2Video.delete()
      videos.push(p)
    }
  }

  // S5: type, navigate in-app to note B right after the last keystroke; once
  // the typing is on disk (or 15 s passed) the agent appends; back.
  const nav: Record<string, unknown> = {}
  {
    const t = tokens('f', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    const link = page.locator(`a[href="${noteBHref}"]`).locator('visible=true').first()
    if ((await link.count()) > 0) {
      await link.click()
      nav.method = 'link-click'
    } else {
      await page.evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(noteBHref)}); dispatchEvent(new PopStateEvent('popstate')) })()`)
      nav.method = 'pushState (no visible link to note B)'
    }
    await waitReady(page, 'BASE-B')
    await screenshot(page, 'desktop', 'S5-note-b')
    nav.typingOnDiskMs = await waitDiskIncludes(t)
    const m = marker('S5')
    await agentAppend('S5', m, null)
    await Bun.sleep(1000)
    await page.goBack()
    await waitReady(page)
    evaluate(await settle(page, 'S5-navigate-away-back', { waitFor: [m] }))
  }

  // S6a: type, reload right after the last keystroke. S6b: reload while the
  // agent appends (its read is fresh: the typing is already on disk).
  const reload: Record<string, unknown> = {}
  {
    const t = tokens('g', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    await page.reload()
    await waitReady(page)
    reload.typingOnDiskMs = await waitDiskIncludes(t)
    evaluate(await settle(page, 'S6a-type-then-reload'))
    const m = marker('S6')
    await Promise.all([page.reload(), agentAppend('S6', m, null)])
    await waitReady(page)
    evaluate(await settle(page, 'S6b-reload-while-agent-appends', { waitFor: [m] }))
  }

  // S7: type, log out, agent appends while logged out (after the typing is
  // on disk), log back in.
  const logout: Record<string, unknown> = {}
  {
    const t = tokens('h', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    await Bun.sleep(300)
    await page.locator('button[aria-label$="ccount menu"]').locator('visible=true').first().click()
    await page.getByRole('menuitem', { name: 'Log out' }).click()
    await page.waitForURL(/\/login/, { timeout: 15_000 })
    await screenshot(page, 'desktop', 'S7-logged-out')
    logout.typingOnDiskMs = await waitDiskIncludes(t)
    const m = marker('S7')
    await agentAppend('S7', m, null)
    logout.loginMs = await uiLogin(page)
    await page.goto(noteUrl)
    await waitReady(page)
    evaluate(await settle(page, 'S7-logout-login', { waitFor: [m] }))
  }

  // S8a: Chromium network emulation offline (the socket is not closed, frames
  // just stop: what a dead Wi-Fi looks like). How long until the UI says so?
  const offline: Record<string, unknown> = {}
  {
    await desktop.setOffline(true)
    await Bun.sleep(1500)
    offline.statusAfterSetOffline = (await readChrome(page)).status
    const t = tokens('i', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    const m = marker('S8A')
    await agentAppend('S8A', m, page, true)
    offline.agentReachedEditorWhileOfflineMs = await waitEditorIncludes(page, m, 5000)
    offline.setOfflineCutSocket = offline.agentReachedEditorWhileOfflineMs === null
    const t0 = performance.now()
    const statusSeen: string[] = []
    offline.silentDropDetectedMs = null
    while (performance.now() - t0 < 45_000) {
      const status = (await readChrome(page)).status.join(' | ')
      if (statusSeen.at(-1) !== status) statusSeen.push(status)
      if (/reconnect|offline/i.test(status)) {
        offline.silentDropDetectedMs = Math.round(performance.now() - t0) + 1500
        break
      }
      await Bun.sleep(500)
    }
    offline.statusSequenceWhileOffline = statusSeen
    // Editor-only expectations while offline: disk/DB can't have i01..i05, the editor can't have the agent line.
    evaluate(await settle(page, 'S8a-offline-emulated', { expectConverged: false }), false, ['editor'], [m])
    await desktop.setOffline(false)
    evaluate(await settle(page, 'S8a-back-online', { waitFor: [m], timeoutMs: 60_000 }))
  }

  // S8b: a real collab socket drop (both sides closed, reconnects refused) + HTTP offline.
  {
    const pairs: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = []
    let partition = false
    let opened = 0
    let refused = 0
    await page.routeWebSocket(/\/collab/, (ws) => {
      if (partition) {
        refused++
        void ws.close({ code: 1001, reason: 'lab partition' })
        return
      }
      opened++
      pairs.push({ page: ws, server: ws.connectToServer() })
    })
    await page.reload()
    await waitReady(page)
    offline.routedSocketsAfterReload = opened
    partition = true
    await desktop.setOffline(true)
    for (const p of pairs.splice(0)) {
      await p.server.close().catch(() => {})
      await p.page.close({ code: 1001, reason: 'lab partition' }).catch(() => {})
    }
    await Bun.sleep(1500)
    offline.statusDuringPartition = (await readChrome(page)).status
    const t = tokens('j', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    const m = marker('S8B')
    await agentAppend('S8B', m, page, true)
    offline.agentReachedEditorDuringPartitionMs = await waitEditorIncludes(page, m, 5000)
    const cut = await settle(page, 'S8b-socket-dropped', { expectConverged: false })
    offline.jIndexWhilePartitioned = cut.editor?.indexOf(' j01') ?? null
    evaluate(cut, false, ['editor'], [m])
    const t0 = performance.now()
    partition = false
    await desktop.setOffline(false)
    // Where the offline typing lands as the merge happens.
    const merge: Array<{ t: number; len: number; jIndex: number; agentIndex: number; head: number | null }> = []
    while (performance.now() - t0 < 60_000) {
      const e = await readEditor(page)
      merge.push({ t: Math.round(performance.now() - t0), len: e.text?.length ?? -1, jIndex: e.text?.indexOf(' j01') ?? -1, agentIndex: e.text?.indexOf(m) ?? -1, head: e.head })
      if (e.text?.includes(m) && merge.length > 1 && performance.now() - t0 > 3000) break
      await Bun.sleep(100)
    }
    offline.mergeSamples = merge
    offline.reconnectToAgentTextMs = merge.find((x) => x.agentIndex >= 0)?.t ?? null
    offline.refusedDuringPartition = refused
    evaluate(await settle(page, 'S8b-reconnected', { waitFor: [m], timeoutMs: 60_000 }))
    offline.statusAfterReconnect = (await readChrome(page)).status
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
  }

  // S8c (#720): the relay unreachable (collab sockets refused, HTTP up), type,
  // reload. The browser asks before the reload (the typing is unacknowledged),
  // the typing comes back from this browser's copy, and once the relay is
  // back it reaches disk and the DB exactly once.
  const relayDown: Record<string, unknown> = {}
  {
    const pairs: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = []
    let partition = false
    let refused = 0
    await page.routeWebSocket(/\/collab/, (ws) => {
      if (partition) {
        refused++
        void ws.close({ code: 1001, reason: 'lab partition' })
        return
      }
      pairs.push({ page: ws, server: ws.connectToServer() })
    })
    await page.reload()
    await waitReady(page)
    partition = true
    for (const p of pairs.splice(0)) {
      await p.server.close().catch(() => {})
      await p.page.close({ code: 1001, reason: 'lab partition' }).catch(() => {})
    }
    await Bun.sleep(1500)
    const t = tokens('k', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    await Bun.sleep(1500)
    relayDown.statusBeforeReload = (await readChrome(page)).status
    const promptsBefore = beforeUnloadPrompts.length
    await page.reload()
    relayDown.promptedOnReload = beforeUnloadPrompts.length > promptsBefore
    relayDown.prompts = beforeUnloadPrompts.length - promptsBefore
    relayDown.restoredInMs = await waitEditorIncludes(page, ' k05', 15_000)
    // The restored copy is unsent: the status must not read "Connecting…"
    // while every socket is refused. Polled: it follows the first refusal.
    const statusSince = performance.now()
    relayDown.statusAfterReload = (await readChrome(page)).status
    while (!/not saved yet/i.test((relayDown.statusAfterReload as string[]).join(' ')) && performance.now() - statusSince < 10_000) {
      await Bun.sleep(250)
      relayDown.statusAfterReload = (await readChrome(page)).status
    }
    evaluate(await settle(page, 'S8c-reloaded-relay-down', { expectConverged: false }), false, ['editor'])
    partition = false
    evaluate(await settle(page, 'S8c-relay-back', { waitFor: t, timeoutMs: 60_000 }))
    relayDown.refused = refused
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
  }

  const desktopVideo = page.video()
  await desktop.close()
  if (desktopVideo) {
    const p = join(OUT, 'desktop.webm')
    await desktopVideo.saveAs(p)
    await desktopVideo.delete()
    videos.push(p)
  }

  // ---------------------------------------------------------------- mobile
  const mobileData: Record<string, unknown> = {}
  const mobileChecks: Check[] = []
  {
    const iphone = devices['iPhone 13']!
    const mobile = await browser.newContext({ ...iphone, recordVideo: { dir: join(OUT, 'video-raw') } })
    const mp = await mobile.newPage()
    watch(mp, 'mobile')
    const screens: Array<{ screen: string; path: string | null; overflowX: boolean; url: string }> = []
    const mshot = async (label: string) => {
      const chrome = await readChrome(mp)
      screens.push({ screen: label, path: await screenshot(mp, 'mobile', label), overflowX: chrome.overflowX, url: new URL(mp.url()).pathname })
    }
    await mp.goto(`${ctx.baseUrl}/login`)
    await mp.locator('#login-email').waitFor({ timeout: 30_000 })
    await mshot('login')
    mobileData.loginMs = await uiLogin(mp)
    await Bun.sleep(1000)
    await mshot('home')
    await mp.goto(`${ctx.baseUrl}/vaults`)
    await Bun.sleep(1500)
    await mshot('vaults')
    const vaultLink = mp.locator(`a[href="/vaults/${vault.id}"]`).locator('visible=true').first()
    mobileData.vaultLinkVisible = (await vaultLink.count()) > 0
    if (mobileData.vaultLinkVisible) await vaultLink.tap()
    else await mp.goto(`${ctx.baseUrl}/vaults/${vault.id}`)
    await mp.waitForURL(new RegExp(`/vaults/${vault.id}`), { timeout: 15_000 })
    await Bun.sleep(1500)
    await mshot('vault')
    const noteLink = mp.locator(`a[href="/vaults/${vault.id}/notes/${path}"]`).locator('visible=true').first()
    mobileData.noteLinkVisible = (await noteLink.count()) > 0
    if (mobileData.noteLinkVisible) await noteLink.tap()
    else await mp.goto(noteUrl)
    mobileData.openNoteMs = await waitReady(mp)
    await mshot('note')
    const box = await mp.locator('.cm-content').boundingBox()
    mobileData.editorBox = box
    const mt = tokens('m', 5)
    await mp.locator('.cm-content').tap()
    await mp.keyboard.press('Control+End')
    await mp.keyboard.type(typedText(mt), { delay: TYPE_DELAY_MS })
    exp.user.push(...mt)
    await mshot('note-typed')
    mobileData.typingOnDiskMs = await waitDiskIncludes(mt)
    const m = marker('MOBILE')
    await agentAppend('MOBILE', m, mp)
    mobileData.agentToEditorMs = await waitEditorIncludes(mp, m)
    const s = await settle(mp, 'M-mobile-edit', { waitFor: [m], prefix: 'mobile' })
    const row = evaluate(s)
    await mshot('note-final')
    const menuBtn = mp.locator('button[aria-label="Mobile account menu"]').locator('visible=true').first()
    if ((await menuBtn.count()) > 0) {
      await menuBtn.tap()
      await Bun.sleep(500)
      await mshot('account-menu')
      await mp.keyboard.press('Escape')
    }
    mobileData.screens = screens
    const mobileVideo = mp.video()
    await mobile.close()
    if (mobileVideo) {
      const p = join(OUT, 'mobile.webm')
      await mobileVideo.saveAs(p)
      await mobileVideo.delete()
      videos.push(p)
    }
    const overflow = screens.filter((x) => x.overflowX).map((x) => x.screen)
    mobileChecks.push(
      {
        name: 'mobile: vault and note reachable by tapping visible links',
        expected: 'visible <a> to the vault and to the note',
        actual: `vault link ${mobileData.vaultLinkVisible ? 'visible' : 'NOT visible'}, note link ${mobileData.noteLinkVisible ? 'visible' : 'NOT visible'}`,
        ok: Boolean(mobileData.vaultLinkVisible && mobileData.noteLinkVisible),
        severity: 'medium',
      },
      {
        name: 'mobile: editor fits the viewport',
        expected: `editor width <= ${iphone.viewport.width}px`,
        actual: box ? `x=${Math.round(box.x)} width=${Math.round(box.width)}` : 'no editor box',
        ok: box ? box.x >= 0 && box.x + box.width <= iphone.viewport.width + 1 : false,
        severity: 'medium',
      },
      {
        name: 'mobile: no horizontal overflow on main screens',
        expected: 'scrollWidth <= innerWidth on every screen',
        actual: overflow.length === 0 ? 'none' : `overflow on ${overflow.join(', ')}`,
        ok: overflow.length === 0,
        severity: 'low',
      },
      {
        name: 'mobile: typed text and agent append both persisted once',
        expected: 'm01..m05 and the agent marker once in editor, disk and DB',
        actual: `dup=${row.duplicates.length} lostUser=${row.lostUser.length} lostAgent=${row.lostAgent.length} converged=${row.converged}`,
        ok: row.duplicates.length === 0 && row.lostUser.length === 0 && row.lostAgent.length === 0 && row.converged,
        severity: 'high',
        detail: row,
      },
    )
  }
  await browser.close()

  const revisions = await ctx.docker.psqlRows<{ actor_type: string; action: string; created_at: string; body: string }>(
    `select r.actor_type, r.action, r.created_at, note_revision_body(r.body, r.body_delta, r.delta_base_id) as body from note_revisions r join notes n on n.id = r.note_id
     where n.vault_id = '${vault.id}' and n.path = '${path}' order by r.ord`,
  )
  // Which actor the audit trail credits with each agent append: the first
  // revision whose body contains the agent's marker.
  const attribution = agentWrites
    .filter((w) => w.ok)
    .map((w) => ({ step: w.step, firstRevisionActor: revisions.find((r) => r.body.includes(w.marker))?.actor_type ?? null }))
  const mcpUpdates = revisions.filter((r) => r.actor_type === 'mcp' && r.action === 'update').length
  // Can the user get lost typing back from the note's history?
  const lostTokens = exp.gone.filter((g) => /^[a-z]\d\d$/.test(g.token))
  const unrecoverable = lostTokens.filter((g) => !revisions.some((r) => r.body.includes(g.token)))

  // ---------------------------------------------------------------- checks
  for (const r of rows) {
    if (r.step === 'M-mobile-edit') continue
    checks.push({
      name: `${r.step}: no duplicated text`,
      expected: 'every marker at most once in editor, disk, DB',
      actual: r.duplicates.length === 0 ? 'none' : r.duplicates.slice(0, 12).join(', '),
      ok: r.duplicates.length === 0,
      severity: 'high',
    })
    checks.push({
      name: `${r.step}: no lost user typing`,
      expected: 'every typed token (and the base lines) present',
      actual: r.lostUser.length === 0 ? 'none lost' : `${r.lostUser.length} missing: ${r.lostUser.slice(0, 12).join(', ')}`,
      ok: r.lostUser.length === 0,
      severity: 'critical',
    })
    checks.push({
      name: `${r.step}: no lost agent edits`,
      expected: 'every agent marker present',
      actual: r.lostAgent.length === 0 ? 'none lost' : r.lostAgent.slice(0, 12).join(', '),
      ok: r.lostAgent.length === 0,
      severity: 'high',
    })
    if (r.expectConverged) {
      checks.push({
        name: `${r.step}: editor = disk = DB`,
        expected: `identical within ${SETTLE_TIMEOUT_MS / 1000}s`,
        actual: r.converged ? `identical (${r.editorHash})` : `editor ${r.editorHash} disk ${r.diskHash} db ${r.dbHash}`,
        ok: r.converged,
        severity: 'high',
      })
    }
  }
  const failedWrites = agentWrites.filter((w) => !w.ok)
  checks.push({
    name: 'agent edit_note calls succeed',
    expected: 'all ok',
    actual: failedWrites.length === 0 ? `${agentWrites.length} ok` : failedWrites.map((w) => `${w.step}: ${w.error}`).join('; '),
    ok: failedWrites.length === 0,
    severity: 'high',
  })
  // Reads while the editor was offline are left out: its typing never reached the server (#485 covers where it lands).
  const staleReads = agentWrites.filter((w) => !w.editorOffline && w.missingFromRead.length > 0)
  checks.push({
    name: 'read_note returns what the live editor shows',
    expected: 'no token visible in a connected editor is missing from the agent read',
    actual:
      staleReads.length === 0
        ? 'never stale'
        : staleReads.map((w) => `${w.step}: ${w.missingFromRead.length} tokens missing (${w.missingFromRead.slice(0, 6).join(' ')})`).join('; '),
    ok: staleReads.length === 0,
    severity: 'high',
  })
  checks.push({
    name: 'S1: user typing stays contiguous while the agent writes',
    expected: '" a01 ... a40" as one run in the final text',
    actual: s1Contiguous ? 'contiguous' : 'split or partially lost (see S1 samples / final text)',
    ok: s1Contiguous,
    severity: 'medium',
  })
  const s1MaxDup = Math.max(0, ...s1Samples.map((x) => x.dupTokens.length))
  checks.push({
    name: 'S1: no transient duplicates while typing (150 ms samples)',
    expected: '0 tokens duplicated in any sample',
    actual: `max ${s1MaxDup} tokens duplicated in one sample (${s1Samples.length} samples)`,
    ok: s1MaxDup === 0,
    severity: 'medium',
  })
  const undoAgentLost = [...new Set(undoSteps.flatMap((u) => u.agentMissing))]
  checks.push({
    name: 'undo (Ctrl+Z) never removes agent edits',
    expected: 'all agent markers in the editor after each Ctrl+Z',
    actual: undoAgentLost.length === 0 ? 'kept' : `removed: ${undoAgentLost.join(', ')}`,
    ok: undoAgentLost.length === 0,
    severity: 'high',
  })
  const cLeft = undo.cTokensAfterUndo1 as string[]
  checks.push({
    name: "undo (Ctrl+Z) removes the user's own last typing after an agent append",
    expected: 'c01..c05 gone after one Ctrl+Z',
    actual:
      cLeft.length === 0
        ? 'removed'
        : `still there: ${cLeft.join(' ')}; Ctrl+Z changed the text: ${undoSteps.map((u) => `${u.label}=${u.changed}`).join(', ')}`,
    ok: cLeft.length === 0,
    severity: 'medium',
  })
  checks.push({
    name: "S3: caret stays after the user's typing when the agent appends",
    expected: 'caret at the end of c01..c05 (where the user stopped typing), not at the top',
    actual: `caret at ${String(undo.caretAfterAppend)}, typing ends at ${String(undo.typingEndsAt)}`,
    ok: undo.typingEndsAt !== null && undo.caretAfterAppend === undo.typingEndsAt,
    severity: 'medium',
  })
  checks.push({
    name: 'note_revisions credits edit_note to the agent (actor mcp)',
    expected: `${attribution.length} agent appends -> first revision with each marker has actor_type mcp`,
    actual: `${attribution.filter((a) => a.firstRevisionActor === 'mcp').length}/${attribution.length} credited to mcp (${mcpUpdates} mcp update revisions total); first actors: ${[...new Set(attribution.map((a) => a.firstRevisionActor))].join(', ')}`,
    ok: attribution.every((a) => a.firstRevisionActor === 'mcp'),
    severity: 'high',
  })
  checks.push({
    name: 'lost typing is recoverable from note history (note_revisions)',
    expected: 'every lost token appears in some revision body',
    actual:
      lostTokens.length === 0
        ? 'nothing was lost'
        : `${lostTokens.length - unrecoverable.length}/${lostTokens.length} recoverable; never in any revision: ${unrecoverable.map((g) => g.token).slice(0, 25).join(' ')}`,
    ok: lostTokens.length === 0 ? null : unrecoverable.length === 0,
    severity: 'high',
  })
  // A jump = the caret falls back >10 chars while the user only types forward.
  const cursorJumps = s1Samples.filter((x, i) => i > 0 && x.head !== null && (s1Samples[i - 1]?.head ?? -1) - x.head > 10)
  checks.push({
    name: 'S1: caret stays where the user types when the agent writes',
    expected: 'no caret jump while typing at the end',
    actual:
      cursorJumps.length === 0
        ? 'no jump'
        : `${cursorJumps.length} jumps: ${cursorJumps.map((x) => `t=${x.t}ms head->${x.head}`).join(', ')}`,
    ok: cursorJumps.length === 0,
    severity: 'medium',
  })
  const control = presence.controlPeersOnTab1 as string[]
  const agentSeenInPresence = agentWrites.some((w) => w.peersDuring.some((p) => p.length > 0 && p.some((x) => !x.startsWith('admin '))))
  checks.push({
    name: 'presence control: a second tab on the note shows up as a peer',
    expected: '1 peer avatar on tab 1',
    actual: JSON.stringify(control),
    ok: control.length > 0,
    severity: 'info',
  })
  checks.push({
    name: 'agent visible in presence while it writes (edit_note says "attributed to this connection")',
    expected: 'a non-human peer in "In this note now" during edit_note',
    actual: agentSeenInPresence ? 'agent visible' : `never visible in ${agentWrites.reduce((n, w) => n + w.peersDuring.length, 0)} samples`,
    ok: control.length > 0 ? agentSeenInPresence : null,
    severity: 'medium',
  })
  checks.push({
    name: 'S8a: context.setOffline stops collab traffic',
    expected: 'stopped (precondition of the S8a steps; Chromium emulation, not Elara)',
    actual: offline.setOfflineCutSocket ? 'stopped (agent text did not arrive while offline)' : 'NOT stopped: agent text arrived while "offline"',
    ok: offline.setOfflineCutSocket ? true : null,
    severity: 'info',
  })
  checks.push({
    name: 'S8a: UI tells the user about a silent network drop',
    expected: 'status shows Reconnecting/Offline within 45 s of going offline',
    actual:
      offline.silentDropDetectedMs === null
        ? `never in 45 s; statuses seen: ${(offline.statusSequenceWhileOffline as string[]).join(' -> ')}`
        : `after ${String(offline.silentDropDetectedMs)} ms; statuses: ${(offline.statusSequenceWhileOffline as string[]).join(' -> ')}`,
    ok: offline.silentDropDetectedMs !== null,
    severity: 'medium',
  })
  // Typing done while disconnected was typed at the end, below the previous
  // agent line; after the merge it must still be below that line, not at the top.
  for (const [step, first, anchorStep] of [
    ['S8a-back-online', ' i01', 'S7'],
    ['S8b-reconnected', ' j01', 'S8A'],
  ] as const) {
    const text = snaps.find((x) => x.step === step)?.editor ?? ''
    const anchor = agentWrites.find((w) => w.step === anchorStep)?.marker ?? '(missing)'
    checks.push({
      name: `${step}: typing done while disconnected stays where it was typed`,
      expected: `"${first.trim()} ..." after ${anchor} (where the caret was), not at the top`,
      actual: `${first.trim()} at index ${text.indexOf(first)}, ${anchor} at ${text.indexOf(anchor)} of ${text.length}`,
      ok: text.indexOf(first) > text.indexOf(anchor) && text.indexOf(anchor) >= 0,
      severity: 'medium',
    })
  }
  const partitionStatus = (offline.statusDuringPartition as string[]).join(' | ')
  checks.push({
    name: 'S8b: status tells the user the socket dropped',
    expected: 'status shows Reconnecting/Offline',
    actual: partitionStatus || '(no status text)',
    ok: /reconnect|offline/i.test(partitionStatus),
    severity: 'medium',
  })
  const relayDownStatus = (relayDown.statusBeforeReload as string[]).join(' | ')
  checks.push({
    name: 'S8c: status says the typing is not saved while the relay is unreachable',
    expected: 'status shows "Offline" and "not saved yet" (#720)',
    actual: relayDownStatus || '(no status text)',
    ok: /offline/i.test(relayDownStatus) && /not saved yet/i.test(relayDownStatus),
    severity: 'medium',
  })
  checks.push({
    name: 'S8c: reload with unacknowledged typing asks before leaving',
    expected: 'a beforeunload prompt on the reload (#720)',
    actual: relayDown.promptedOnReload ? 'prompted' : `no prompt (${beforeUnloadPrompts.length} prompts in the whole run)`,
    ok: relayDown.promptedOnReload === true,
    severity: 'medium',
  })
  const restoredStatus = (relayDown.statusAfterReload as string[]).join(' | ')
  checks.push({
    name: 'S8c: restored copy says it is not saved while the relay is unreachable',
    expected: 'status shows "Offline" and "not saved yet", not "Connecting…" (#720)',
    actual: restoredStatus || '(no status text)',
    ok: /offline/i.test(restoredStatus) && /not saved yet/i.test(restoredStatus),
    severity: 'medium',
  })
  // Every other step navigates or reloads with everything acknowledged (S6a,
  // S6b, S7, mobile): a prompt there nags on a synced note.
  checks.push({
    name: 'S8c is the only leave-page prompt in the run',
    expected: 'exactly 1 beforeunload prompt, on the S8c reload (#720)',
    actual: `${beforeUnloadPrompts.length} prompt(s), ${relayDown.prompts ?? 0} on the S8c reload: ${beforeUnloadPrompts.map((p) => `${p.page} ${p.at}`).join(', ') || 'none'}`,
    ok: beforeUnloadPrompts.length === 1 && relayDown.prompts === 1,
    severity: 'medium',
  })
  checks.push(...mobileChecks)
  checks.push({
    name: 'no page errors in the browser console',
    expected: '0 console errors / page errors',
    actual: `${consoleErrors.length}: ${consoleErrors.slice(0, 5).join(' || ')}`,
    ok: consoleErrors.length === 0,
    severity: 'low',
  })

  const bad = checks.filter((c) => c.ok === false)
  const summary =
    `Chromium ${browserVersion} (Playwright) on the collab editor with an MCP agent appending via read_note+edit_note: ` +
    `${rows.length} snapshots (editor/disk/DB/screenshot), ${agentWrites.length} agent writes. ` +
    `${bad.length} failed checks: ${bad.map((c) => c.name).join('; ') || 'none'}.`

  return {
    summary,
    checks,
    data: {
      chromium: browserVersion,
      installMs,
      vaultId: vault.id,
      path,
      timings,
      table: rows,
      snapshots: snaps,
      agentWrites,
      s1: { tokens: s1Tokens.length, samples: s1Samples, contiguous: s1Contiguous },
      undo,
      presence,
      navigation: nav,
      reload,
      logout,
      offline,
      relayDown,
      beforeUnloadPrompts,
      mobile: mobileData,
      attribution,
      lost: exp.gone,
      unrecoverable: unrecoverable.map((g) => g.token),
      revisions: revisions.map((r) => ({
        actor: r.actor_type,
        action: r.action,
        at: r.created_at,
        bodyHash: sha(r.body),
        len: r.body.length,
        userTokens: r.body.match(/\b[a-z]\d\d\b/g) ?? [],
      })),
      consoleErrors,
      videos,
    },
  }
}
