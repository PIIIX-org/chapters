/**
 * Collaborator "ink" palette (`docs/superpowers/specs/2026-07-19-ui-design-system.md`).
 *
 * Five hues, hashed deterministically per user so the same person keeps the
 * same ink for everyone watching. Teal is **not** in this list and must never
 * be added to it: teal means AI/MCP authored something, and handing it to a
 * human breaks the one colour rule the whole design system rests on.
 *
 * Every ink has two renderings of one hue. A hue dark enough to read on the
 * paper canvas is far too dark on the night one: measured against `#17140F`
 * all five sat between 2.3:1 and 3.8:1, under AA everywhere they are used as
 * text. The hue is the identity, not the lightness — `ink.test.ts` holds each
 * pair to the same hue angle, so a collaborator stays the same colour in both
 * themes and only gets lighter. The dark renderings are the ones the design
 * system already approved for these hues elsewhere: four are
 * `CATEGORY_HUES_DARK` (`components/graph/draw.ts`) and vermillion is the dark
 * `--primary`, so nothing new was invented here.
 *
 * *Which* rendering gets used is the reader's business, not the author's:
 * `useCollabDoc` broadcasts {@link Ink.color} over awareness and the peer's own
 * browser paints it, so the value on the wire has to be a CSS variable that
 * resolves against whatever theme *that* reader is in. A hex would freeze a
 * light-mode author's ink onto a dark-mode reader's screen.
 */
export interface Ink {
  name: string
  /** Hex on the light canvas (`--background`). */
  light: string
  /** Hex on the dark canvas (`--background` under `.dark`): same hue, lifted
   *  until it clears AA there. */
  dark: string
  /** Cursor / caret / avatar colour, theme-resolved by whoever renders it. */
  color: string
  /** Selection wash — the same variable at 20% (`yCollab` reads `colorLight`). */
  colorLight: string
}

function ink(name: string, light: string, dark: string): Ink {
  // The hex fallback is the light rendering, which is what every ink was before
  // the tokens existed and what an older peer still broadcasts — so a client
  // that has not loaded them (or a peer mid-deploy) is no worse off than today.
  const color = `var(--ink-${name}, ${light})`
  return { name, light, dark, color, colorLight: `color-mix(in srgb, ${color} 20%, transparent)` }
}

export const INKS: readonly Ink[] = [
  ink('vermillion', '#BA3B1D', '#E2683F'),
  ink('indigo', '#3B4C8C', '#7C8FD9'),
  ink('plum', '#7A3B6B', '#C97FB0'),
  // Light ochre is a shade darker than the spec's #8C6D1F, which measured
  // 4.31:1 on the paper canvas — the one ink that missed AA in *both* themes.
  ink('ochre', '#856619', '#D9B24C'),
  ink('forest', '#3B6B4C', '#6FBF8A'),
]

/** Reserved for the AI/MCP's own live cursor. Excluded from the human hash. */
export const AI_INK: Ink = ink('teal', '#2B6E6B', '#4FA39F')

/** FNV-1a, 32-bit — stable across sessions and machines, which `Math.random`
 *  and object identity are not. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The ink for a human collaborator. Never returns {@link AI_INK}. */
export function inkFor(userId: string): Ink {
  return INKS[hash(userId) % INKS.length]!
}
