import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PACK_LIMITS, parsePush, pkt, validatePack } from '../src/git-remote/pack.js'

const exec = promisify(execFile)
let dir: string
let pack: Buffer
let head: string
let base: string
async function git(args: string[]) {
  const child = exec('git', args, { cwd: dir, encoding: 'buffer', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  child.child.stdin?.end()
  return (await child).stdout
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'elara-pack-'))
  await git(['init', '-q', '--initial-branch=main'])
  await git(['config', 'user.name', 'Pack test'])
  await git(['config', 'user.email', 'pack@localhost'])
  await writeFile(join(dir, 'note.md'), '---\ntype: note\n---\nbase\n')
  await git(['add', '.'])
  await git(['commit', '-qm', 'base'])
  base = (await git(['rev-parse', 'HEAD'])).toString().trim()
  await writeFile(join(dir, 'note.md'), '---\ntype: note\n---\nchanged\n')
  await git(['commit', '-qam', 'edit'])
  head = (await git(['rev-parse', 'HEAD'])).toString().trim()
  pack = await git(['pack-objects', '--stdout', '--all'])
})
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('untrusted real Git packs', () => {
  it('accepts a real CLI pack and exactly one main update', () => {
    expect(() => validatePack(pack)).not.toThrow()
    const command = Buffer.concat([pkt(`${base} ${head} refs/heads/main\0 report-status object-format=sha1 agent=git/2.(Apple.Git) \n`), Buffer.from('0000'), pack])
    const parsed = parsePush(command)
    expect(parsed.old).toBe(base)
    expect(parsed.next).toBe(head)
    expect(parsed.pack).toEqual(pack)
  })
  it('refuses corrupted, truncated, oversized and multi-ref requests', () => {
    const corrupt = Buffer.from(pack)
    corrupt[13] = corrupt[13]! ^ 1
    expect(() => validatePack(corrupt)).toThrow('checksum')
    expect(() => validatePack(pack.subarray(0, 20))).toThrow()
    expect(() => parsePush(Buffer.alloc(PACK_LIMITS.request + 1))).toThrow('limit')
    const first = pkt(`${base} ${head} refs/heads/main\0report-status\n`)
    expect(() => parsePush(Buffer.concat([first, pkt(`${base} ${head} refs/heads/extra\n`), Buffer.from('0000'), pack]))).toThrow('exactly one')
    expect(() => parsePush(Buffer.concat([pkt(`${base} ${'0'.repeat(40)} refs/heads/main\0report-status\n`), Buffer.from('0000'), pack]))).toThrow('deleting')
  })
  it('bounds inflated objects before invoking Git, including a highly compressed bomb with a valid pack checksum', () => {
    // A valid pack envelope with a real zlib stream; its lying size header cannot bypass the inflated byte cap.
    const header = Buffer.alloc(12)
    header.write('PACK')
    header.writeUInt32BE(2, 4)
    header.writeUInt32BE(1, 8)
    const content = Buffer.concat([header, Buffer.from([0x30]), deflateSync(Buffer.alloc(PACK_LIMITS.object + 1))])
    const bomb = Buffer.concat([content, createHash('sha1').update(content).digest()])
    expect(bomb.length).toBeLessThan(100_000)
    expect(() => validatePack(bomb)).toThrow('oversized')
  })
})
