// Tests for the attribution hooks in .githooks (commit-msg, prepare-commit-msg,
// coauthor) and their installer (.githooks/install.sh): real git in scratch
// repositories, isolated from the user's git config.
// Run: node --test '.github/scripts/*.test.mjs' (the `checks` job in ci.yml does).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOKS = fileURLToPath(new URL('../../.githooks', import.meta.url))
const TRAILER = 'Co-Authored-By: Claude Opus <noreply@anthropic.com>'

let root
before(() => {
  root = mkdtempSync(join(tmpdir(), 'githooks-'))
  // An editor git can run without a terminal: `keep` leaves the buffer,
  // `prepend <text>` types text on the first line.
  writeFileSync(
    join(root, 'editor.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      'const [mode, ...rest] = process.argv.slice(2)',
      'const file = rest.pop()',
      "if (mode === 'prepend') writeFileSync(file, rest.join(' ') + readFileSync(file, 'utf8'))",
    ].join('\n'),
  )
})
after(() => rmSync(root, { recursive: true, force: true }))

const env = (dir) => ({
  ...process.env,
  HOME: root,
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig-none'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@x',
  GIT_EDITOR: `"${process.execPath}" "${join(root, 'editor.mjs')}" ${dir.editor ?? 'keep'}`,
})

