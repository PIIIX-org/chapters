// Fails-before check for fix PRs (#575). Runs the test files a fix PR adds
// or changes against the base commit's source and requires at least one of
// them to fail there: a regression test that also passes without the fix
// does not show the fix does anything. See docs/agents/github-workflow.md.
//
// Plain Node, no dependencies: it runs before `pnpm install`, from the PR
// checkout. The base source lives in a separate git worktree so restoring it
// never touches this script.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXEMPT_LABEL = 'no-fails-before'
const MIN_JUSTIFICATION = 10

/** Conventional-commit fix titles: `fix: ...`, `fix(scope): ...`, `fix!: ...`. */
export function isFixTitle(title) {
  return /^fix(\([^)]*\))?!?:/i.test((title ?? '').trim())
}

/**
 * The `Fails-before: n/a <why>` line from a PR body, or null when there is
 * none or the reason after `n/a` is shorter than MIN_JUSTIFICATION chars.
 */
export function parseJustification(body) {
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?\**Fails-before:?\**:?\s*n\/a\b(.*)$/i.exec(line)
    if (!m) continue
    const reason = m[1].replace(/^[\s:,.;-]+/, '').trim()
    if (reason.length >= MIN_JUSTIFICATION) return line.trim()
  }
  return null
}

/** Test code and its helpers/fixtures: kept at the PR's version. */
export function isTestSide(path) {
  return (
    path.startsWith('server/test/') ||
    path.startsWith('client/src/test/') ||
    /^client\/src\/.+\.test\.tsx?$/.test(path)
  )
}

/** A file vitest runs. */
export function isTestFile(path) {
  return isTestSide(path) && /\.test\.tsx?$/.test(path)
}

/** `git diff --name-status --no-renames -z` output -> [{status, path}]. */
export function parseNameStatus(out) {
  const parts = out.split('\0').filter((s) => s !== '')
  const changes = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    changes.push({ status: parts[i][0], path: parts[i + 1] })
  }
  return changes
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')

function firstLine(text) {
  const line = (text ?? '').replace(ANSI, '').trim().split('\n')[0] ?? ''
  return line.length > 300 ? `${line.slice(0, 297)}...` : line
}

/**
 * One vitest JSON file result -> what happened on base.
 * - `failed`: at least one test ran and failed (what the check wants).
 * - `load-error`: the file failed to import/compile or a suite-level error
 *   stopped it before any test failed; this does not show the test catches
 *   the bug.
 * - `passed`: every test that ran passed.
 */
export function classifyFile(result) {
  const assertions = result.assertionResults ?? []
  const failed = assertions.filter((a) => a.status === 'failed')
  if (failed.length > 0) {
    return {
      kind: 'failed',
      tests: failed.map((a) => ({
        name: a.fullName || a.title,
        message: firstLine(a.failureMessages?.[0]),
      })),
    }
  }
  if (result.status === 'failed') {
    return {
      kind: 'load-error',
      message: firstLine(result.message) || '(no message)',
    }
  }
  return {
    kind: 'passed',
    count: assertions.filter((a) => a.status === 'passed').length,
  }
}

/**
 * Per-file outcomes + the job verdict. `outcomes` maps repo path ->
 * classifyFile() result, or { kind: 'not-run', message } when vitest
 * produced no result for the file.
 */
