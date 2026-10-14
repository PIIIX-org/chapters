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
//   S1  user types 40 tokens while the agent appends twice mid-typing
//   S2  agent appends while the user is idle, then the user types
//   S3  user types, agent appends, Ctrl+Z x2 (does undo touch agent text?)
//   S4  second tab on the same note (presence control), then another page in
//       front while the agent appends, back, type
//   S5  type, navigate to another note in-app at once, agent appends, back
//   S6  type, reload at once while the agent appends
//   S7  type, log out via the account menu, agent appends, log in via UI
//   S8a context.setOffline(true): type + agent append, back online
//   S8b real socket drop (routeWebSocket closes both sides, refuses
//       reconnects, HTTP offline): type + agent append, back online
// Mobile (iPhone 13 emulation on Chromium): login, home, vaults, vault, note,
// type, agent append; screenshots of each screen.
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
import type * as Playwright from 'playwright'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import type { Check, LabContext, LabTest } from '../lib/context.ts'
import type { McpClient } from '../lib/mcp.ts'

const PW_VERSION = process.env.LAB_PLAYWRIGHT_VERSION ?? '1.55.0'
const PW_DIR = join(process.env.RUNNER_TEMP ?? '/tmp', 'lab-playwright')
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
  absent: string[]
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

async function installPlaywright(ctx: LabContext) {
  const t0 = performance.now()
  const script = [
    `mkdir -p '${PW_DIR}'`,
    `cd '${PW_DIR}'`,
    `[ -f package.json ] || echo '{"name":"lab-playwright","private":true}' > package.json`,
    `bun add playwright@${PW_VERSION}`,
    `bun node_modules/playwright/cli.js install --with-deps chromium`,
  ].join(' && ')
  const r = await ctx.docker.exec(['sh', '-c', script])
  if (r.code !== 0) {
    throw new Error(`playwright install failed (${r.code}): ${r.stderr.slice(-2000)}\n${r.stdout.slice(-2000)}`)
  }
  ctx.log(`playwright ${PW_VERSION} + chromium installed in ${Math.round(r.ms)} ms`)
  // Dynamic import is required: the package is installed at run time into a
  // temp dir outside the repo (the lab has no install step of its own).
  const pw = (await import(join(PW_DIR, 'node_modules/playwright/index.mjs'))) as typeof Playwright
  return { pw, installMs: Math.round(performance.now() - t0) }
}

