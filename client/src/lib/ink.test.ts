import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_INK, INKS, inkFor } from './ink'

// Deliberately uneven ids — a fixture of `user-1..user-5` could pass while the
// hash was broken, since any five distinct inputs mod 5 look plausible.
const ids = [
  '3f0d5f9a-1c2b-4e7a-9f11-000000000001',
  'b7',
  'taha@example.com',
  'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  '9',
  'e2d0c1b4-aaaa-bbbb-cccc-ddddeeeeffff',
  'A',
  'a',
  '',
  'note/path/like/thing',
]

/** Every ink, human and machine: teal is painted on the same two canvases. */
const ALL = [...INKS, AI_INK]

// ---------------------------------------------------------------------------
// The stylesheet is the other half of this palette, so the test reads the real
// file rather than a copy of it: a token that is missing, misspelled or drifted
// from ink.ts is the exact failure this catches, and no fixture can fake it.
// (Read, not imported: `?raw` on a stylesheet comes back empty through the
// Tailwind plugin. Same `process.cwd()` route PhysicsControls.test.tsx uses.)
const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf-8')

function vars(selector: string): Record<string, string> {
  const block = new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1]
  if (block === undefined) throw new Error(`no ${selector} block in index.css`)
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1]!, m[2]!]),
  )
}

const LIGHT = vars(':root')
const DARK = vars('\\.dark')

// --- WCAG 2.1 relative luminance and contrast, straight from the spec. ------
function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Hue angle in degrees. Lightness is what changes between themes; hue is what
 *  must not, and what tells two collaborators apart. */
function hue(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (span === 0) return 0
  const sixth = max === r ? (g - b) / span : max === g ? (b - r) / span + 2 : (r - g) / span + 4
  return ((sixth * 60) % 360 + 360) % 360
}

function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b)) % 360
  return d > 180 ? 360 - d : d
}

const AA = 4.5 // 12px avatar initials and a 0.75em name tag are both small text

describe('ink contrast', () => {
  // The measured failure this palette exists to fix: every ink was one hex,
  // and on #17140F those hexes ran 2.27:1 – 3.78:1.
  it('sanity-checks its own maths against a known pair', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#BA3B1D', '#17140F')).toBeLessThan(AA) // the old dark-mode ink
  })

  it('clears AA on the canvas it is painted on, in both themes', () => {
    for (const i of ALL) {
      expect(contrast(i.light, LIGHT['--background']!), `${i.name} on paper`).toBeGreaterThanOrEqual(AA)
      expect(contrast(i.dark, DARK['--background']!), `${i.name} on night`).toBeGreaterThanOrEqual(AA)
    }
  })

  it('carries a legible name tag on every ink', () => {
    // `yCollab` paints the peer's name *on* their ink, so the tag's own text
    // colour has to clear AA against all six — in whichever theme it is in.
    for (const i of ALL) {
      expect(contrast(LIGHT['--primary-foreground']!, i.light)).toBeGreaterThanOrEqual(AA)
      expect(contrast(DARK['--primary-foreground']!, i.dark)).toBeGreaterThanOrEqual(AA)
    }
  })

  it('keeps each collaborator the same colour in both themes', () => {
    // A person's ink is their identity across the avatar, the nib and the tag.
    // Dark mode may lighten it; it may not turn them into someone else.
    for (const i of ALL) expect(hueGap(i.light, i.dark)).toBeLessThanOrEqual(10)
  })

  it('keeps the inks distinguishable from one another in both themes', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a === b) continue
        // 25° is the floor for "these read as two different pens"; the tightest
        // real pair is vermillion/ochre at 28°.
        expect(hueGap(a.light, b.light), `${a.name}/${b.name} light`).toBeGreaterThan(25)
        expect(hueGap(a.dark, b.dark), `${a.name}/${b.name} dark`).toBeGreaterThan(25)
      }
    }
  })

  it('is wired to index.css, so the theme actually switches it', () => {
    // Awareness carries `color` to other people's browsers, so it must stay a
    // variable — a hex would freeze this author's theme onto their reader.
    for (const i of ALL) {
      expect(i.color).toBe(`var(--ink-${i.name}, ${i.light})`)
      expect(i.colorLight).toBe(`color-mix(in srgb, ${i.color} 20%, transparent)`)
      expect(LIGHT[`--ink-${i.name}`]).toBe(i.light)
      expect(DARK[`--ink-${i.name}`]).toBe(i.dark)
    }
  })
})

describe('ink palette', () => {
  it('is the five spec hues, teal excluded', () => {
    expect(INKS.map((i) => i.name)).toEqual(['vermillion', 'indigo', 'plum', 'ochre', 'forest'])
    expect(INKS.map((i) => i.color)).not.toContain(AI_INK.color)
  })

  it('never assigns the AI teal to a human, however many ids are hashed', () => {
    for (let i = 0; i < 500; i += 1) {
      const assigned = inkFor(`user-${i}-${i * 7919}`)
      expect(assigned.color).not.toBe(AI_INK.color)
      expect(INKS).toContain(assigned)
    }
  })

  it('is deterministic per user', () => {
    for (const id of ids) expect(inkFor(id)).toBe(inkFor(id))
  })

  it('spreads across all five inks rather than collapsing onto one', () => {
    const used = new Set<string>()
    for (let i = 0; i < 200; i += 1) used.add(inkFor(`user-${i}`).name)
    expect(used.size).toBe(INKS.length)
  })

  it('distinguishes ids that differ only in case or by one character', () => {
    expect(inkFor('A')).not.toBe(inkFor('a'))
    expect(inkFor('user-1')).not.toBe(inkFor('user-2'))
  })
})
