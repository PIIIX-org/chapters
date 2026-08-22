import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useVaults } from '../../hooks/useVaults.js'

export function ScopePicker() {
  const [open, setOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const vaults = useVaults()
  const triggerRef = useRef<HTMLButtonElement>(null)

  const vaultId = searchParams.get('vault')
  const activeVault = vaultId ? vaults.data?.find((v) => v.id === vaultId) : undefined
  const label = vaultId && activeVault ? activeVault.name : 'All vaults'

  function select(id: string | null) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id) next.set('vault', id)
      else next.delete('vault')
      return next
    })
    setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="scope-list"
        disabled={vaults.isPending}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-100"
      >
        {label}
      </button>
      {open && (
        <ul
          id="scope-list"
          role="listbox"
          aria-label="Scope"
          onKeyDown={onKeyDown}
          className="absolute left-0 top-full z-10 mt-1 min-w-[10rem] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          <li role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={!vaultId}
              onClick={() => select(null)}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              All vaults
            </button>
          </li>
          {vaults.data?.map((v) => (
            <li key={v.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={v.id === vaultId}
                onClick={() => select(v.id)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                {v.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
