// Colour-mode control for the graph. The spec considered layering
// type/tag colouring and community colouring and rejected it — so this is
// a two-option radiogroup of native <input type="radio">, never checkboxes
// and never a 'blend'/'both' option, which would make layering
// representable again.
//
// Selection lives in the URL (`?color=community`, default omitted) rather
// than component state — GraphCanvas reads the same `useSearchParams` from
// the same router, so the URL is the single source of truth both here and
// there, and a shared link reproduces the view.
import { useSearchParams } from 'react-router'
import { CATEGORY_HUES, type ColorMode } from './draw.js'
import { cn } from '../../lib/utils.js'

const OPTIONS: { value: ColorMode; label: string }[] = [
  { value: 'attribute', label: 'By type & tag' },
  { value: 'community', label: 'By community' },
]

// Legend labels for the five fixed hue slots each mode cycles through
// (draw.ts's `hueAt` is a modulo into CATEGORY_HUES) — not a mapping onto
// specific type names or community numbers, which the hash/mod scheme
// doesn't preserve as a stable one-to-one anyway.
const LEGEND_NOUN: Record<ColorMode, string> = {
  attribute: 'Type/tag group',
  community: 'Community group',
}

export function ColorModeToggle() {
  const [searchParams, setSearchParams] = useSearchParams()
  const colorMode: ColorMode = searchParams.get('color') === 'community' ? 'community' : 'attribute'

  function select(mode: ColorMode) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (mode === 'community') next.set('color', 'community')
      else next.delete('color')
      return next
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 text-sm shadow-sm">
      <fieldset className="flex gap-1">
        <legend className="sr-only">Colour mode</legend>
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-muted',
              colorMode === opt.value ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <input
              type="radio"
              name="graph-color-mode"
              value={opt.value}
              checked={colorMode === opt.value}
              onChange={() => select(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </fieldset>
      {/* Legend for the active mode only — never both at once, matching the
          "never layered" rule for the modes themselves. */}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {CATEGORY_HUES.map((hue, i) => (
          <li key={hue} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: hue }} />
            <span>{`${LEGEND_NOUN[colorMode]} ${i + 1}`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
