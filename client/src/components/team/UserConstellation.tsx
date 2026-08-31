import { inkFor } from '../../lib/ink.js'
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

const CENTER = CONSTELLATION_VIEWBOX / 2
// Past this the ring is too crowded for 7px labels to stay apart; the roster
// table right below carries every name anyway.
const MAX_LABELS = 12
// Margin around the layout's 0–200 box so a label under the bottom node is
// not clipped. Presentation only — the layout maths is untouched.
const MARGIN = 20

function massLabel(mass: number): string {
  return `${mass} note${mass === 1 ? '' : 's'} touched`
}

// One inline <svg>, one <circle> per person. This is presentation only — the
// roster table below is the accessible equivalent of the picture (each circle
// still carries a <title> so a pointer or screen-magnifier user gets the
// same identity a hover would, but the roster is what a screen reader uses).
export function UserConstellation({ people }: UserConstellationProps) {
  const maxMass = people.reduce((max, p) => Math.max(max, p.mass), 0)
  const showLabels = people.length <= MAX_LABELS

  return (
    <div
      data-slot="constellation"
      className="w-full px-3 py-4"
      // Subtle dotted backdrop — static CSS, no animation, hairline dots.
      style={{
        backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      }}
    >
      <svg
        viewBox={`${-MARGIN} ${-MARGIN} ${CONSTELLATION_VIEWBOX + 2 * MARGIN} ${CONSTELLATION_VIEWBOX + 2 * MARGIN}`}
        role="img"
        aria-label={`Team constellation: ${people.length} member${people.length === 1 ? '' : 's'}, sized by notes touched`}
        className="mx-auto block h-64 w-64 max-w-full"
      >
        {people.length > 1 &&
          people.map((person, index) => {
            const { x, y } = positionFor(index, people.length)
            return (
              <line
                key={person.userId}
                x1={CENTER}
                y1={CENTER}
                x2={x}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
            )
          })}
        {people.map((person, index) => {
          const { x, y } = positionFor(index, people.length)
          const r = radiusFor(person.mass, maxMass)
          // Fill is this person's collaborator ink — never the AI/teal
          // accent. inkFor hashes the id to one of the five human hues; the
          // human accent stands in only when there is no id to hash.
          const fill = person.userId ? inkFor(person.userId).color : 'var(--primary)'
          return (
            <circle key={person.userId} cx={x} cy={y} r={r} fill={fill} fillOpacity={0.9}>
              <title>{`${person.email} — ${massLabel(person.mass)}`}</title>
            </circle>
          )
        })}
        {showLabels &&
          people.map((person, index) => {
            const { x, y } = positionFor(index, people.length)
            const r = radiusFor(person.mass, maxMass)
            const handle = person.email.split('@')[0] ?? person.email
            return (
              <text
                key={person.userId}
                x={x}
                y={y + r + 10}
                textAnchor="middle"
                aria-hidden="true"
                className="font-mono"
                style={{ fontSize: 7, fill: 'var(--muted-foreground)' }}
              >
                {handle.length > 14 ? `${handle.slice(0, 13)}…` : handle}
              </text>
            )
          })}
      </svg>
    </div>
  )
}
