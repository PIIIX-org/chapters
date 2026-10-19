// #492: the detector behind the write quarantine (server/src/notes/growth-guard.ts).
// note-growth-quarantine.test.ts covers the write paths; this file the rules,
// their floors and the cost on ~1 MiB bodies.
import { describe, expect, it } from 'vitest'
import { suspiciousWrite } from '../src/notes/growth-guard.js'

/** `n` distinct lines of varied text, about 90 bytes each. */
function lines(tag: string, n: number, sep = '\n'): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`${tag} line ${i}: measurement ${i * 37 + 11} differs from run ${i * 3} by ${(i * 7919) % 1000} units in the nightly batch.`)
  return out.join(sep)
}

describe('suspiciousWrite', () => {
  it('flags a doubled note by growth, and by repeated block when growth is not checked', () => {
    const body = lines('a', 40) // ~4 KiB
    expect(suspiciousWrite(body, `${body}\n${body}`, 'all')).toMatchObject({ rule: 'growth' })
    const relay = suspiciousWrite(body, `${body}\n${body}`, 'repeated-block')
    expect(relay?.rule).toBe('repeated-block')
    expect(relay!.repeatedBytes).toBeGreaterThan(Buffer.byteLength(body) * 0.9)
  })

  it('flags a doubled note under the growth floor, and a single-line note, as a repeated block', () => {
    const small = lines('b', 20) // ~1.8 KiB: under the 2 KiB growth floor
    expect(suspiciousWrite(small, `${small}${small}`, 'all')).toMatchObject({ rule: 'repeated-block' })
    const oneLine = lines('c', 30, ' ') // no newline at all
    expect(suspiciousWrite(oneLine, `${oneLine} typed ${oneLine}`, 'repeated-block')).toMatchObject({ rule: 'repeated-block' })
  })

  it('flags the stale-client merge shape: the copy carries the user’s new text in the middle', () => {
    const body = lines('d', 25)
    const merged = `${body.slice(0, 900)} @TYPED@ ${body.slice(900)}\n${body}`
    expect(suspiciousWrite(body, merged, 'repeated-block')).toMatchObject({ rule: 'repeated-block' })
  })

  it('does not flag small notes, stubs filled in, ordinary growth or a section copied in a large note', () => {
    expect(suspiciousWrite('0123456789', '0123456789'.repeat(4), 'all')).toBeNull()
    expect(suspiciousWrite('TODO', lines('e', 100), 'all')).toBeNull()
    const note = lines('f', 40) // ~4 KiB
    expect(suspiciousWrite(note, `${note}\n${lines('g', 30)}`, 'all')).toBeNull() // 1.75x
    const big = lines('h', 1000) // ~100 KiB
    expect(suspiciousWrite(big, `${big}\n${big.slice(0, 5000)}`, 'all')).toBeNull() // 5 KiB copied
    expect(suspiciousWrite(big, big.replace('line 500', 'line five hundred'), 'all')).toBeNull()
  })

  it('pure growth is not a repeated block', () => {
    const note = lines('i', 30)
    expect(suspiciousWrite(note, `${note}\n${lines('j', 60)}`, 'repeated-block')).toBeNull()
    expect(suspiciousWrite(note, `${note}\n${lines('j', 60)}`, 'all')).toMatchObject({ rule: 'growth' })
  })

  it('checks ~1 MiB bodies in linear time', () => {
    const mib = lines('k', 12_000) // ~1 MiB
    expect(Buffer.byteLength(mib)).toBeGreaterThan(1000 * 1024)
    const oneLine = lines('l', 12_000, ' ')
    const t = performance.now()
    expect(suspiciousWrite(mib, `${mib}\n${mib}`, 'repeated-block')).toMatchObject({ rule: 'repeated-block' })
    expect(suspiciousWrite(oneLine, `${oneLine}${oneLine}`, 'repeated-block')).toMatchObject({ rule: 'repeated-block' })
    expect(suspiciousWrite(mib, mib.replace('line 5000', 'line 5000 edited'), 'all')).toBeNull()
    // Pathological input: one character repeated has no content-defined cut points.
    const flat = 'a'.repeat(1024 * 1024)
    suspiciousWrite(flat, flat + flat, 'repeated-block')
    const ms = performance.now() - t
    // Each check is one pass per body: four 1-3 MiB checks well under a second.
    expect(ms).toBeLessThan(1500)
  })
})
