import { describe, expect, it } from 'vitest'
import { resolveRefListing, MirrorRefError as RefError } from '../src/repositories/git-mirror.js'

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
