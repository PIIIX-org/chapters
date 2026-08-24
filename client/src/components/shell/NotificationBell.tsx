import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Bell } from 'lucide-react'
import { Button } from '../ui/button.js'
import { useMarkNotificationRead, useNotifications } from '../../hooks/useNotifications.js'

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const notifications = useNotifications()
  const markRead = useMarkNotificationRead()

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // role="dialog" with focus that never enters it is the wrong role for what
  // it is — this is non-modal (no trap, Escape returns focus to the trigger
  // below), but it still needs to actually receive focus on open.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  const unreadCount = notifications.data?.filter((n) => n.readAt === null).length ?? 0
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'

  function close() {
    setOpen(false)
  }

  // Bound to the wrapper, not the drawer panel: after clicking the trigger,
  // focus sits on the trigger button, a sibling of the panel — not a
  // descendant of the dialog — so a real Escape keydown bubbles
  // trigger -> this div and never reaches a handler on the panel itself.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close()
      triggerRef.current?.focus()
    }
  }

  return (
    <div ref={wrapperRef} className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 hover:bg-muted"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 h-2 w-2 rounded-full bg-foreground"
          />
        )}
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="absolute right-0 top-full z-10 mt-1 w-80 rounded-md border border-border bg-popover py-1 shadow-md focus:outline-none"
        >
          {notifications.isError ? (
            // Ordered before any read of `.data`, same reasoning as
            // HomePage's vaults fetch: isError must gate before an empty
            // `.data` reads as "no notifications" over a failed request.
            <div role="alert" className="flex flex-col items-start gap-2 px-3 py-3">
              <p className="text-sm text-muted-foreground">{notifications.error.message}</p>
              <Button type="button" size="sm" onClick={() => notifications.refetch()}>
                Retry
              </Button>
            </div>
          ) : notifications.isPending ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : notifications.data.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">No notifications yet.</p>
          ) : (
            <ul>
              {notifications.data.map((n) => (
                <li key={n.id} className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm">
                      {n.readAt === null && <span aria-hidden="true" className="mr-1.5 text-foreground">●</span>}
                      {n.message}
                    </p>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(n.createdAt).toLocaleString()}
                    </span>
                    {n.readAt === null && (
                      <Button type="button" size="sm" variant="secondary" onClick={() => markRead.mutate(n.id)}>
                        Mark as read
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
