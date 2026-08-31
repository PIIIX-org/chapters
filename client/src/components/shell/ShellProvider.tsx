import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  ShellContext,
  type BreadcrumbItem,
  type PanelKind,
  type ShellStatus,
  type ShellValue,
} from './shell-context.js'

interface PanelState {
  open: boolean
  mounted: number
  node: HTMLElement | null
}

const STORAGE_PREFIX = 'chapters.shell.'
/** Below this the tracks would leave the content cell too narrow to use. */
const WIDE_VIEWPORT = 1024

function readOpen(kind: PanelKind): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + kind)
    if (raw === 'open') return true
    if (raw === 'closed') return false
  } catch {
    // no storage: fall through to the viewport default
  }
  return typeof window === 'undefined'
    ? true
    : window.innerWidth >= WIDE_VIEWPORT
}

function writeOpen(kind: PanelKind, open: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + kind, open ? 'open' : 'closed')
  } catch {
    // preference only; nothing to do if it cannot persist
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([])
  const [status, setStatus] = useState<ShellStatus | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [panels, setPanels] = useState<Record<PanelKind, PanelState>>(() => ({
    context: { open: readOpen('context'), mounted: 0, node: null },
    inspector: { open: readOpen('inspector'), mounted: 0, node: null },
  }))

  const setPanelOpen = useCallback((kind: PanelKind, open: boolean) => {
    writeOpen(kind, open)
    setPanels((prev) =>
      prev[kind].open === open
        ? prev
        : { ...prev, [kind]: { ...prev[kind], open } },
    )
  }, [])

  const togglePanel = useCallback((kind: PanelKind) => {
    setPanels((prev) => {
      const open = !prev[kind].open
      writeOpen(kind, open)
      return { ...prev, [kind]: { ...prev[kind], open } }
    })
  }, [])

  const registerPanel = useCallback((kind: PanelKind) => {
    setPanels((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], mounted: prev[kind].mounted + 1 },
    }))
    return () => {
      setPanels((prev) => ({
        ...prev,
        [kind]: { ...prev[kind], mounted: Math.max(0, prev[kind].mounted - 1) },
      }))
    }
  }, [])

  const setPanelNode = useCallback(
    (kind: PanelKind, node: HTMLElement | null) => {
      setPanels((prev) =>
        prev[kind].node === node
          ? prev
          : { ...prev, [kind]: { ...prev[kind], node } },
      )
    },
    [],
  )

  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  const value = useMemo<ShellValue>(
    () => ({
      breadcrumb,
      setBreadcrumb,
      status,
      setStatus,
      panels,
      togglePanel,
      setPanelOpen,
      registerPanel,
      setPanelNode,
      paletteOpen,
      openPalette,
      closePalette,
    }),
    [
      breadcrumb,
      status,
      panels,
      togglePanel,
      setPanelOpen,
      registerPanel,
      setPanelNode,
      paletteOpen,
      openPalette,
      closePalette,
    ],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}
