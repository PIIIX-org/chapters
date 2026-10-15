import { describe, expect, it } from 'vitest'
import { splitPath } from '../src/notes/okf/paths.js'

// Scratch PR for #575 (fails-before proof (a)); never merged.
describe('splitPath (scratch #575)', () => {
  it('lower-cases a mixed-case path', () => {
    expect(splitPath('People/John')).toEqual({ type: 'people', name: 'john' })
  })

  it('still splits a plain path', () => {
    expect(splitPath('people/john')).toEqual({ type: 'people', name: 'john' })
  })
})
