import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ELARA_TOOLS, LOCAL_TOOL_SPECS, elaraToolset, globToRegExp, localToolset, toParameters, type McpToolInfo } from './tools.ts'

const root = mkdtempSync(join(tmpdir(), 'agent-trial-tools-'))
after(() => rmSync(root, { recursive: true, force: true }))
const files: Record<string, string | Buffer> = {
  'server/src/notes/store.ts': ['import x from "y"', 'export async function regenProgressiveIndices() {', '  return 1', '}', 'regenProgressiveIndices()'].join('\n'),
  'server/src/notes/okf.ts': 'export const SLUG = /^[a-z0-9][a-z0-9-]*$/\n',
  'server/test/notes.test.ts': 'it("regenerates", () => regenProgressiveIndices())\n',
  'client/src/App.tsx': 'export default function App() {}\n',
  'docs/a.md': 'REGENPROGRESSIVEINDICES in docs\n',
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00, 0x72, 0x65, 0x67, 0x65, 0x6e]),
  'README.md': `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
}
for (const [path, content] of Object.entries(files)) {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}
const local = localToolset(root)

test('globToRegExp: ** any depth, * within a segment, ? one character, {a,b} alternatives', () => {
  const cases: Array<[string, string, boolean]> = [
    ['server/**/*.ts', 'server/src/notes/store.ts', true],
    ['server/**/*.ts', 'server/x.ts', true],
    ['server/*.ts', 'server/src/x.ts', false],
    ['**/*.test.ts', 'server/test/notes.test.ts', true],
    ['**/*.test.ts', 'notes.test.ts', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/a.md', false],
    ['docs/**', 'docs/a.md', true],
    ['**/*.{ts,tsx}', 'client/src/App.tsx', true],
    ['**/*.{ts,tsx}', 'client/src/App.css', false],
    ['a?c.ts', 'abc.ts', true],
    ['a?c.ts', 'a/c.ts', false],
    ['file.ts', 'fileXts', false],
  ]
  for (const [glob, path, expected] of cases) assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`)
})

test('local list_files lists matching checkout paths, sorted, capped', async () => {
  const r = await local.run('list_files', { pattern: 'server/**/*.ts' })
  assert.equal(r.isError, false)
  assert.equal(r.text, '3 file(s)\nserver/src/notes/okf.ts\nserver/src/notes/store.ts\nserver/test/notes.test.ts')
  const capped = await local.run('list_files', { pattern: '**', limit: 2 })
  assert.match(capped.text, /^7 file\(s\), first 2\n/)
  assert.equal((await local.run('list_files', {})).isError, true)
})

test('local grep returns path:line:text, honours path, glob, ignore_case and max_results, skips binary files', async () => {
  const all = await local.run('grep', { pattern: 'regenProgressiveIndices\\(' })
  assert.equal(all.text, ['3 matching line(s)', 'server/src/notes/store.ts:2:export async function regenProgressiveIndices() {', 'server/src/notes/store.ts:5:regenProgressiveIndices()', 'server/test/notes.test.ts:1:it("regenerates", () => regenProgressiveIndices())'].join('\n'))
  assert.match((await local.run('grep', { pattern: 'regenProgressiveIndices', path: 'server/test' })).text, /^1 matching line\(s\)\nserver\/test\//)
  assert.match((await local.run('grep', { pattern: 'regenProgressiveIndices', glob: '**/*.test.ts' })).text, /^1 matching line/)
  // The PNG holds the bytes "regen" but is binary, so it is skipped.
  assert.match((await local.run('grep', { pattern: 'regenprogressiveindices', ignore_case: true })).text, /^4 matching line\(s\)\ndocs\/a\.md:1:/)
  assert.match((await local.run('grep', { pattern: 'regen', ignore_case: true, max_results: 1 })).text, /^4 matching line\(s\), first 1\n[^\n]+$/)
  assert.equal((await local.run('grep', { pattern: 'nothing-here' })).text, 'no matches')
  assert.equal((await local.run('grep', { pattern: '(' })).isError, true)
  assert.equal((await local.run('grep', { pattern: 'x', path: '../etc' })).isError, true)
})

test('local read_file numbers lines from offset, caps the slice, refuses escapes', async () => {
  const r = await local.run('read_file', { path: 'README.md', offset: 28, limit: 2 })
  assert.equal(r.text, 'README.md lines 28-29 of 31\n28\tline 28\n29\tline 29')
  assert.match((await local.run('read_file', { path: './server/src/notes/okf.ts' })).text, /^server\/src\/notes\/okf\.ts lines 1-2 of 2\n1\texport const SLUG/)
  assert.equal((await local.run('read_file', { path: 'README.md', offset: 99 })).isError, true)
  assert.deepEqual(await local.run('read_file', { path: 'missing.ts' }), { text: 'Error: no such file', isError: true })
  assert.equal((await local.run('read_file', { path: 'server/../../secret' })).isError, true)
  assert.match((await local.run('read_file', { path: 'server' })).text, /is a directory/)
})

test('local tools: specs name the three tools; an unknown tool is an error result, not a throw', async () => {
  assert.deepEqual(
    LOCAL_TOOL_SPECS.map((t) => t.name),
    ['list_files', 'grep', 'read_file'],
  )
  assert.equal(local.specs, LOCAL_TOOL_SPECS)
  const r = await local.run('bash', { cmd: 'ls' })
  assert.equal(r.isError, true)
  assert.match(r.text, /unknown tool bash/)
})

const listed: McpToolInfo[] = [
  ...ELARA_TOOLS.map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  })),
  { name: 'edit_note', description: 'writes', inputSchema: { type: 'object', properties: {} } },
]

test('elara tools: the allow-listed MCP tools with the server schemas, minus the draft marker', () => {
  const calls: unknown[] = []
  const set = elaraToolset(listed, async (tool, args) => {
    calls.push([tool, args])
    return { text: 'ok', ok: true }
  })
  assert.deepEqual(
    set.specs.map((s) => s.name),
    ELARA_TOOLS,
  )
  assert.deepEqual(set.specs[0], {
    name: 'search',
    description: 'search description',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  })
  assert.ok(!set.specs.some((s) => s.name === 'edit_note'))
  assert.deepEqual(calls, [])
})

test('elara tools: a call is one MCP tools/call with the same name and arguments; failures become error results', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const set = elaraToolset(listed, async (tool, args) => {
    calls.push([tool, args])
    return tool === 'read_file' ? { text: 'Error: file not found', ok: false } : { text: '{"hits":[]}', ok: true }
  })
  assert.deepEqual(await set.run('search', { query: 'rrf', limit: 5 }), { text: '{"hits":[]}', isError: false })
  assert.deepEqual(await set.run('read_file', { path: 'nope.ts' }), { text: 'Error: file not found', isError: true })
  const refused = await set.run('edit_note', { path: 'x' })
  assert.equal(refused.isError, true)
  assert.deepEqual(calls, [
    ['search', { query: 'rrf', limit: 5 }],
    ['read_file', { path: 'nope.ts' }],
  ])
})

test('elara tools: a server without one of the tools is a setup error', () => {
  assert.throws(() => elaraToolset(listed.filter((t) => t.name !== 'graph'), async () => ({ text: '', ok: true })), /does not list graph/)
})

test('toParameters always yields an object schema', () => {
  assert.deepEqual(toParameters(undefined), { type: 'object', properties: {} })
  assert.deepEqual(toParameters({ type: 'object' }), { type: 'object', properties: {} })
})
