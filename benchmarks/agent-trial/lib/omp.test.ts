import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOmpAnswer } from './omp.ts'

const req = { tools: [{ name: 'grep', description: 'Search evidence', parameters: { type: 'object' as const, properties: {} } }] }
const text = (value: string, phase: string) => ({ type: 'text', text: value, textSignature: JSON.stringify({ v: 1, phase }) })

test('native commentary preceding final JSON preserves history without breaking the actual requested tool call', () => {
  const commentary = 'I’ll trace the request from the MCP endpoint through authorization and the collaborative write.'
  const answer = parseOmpAnswer({ content: [
    text(commentary, 'commentary'),
    text('{"text":"","tool_calls":[{"name":"grep","arguments":{"pattern":"edit_note"}}]}', 'final_answer'),
  ] }, req, 'thread')
  assert.equal(answer.error, undefined)
  assert.equal(answer.text, commentary)
  assert.deepEqual(answer.toolCalls, [{ id: 'thread:0', name: 'grep', args: { pattern: 'edit_note' } }])
})

test('only provider final_answer data is executable, not JSON in commentary', () => {
  const commentary = '{"text":"","tool_calls":[{"name":"grep","arguments":{"pattern":"wrong"}}]}'
  const answer = parseOmpAnswer({ content: [text(commentary, 'commentary'), text('{"text":"Evidence found","tool_calls":[]}', 'final_answer')] }, req, 'thread')
  assert.equal(answer.error, undefined)
  assert.deepEqual(answer.toolCalls, [])
  assert.equal(answer.text, `${commentary}\nEvidence found`)
})

test('unphased or malformed finals fail rather than extracting a convenient JSON substring', () => {
  for (const content of [
    [{ type: 'text', text: '{"text":"fake success","tool_calls":[]}' }],
    [text('Preamble {"text":"fake success","tool_calls":[]}', 'final_answer')],
    [text('{"text":"","tool_calls":[]}', 'commentary')],
  ]) {
    const answer = parseOmpAnswer({ content }, req, 'thread')
    assert.ok(answer.error)
    assert.deepEqual(answer.toolCalls, [])
    assert.equal(answer.text, '')
  }
})