/** A scratch repository with the hooks installed and one commit. */
function repo() {
  const dir = { path: mkdtempSync(join(root, 'r-')) }
  const run = (args, opts = {}) =>
    spawnSync('git', args, { cwd: dir.path, env: env(dir), encoding: 'utf8', ...opts })
  dir.git = (...args) => {
    const r = run(args)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}${r.stdout}`)
    return r.stdout.trimEnd()
  }
  dir.try = (...args) => run(args)
  dir.file = (name, text) => writeFileSync(join(dir.path, name), text)
  dir.body = () => dir.git('log', '-1', '--format=%B').trimEnd()
  dir.trailer = () => dir.git('log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)').trim()
  dir.count = () => Number(dir.git('rev-list', '--count', 'HEAD'))
  dir.git('init', '-q', '-b', 'main')
  dir.git('config', 'core.hooksPath', HOOKS)
  dir.file('a', 'a\n')
  dir.git('add', 'a')
  dir.git('commit', '-q', '-m', 'init', '--no-verify')
  return dir
}

/** A branch off HEAD~0 with one commit that changes `name`, HEAD back on main. */
function branch(r, name, text = `${name}\n`) {
  r.git('checkout', '-q', '-b', name)
  r.file(name === 'a' ? 'a' : name, text)
  r.git('add', '-A')
  r.git('commit', '-q', '-m', `on ${name}`, '--no-verify')
  r.git('checkout', '-q', 'main')
}

describe('commit-msg hook', () => {
  it('-m: appends the trailer as its own paragraph', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'feat: one')
    assert.equal(r.body(), `feat: one\n\n${TRAILER}`)
    assert.equal(r.trailer(), 'Claude Opus <noreply@anthropic.com>')
  })

  it('multiple -m: after the last paragraph', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'subject', '-m', 'body one\n\nbody two')
    assert.equal(r.body(), `subject\n\nbody one\n\nbody two\n\n${TRAILER}`)
  })

  it('-F: appends to a message read from a file', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.file('msg.txt', 'from file\n\nbody\n')
    r.git('commit', '-q', '-a', '-F', 'msg.txt')
    assert.equal(r.body(), `from file\n\nbody\n\n${TRAILER}`)
  })

  it('amend: --no-edit adds nothing twice, -m gets a trailer', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'one')
    r.git('commit', '-q', '--amend', '--no-edit')
    assert.equal(r.body(), `one\n\n${TRAILER}`)
    r.git('commit', '-q', '--amend', '-m', 'two')
    assert.equal(r.body(), `two\n\n${TRAILER}`)
  })

  it('merge --no-edit: the merge commit gets the trailer', () => {
    const r = repo()
    branch(r, 'side')
    r.file('m', 'm\n')
    r.git('add', 'm')
    r.git('commit', '-q', '-m', 'main', '--no-verify')
    r.git('merge', '--no-edit', 'side')
    assert.equal(r.body(), `Merge branch 'side'\n\n${TRAILER}`)
  })

  it('conflicted merge: the trailer goes above the Conflicts comments, which git drops', () => {
    const r = repo()
    branch(r, 'a', 'side\n')
    r.file('a', 'main\n')
    r.git('commit', '-q', '-am', 'main', '--no-verify')
    assert.notEqual(r.try('merge', 'a').status, 0)
    r.file('a', 'resolved\n')
    r.git('add', 'a')
    r.git('commit', '-q')
    assert.equal(r.body(), `Merge branch 'a'\n\n${TRAILER}`)
  })

  it('merge --squash: the squash message ends with the trailer', () => {
    const r = repo()
    branch(r, 'sq')
    r.git('merge', '--squash', 'sq')
    r.git('commit', '-q')
    const body = r.body()
    assert.match(body, /^Squashed commit of the following:/)
    assert.ok(body.endsWith(`\n\n${TRAILER}`), body)
    assert.equal(r.trailer(), 'Claude Opus <noreply@anthropic.com>')
  })

  it('revert --no-edit and cherry-pick (sequencer, prepare-commit-msg only) get the trailer', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'change', '--no-verify')
    r.git('revert', '--no-edit', 'HEAD')
    assert.match(r.body(), /^Revert "change"\n\nThis reverts commit [0-9a-f]{40}\.\n\n/)
    assert.equal(r.trailer(), 'Claude Opus <noreply@anthropic.com>')
    branch(r, 'cp')
    r.git('cherry-pick', 'cp')
    assert.equal(r.body(), `on cp\n\n${TRAILER}`)
  })

  it('existing Co-Authored-By in any case: left alone; another trailer: joined', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'fix: two', '-m', 'co-authored-by: Other Model <o@x>')
    assert.equal(r.body(), 'fix: two\n\nco-authored-by: Other Model <o@x>')
    r.file('a', 'c\n')
    r.git('commit', '-q', '-am', 'three', '-m', 'Signed-off-by: T <t@x>')
    assert.equal(r.body(), `three\n\nSigned-off-by: T <t@x>\n${TRAILER}`)
  })

  it('-v editor: the subject typed on line 1 stays its own paragraph; the diff is not in the message', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.editor = 'prepend verbose subject'
    r.git('commit', '-q', '-av')
    assert.equal(r.body(), `verbose subject\n\n${TRAILER}`)
    assert.equal(r.trailer(), 'Claude Opus <noreply@anthropic.com>')
  })

  it('editor without -v: same result', () => {
    const r = repo()
    r.file('a', 'b\n')
    r.editor = 'prepend plain subject'
    r.git('commit', '-q', '-a')
    assert.equal(r.body(), `plain subject\n\n${TRAILER}`)
  })

  it('aborted editor: an untouched buffer still aborts the commit, with and without -v', () => {
    const r = repo()
    r.file('a', 'b\n')
    for (const flags of [['-a'], ['-av']]) {
      const res = r.try('commit', ...flags)
      assert.notEqual(res.status, 0)
      assert.match(res.stderr + res.stdout, /Aborting commit due to empty commit message/)
      assert.equal(r.count(), 1)
    }
  })

  it('chapters.coauthor: none turns it off, a value replaces the default', () => {
    const r = repo()
    r.git('config', 'chapters.coauthor', 'none')
    r.file('a', 'b\n')
    r.git('commit', '-q', '-am', 'off')
    assert.equal(r.body(), 'off')
    r.git('config', 'chapters.coauthor', 'GPT <g@x>')
    r.file('a', 'c\n')
    r.git('commit', '-q', '-am', 'other')
    assert.equal(r.body(), 'other\n\nCo-Authored-By: GPT <g@x>')
  })
})
describe('install.sh', () => {
  const sh = (dir, extra = {}) =>
    spawnSync('sh', [join(HOOKS, 'install.sh')], { cwd: dir, env: { ...env({}), ...extra }, encoding: 'utf8' })

  it('sets core.hooksPath in a clone that has none', () => {
    const r = repo()
    r.git('config', '--unset', 'core.hooksPath')
    const res = sh(r.path)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(r.git('config', '--get', 'core.hooksPath'), '.githooks')
    assert.equal(sh(r.path).status, 0) // idempotent
  })

  it('leaves another hooks path alone and warns', () => {
    const r = repo()
    r.git('config', 'core.hooksPath', '.husky')
    const res = sh(r.path)
    assert.equal(res.status, 0)
    assert.match(res.stderr, /core\.hooksPath is '\.husky', not \.githooks/)
    assert.equal(r.git('config', '--get', 'core.hooksPath'), '.husky')
  })

  it('is a no-op outside a git checkout', () => {
    const dir = mkdtempSync(join(root, 'nogit-'))
    const res = sh(dir, { GIT_CEILING_DIRECTORIES: root })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stderr, '')
    assert.notEqual(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, env: env({}) }).status, 0)
  })
})
