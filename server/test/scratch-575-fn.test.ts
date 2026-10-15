import { describe, expect, it } from 'vitest'
import { noteDepth } from '../src/notes/okf/paths.js'

// Scratch PR for #575 (fails-before proof (d)); never merged. Only tests a
// function the PR adds to an existing module: on base it fails with
// "(0 , __vite_ssr_import_N__.noteDepth) is not a function", which must not count.
describe('noteDepth (scratch #575)', () => {
  it('counts path segments', () => {
    expect(noteDepth('people/john')).toBe(2)
  })
})
