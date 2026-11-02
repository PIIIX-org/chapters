// Unit tests for lab-plan.mjs (the `plan` job of elara-lab.yml).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { outputs, plan, reuseFrom } from './lab-plan.mjs'

const SCRIPT = fileURLToPath(new URL('./lab-plan.mjs', import.meta.url))

describe('plan', () => {
  it('a docs-only PR runs nothing', () => {
    assert.deepEqual(plan(['docs/agents/STATE.md', 'README.md']), { tier: 'none', also: '', bench: 'none', golds: false })
    assert.deepEqual(plan([]), { tier: 'none', also: '', bench: 'none', golds: false })
  })

  it('image or lab changes pick the fast tier; collab and backup code add their tests', () => {
    assert.equal(plan(['client/src/App.tsx']).tier, 'fast')
    assert.equal(plan(['lab/tests/x.test.ts']).tier, 'fast')
    assert.equal(plan(['skills/elara/references/mcp-tools.md']).tier, 'fast')
    assert.equal(plan(['.github/scripts/lab-gate.mjs']).tier, 'fast')
    assert.equal(plan(['.github/scripts/lab-plan.mjs']).tier, 'fast')
    assert.equal(plan(['client/src/hooks/useCollabDoc.ts']).also, 'browser')
    assert.equal(plan(['server/src/export/backup.ts']).also, 'backup-restore')
    assert.equal(plan(['client/src/api/collab.ts', 'lab/tests/backup-restore.test.ts']).also, 'browser,backup-restore')
    assert.equal(plan(['server/src/export/backup.ts']).bench, 'none')
  })

  it('search, the MCP budget ladder and reads, extraction or benchmark changes run every suite and require the golds', () => {
    for (const file of ['server/src/search/fusion.ts', 'server/src/mcp/response.ts', 'server/src/mcp/read-targets.ts', 'server/src/mcp/session-reads.ts', 'benchmarks/questions/rea.json', 'benchmarks/lib/policies.ts', 'benchmarks/run.ts',
      'server/src/repositories/extraction.ts', 'server/src/repositories/extraction-queue.ts', 'server/src/repositories/extraction-languages.ts', 'server/src/repositories/code-blocks.ts',
      'server/src/repositories/code-edges.ts', 'server/src/repositories/code-edge-rules.ts', 'server/src/repositories/outline.ts',
      'server/src/repositories/import-resolution.ts', 'server/src/repositories/language.ts', 'server/src/text/blocks.ts', 'server/src/text/lines.ts', 'server/src/text/targets.ts',
      'server/src/notes/note-blocks.ts', 'server/src/config.ts']) {
      const p = plan(['README.md', file])
      assert.equal(p.bench, 'all', file)
      assert.equal(p.golds, true, file)
    }
    assert.equal(plan(['server/src/search/fusion.ts']).tier, 'fast')
    // Markdown under benchmarks/ (README, run notes) changes no result.
    assert.deepEqual(plan(['benchmarks/README.md', 'benchmarks/runs/2026-10-31.md']), { tier: 'none', also: '', bench: 'none', golds: false })
    assert.equal(plan(['benchmarks/baseline.json']).bench, 'all')
    // Benchmark files outside the premise inputs run nothing.
    for (const file of ['benchmarks/agent-trial/run.ts', 'benchmarks/runs/2026-10-31.json', 'benchmarks/session/x.ts', 'benchmarks/package.json']) {
      assert.deepEqual(plan([file]), { tier: 'none', also: '', bench: 'none', golds: false }, file)
    }
    // The rest of repositories/ stays on the chapters suite without the golds floor.
    for (const file of ['server/src/repositories/store.ts', 'server/src/repositories/git-sync.ts', 'server/src/repositories/routes.ts', 'server/src/repositories/scheduler.ts', 'server/src/text/other.ts']) {
      assert.equal(plan([file]).golds, false, file)
    }
  })

  it('the rest of the MCP code (tool definitions, contracts, new tools) runs the chapters suite only', () => {
    for (const file of ['server/src/mcp/server.ts', 'server/src/mcp/tools/read.ts', 'server/src/mcp/code-queries.ts', 'server/src/mcp/grep.ts', 'server/src/mcp/prompts.ts', 'server/src/mcp/response-shapes.ts', 'server/src/mcp/sub/read-targets.ts']) {
      const p = plan([file])
      assert.equal(p.bench, 'chapters', file)
      assert.equal(p.golds, false, file)
    }
    // A mixed PR takes the larger plan.
    assert.deepEqual(plan(['server/src/mcp/server.ts', 'server/src/mcp/response.ts']).bench, 'all')
  })

  it('the wider chapters set runs the chapters suite only, without the golds floor', () => {
    for (const file of [
      'server/src/repositories/store.ts',
      'server/src/db/schema.ts',
      'server/drizzle/0001.sql',
      'server/package.json',
      'pnpm-lock.yaml',
      'Dockerfile',
      'docker-compose.yml',
      'lab/bootstrap.ts',
      'lab/lib/fixlab.ts',
      '.github/workflows/elara-lab.yml',
      '.github/actions/lab-instance/action.yml',
      '.github/scripts/bench-gate.mjs',
    ]) {
      const p = plan([file])
      assert.equal(p.bench, 'chapters', file)
      assert.equal(p.golds, false, file)
    }
    // Not: a client change, a server test, a search test file outside server/src.
    assert.equal(plan(['client/src/search.ts']).bench, 'none')
    assert.equal(plan(['server/test/search.test.ts']).bench, 'none')
    assert.equal(plan(['server/src/notes/store.ts']).bench, 'none')
  })

  it('prints key=value lines for $GITHUB_OUTPUT', () => {
    assert.equal(outputs(plan(['server/src/mcp/response.ts'])), 'tier=fast\nalso=\nbench=all\ngolds=true')
    assert.equal(outputs(plan(['server/src/mcp/server.ts'])), 'tier=fast\nalso=\nbench=chapters\ngolds=false')
    const dir = mkdtempSync(join(tmpdir(), 'lab-plan-'))
    const list = join(dir, 'changed.txt')
    writeFileSync(list, 'docs/x.md\r\nserver/src/db/schema.ts\n\n')
    const res = spawnSync(process.execPath, [SCRIPT, '--files', list], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout.trim(), 'tier=fast\nalso=\nbench=chapters\ngolds=false')
    assert.notEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 0)
  })
})

