import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertLabBaseUrl } from './guard.ts'

test('the lab instance on this machine is accepted', () => {
  assert.equal(assertLabBaseUrl('http://localhost:3000').port, '3000')
  assert.equal(assertLabBaseUrl('http://127.0.0.1:3000/').hostname, '127.0.0.1')
  assert.equal(assertLabBaseUrl('http://[::1]:3000').hostname, '[::1]')
})

test('production and every other host are refused (#572)', () => {
  for (const url of [
    'https://chapters.piiix.org',
    'http://chapters.piiix.org',
    'https://chapters.piiix.org/mcp',
    'http://localhost.piiix.org:3000',
    'http://10.0.0.5:3000',
    'https://localhost:3000',
    'http://user:pass@localhost:3000',
    'localhost:3000',
    '',
  ]) {
    assert.throws(() => assertLabBaseUrl(url), /refusing to benchmark/, url)
  }
})
