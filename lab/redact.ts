// Replaces every secret of this lab run with *** in the text files of a
// results directory, before the workflow uploads it as an artifact (masking
// only covers the job log; the app prints its setup token into compose.log).
// Secrets: the values in ./.env and the passwords, session cookies and MCP
// tokens in lab-env.json (when bootstrap got that far).
//   bun lab/redact.ts lab-results
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { LabEnv } from './lib/context.ts'

const dir = process.argv[2] ?? 'lab-results'
const TEXT = ['.json', '.md', '.log', '.txt']

const secrets: string[] = []
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const i = line.indexOf('=')
    // MCP_RATE_LIMIT is a number, not a secret.
    if (i > 0 && !line.startsWith('MCP_RATE_LIMIT=')) secrets.push(line.slice(i + 1).trim())
  }
}
if (existsSync('lab-env.json')) {
  const env = JSON.parse(readFileSync('lab-env.json', 'utf8')) as LabEnv
  for (const u of Object.values(env.users)) secrets.push(u.password, u.cookie)
  for (const t of Object.values(env.tokens)) secrets.push(t.token)
}
// Short values would also hit unrelated text; every generated secret is long.
const values = [...new Set(secrets)].filter((s) => s.length >= 16).sort((a, b) => b.length - a.length)

let files = 0
let hits = 0
function walk(path: string) {
  for (const name of readdirSync(path)) {
    const p = join(path, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (TEXT.includes(extname(p))) {
      const text = readFileSync(p, 'utf8')
      let out = text
      for (const v of values) {
        const n = out.split(v).length - 1
        if (n > 0) {
          hits += n
          out = out.split(v).join('***')
        }
      }
      if (out !== text) {
        writeFileSync(p, out)
        files++
      }
    }
  }
}
if (existsSync(dir)) walk(dir)
console.log(`redacted ${hits} occurrence(s) of ${values.length} secret(s) in ${files} file(s)`)