// #1071: a review-record head reuses its parent's green results.
const GATE_URL = 'https://github.com/PIIIX-org/chapters/actions/runs/1/job/2'
const run = (name, conclusion, id = 1, slug = 'github-actions') => ({ id, name, conclusion, app: { slug }, html_url: name === 'bench-gate' ? GATE_URL : `https://x/${name}` })
const green = { check_runs: [run('plan', 'success'), run('lab', 'success'), run('bench (1)', 'success'), run('bench (2)', 'success'), run('bench (3)', 'success'), run('bench-gate', 'success')] }
const record = { parents: [{ sha: 'p' }], files: [{ filename: 'docs/reviews/1043-abc.md' }] }

describe('reuseFrom', () => {
  it('a head that changes only docs/reviews/ with a green parent reuses the parent bench-gate run', () => {
    assert.equal(reuseFrom(record, green), GATE_URL)
    // A skipped lab (a PR with no image change) and a renamed record are fine.
    const skippedLab = { check_runs: green.check_runs.map((c) => (c.name === 'lab' ? run('lab', 'skipped') : c)) }
    assert.equal(reuseFrom({ parents: [{}], files: [{ filename: 'docs/reviews/archive/2026-11/a.md', previous_filename: 'docs/reviews/a.md' }] }, skippedLab), GATE_URL)
  })

  it('a red, cancelled, missing or unfinished parent does not reuse', () => {
    for (const bad of ['failure', 'cancelled', 'timed_out', null]) {
      assert.equal(reuseFrom(record, { check_runs: green.check_runs.map((c) => (c.name === 'bench-gate' ? run('bench-gate', bad) : c)) }), null, `gate ${bad}`)
      assert.equal(reuseFrom(record, { check_runs: green.check_runs.map((c) => (c.name === 'bench (2)' ? run('bench (2)', bad) : c)) }), null, `bench ${bad}`)
      assert.equal(reuseFrom(record, { check_runs: green.check_runs.map((c) => (c.name === 'lab' ? run('lab', bad) : c)) }), null, `lab ${bad}`)
    }
    assert.equal(reuseFrom(record, { check_runs: green.check_runs.filter((c) => c.name !== 'bench-gate') }), null)
    assert.equal(reuseFrom(record, { check_runs: [] }), null)
    assert.equal(reuseFrom(record, undefined), null)
    // A check of another app named bench-gate is not the workflow's.
    assert.equal(reuseFrom(record, { check_runs: [run('bench-gate', 'success', 1, 'other-app')] }), null)
  })

  it('the latest run of a name decides: a rerun that passed after a failure reuses, a later failure does not', () => {
    const rerun = { check_runs: [run('bench-gate', 'failure', 1), run('bench-gate', 'success', 2), ...green.check_runs.filter((c) => c.name !== 'bench-gate')] }
    assert.equal(reuseFrom(record, rerun), GATE_URL)
    const later = { check_runs: [run('bench-gate', 'success', 1), run('bench-gate', 'failure', 2), ...green.check_runs.filter((c) => c.name !== 'bench-gate')] }
    assert.equal(reuseFrom(record, later), null)
  })

  it('any other path in the diff, a merge commit, no parent or no files does not reuse', () => {
    assert.equal(reuseFrom({ parents: [{}], files: [{ filename: 'docs/reviews/a.md' }, { filename: 'server/src/search/x.ts' }] }, green), null)
    assert.equal(reuseFrom({ parents: [{}], files: [{ filename: 'docs/reviews.md' }] }, green), null)
    assert.equal(reuseFrom({ parents: [{}], files: [{ filename: 'docs/reviews/a.md', previous_filename: 'server/src/search/x.ts' }] }, green), null)
    assert.equal(reuseFrom({ parents: [{}, {}], files: record.files }, green), null)
    assert.equal(reuseFrom({ parents: [], files: record.files }, green), null)
    assert.equal(reuseFrom({ parents: [{}], files: [] }, green), null)
    assert.equal(reuseFrom({ parents: [{}], files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/reviews/${i}.md` })) }, green), null)
    assert.equal(reuseFrom({ parents: [{}] }, green), null)
    assert.equal(reuseFrom(null, green), null)
  })
})

describe('lab-plan.mjs with a head commit and the parent checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-plan-reuse-'))
  const write = (name, value) => {
    const file = join(dir, name)
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  // The whole PR changes the search ranking (the all-suite plan); its last commit adds a review record.
  const files = write('changed.txt', 'server/src/search/fusion.ts\ndocs/reviews/1-abc.md\n')
  const planWith = (head, checks) => {
    const res = spawnSync(process.execPath, [SCRIPT, '--files', files, '--head-commit', write('head.json', head), '--parent-checks', write('checks.json', checks)], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    return res.stdout.trim()
  }

  it('a review-record head with a green parent plans nothing and names the parent run', () => {
    assert.equal(planWith(record, green), `tier=none\nalso=\nbench=none\ngolds=false\nreuse=${GATE_URL}`)
  })

  it('red parent, mixed diff or unreadable input plans as today (every suite, the golds floor)', () => {
    const today = 'tier=fast\nalso=\nbench=all\ngolds=true'
    assert.equal(planWith(record, { check_runs: green.check_runs.map((c) => (c.name === 'bench-gate' ? run('bench-gate', 'failure') : c)) }), today)
    assert.equal(planWith({ parents: [{}], files: [{ filename: 'docs/reviews/a.md' }, { filename: 'server/src/search/fusion.ts' }] }, green), today)
    assert.equal(planWith('not json', green), today)
    assert.equal(planWith(record, 'not json'), today)
    // Without the API inputs (a merge_group run passes none) it is the plan from the files.
    const res = spawnSync(process.execPath, [SCRIPT, '--files', files], { encoding: 'utf8' })
    assert.equal(res.stdout.trim(), today)
  })
})

describe('the workflow wiring (#1071)', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../workflows/elara-lab.yml', import.meta.url)), 'utf8')

  it('only a pull_request event passes the head commit and the parent checks: a merge_group run never reuses', () => {
    assert.match(workflow, /if \[ "\$GITHUB_EVENT_NAME" = pull_request \] && gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$HEAD_SHA"/)
    assert.equal(workflow.split('--head-commit').length - 1, 1)
  })

  it('the gate job runs for a reuse and skips its steps, naming the parent run', () => {
    assert.match(workflow, /if: always\(\) && \(needs\.plan\.outputs\.bench != 'none' \|\| needs\.plan\.outputs\.reuse != ''\)/)
    assert.match(workflow, /name: Reuse the parent's results/)
  })
})
