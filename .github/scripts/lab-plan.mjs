// Lab and benchmark tier for a pull request to `dev`, from the files it
// changes (the `plan` job of .github/workflows/elara-lab.yml; the same job
// resolves the PR of a merge-group commit and plans it the same way).
//
//   tier   fast when the PR changes what goes into the image or the lab,
//          else none.
//   also   extra fast-tier tests: browser (client collab code), backup-restore
//          (#493: backup or restore code).
//   bench  all when the PR touches what shapes a ranking or the tokens every
//          suite measures (server/src/search/**, and from the MCP code only
//          mcp/{response,read-targets,session-reads}.ts: the budget ladder and
//          the reads), the extraction path
//          (repositories/{extraction,code-blocks,code-edge,outline,
//          import-resolution,language}*, text/{blocks,lines,targets}.ts,
//          notes/note-blocks.ts, config.ts) or the benchmark's premise
//          inputs (benchmarks/{run.ts,lib/,questions/,baseline.json});
//          chapters when it touches the wider set the chapters suite
//          covers (the rest of server/src/mcp/**: tool definitions and
//          contracts, the rest of repositories/, schema, start-up, the image's
//          dependencies, the lab plumbing, the workflow, the gate); else none.
//   golds  true with bench=all by path: bench-gate then also requires every
//          suite to reach at least the reference's goldReached
//          (bench-gate.mjs --require-golds).
//
//   reuse  a review-record head (#1071): a PR head whose only change from its
//          single parent is under docs/reviews/** and whose parent's lab,
//          bench and bench-gate checks all concluded success (or skipped)
//          with a successful bench-gate: nothing runs again; the plan is
//          tier none, bench none, and `reuse` is the parent's bench-gate
//          run, which the gate job reports instead. Never on a merge_group
//          run, and any doubt (another path, a merge commit, a missing or
//          red parent check, an API error) plans as today.
//
// Plain Node, no dependencies. Prints `key=value` lines for $GITHUB_OUTPUT:
//
//   node .github/scripts/lab-plan.mjs --files changed.txt   (one path per line)
//     [--head-commit head.json --parent-checks checks.json]   (GitHub API: the head commit, and the check runs of its parent)

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Everything the Dockerfile copies into the image, plus the lab itself. */
export const IMAGE_OR_LAB =
  /^(server\/|client\/|lab\/|skills\/elara\/references\/mcp-tools\.md$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.base\.json$|Dockerfile$|\.dockerignore$|docker-compose\.yml$|\.github\/workflows\/elara-lab\.yml$|\.github\/actions\/lab-instance\/|\.github\/scripts\/lab-gate\.mjs$|\.github\/scripts\/lab-plan\.mjs$)/

/** The browser test is the only one that drives the client's collab code. */
export const BROWSER = /^client\/src\/(hooks\/(useCollabDoc|useCodeMirrorEditor)|api\/collab)/

/** Backup -> restore into a fresh database -> verify counts, digests and content (#493). */
export const BACKUP_RESTORE =
  /^(server\/src\/export\/|server\/src\/scripts\/restore-backup\.ts$|server\/src\/notes\/atomic-write\.ts$|lab\/tests\/backup-restore\.test\.ts$)/

/**
 * What decides what an agent gets back: search, extraction and ingestion,
 * MCP responses, the schema, the image's dependencies, and the benchmark
 * with its lab plumbing. Markdown under benchmarks/ (README, run notes)
 * cannot change a result and runs nothing; neither can agent-trial/, runs/,
 * session/ or package.json, which feed no premise fingerprint.
 */
export const BENCH_CHAPTERS =
  /^(server\/src\/(search|mcp|repositories|db)\/|server\/src\/(config|index|app)\.ts$|server\/drizzle\/|server\/package\.json$|pnpm-lock\.yaml$|Dockerfile$|docker-compose\.yml$|benchmarks\/(run\.ts$|baseline\.json$|lib\/|questions\/)|lab\/bootstrap\.ts$|lab\/lib\/|lab\/docker-compose\.lab\.yml$|\.github\/workflows\/elara-lab\.yml$|\.github\/actions\/lab-instance\/|\.github\/scripts\/bench-gate\.mjs$|\.github\/scripts\/lab-plan\.mjs$)/

