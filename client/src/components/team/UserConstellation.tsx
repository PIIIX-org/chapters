import { CONSTELLATION_VIEWBOX, positionFor, radiusFor } from './constellation.js'

export interface ConstellationPerson {
  userId: string
  email: string
  /** Notes touched — the only mass this view is allowed to show. */
  mass: number
}

interface UserConstellationProps {
  people: ConstellationPerson[]
}

function massLabel(mass: number): string {
  return `${mass} note${mass === 1 ? '' : 's'} touched`
}

// One inline <svg>, one <circle> per person. This is presentation only — the
// roster list below is the accessible equivalent of the picture (each circle
// still carries a <title> so a pointer or screen-magnifier user gets the
// same identity a hover would, but the roster is what a screen reader uses).
export function UserConstellation({ people }: UserConstellationProps) {
  const maxMass = people.reduce((max, p) => Math.max(max, p.mass), 0)

  return (
    <svg
      viewBox={`0 0 ${CONSTELLATION_VIEWBOX} ${CONSTELLATION_VIEWBOX}`}
      role="img"
      aria-label={`Team constellation: ${people.length} member${people.length === 1 ? '' : 's'}, sized by notes touched`}
      className="mx-auto block h-72 w-72"
    >
      {people.map((person, index) => {
        const { x, y } = positionFor(index, people.length)
        const r = radiusFor(person.mass, maxMass)
        return (
          // Fill is the human-authorship token, never the AI/teal accent —
          // every circle here represents a person.
          <circle key={person.userId} cx={x} cy={y} r={r} fill="var(--primary)">
            <title>{`${person.email} — ${massLabel(person.mass)}`}</title>
          </circle>
        )
      })}
    </svg>
  )
}
