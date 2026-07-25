import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import type { CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { wikilinkCompletions } from './wikilinkCompletions'

// wikilinkCompletions never returns a Promise (it's synchronous), so this
// narrows CompletionSource's return type for the assertions below.
function resultFor(doc: string, pos: number, targets: string[]): CompletionResult | null {
  const state = EditorState.create({ doc })
  return wikilinkCompletions(targets)(new CompletionContext(state, pos, false)) as CompletionResult | null
}

describe('wikilinkCompletions', () => {
  const targets = ['people/jane', 'projects/roadmap']

  it('suggests note paths inside an open [[', () => {
    const result = resultFor('[[pe', 4, targets)
    expect(result).not.toBeNull()
    expect(result!.from).toBe(2) // just after the [[
    expect(result!.options.map((o) => o.label)).toEqual(targets)
    expect(result!.options[0]!.apply).toBe('people/jane]]')
  })

  it('returns null when the cursor is not inside a wikilink', () => {
    expect(resultFor('hello world', 11, targets)).toBeNull()
  })

  it('returns null once the wikilink is closed', () => {
    // cursor after the closing ]] — matchBefore no longer sees an open [[
    expect(resultFor('[[people/jane]]', 15, targets)).toBeNull()
  })
})
