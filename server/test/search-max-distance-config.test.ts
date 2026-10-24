import { describe, expect, it } from 'vitest'
import { defaultSearchMaxDistance, readSearchMaxDistance } from '../src/config.js'

describe('readSearchMaxDistance (#441)', () => {
  it("uses the embedder's measured default when unset or empty", () => {
    expect(readSearchMaxDistance(undefined, 'local')).toBe(0.4)
    expect(readSearchMaxDistance('', 'fake')).toBe(0.8)
    expect(defaultSearchMaxDistance('local')).toBe(0.4)
  })

  it('accepts a cosine distance between 0 and 2', () => {
    expect(readSearchMaxDistance('0.35', 'local')).toBe(0.35)
    expect(readSearchMaxDistance('1.5', 'fake')).toBe(1.5)
  })

  it('rejects what would silently cut every vector hit or none: NaN, whitespace, 0, negatives, 2 and above', () => {
    for (const raw of ['abc', ' ', '0', '-0.1', '2', '3', 'Infinity']) expect(readSearchMaxDistance(raw, 'local'), raw).toBeNull()
  })
})
