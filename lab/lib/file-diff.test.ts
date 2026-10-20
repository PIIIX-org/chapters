// node --test 'lab/lib/*.test.ts' (run by CI `checks`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileDiff } from './file-diff.ts'

test('same paths: both counts', () => {
  assert.equal(fileDiff(['a', 'b'], ['b', 'a'], 'clean').text, 'files 2 vs clean 2, same paths')
})

test('different paths: both counts and the paths on each side (#663, #767 run 39257370750)', () => {
  const d = fileDiff(['a', 'b', 'gone'], ['a', 'b', 'new2', 'new1'], 'clean')
  assert.equal(d.text, 'files 4 vs clean 3; only here (2): new1, new2; only in clean (1): gone')
  assert.deepEqual([d.files, d.referenceFiles], [4, 3])
})

test('same count, different paths is still visible', () => {
  assert.equal(fileDiff(['a', 'x'], ['a', 'y'], 'clean').text, 'files 2 vs clean 2; only here (1): y; only in clean (1): x')
})

test('long lists are cut', () => {
  const many = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}`)
  const d = fileDiff([], many, 'clean', 3)
  assert.equal(d.text, 'files 25 vs clean 0; only here (25): f00, f01, f02, ... 22 more; only in clean (0)')
  assert.equal(d.onlyHere.length, 25)
})
