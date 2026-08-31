// Colour-mode control for the graph. The spec considered layering
// type/tag colouring and community colouring and rejected it — so this is
// a two-option radiogroup of native <input type="radio">, never checkboxes
// and never a 'blend'/'both' option, which would make layering
// representable again. Visually it is the two small pills the redesign
// allows in the canvas cell's top-left corner, plus a swatch-dot legend
// whose labels are sr-only/title so the canvas stays uncluttered.
//
// Selection lives in the URL (`?color=community`, default omitted) rather
// than component state — GraphCanvas reads the same `useSearchParams` from
// the same router, so the URL is the single source of truth both here and
// there, and a shared link reproduces the view.
import { useSearchParams } from 'react-router'
import { categoryHuesFor, type ColorMode } from './draw.js'
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
  // Matches GraphCanvas's own one-time `isDark` read (see GraphCanvas.tsx)
  // — nothing in the client sets `.dark` reactively today, so re-reading on
  // every render costs nothing and stays correct the day something does.
  const hues = categoryHuesFor(document.documentElement.classList.contains('dark'))

  function select(mode: ColorMode) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (mode === 'community') next.set('color', 'community')
      else next.delete('color')
      return next
    })
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <fieldset className="flex gap-0.5 rounded-md border border-border bg-popover/90 p-0.5">
        <legend className="sr-only">Colour mode</legend>
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              'flex h-6 cursor-pointer select-none items-center rounded-sm px-2 font-mono text-[11px] font-medium uppercase tracking-[0.04em] transition-colors duration-100 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
              colorMode === opt.value
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <input
              type="radio"
              name="graph-color-mode"
              value={opt.value}
              checked={colorMode === opt.value}
              onChange={() => select(opt.value)}
              className="sr-only"
            />
            {opt.label}
          </label>
        ))}
      </fieldset>
      {/* Legend for the active mode only — never both at once, matching the
          "never layered" rule for the modes themselves. */}
      <ul className="flex items-center gap-1.5 rounded-md border border-border bg-popover/90 px-2 py-1.5">
        {hues.map((hue, i) => (
          <li key={hue} className="flex items-center" title={`${LEGEND_NOUN[colorMode]} ${i + 1}`}>
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: hue }}
            />
            <span className="sr-only">{`${LEGEND_NOUN[colorMode]} ${i + 1}`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
