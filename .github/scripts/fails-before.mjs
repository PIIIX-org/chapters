// Fails-before check for fix PRs (#575). Runs the test files a fix PR adds
// or changes (whole files, not named tests) against the base commit's
// source and requires at least one of them to fail there: a regression test
// that also passes without the fix does not show the fix does anything. A
// NEW test file that passes entirely on base is vacuous and fails the check
// unless it carries `// fails-before: exempt <reason>` (parseExempt). See
// docs/agents/github-workflow.md.
//
// Plain Node, no dependencies: it runs before `pnpm install`, from the PR
// checkout (the workflow runs the base commit's copy of this file when there
// is one). The base source lives in a separate git worktree so restoring it
// never touches the checkout.

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXEMPT_LABEL = 'no-fails-before'
const MIN_JUSTIFICATION = 10

/** Conventional-commit fix titles: `fix: ...`, `fix(scope): ...`, `fix!: ...`, `fix(scope)!: ...`. */
export function isFixTitle(title) {
  return /^fix(\([^)]*\))?!?:/i.test((title ?? '').trim())
}

/**
 * The `Fails-before: n/a because <why>` line from a PR body, or null when
 * there is none or the reason is shorter than MIN_JUSTIFICATION chars. The
 * reason is measured after `n/a`, a leading `because` and any `<...>`
 * placeholder are removed, so the hint text itself is not a reason.
 */
export function parseJustification(body) {
  for (const line of (body ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:[-*]\s+)?\**Fails-before:?\**:?\s*n\/a\b(.*)$/i.exec(line)
    if (!m) continue
    const reason = m[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/^[\s:,.;-]*(because\b)?[\s:,.;-]*/i, '')
      .trim()
    if (reason.length >= MIN_JUSTIFICATION) return line.trim()
  }
  return null
}

/** Test code, its helpers, fixtures and snapshots: kept at the PR's version. */
export function isTestSide(path) {
  return (
    path.startsWith('server/test/') ||
    path.startsWith('client/src/test/') ||
    /^client\/src\/.+\.test\.tsx?$/.test(path) ||
    /^client\/src\/(.+\/)?__snapshots__\//.test(path)
  )
}

/** A file vitest runs. */
export function isTestFile(path) {
  return isTestSide(path) && /\.test\.tsx?$/.test(path)
}

/**
 * The reason from a `// fails-before: exempt <reason>` comment in a test
 * file, or null. The marker lets a NEW test file pass entirely on the base
 * commit (otherwise a new file that passes without the fix is vacuous and
 * fails the check); the reason needs at least MIN_JUSTIFICATION characters.
 */
export function parseExempt(source) {
  const m = /^[ \t]*\/\/[ \t]*fails-before:[ \t]*exempt[ \t]+(\S.*)$/im.exec(
    source ?? '',
  )
  if (!m) return null
  const reason = m[1].trim()
  return reason.length >= MIN_JUSTIFICATION && !/^<[^>]*>$/.test(reason)
    ? reason
    : null
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
 * Vitest rewrites `import { f } from './x'` to a binding object
 * (`__vite_ssr_import_0__`, or `__vi_import_0__` in files that use
 * `vi.mock`). When `x` exists on base without `f`, the suite loads and the
 * call fails with `(0 , __vite_ssr_import_0__.f) is not a function` (or `is
 * not a constructor`): that is a missing export, not the bug.
 */
export const MISSING_BINDING = /__vi(?:te_ssr)?_import_\d+__\.[\w$]+/

/**
 * Named value imports from relative (`./`, `../`) or `@/` modules in a test
 * file: [{ spec, names }]. `import type`, `type X` specifiers and namespace
 * imports are skipped; a default import is the name `default`.
 */
export function relativeImports(source) {
  const out = []
  const re =
    /^\s*import\s+([\w$*\s{},]+?)\s+from\s+['"]((?:\.{1,2}|@)\/[^'"]+)['"]/gm
  for (const [, clause, spec] of source.matchAll(re)) {
    if (/^type\s/.test(clause)) continue
    const names = []
    const brace = /\{([^}]*)\}/.exec(clause)
    const head = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim()
    if (/^[\w$]+$/.test(head)) names.push('default')
    for (const part of (brace?.[1] ?? '').split(',')) {
      const p = part.trim()
      if (p === '' || /^type\s/.test(p)) continue
      names.push(p.split(/\s+as\s+/)[0].trim())
    }
    if (names.length > 0) out.push({ spec, names })
  }
  return out
}

