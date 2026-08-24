// Pure layout math for the Team page's by-user constellation hero. No DOM,
// no dependency — a few dozen members don't earn a force-simulation library.

const MIN_RADIUS = 6
const MAX_RADIUS = 28

/**
 * Square-root scale so mass differences read as area (what the eye actually
 * compares for a filled circle), not raw radius — a linear scale lets one
 * heavy contributor's circle swallow the canvas. Clamped so a 1-note person
 * is still visible and a 10k-note person still fits.
 */
export function radiusFor(mass: number, maxMass: number): number {
  if (maxMass <= 0) return MIN_RADIUS
  const t = Math.min(1, Math.max(0, mass) / maxMass)
  return MIN_RADIUS + Math.sqrt(t) * (MAX_RADIUS - MIN_RADIUS)
}

// 0–200 viewBox, centered ring — big enough that a MAX_RADIUS circle at any
// point on the ring stays inside the box.
export const CONSTELLATION_VIEWBOX = 200
const CENTER = CONSTELLATION_VIEWBOX / 2
const RING_RADIUS = 70

/** Deterministic point on a ring — same (index, count) always lands the same place. */
export function positionFor(index: number, count: number): { x: number; y: number } {
  if (count <= 1) return { x: CENTER, y: CENTER }
  const angle = (2 * Math.PI * index) / count - Math.PI / 2
  return { x: CENTER + RING_RADIUS * Math.cos(angle), y: CENTER + RING_RADIUS * Math.sin(angle) }
}
