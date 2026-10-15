import { describe, expect, it } from 'vitest'
import { MAX_NOTE_DEPTH, resolveNotePath } from '../src/notes/okf/paths.js'

// Scratch PR for #575 (fails-before proof (d)); never merged. Only tests a
// constant the PR adds to an existing module: on base it fails with
// "expected undefined to be 8" (no binding name in the message), which the
// export probe must catch.
describe('MAX_NOTE_DEPTH (scratch #575)', () => {
  it('is the depth resolveNotePath allows', () => {
    expect(MAX_NOTE_DEPTH).toBe(8)
    expect(resolveNotePath('a/b').segments.length).toBeLessThan(MAX_NOTE_DEPTH)
  })
})
