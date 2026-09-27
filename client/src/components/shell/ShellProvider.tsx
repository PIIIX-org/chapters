import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
const MOBILE_BREAKPOINT = 768

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT
}

function readOpen(kind: PanelKind): boolean {
  if (isMobile()) return false
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
  const [sidebarExpanded, setSidebarExpandedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('chapters.shell.sidebar') === 'expanded'
    } catch {
      return false
    }
  })
  const [panels, setPanels] = useState<Record<PanelKind, PanelState>>(() => ({
    context: { open: readOpen('context'), mounted: 0, node: null },
    inspector: { open: readOpen('inspector'), mounted: 0, node: null },
  }))

  useEffect(() => {
    if (typeof window === 'undefined') return
    let lastMobile = window.innerWidth < MOBILE_BREAKPOINT
    const handleResize = () => {
      const currentMobile = window.innerWidth < MOBILE_BREAKPOINT
      if (currentMobile && !lastMobile) {
        setPanels((prev) => {
          if (!prev.context.open && !prev.inspector.open) return prev
          return {
            ...prev,
            context: { ...prev.context, open: false },
            inspector: { ...prev.inspector, open: false },
          }
        })
      }
      lastMobile = currentMobile
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const setPanelOpen = useCallback((kind: PanelKind, open: boolean) => {
    writeOpen(kind, open)
    setPanels((prev) => {
      if (prev[kind].open === open) return prev
      if (isMobile() && open) {
        const otherKind: PanelKind = kind === 'context' ? 'inspector' : 'context'
        return {
          ...prev,
          [kind]: { ...prev[kind], open: true },
          [otherKind]: { ...prev[otherKind], open: false },
        }
      }
      return { ...prev, [kind]: { ...prev[kind], open } }
    })
  }, [])

  const togglePanel = useCallback((kind: PanelKind) => {
    setPanels((prev) => {
      const open = !prev[kind].open
      writeOpen(kind, open)
      if (isMobile() && open) {
        const otherKind: PanelKind = kind === 'context' ? 'inspector' : 'context'
        return {
          ...prev,
          [kind]: { ...prev[kind], open: true },
          [otherKind]: { ...prev[otherKind], open: false },
        }
      }
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

  const toggleSidebar = useCallback(() => {
    setSidebarExpandedState((prev) => {
      const next = !prev
      try {
        localStorage.setItem('chapters.shell.sidebar', next ? 'expanded' : 'collapsed')
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const setSidebarExpanded = useCallback((expanded: boolean) => {
    setSidebarExpandedState(expanded)
    try {
      localStorage.setItem('chapters.shell.sidebar', expanded ? 'expanded' : 'collapsed')
    } catch {
      // ignore storage errors
    }
  }, [])

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
      sidebarExpanded,
      toggleSidebar,
      setSidebarExpanded,
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
      sidebarExpanded,
      toggleSidebar,
      setSidebarExpanded,
    ],
  )

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>
}
