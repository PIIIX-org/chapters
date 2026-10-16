// Lifecycle marker logic (#583): how the previous process ended, read from
// DATA_DIR/lifecycle.json. The end-to-end version (a real server, SIGTERM
// and SIGKILL) is lifecycle-boot.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LIFECYCLE_FILE,
  bootInfo,
  bootLogLine,
  readPreviousShutdown,
  recordBoot,
  recordGracefulShutdown,
  uuidv7,
  writeLifecycleMarker,
} from '../src/lifecycle.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elara-lifecycle-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const marker = (dir: string) => JSON.parse(readFileSync(join(dir, LIFECYCLE_FILE), 'utf8'))

describe('readPreviousShutdown', () => {
  it('is unknown when there is no marker (first boot on this data directory)', () => {
    expect(readPreviousShutdown(tempDir())).toEqual({ lastShutdown: 'unknown', previous: null })
  })

  it('is unknown when the data directory does not exist yet', () => {
    expect(readPreviousShutdown(join(tempDir(), 'missing')).lastShutdown).toBe('unknown')
  })

  it('is graceful when the previous process wrote `stopped`', () => {
    const dir = tempDir()
    writeLifecycleMarker(dir, { state: 'stopped', bootId: 'b1', startedAt: 't1', version: 'v1', stoppedAt: 't2', signal: 'SIGTERM' })
    const r = readPreviousShutdown(dir)
    expect(r.lastShutdown).toBe('graceful')
    expect(r.previous).toMatchObject({ bootId: 'b1', signal: 'SIGTERM', stoppedAt: 't2' })
  })

  it('is unclean when the previous process never got past `running`', () => {
    const dir = tempDir()
    writeLifecycleMarker(dir, { state: 'running', bootId: 'b1', startedAt: 't1', version: null })
    expect(readPreviousShutdown(dir).lastShutdown).toBe('unclean')
  })

  it('is unknown for a damaged or foreign marker, never a guess', () => {
    const dir = tempDir()
    for (const content of ['{"state":"runn', 'null', '[]', '{"state":"paused"}', '']) {
      writeFileSync(join(dir, LIFECYCLE_FILE), content)
      expect(readPreviousShutdown(dir)).toEqual({ lastShutdown: 'unknown', previous: null })
    }
  })
})

describe('recordBoot / recordGracefulShutdown', () => {
  it('boot -> running; clean shutdown -> stopped; next boot reads graceful', () => {
    const dir = tempDir()
    const first = recordBoot(dir)
    expect(first.boot.lastShutdown).toBe('unknown')
    expect(first.previous).toBeNull()
    expect(marker(dir)).toEqual({ state: 'running', bootId: bootInfo().bootId, startedAt: bootInfo().startedAt, version: null })

    recordGracefulShutdown('SIGTERM', dir)
    const stopped = marker(dir)
    expect(stopped).toMatchObject({ state: 'stopped', bootId: bootInfo().bootId, signal: 'SIGTERM' })
    expect(new Date(stopped.stoppedAt).toISOString()).toBe(stopped.stoppedAt)

    const second = recordBoot(dir)
    expect(second.boot.lastShutdown).toBe('graceful')
    expect(bootInfo().lastShutdown).toBe('graceful')
    expect(second.previous).toMatchObject({ state: 'stopped', signal: 'SIGTERM' })
    expect(marker(dir).state).toBe('running')
  })

  it('a boot with no clean shutdown after it reads unclean on the next boot (SIGKILL, OOM, crash)', () => {
    const dir = tempDir()
    recordBoot(dir)
    // The process dies here: nothing else is written.
    expect(recordBoot(dir).boot.lastShutdown).toBe('unclean')
  })

  it('creates the data directory on a first boot', () => {
    const dir = join(tempDir(), 'fresh', 'data')
    recordBoot(dir)
    expect(marker(dir).state).toBe('running')
  })

  it('leaves no temp file behind (write-then-rename)', () => {
    const dir = tempDir()
    recordBoot(dir)
    recordGracefulShutdown('SIGINT', dir)
    expect(existsSync(join(dir, `${LIFECYCLE_FILE}.tmp`))).toBe(false)
  })

  it('does not throw when the marker cannot be written; the boot is then unknown', () => {
    const dir = tempDir()
    // A file where the data directory should be: mkdir and write both fail.
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    expect(() => recordBoot(blocked)).not.toThrow()
    expect(bootInfo().lastShutdown).toBe('unknown')
    expect(() => recordGracefulShutdown('SIGTERM', blocked)).not.toThrow()
  })
})

describe('bootLogLine', () => {
  it('is one JSON line with the previous shutdown', () => {
    const dir = tempDir()
    recordBoot(dir)
    recordGracefulShutdown('SIGTERM', dir)
    const { boot, previous } = recordBoot(dir)
    const line = bootLogLine(boot, previous)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({
      event: 'boot',
      bootId: boot.bootId,
      lastShutdown: 'graceful',
      previous: { bootId: boot.bootId, signal: 'SIGTERM' },
    })
  })
})

describe('uuidv7', () => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('has the version and variant bits and the timestamp in front', () => {
    const id = uuidv7(0x0123456789ab, new Uint8Array(10).fill(0xff))
    expect(id).toMatch(V7)
    expect(id.startsWith('01234567-89ab-7fff-bfff-')).toBe(true)
  })

  it('a later boot sorts after an earlier one, whatever the random bits', () => {
    const early = uuidv7(1_760_000_000_000, new Uint8Array(10).fill(0xff))
    const late = uuidv7(1_760_000_000_001, new Uint8Array(10).fill(0x00))
    expect(late > early).toBe(true)
  })

  it('differs between two ids of the same millisecond', () => {
    expect(uuidv7(1_760_000_000_000)).not.toBe(uuidv7(1_760_000_000_000))
  })
})