/**
 * A throwaway vitest file, placed next to a test file, that imports the
 * same modules and writes `{ spec: missingNames[] | 'error: ...' }` to
 * `outFile`. Runs on base and on the PR head: a name missing on base but
 * present on head is an export the PR adds (types are missing on both).
 */
export function probeSource(imports, outFile) {
  const steps = imports.map(({ spec, names }) => {
    const s = JSON.stringify(spec)
    return (
      `  try {\n    const m = await import(${s})\n` +
      `    out[${s}] = ${JSON.stringify(names)}.filter((n) => !(n in m))\n` +
      `  } catch (e) {\n    out[${s}] = 'error: ' + String(e)\n  }\n`
    )
  })
  return (
    `import { writeFileSync } from 'node:fs'\nimport { it } from 'vitest'\n\n` +
    `it('fails-before export probe', async () => {\n  const out = {}\n` +
    `${steps.join('')}  writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out))\n})\n`
  )
}

/**
 * Exports a test file imports that the PR adds: names the base probe found
 * missing and the head probe found present. A head probe that is missing or
 * could not import the module counts every base-missing name as added.
 */
export function addedExports(baseProbe, headProbe) {
  const added = []
  for (const [spec, missing] of Object.entries(baseProbe ?? {})) {
    const onHead = headProbe?.[spec]
    const names =
      typeof missing === 'string'
        ? []
        : missing.filter((n) => !Array.isArray(onHead) || !onHead.includes(n))
    for (const name of names) added.push({ spec, name })
  }
  return added
}

const testInfo = (a) => ({
  name: a.fullName || a.title,
  message: firstLine(a.failureMessages?.[0]),
})

/**
 * One vitest JSON file result -> what happened on base.
 * - `failed`: at least one test failed on an assertion or error of its own
 *   (what the check wants). `ignored` lists failures on a missing import
 *   binding, which do not count.
 * - `missing-export`: tests failed, but every failure is a missing import
 *   binding, or the file imports exports the PR adds (`exports`), so the
 *   failures can come from the missing export rather than the bug.
 * - `load-error`: the file failed to import/compile or a suite-level error
 *   stopped it before any test failed; this does not show the test catches
 *   the bug.
 * - `passed`: every test that ran passed.
 */