/**
 * Ranking and token paths (search ranking; the MCP budget ladder, `response.ts`,
 * and the range reads, `read-targets.ts` and `session-reads.ts`: they change the
 * tokens every suite measures, #1066 added 3.8 % to tokens-to-gold), the
 * extraction path (blocks, line ranges, targets, code edges, outlines,
 * languages, config) and the
 * benchmark's premise inputs (run.ts, lib/, questions/, baseline.json):
 * every suite runs, and no suite may lose a gold.
 */
export const BENCH_ALL =
  /^(server\/src\/search\/|server\/src\/mcp\/(response|read-targets|session-reads)\.ts$|server\/src\/repositories\/(extraction|code-blocks|code-edge|outline|import-resolution|language)[^/]*$|server\/src\/text\/(blocks|lines|targets)\.ts$|server\/src\/notes\/note-blocks\.ts$|server\/src\/config\.ts$|benchmarks\/(run\.ts$|baseline\.json$|lib\/|questions\/))/

/** The plan for a list of changed paths: { tier, also, bench, golds }. */
export function plan(files) {
  const some = (re) => files.some((f) => re.test(f))
  const also = []
  if (some(BROWSER)) also.push('browser')
  if (some(BACKUP_RESTORE)) also.push('backup-restore')
  const all = some(BENCH_ALL)
  return {
    tier: some(IMAGE_OR_LAB) ? 'fast' : 'none',
    also: also.join(','),
    bench: all ? 'all' : some(BENCH_CHAPTERS) ? 'chapters' : 'none',
    golds: all,
  }
}

/**
 * The parent's bench-gate run to reuse for a review-record head, or null (#1071). `head` is the API's commit object of the
 * PR head, `checks` the parent's `check-runs` answer. Reuse needs: one parent; the head's only changes (renames included)
 * under docs/reviews/; the parent's latest bench-gate check successful; every other lab or bench check of the parent
 * (latest per name) successful or skipped.
 */
export function reuseFrom(head, checks) {
  const files = head?.files
  if (!Array.isArray(files) || files.length === 0 || files.length >= 300 || head.parents?.length !== 1) return null
  const reviews = (f) => typeof f === 'string' && f.startsWith('docs/reviews/') && !f.includes('..')
  if (!files.every((f) => reviews(f.filename) && (f.previous_filename === undefined || reviews(f.previous_filename)))) return null
  const latest = new Map()
  for (const run of checks?.check_runs ?? []) {
    if (!/^(lab|bench-gate|bench \(\d+\))$/.test(run.name) || run.app?.slug !== 'github-actions') continue
    if (!latest.has(run.name) || run.id > latest.get(run.name).id) latest.set(run.name, run)
  }
  const gate = latest.get('bench-gate')
  if (gate?.conclusion !== 'success' || typeof gate.html_url !== 'string') return null
  for (const run of latest.values()) if (run.conclusion !== 'success' && run.conclusion !== 'skipped') return null
  return gate.html_url
}

/** The `key=value` lines for $GITHUB_OUTPUT (`reuse` only when set). */
export function outputs(p) {
  return [`tier=${p.tier}`, `also=${p.also}`, `bench=${p.bench}`, `golds=${p.golds}`, ...(p.reuse ? [`reuse=${p.reuse}`] : [])].join('\n')
}

function main() {
  const i = process.argv.indexOf('--files')
  if (i < 0 || !process.argv[i + 1]) throw new Error('usage: lab-plan.mjs --files <changed paths, one per line>')
  const files = readFileSync(process.argv[i + 1], 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  let p = plan(files)
  const arg = (name) => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined)
  // Fail closed: an unreadable or malformed API answer plans as today.
  try {
    if (arg('--head-commit') && arg('--parent-checks')) {
      const reuse = reuseFrom(JSON.parse(readFileSync(arg('--head-commit'), 'utf8')), JSON.parse(readFileSync(arg('--parent-checks'), 'utf8')))
      if (reuse) p = { tier: 'none', also: '', bench: 'none', golds: false, reuse }
    }
  } catch {
    // plan as today
  }
  console.log(outputs(p))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
