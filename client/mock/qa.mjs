// Visual QA driver (dev tooling, nothing ships): launches a headless Chromium
// browser with remote debugging, opens each route against a running client,
// waits for it to settle, screenshots it, measures the shell regions and
// reports any overlap between sibling regions plus horizontal body scroll —
// the mechanical version of "no weird overlaps".
//
//   node client/mock/qa.mjs <outDir> <base> <path>[,<path>...] [--width=1440 --height=900 --theme=light --port=9333]
//   e.g. MSYS_NO_PATHCONV=1 node client/mock/qa.mjs ./shots http://localhost:5173 /,/vaults,/repos
//
// Browser: $BROWSER_PATH, else Edge's default install (Windows), else Chrome.
// On Git Bash pass paths with MSYS_NO_PATHCONV=1 so a leading '/' is not
// rewritten into a filesystem path.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const BROWSER = CANDIDATES.find((p) => existsSync(p))
if (!BROWSER) throw new Error('no browser found; set BROWSER_PATH')

const [outDir, base, pathsArg, ...flags] = process.argv.slice(2)
if (!outDir || !base || !pathsArg) {
  console.error('usage: node client/mock/qa.mjs <outDir> <base> <path,path,...> [--width --height --theme --port]')
  process.exit(2)
}
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')))
const width = Number(opt.width ?? 1440)
const height = Number(opt.height ?? 900)
const port = Number(opt.port ?? 9333)
const paths = pathsArg.split(',')
mkdirSync(outDir, { recursive: true })

const profile = join(outDir, 'profile')
const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function wsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const j = await r.json()
      return j.webSocketDebuggerUrl
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('browser did not start')
}

const ws = new WebSocket(await wsUrl())
await new Promise((r) => (ws.onopen = r))
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
}
function send(method, params = {}, sessionId) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

// Runs in the page. Measures the shell regions and reports sibling overlaps
// (two visible boxes that intersect by more than a pixel without one
// containing the other).
const MEASURE = `(() => {
  const sel = 'nav[aria-label="Primary"], header, aside, main, [data-shell-panel], [data-testid="graph-canvas"], canvas, [role="dialog"], [data-slot="panel"]';
  const els = [...document.querySelectorAll(sel)];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('aria-label') ? '[' + el.getAttribute('aria-label') + ']' : '') + (el.dataset.shellPanel ? '.' + el.dataset.shellPanel : '') + (el.dataset.testid ? '.' + el.dataset.testid : '');
  const boxes = els.filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed').map((el) => ({ name: name(el), ...rect(el), hidden: el.hidden }));
  const overlaps = [];
  const visible = boxes.filter((b) => b.w > 0 && b.h > 0);
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const a = visible[i], b = visible[j];
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (ix < 2 || iy < 2) continue;
    const contains = (o, p) => o.x <= p.x + 1 && o.y <= p.y + 1 && o.x + o.w >= p.x + p.w - 1 && o.y + o.h >= p.y + p.h - 1;
    if (contains(a, b) || contains(b, a)) continue;
    overlaps.push({ a: a.name, b: b.name, ix, iy });
  }
  const bodyScrollX = document.documentElement.scrollWidth > window.innerWidth;
  return { url: location.pathname, title: document.title, boxes, overlaps, bodyScrollX, dark: document.documentElement.classList.contains('dark') };
})()`

const report = []
for (const path of paths) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
  if (opt.theme) {
    await send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `localStorage.setItem('chapters.theme','${opt.theme}')` },
      sessionId,
    )
  }
  await send('Page.navigate', { url: base + path }, sessionId)
  // Settle: give the first requests a moment, then wait for fonts and for
  // every loading indicator to clear, capped so a stuck page still reports.
  await new Promise((r) => setTimeout(r, 2500))
  for (let i = 0; i < 20; i++) {
    const { result } = await send(
      'Runtime.evaluate',
      { expression: `document.fonts.status === 'loaded' && !document.querySelector('[role="status"]')`, returnByValue: true },
      sessionId,
    )
    if (result.value) break
    await new Promise((r) => setTimeout(r, 250))
  }
  await new Promise((r) => setTimeout(r, 400))
  const { result } = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId)
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const name = path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
  const file = `${name}${opt.theme ? '-' + opt.theme : ''}.png`
  writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'))
  report.push({ path, file, ...result.value })
  await send('Target.closeTarget', { targetId })
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
for (const r of report) {
  console.log(`\n== ${r.path} (${r.dark ? 'dark' : 'light'}) -> ${r.file}${r.bodyScrollX ? '  !! HORIZONTAL BODY SCROLL' : ''}`)
  for (const b of r.boxes) {
    console.log(
      `  ${b.name.padEnd(46)} x=${String(b.x).padStart(5)} y=${String(b.y).padStart(4)} w=${String(b.w).padStart(5)} h=${String(b.h).padStart(4)}${b.hidden ? ' hidden' : ''}`,
    )
  }
  for (const o of r.overlaps) console.log(`  !! OVERLAP ${o.a} <> ${o.b} (${o.ix}x${o.iy})`)
}
ws.close()
browser.kill()
process.exit(0)