export function verdict(outcomes) {
  const all = Object.values(outcomes)
  if (all.some((o) => o.kind === 'failed')) {
    return {
      ok: true,
      reason: 'At least one changed test fails on the base commit.',
    }
  }
  if (all.some((o) => o.kind === 'load-error' || o.kind === 'not-run')) {
    return {
      ok: false,
      reason:
        'No changed test failed on the base commit; some test files did not load or run there ' +
        '(see the table). A suite that fails to load does not show that the test catches the bug: ' +
        'make the test fail on an assertion, or label the PR `no-fails-before` with a ' +
        '`Fails-before: n/a because ...` line.',
    }
  }
  return {
    ok: false,
    reason:
      'Every changed test passes on the base commit, so none of them shows the bug. Add a test ' +
      'that fails without the fix, or label the PR `no-fails-before` with a ' +
      '`Fails-before: n/a because ...` line in the PR body.',
  }
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function summaryTable(outcomes) {
  const rows = ['| Test file | On base | Details |', '| --- | --- | --- |']
  for (const [path, o] of Object.entries(outcomes)) {
    if (o.kind === 'failed') {
      const details = o.tests
        .map(
          (t) =>
            `\`${cell(t.name)}\`${t.message ? `: ${cell(t.message)}` : ''}`,
        )
        .join('<br>')
      rows.push(
        `| \`${path}\` | ❌ test failed (${o.tests.length}) | ${details} |`,
      )
    } else if (o.kind === 'load-error') {
      rows.push(
        `| \`${path}\` | ⚠️ suite failed to load | ${cell(o.message)} |`,
      )
    } else if (o.kind === 'not-run') {
      rows.push(`| \`${path}\` | ⚠️ not run | ${cell(o.message)} |`)
    } else {
      rows.push(
        `| \`${path}\` | ✅ passed (${o.count}) | all tests pass without the fix |`,
      )
    }
  }
  return rows.join('\n')
}

// ---------------------------------------------------------------------------
// Runner (GitHub Actions only)

function summary(markdown) {
  console.log(markdown)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
}

function finish(ok, title, body) {
  summary(
    `## Fails-before check: ${ok ? 'passed' : 'failed'}\n\n**${title}**\n\n${body}`,
  )
  if (!ok) console.log(`::error title=Fails-before check failed::${title}`)
  process.exit(ok ? 0 : 1)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    ...opts,
  })
  if (res.error) throw res.error
  return res.status ?? 1
}

