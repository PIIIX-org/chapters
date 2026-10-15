import { describe, expect, it } from 'vitest'
import { splitPath } from '../src/notes/okf/paths.js'

// Scratch PR for #575 (fails-before proof (b)); never merged. This test
// passes with or without the "fix", so the check must fail.
describe('splitPath (scratch #575)', () => {
  it('splits a plain path', () => {
    expect(splitPath('people/john')).toEqual({ type: 'people', name: 'john' })
  })
})
