import { Link } from 'react-router'
import type { BreadcrumbItem } from './shell-context.js'

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  const shown = items.length > 0 ? items : [{ label: 'Chapters' }]
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 font-mono text-[12px]">
        {shown.map((item, i) => {
          const last = i === shown.length - 1
          return (
            <li
              key={`${item.label}-${i}`}
              className="flex min-w-0 items-center gap-1.5"
            >
              {i > 0 && (
                <span aria-hidden="true" className="text-faint select-none">
                  /
                </span>
              )}
              {item.to && !last ? (
                <Link
                  to={item.to}
                  className="truncate text-muted-foreground transition-colors duration-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 rounded-[var(--radius-sm)]"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className="truncate font-medium text-foreground"
                >
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
