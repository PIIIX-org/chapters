// Unit tests for lab-plan.mjs (the `plan` job of elara-lab.yml).
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { outputs, plan } from './lab-plan.mjs'

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

  it('search, MCP or benchmark changes run every suite and require the golds', () => {
    for (const file of ['server/src/search/fusion.ts', 'server/src/mcp/tools/read.ts', 'benchmarks/questions/rea.json', 'benchmarks/lib/policies.ts', 'benchmarks/run.ts',
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
    assert.equal(outputs(plan(['server/src/mcp/server.ts'])), 'tier=fast\nalso=\nbench=all\ngolds=true')
    const dir = mkdtempSync(join(tmpdir(), 'lab-plan-'))
    const list = join(dir, 'changed.txt')
    writeFileSync(list, 'docs/x.md\r\nserver/src/db/schema.ts\n\n')
    const res = spawnSync(process.execPath, [SCRIPT, '--files', list], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout.trim(), 'tier=fast\nalso=\nbench=chapters\ngolds=false')
    assert.notEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 0)
  })
})
