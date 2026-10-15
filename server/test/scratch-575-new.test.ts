import { expect, it } from 'vitest'
import { scratch575 } from '../src/scratch-575-new.js'

// Scratch PR for #575 (fails-before proof (a)); never merged.
it('returns 575', () => {
  expect(scratch575()).toBe(575)
})
