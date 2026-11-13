#!/usr/bin/env node
// Run with tree-sitter-cli 0.25.10 and native Emscripten 3.1.74 on PATH.
// No Docker, source-package install scripts, or third-party grammar binaries.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = new URL('../server/grammars/', import.meta.url)
const provenance = JSON.parse(
  readFileSync(new URL('swift.json', directory), 'utf8'),
)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
for (const [tool, version] of [
  ['tree-sitter', provenance.treeSitterCli],
  ['emcc', provenance.emscripten],
]) {
  const actual = execFileSync(tool, ['--version'], { encoding: 'utf8' }).split(
    '\n',
  )[0]
  if (!actual.includes(` ${version} `) && !actual.endsWith(` ${version}`))
    throw new Error(`Expected ${tool} ${version}, got ${actual}`)
}
const scratch = mkdtempSync(join(tmpdir(), 'elara-swift-build-'))
try {
  const response = await fetch(provenance.source)
  if (!response.ok) throw new Error(`Source download: ${response.status}`)
  const source = Buffer.from(await response.arrayBuffer())
  if (sha256(source) !== provenance.sourceSha256)
    throw new Error('Source SHA-256 mismatch')
  const archive = join(scratch, 'swift.tgz')
  writeFileSync(archive, source)
  execFileSync('tar', [
    '-xzf',
    archive,
    '-C',
    scratch,
    'package/src',
    'package/tree-sitter.json',
    'package/package.json',
    'package/LICENSE',
  ])
  const output = join(scratch, 'tree-sitter-swift.wasm')
  execFileSync(
    'tree-sitter',
    ['build', '--wasm', '--output', output, join(scratch, 'package')],
    { stdio: 'inherit' },
  )
  const bytes = readFileSync(output)
  if (bytes.length !== provenance.bytes || sha256(bytes) !== provenance.sha256)
    throw new Error('Built grammar differs from recorded artifact')
  if (
    readFileSync(join(scratch, 'package/LICENSE'), 'utf8') !==
    readFileSync(new URL('swift.LICENSE', directory), 'utf8')
  )
    throw new Error('Upstream license differs')
  copyFileSync(output, new URL('tree-sitter-swift.wasm', directory))
  console.log(
    `Swift ABI ${provenance.abi}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)}`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