function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${res.status}: ${res.stderr}`,
    )
  }
  return res.stdout
}

const git = (args, opts) => capture('git', args, opts).trim()

function startDatabase() {
  console.log('::group::Start Postgres (pgvector) for server tests')
  const status = run('docker', [
    'run',
    '-d',
    '-q',
    '--name',
    'fails-before-db',
    '-e',
    'POSTGRES_USER=elara',
    '-e',
    'POSTGRES_PASSWORD=elara',
    '-e',
    'POSTGRES_DB=elara',
    '-p',
    '5432:5432',
    'pgvector/pgvector:pg17',
  ])
  if (status !== 0) throw new Error('docker run pgvector failed')
  for (let i = 0; i < 60; i++) {
    const ready = spawnSync('docker', [
      'exec',
      'fails-before-db',
      'pg_isready',
      '-U',
      'elara',
    ])
    if (ready.status === 0) {
      console.log('::endgroup::')
      return
    }
    spawnSync('sleep', ['2'])
  }
  throw new Error('Postgres did not become ready in 120s')
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const pr = event.pull_request
  if (!pr) finish(true, 'Not a pull_request event; nothing to check.', '')

  if (!isFixTitle(pr.title)) {
    finish(
      true,
      'Not a fix PR: skipped.',
      `The title \`${cell(pr.title)}\` does not start with \`fix:\` / \`fix(scope):\`, ` +
        'so no fails-before test is required.',
    )
  }

  const labels = (pr.labels ?? []).map((l) => l.name)
  if (labels.includes(EXEMPT_LABEL)) {
    const line = parseJustification(pr.body)
    if (!line) {
      finish(
        false,
        `Label \`${EXEMPT_LABEL}\` is set but the PR body has no justification.`,
        'Add a line `Fails-before: n/a because <why no test can fail before this fix>` ' +
          `(at least ${MIN_JUSTIFICATION} characters after \`n/a\`) to the PR body.`,
      )
    }
    console.log(`::notice title=Fails-before exemption::${line}`)
    finish(
      true,
      `Exempt: label \`${EXEMPT_LABEL}\`. No test was run.`,
      `Justification from the PR body:\n\n> ${line}`,
    )
  }

  // With the default checkout of a pull_request event, HEAD is GitHub's
  // merge of the PR into its base: HEAD^1 is the base the PR is tested
  // against and HEAD^2 the PR head. Fall back to the payload otherwise.
  const head = git(['rev-parse', 'HEAD'])
  let baseSha = pr.base.sha
  let overlaySha = pr.head.sha
  const parents = git(['rev-list', '--parents', '-n', '1', head])
    .split(' ')
    .slice(1)
  if (parents.length === 2 && parents[1] === pr.head.sha) {
    baseSha = parents[0]
    overlaySha = head
  } else {
    git(['fetch', '--no-tags', 'origin', pr.base.sha, pr.head.sha])
  }

  const changes = parseNameStatus(
    capture('git', [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      `${baseSha}...${pr.head.sha}`,
    ]),
  )
  const testSide = changes.filter((c) => isTestSide(c.path))
  const source = changes.filter((c) => !isTestSide(c.path))
  const tests = testSide
    .filter((c) => c.status !== 'D' && isTestFile(c.path))
    .map((c) => c.path)

  console.log(`Base commit: ${baseSha}\nTest files taken from: ${overlaySha}`)
  console.log(
    `Changed test-side files:\n${testSide.map((c) => `  ${c.status} ${c.path}`).join('\n') || '  (none)'}`,
  )
  console.log(
    `Changed source files, kept at base:\n${source.map((c) => `  ${c.status} ${c.path}`).join('\n') || '  (none)'}`,
  )

  if (tests.length === 0) {
    finish(
      false,
      'This fix PR adds or changes no test file.',
      'A fix PR needs a regression test (`server/test/**/*.test.ts` or ' +
        '`client/src/**/*.test.ts(x)`) that fails without the fix. If no such test can exist ' +
        `(docs- or CI-only fix), label the PR \`${EXEMPT_LABEL}\` and add a ` +
        '`Fails-before: n/a because ...` line to the PR body.',
    )
  }

  // Base source + the PR's test side.
  const tmp = process.env.RUNNER_TEMP ?? resolve('..')
  const wt = join(tmp, 'fails-before-base')
  const reports = join(tmp, 'fails-before-reports')
  mkdirSync(reports, { recursive: true })
  git(['worktree', 'add', '--detach', wt, baseSha])
  const keep = testSide.filter((c) => c.status !== 'D').map((c) => c.path)
  const drop = testSide.filter((c) => c.status === 'D').map((c) => c.path)
  if (keep.length > 0) git(['-C', wt, 'checkout', overlaySha, '--', ...keep])
  if (drop.length > 0)
    git(['-C', wt, 'rm', '-q', '--ignore-unmatch', '--', ...drop])

  console.log('::group::pnpm install (base commit)')
  if (run('pnpm', ['install', '--frozen-lockfile'], { cwd: wt }) !== 0) {
    throw new Error('pnpm install failed on the base commit')
  }
  console.log('::endgroup::')

  const byPackage = { server: [], client: [] }
  for (const t of tests) byPackage[t.split('/')[0]].push(t)

  const outcomes = {}
  for (const [pkg, files] of Object.entries(byPackage)) {
    if (files.length === 0) continue
    const env = { ...process.env }
    if (pkg === 'server') {
      startDatabase()
      Object.assign(env, {
        DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara_test',
        TEST_DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara_test',
        ADMIN_DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara',
        DATA_DIR: join(tmp, 'elara-test-data'),
      })
    }
    const report = join(reports, `${pkg}.json`)
    console.log(`::group::vitest (${pkg}) on base: ${files.join(' ')}`)
    const code = run(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${report}`,
        ...files.map((f) => join(wt, f)),
      ],
      { cwd: join(wt, pkg), env },
    )
    console.log('::endgroup::')
    const results = existsSync(report)
      ? (JSON.parse(readFileSync(report, 'utf8')).testResults ?? [])
      : []
    for (const f of files) {
      const abs = resolve(wt, f)
      const r = results.find((x) => resolve(x.name) === abs)
      outcomes[f] = r
        ? classifyFile(r)
        : {
            kind: 'not-run',
            message: existsSync(report)
              ? 'vitest reported no result for this file'
              : `vitest exited ${code} without a report (config or global setup error; see the log)`,
          }
    }
  }

  const v = verdict(outcomes)
  const restored = source.length
    ? `\n\nSource files restored to the base commit (${source.length}): ` +
      source.map((c) => `\`${c.path}\``).join(', ')
    : '\n\nThe PR changes no source file outside the test directories.'
  finish(
    v.ok,
    v.reason,
    `Base commit \`${baseSha.slice(0, 12)}\`. Each changed test file was run there; ` +
      `a test that fails on base is what this check wants.\n\n` +
      `${summaryTable(outcomes)}${restored}`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (err) {
    finish(
      false,
      'The check could not run.',
      `\`\`\`\n${err?.stack ?? err}\n\`\`\``,
    )
  }
}
