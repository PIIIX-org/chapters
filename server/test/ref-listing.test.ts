import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRefListing, resolveMirrorRef, MirrorRefError as RefError } from '../src/repositories/git-mirror.js'
import { checkGitRef } from '../src/repositories/ref-index.js'

// #676: `ref: "release"` names one commit or reports every competing ref, whatever kind each one is.

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const row = (sha: string, name: string) => `${sha}\t${name}`

describe('resolveRefListing', () => {
  it('reports a branch and an annotated tag of the same name that end on different commits, naming both', () => {
    const listing = [row(A, 'refs/heads/release'), row(TAG_OBJECT, 'refs/tags/release'), row(B, 'refs/tags/release^{}')].join('\n')
    expect(() => resolveRefListing(listing, 'release')).toThrow(RefError)
    expect(() => resolveRefListing(listing, 'release')).toThrow(/refs\/heads\/release and refs\/tags\/release/)
  })

  it('reports a lightweight tag and a branch of the same name that differ', () => {
    expect(() => resolveRefListing([row(A, 'refs/heads/release'), row(B, 'refs/tags/release')].join('\n'), 'release')).toThrow(/ambiguous/)
  })

  it('serves a branch alone, a lightweight tag alone, and an annotated tag alone peeled to its commit', () => {
    expect(resolveRefListing(row(A, 'refs/heads/release'), 'release')).toBe(A)
    expect(resolveRefListing(row(B, 'refs/tags/release'), 'release')).toBe(B)
    expect(resolveRefListing([row(TAG_OBJECT, 'refs/tags/release'), row(B, 'refs/tags/release^{}')].join('\n'), 'release')).toBe(B)
  })

  it('accepts a branch and an annotated tag that peel to the same commit', () => {
    expect(resolveRefListing([row(A, 'refs/heads/release'), row(TAG_OBJECT, 'refs/tags/release'), row(A, 'refs/tags/release^{}')].join('\n'), 'release')).toBe(A)
  })

  it('lets a full ref name pick one of two competing refs and ignores refs that only end in the name', () => {
    const listing = [row(A, 'refs/heads/release'), row(B, 'refs/tags/release'), row(TAG_OBJECT, 'refs/heads/feature/release')].join('\n')
    expect(resolveRefListing(listing, 'refs/heads/release')).toBe(A)
    expect(resolveRefListing(listing, 'refs/tags/release')).toBe(B)
  })

  it('names nothing when the mirror holds no such ref', () => {
    expect(resolveRefListing('', 'release')).toBeNull()
  })
})

describe('resolveMirrorRef against a real mirror', () => {
  let root: string
  let dir: string
  let first: string
  let second: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } }).trim()
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'elara-mirror-ref-'))
    dir = join(root, 'm.git')
    execFileSync('git', ['init', '--bare', '--quiet', dir])
    const tree = execFileSync('git', ['mktree'], { cwd: dir, input: '', encoding: 'utf8' }).trim()
    first = git('commit-tree', '-m', 'one', tree)
    second = git('commit-tree', '-m', 'two', '-p', first, tree)
    git('update-ref', 'refs/elara/head', first)
    git('update-ref', 'refs/tags/trunk', second)
    git('config', 'elara.source', 'src-1')
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('refuses a tag named like the default branch instead of letting it win over the fetched tip', async () => {
    await expect(resolveMirrorRef(dir, 'src-1', 'trunk', null, 'trunk')).rejects.toMatchObject({ kind: 'ambiguous', message: expect.stringMatching(/refs\/heads\/trunk and refs\/tags\/trunk/) })
    expect(await resolveMirrorRef(dir, 'src-1', 'refs/heads/trunk', null, 'trunk')).toBe(first)
    expect(await resolveMirrorRef(dir, 'src-1', 'refs/tags/trunk', null, 'trunk')).toBe(second)
    expect(await resolveMirrorRef(dir, 'src-1', 'HEAD', null, 'trunk')).toBe(first)
  })

  it('serves a full SHA in lowercase only, and only a held tip', async () => {
    expect(await resolveMirrorRef(dir, 'src-1', first, null, null)).toBe(first)
    await expect(resolveMirrorRef(dir, 'src-1', first.toUpperCase(), null, null)).rejects.toMatchObject({ kind: 'unsynced' })
    expect(() => checkGitRef(first.toUpperCase())).toThrow(/lowercase/)
    expect(() => checkGitRef(first)).not.toThrow()
    expect(() => checkGitRef('Release-1')).not.toThrow()
  })

  it('refuses a mirror recorded for another source', async () => {
    await expect(resolveMirrorRef(dir, 'src-2', 'refs/tags/trunk', null, null)).rejects.toMatchObject({ kind: 'unsynced' })
  })
})