export function classifyFile(result, exports = []) {
  const assertions = result.assertionResults ?? []
  const failed = assertions.filter((a) => a.status === 'failed')
  const binding = failed.filter((a) =>
    MISSING_BINDING.test(a.failureMessages?.[0] ?? ''),
  )
  const counted = failed.filter((a) => !binding.includes(a))
  if (counted.length > 0 && exports.length === 0) {
    return {
      kind: 'failed',
      tests: counted.map(testInfo),
      ignored: binding.map(testInfo),
    }
  }
  if (failed.length > 0) {
    return { kind: 'missing-export', exports, tests: failed.map(testInfo) }
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

/** Outcomes of new test files that pass entirely on base without an exempt marker. */
export function vacuousFiles(outcomes) {
  return Object.entries(outcomes)
    .filter(([, o]) => o.added && o.kind === 'passed' && !o.exempt)
    .map(([path]) => path)
}

/**
 * Per-file outcomes + the job verdict. `outcomes` maps repo path ->
 * classifyFile() result, or { kind: 'not-run', message } when vitest
 * produced no result for the file, plus `added` (the PR adds the file) and
 * `exempt` (its `// fails-before: exempt <reason>` reason, or null).
 */
export function verdict(outcomes) {
  const all = Object.values(outcomes)
  const vacuous = vacuousFiles(outcomes)
  if (vacuous.length > 0) {
    return {
      ok: false,
      reason:
        `New test file${vacuous.length > 1 ? 's' : ''} ${vacuous.map((p) => `\`${p}\``).join(', ')} ` +
        `pass${vacuous.length > 1 ? '' : 'es'} entirely on the base commit: a new file whose every test passes ` +
        'without the fix is vacuous. Make at least one of its tests fail on base, or mark the file ' +
        'with a `// fails-before: exempt <reason>` comment if it legitimately cannot (for example a ' +
        'characterisation test the fix must keep passing).',
    }
  }
  if (all.some((o) => o.kind === 'failed')) {
    return {
      ok: true,
      reason: 'At least one changed test fails on the base commit.',
    }
  }
  if (all.some((o) => o.kind !== 'passed')) {
    return {
      ok: false,
      reason:
        'No changed test failed on the base commit for a reason that shows the bug: some test ' +
        'files did not load or run there, or failed only because they import an export the PR ' +
        'adds (see the table). Make a test fail on an assertion, reaching new code only through ' +
        'exports the base already has, or label the PR `no-fails-before` with a ' +
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
      const ignored = o.ignored.length
        ? `<br>Not counted (missing import binding): ${o.ignored.map((t) => `\`${cell(t.name)}\``).join(', ')}`
        : ''
      rows.push(
        `| \`${path}\` | ❌ test failed (${o.tests.length}) | ${details}${ignored} |`,
      )
    } else if (o.kind === 'missing-export') {
      const names = o.exports.length
        ? `imports exports the base lacks: ${o.exports.map((e) => `\`${cell(e.name)}\` from \`${cell(e.spec)}\``).join(', ')}. `
        : ''
      const tests = o.tests
        .map((t) => `\`${cell(t.name)}\`: ${cell(t.message)}`)
        .join('<br>')
      rows.push(
        `| \`${path}\` | ⚠️ failed on a missing export (not counted) | ${names}Failed: ${tests} |`,
      )
    } else if (o.kind === 'load-error') {
      rows.push(
        `| \`${path}\` | ⚠️ suite failed to load | ${cell(o.message)} |`,
      )
    } else if (o.kind === 'not-run') {
      rows.push(`| \`${path}\` | ⚠️ not run | ${cell(o.message)} |`)
    } else if (o.added && o.exempt) {
      rows.push(
        `| \`${path}\` | ✅ passed (${o.count}), new file, exempt | \`// fails-before: exempt\`: ${cell(o.exempt)} |`,
      )
    } else if (o.added) {
      rows.push(
        `| \`${path}\` | ❌ new file passes entirely (${o.count}) | vacuous: every test passes without the fix; add a failing one or a \`// fails-before: exempt <reason>\` comment |`,
      )
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

// The workflow runs the base commit's copy of this script when the base
// has one (so a PR cannot edit the check it is judged by) and says which.
const CHECKER =
  process.env.FAILS_BEFORE_CHECKER === 'base'
    ? "Checker: the base commit's `.github/scripts/fails-before.mjs`."
    : process.env.FAILS_BEFORE_CHECKER === 'pr'
      ? "Checker: the PR's `.github/scripts/fails-before.mjs` (the base commit has none yet)."
      : ''

function finish(ok, title, body) {
  summary(
    `## Fails-before check: ${ok ? 'passed' : 'failed'}\n\n**${title}**\n\n${body}` +
      (CHECKER ? `\n\n${CHECKER}` : ''),
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
      `The title \`${cell(pr.title)}\` does not start with \`fix:\` / \`fix(scope):\` ` +
        '(or `fix!:` / `fix(scope)!:`), so no fails-before test is required.',
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
          `to the PR body, with at least ${MIN_JUSTIFICATION} characters of reason after ` +
          '`because` (the `<...>` placeholder does not count).',
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

  const install = (what) => {
    console.log(`::group::pnpm install (${what})`)
    if (run('pnpm', ['install', '--frozen-lockfile'], { cwd: wt }) !== 0) {
      throw new Error(`pnpm install failed on the ${what}`)
    }
    console.log('::endgroup::')
  }
  const vitest = (pkg, files, report, what) => {
    console.log(`::group::vitest (${pkg}) ${what}: ${files.join(' ')}`)
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
    return code
  }
  install('base commit')

  const byPackage = { server: [], client: [] }
  for (const t of tests) byPackage[t.split('/')[0]].push(t)

  const env = { ...process.env }
  if (byPackage.server.length > 0) {
    startDatabase()
    Object.assign(env, {
      DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara_test',
      TEST_DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara_test',
      ADMIN_DATABASE_URL: 'postgres://elara:elara@localhost:5432/elara',
      DATA_DIR: join(tmp, 'elara-test-data'),
    })
  }

  // Export probes (see probeSource): one next to each test file that
  // imports named values from repo modules, run with the tests on base.
  const probes = []
  for (const test of tests) {
    const imports = relativeImports(readFileSync(join(wt, test), 'utf8'))
    if (imports.length === 0) continue
    const i = probes.length
    probes.push({
      test,
      imports,
      path: `${dirname(test)}/__fails_before_probe_${i}__.test.ts`,
      out: (phase) => join(reports, `probe-${i}-${phase}.json`),
    })
  }
  const writeProbes = (phase) => {
    for (const p of probes) {
      writeFileSync(join(wt, p.path), probeSource(p.imports, p.out(phase)))
    }
  }
  const readProbes = (phase) =>
    probes.map((p) =>
      existsSync(p.out(phase))
        ? JSON.parse(readFileSync(p.out(phase), 'utf8'))
        : null,
    )
  const probesOf = (pkg) =>
    probes.filter((p) => p.test.startsWith(`${pkg}/`)).map((p) => p.path)

  writeProbes('base')
  const outcomes = {}
  for (const [pkg, files] of Object.entries(byPackage)) {
    if (files.length === 0) continue
    const report = join(reports, `${pkg}.json`)
    const code = vitest(pkg, [...files, ...probesOf(pkg)], report, 'on base')
    const results = existsSync(report)
      ? (JSON.parse(readFileSync(report, 'utf8')).testResults ?? [])
      : []
    for (const f of files) {
      const abs = resolve(wt, f)
      const r = results.find((x) => resolve(x.name) === abs)
      outcomes[f] = r ?? {
        kind: 'not-run',
        message: existsSync(report)
          ? 'vitest reported no result for this file'
          : `vitest exited ${code} without a report (config or global setup error; see the log)`,
      }
    }
  }

  // A name the base lacks is either an export the PR adds or a type (types
  // never exist at runtime). Only if the base probe found any, check the
  // same imports on the PR head in the same worktree to tell them apart.
  const baseProbes = readProbes('base')
  let headProbes = []
  const missingOnBase = baseProbes.some(
    (bp) =>
      bp && Object.values(bp).some((v) => Array.isArray(v) && v.length > 0),
  )
  if (missingOnBase) {
    git(['-C', wt, 'checkout', '-q', '-f', '--detach', overlaySha])
    install('PR head, export probe')
    writeProbes('head')
    for (const pkg of Object.keys(byPackage)) {
      const files = probesOf(pkg)
      if (files.length === 0) continue
      vitest(pkg, files, join(reports, `${pkg}-head.json`), 'on PR head')
    }
    headProbes = readProbes('head')
  }
  const added = {}
  probes.forEach((p, i) => {
    added[p.test] = addedExports(baseProbes[i], headProbes[i])
  })
  // A file the PR adds must not pass entirely on base (vacuous) unless it
  // carries a `// fails-before: exempt <reason>` comment. The test files
  // are read from the worktree, which holds the PR's copy of each.
  const newFiles = new Set(
    testSide.filter((c) => c.status === 'A').map((c) => c.path),
  )
  for (const [f, r] of Object.entries(outcomes)) {
    const o = r.kind !== 'not-run' ? classifyFile(r, added[f] ?? []) : r
    o.added = newFiles.has(f)
    o.exempt = o.added ? parseExempt(readFileSync(join(wt, f), 'utf8')) : null
    outcomes[f] = o
  }
  for (const [f, o] of Object.entries(outcomes)) {
    if (o.exempt)
      console.log(
        `::notice file=${f},title=Fails-before exempt file::${o.exempt}`,
      )
  }

  const v = verdict(outcomes)
  const restored = source.length
    ? `\n\nSource files restored to the base commit (${source.length}): ` +
      source.map((c) => `\`${c.path}\``).join(', ')
    : '\n\nThe PR changes no source file outside the test directories.'
  finish(
    v.ok,
    v.reason,
    `Base commit \`${baseSha.slice(0, 12)}\`. Each changed test file was run there in full; ` +
      `a test that fails on base is what this check wants, and a new file that passes entirely is vacuous.\n\n` +
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
