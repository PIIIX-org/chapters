// node --test 'lab/lib/*.test.ts' (run by CI `checks`). answerJson reads a
// tool answer as the lab's tests do: read_note's body comes as a plain text
// block after the JSON (#445) and is put back in its key.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerJson } from './tool-answer.ts'

const BODY = 'line "one"\r\nC:\\path\n\tمرحبا 👋\n'

test('read_note: the body block goes back in `body`, exact', () => {
  const json = { path: 'docs/a', rev: 3, body: { in: 'content[1]' }, truncated: false }
  assert.deepEqual(answerJson([{ text: JSON.stringify(json) }, { text: BODY }]), { ...json, body: BODY })
})

test('an empty body block is an empty body; a missing one too', () => {
  const head = JSON.stringify({ body: { in: 'content[1]' }, truncated: false })
  assert.deepEqual(answerJson([{ text: head }, { text: '' }]), { body: '', truncated: false })
  assert.deepEqual(answerJson([{ text: head }]), { body: '', truncated: false })
})

test('answers without blocks, errors, arrays and non-JSON text are as parsed', () => {
  const answer = { path: 'src/a.ts', content: 'x\n', body: { in: 'elsewhere' } }
  assert.deepEqual(answerJson([{ text: JSON.stringify(answer) }]), answer)
  assert.deepEqual(answerJson([{ text: '{"error":{"code":"NOT_FOUND"}}' }]), { error: { code: 'NOT_FOUND' } })
  assert.deepEqual(answerJson([{ text: '[1,2]' }]), [1, 2])
  assert.equal(answerJson([{ text: 'not json' }]), undefined)
  assert.equal(answerJson([]), undefined)
})