async function runBrowser(ctx: LabContext, redact: (s: string) => string) {
  mkdirSync(OUT, { recursive: true })
  const checks: Check[] = []
  const { pw, installMs } = await installPlaywright(ctx)

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
    const r = await ctx.docker.exec([...ctx.docker.COMPOSE, 'exec', '-T', 'app', 'cat', file])
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

  const browser = await pw.chromium.launch()
  const consoleErrors: string[] = []
  const watch = (page: Page, label: string) => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(redact(`[${label}] ${m.text()}`).slice(0, 400))
    })
    page.on('pageerror', (e) => consoleErrors.push(redact(`[${label}] pageerror ${e.message}`).slice(0, 400)))
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
  const exp: Expect = { user: [...BASE], agent: [], absent: [] }
  const evaluate = (s: Snap, expectConverged = true, sources: Array<'editor' | 'disk' | 'db'> = ['editor', 'disk', 'db']) => {
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
      for (const m of exp.user) if (count(text, m) === 0) row.lostUser.push(`${m}@${name}`)
      for (const m of exp.agent) if (count(text, m) === 0) row.lostAgent.push(`${m}@${name}`)
      for (const m of exp.absent) if (count(text, m) > 0) row.reappeared.push(`${m}@${name}`)
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
  const agentAppend = async (step: string, m: string, watchPage: Page | null): Promise<AgentWrite> => {
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
      peersDuring,
    }
    agentWrites.push(w)
    exp.agent.push(m)
    ctx.log(`agent ${step} ${w.ok ? 'ok' : 'FAILED'} read ${readMs} ms edit ${editMs} ms missingFromRead=${w.missingFromRead.length}`)
    return w
  }

  // ---------------------------------------------------------------- desktop
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

  // S3: undo after an agent append.
  const undo: Record<string, unknown> = {}
  {
    const t = tokens('c', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    await Bun.sleep(3000) // past the relay's 2 s store debounce: the agent's read includes c01..c05
    const m = marker('S3')
    await agentAppend('S3', m, page)
    await waitEditorIncludes(page, m)
    await Bun.sleep(500)
    const before = (await readEditor(page)).text
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Control+z')
    await Bun.sleep(1500)
    const after1 = (await readEditor(page)).text
    // Expected: own c-typing undone, every agent line kept.
    exp.user = exp.user.filter((x) => !t.includes(x))
    exp.absent.push(...t)
    const r1 = evaluate(await settle(page, 'S3-undo-1', { waitFor: exp.agent }))
    await page.keyboard.press('Control+z')
    await Bun.sleep(1500)
    const after2 = (await readEditor(page)).text
    // Undo 2 may legitimately take more of the user's own typing; accept it,
    // but agent lines must survive.
    const undone2 = exp.user.filter((x) => !BASE.includes(x) && count(after2, x) === 0)
    exp.user = exp.user.filter((x) => !undone2.includes(x))
    exp.absent.push(...undone2)
    evaluate(await settle(page, 'S3-undo-2', { waitFor: exp.agent }))
    const agentLostByUndo = exp.agent.filter((x) => count(after1, x) === 0 || count(after2, x) === 0)
    undo.beforeLen = before?.length ?? null
    undo.after1Len = after1?.length ?? null
    undo.after2Len = after2?.length ?? null
    undo.undo1Changed = before !== after1
    undo.undo2Changed = after1 !== after2
    undo.cTokensAfterUndo1 = t.filter((x) => count(after1, x) > 0)
    undo.undone2 = undone2
    undo.agentLostByUndo = agentLostByUndo
    undo.reappearedAfterUndo1 = r1.reappeared
    undo.before = before
    undo.after1 = after1
    undo.after2 = after2
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
    await page2.close()
  }

  // S5: type, navigate in-app to note B immediately, agent appends, back.
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
    const m = marker('S5')
    await agentAppend('S5', m, null)
    await Bun.sleep(1000)
    await page.goBack()
    await waitReady(page)
    evaluate(await settle(page, 'S5-navigate-away-back', { waitFor: [m] }))
  }

  // S6: type then reload at once, while the agent appends.
  {
    const t = tokens('g', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    const m = marker('S6')
    await Promise.all([page.reload(), agentAppend('S6', m, null)])
    await waitReady(page)
    evaluate(await settle(page, 'S6-reload', { waitFor: [m] }))
  }

  // S7: type, log out, agent appends while logged out, log back in.
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
    const m = marker('S7')
    await agentAppend('S7', m, null)
    logout.loginMs = await uiLogin(page)
    await page.goto(noteUrl)
    await waitReady(page)
    evaluate(await settle(page, 'S7-logout-login', { waitFor: [m] }))
  }

  // S8a: Chromium network emulation offline.
  const offline: Record<string, unknown> = {}
  {
    await desktop.setOffline(true)
    await Bun.sleep(1500)
    offline.statusAfterSetOffline = (await readChrome(page)).status
    const t = tokens('i', 5)
    await typeAtEnd(page, typedText(t))
    exp.user.push(...t)
    const m = marker('S8A')
    await agentAppend('S8A', m, page)
    offline.agentReachedEditorWhileOfflineMs = await waitEditorIncludes(page, m, 5000)
    offline.setOfflineCutSocket = offline.agentReachedEditorWhileOfflineMs === null
    // Editor-only expectations while offline: disk/DB can't have i01..i05 if the socket is cut.
    evaluate(await settle(page, 'S8a-offline-emulated', { expectConverged: false }), false, ['editor'])
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
    await agentAppend('S8B', m, page)
    offline.agentReachedEditorDuringPartitionMs = await waitEditorIncludes(page, m, 5000)
    evaluate(await settle(page, 'S8b-socket-dropped', { expectConverged: false }), false, ['editor'])
    const t0 = performance.now()
    partition = false
    await desktop.setOffline(false)
    offline.reconnectToAgentTextMs = await waitEditorIncludes(page, m, 60_000)
    offline.refusedDuringPartition = refused
    offline.reconnectWallMs = Math.round(performance.now() - t0)
    evaluate(await settle(page, 'S8b-reconnected', { waitFor: [m], timeoutMs: 60_000 }))
    offline.statusAfterReconnect = (await readChrome(page)).status
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
  }

  const revisions = await ctx.docker.psqlRows<{ actor_type: string; action: string; created_at: string; body: string }>(
    `select r.actor_type, r.action, r.created_at, r.body from note_revisions r join notes n on n.id = r.note_id
     where n.vault_id = '${vault.id}' and n.path = '${path}' order by r.created_at`,
  )

  const desktopVideo = page.video()
  await desktop.close()
  const videos: string[] = []
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
    const { defaultBrowserType: _ignored, ...iphone } = pw.devices['iPhone 13']!
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
  const staleReads = agentWrites.filter((w) => w.missingFromRead.length > 0)
  checks.push({
    name: 'read_note returns what the live editor shows',
    expected: 'no token visible in the editor is missing from the agent read',
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
  const undoAgentLost = undo.agentLostByUndo as string[]
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
    actual: cLeft.length === 0 ? 'removed' : `still there: ${cLeft.join(' ')} (undo changed text: ${String(undo.undo1Changed)})`,
    ok: cLeft.length === 0,
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
    name: 'S8a: context.setOffline cuts the collab socket',
    expected: 'informational (Chromium emulation, not Elara)',
    actual: offline.setOfflineCutSocket ? 'cut (agent text did not arrive while offline)' : 'NOT cut: agent text arrived while "offline"',
    ok: null,
    severity: 'info',
  })
  const partitionStatus = (offline.statusDuringPartition as string[]).join(' | ')
  checks.push({
    name: 'S8b: status tells the user the socket dropped',
    expected: 'status shows Reconnecting/Offline',
    actual: partitionStatus || '(no status text)',
    ok: /reconnect|offline/i.test(partitionStatus),
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
    `Chromium (Playwright ${PW_VERSION}) on the collab editor with an MCP agent appending via read_note+edit_note: ` +
    `${rows.length} snapshots (editor/disk/DB/screenshot), ${agentWrites.length} agent writes. ` +
    `${bad.length} failed checks: ${bad.map((c) => c.name).join('; ') || 'none'}.`

  return {
    summary,
    checks,
    data: {
      playwright: PW_VERSION,
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
      logout,
      offline,
      mobile: mobileData,
      revisions: revisions.map((r) => ({ actor: r.actor_type, action: r.action, at: r.created_at, bodyHash: sha(r.body), len: r.body.length })),
      consoleErrors,
      videos,
    },
  }
}
