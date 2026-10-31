// Archives review records (docs/reviews/<pr>-<sha>.md). A record whose PR
// has been merged (or closed without merging) for more than DAYS days moves
// to docs/reviews/archive/YYYY-MM/, the month the PR was merged or closed,
// so the top-level directory holds only the records of open and recent
// PRs. Verdict comments link records by commit sha, so a moved record's
// links keep working. Records of open PRs, and files that are not records,
// stay. Workflow: .github/workflows/review-archive.yml (weekly bot PR);
// policy: docs/agents/github-workflow.md (Review records).
//
// Usage (plain Node, no dependencies):
//   node .github/scripts/review-archive.mjs [--write] [--dir docs/reviews] [--repo owner/name] [--days 7]
// Without --write it only prints the moves. Token: GITHUB_TOKEN, GH_TOKEN,
// or `gh auth token`. Repo: --repo, GITHUB_REPOSITORY, or the `origin`
// remote. In Actions it also writes the step summary and
// `changed=true|false` to GITHUB_OUTPUT.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DAYS = 7
export const ARCHIVE = 'archive'
const RECORD = /^(\d+)-([0-9a-f]{7,40})\.md$/

/** `{ number, sha }` for a record file name, or null for anything else. */
export function parseRecord(name) {
  const m = RECORD.exec(name)
  return m ? { number: Number(m[1]), sha: m[2] } : null
}

/** `archive/YYYY-MM` for an ISO date (UTC). */
export function archiveDir(iso) {
  return `${ARCHIVE}/${iso.slice(0, 7)}`
}

/**
 * The moves to make, as `{ name, number, to }` sorted by name, where `to`
 * is the directory relative to the records directory. `pulls` maps a PR
 * number to `{ state, merged_at, closed_at }` as the API returns it; a
 * record whose PR is open or missing from `pulls` stays. A PR counts as
 * done from `merged_at` (or `closed_at` when never merged); its records move
 * once that is more than `days` days before `now`.
 */
export function plan(names, pulls, now = new Date(), days = DAYS) {
  const cutoff = now.getTime() - days * 86_400_000
  const out = []
  for (const name of names) {
    const rec = parseRecord(name)
    if (!rec) continue
    const pr = pulls[rec.number]
    if (!pr || pr.state !== 'closed') continue
    const done = pr.merged_at ?? pr.closed_at
    if (!done || Date.parse(done) > cutoff) continue
    out.push({ name, number: rec.number, to: archiveDir(done) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The record file names at the top of `dir` (the archive is not scanned). */
export function records(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && parseRecord(e.name))
    .map((e) => e.name)
    .sort()
}

/** Moves each planned record; creates the month directories. */
export function apply(dir, moves) {
  for (const m of moves) {
    mkdirSync(join(dir, m.to), { recursive: true })
    renameSync(join(dir, m.name), join(dir, m.to, m.name))
  }
}

// ---------------------------------------------------------------------------
// GitHub data

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

async function api(path, auth) {
  const url = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${auth}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * `{ [number]: { state, merged_at, closed_at } }` for each PR the records
 * name. One request at a time: a few dozen is all there ever is. A number
 * the API will not return (not a PR, a transient error) is left out with a
 * warning, so its records stay where they are and the rest still move;
 * `get(path, auth)` is the request, replaceable in tests.
 */
export async function fetchPulls(repo, numbers, auth, get = api) {
  const out = {}
  for (const n of new Set(numbers)) {
    try {
      const p = await get(`/repos/${repo}/pulls/${n}`, auth)
      out[n] = { state: p.state, merged_at: p.merged_at, closed_at: p.closed_at }
    } catch (err) {
      const text = `#${n}: not looked up, its records stay (${err?.message ?? err})`
      console.warn(process.env.GITHUB_ACTIONS ? `::warning title=review-archive::${text}` : `warning: ${text}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

/** owner/name of the `origin` remote, or undefined. */
function originRepo() {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1]
  } catch {
    return undefined
  }
}

async function main() {
  const dir = arg('--dir', 'docs/reviews')
  const days = Number(arg('--days', DAYS))
  const write = process.argv.includes('--write')
  const repo = arg('--repo', process.env.GITHUB_REPOSITORY) ?? originRepo()
  if (!repo) throw new Error('No repository: pass --repo owner/name or set GITHUB_REPOSITORY')
  const names = records(dir)
  const pulls = await fetchPulls(
    repo,
    names.map((n) => parseRecord(n).number),
    token(),
  )
  const moves = plan(names, pulls, new Date(), days)
  const changed = moves.length > 0
  if (changed && write) apply(dir, moves)
  const lines = moves.map((m) => `- \`${m.name}\` → \`${m.to}/\` (#${m.number})`)
  const state = !changed
    ? `${dir}: nothing older than ${days} days to archive`
    : write
      ? `${dir}: archived ${moves.length} record(s)`
      : `${dir}: ${moves.length} record(s) to archive (run with --write to move them)`
  console.log([...lines, state].join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Review records: ${state}\n\n${lines.join('\n')}\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err?.stack ?? err)
    process.exit(1)
  })
}
