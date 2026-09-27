import { describe, expect, it } from 'vitest'
import { computeLineDiff } from './diff.js'

describe('computeLineDiff', () => {
  it('handles empty inputs', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })

  it('handles addition from empty oldText', () => {
    const diff = computeLineDiff('', 'line 1\nline 2')
    expect(diff).toEqual([
      { type: 'add', text: 'line 1', newLineNumber: 1 },
      { type: 'add', text: 'line 2', newLineNumber: 2 },
    ])
  })

  it('handles deletion to empty newText', () => {
    const diff = computeLineDiff('line 1\nline 2', '')
    expect(diff).toEqual([
      { type: 'remove', text: 'line 1', oldLineNumber: 1 },
      { type: 'remove', text: 'line 2', oldLineNumber: 2 },
    ])
  })

  it('handles identical inputs', () => {
    const diff = computeLineDiff('hello\nworld', 'hello\nworld')
    expect(diff).toEqual([
      { type: 'same', text: 'hello', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'same', text: 'world', oldLineNumber: 2, newLineNumber: 2 },
    ])
  })

  it('detects insertions, modifications, and deletions', () => {
    const oldText = 'apple\nbanana\ncherry'
    const newText = 'apple\nblueberry\ncherry\ndate'

    const diff = computeLineDiff(oldText, newText)

    expect(diff).toEqual([
      { type: 'same', text: 'apple', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'remove', text: 'banana', oldLineNumber: 2 },
      { type: 'add', text: 'blueberry', newLineNumber: 2 },
      { type: 'same', text: 'cherry', oldLineNumber: 3, newLineNumber: 3 },
      { type: 'add', text: 'date', newLineNumber: 4 },
    ])
  })

  it('falls back gracefully on huge inputs exceeding the ceiling', () => {
    const oldLines = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n')
    const newLines = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\n')
    // 800 * 800 = 640,000 > 500,000
    const diff = computeLineDiff(oldLines, newLines)
    expect(diff.length).toBeGreaterThan(0)
  })
})
