import { describe, expect, it } from 'vitest'
import { countWithNoun } from './GraphOutline'

// Scratch PR for #575 (fails-before proof (a)); never merged.
describe('countWithNoun (scratch #575)', () => {
  it('uses the singular for -1', () => {
    expect(countWithNoun(-1, 'edge')).toBe('-1 edge')
  })
})
