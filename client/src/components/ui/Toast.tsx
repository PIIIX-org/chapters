import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import {
  toast,
  toastStore,
  ToastContext,
  type ToastItem,
} from '../../lib/toast.js'

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    return toastStore.subscribe(setToasts)
  }, [])

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={(id) => toastStore.remove(id)} />
    </ToastContext.Provider>
  )
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <aside
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-14 z-50 flex max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </aside>
  )
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    if (item.duration <= 0) return
    const timer = setTimeout(onDismiss, item.duration)
    return () => clearTimeout(timer)
  }, [item.id, item.duration, onDismiss])

  const icons = {
    success: <CheckCircle2 className="size-4 shrink-0 text-emerald-400" aria-hidden="true" />,
    error: <AlertCircle className="size-4 shrink-0 text-red-400" aria-hidden="true" />,
    warning: <AlertTriangle className="size-4 shrink-0 text-amber-400" aria-hidden="true" />,
    info: <Info className="size-4 shrink-0 text-sky-400" aria-hidden="true" />,
  }

  const borderStyles = {
    success: 'border-emerald-500/20',
    error: 'border-red-500/20',
    warning: 'border-amber-500/20',
    info: 'border-sky-500/20',
  }

  return (
    <div
      role={item.variant === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border bg-card/95 p-3.5 shadow-floating backdrop-blur-md transition-all',
        borderStyles[item.variant],
      )}
    >
      {icons[item.variant]}
      <div className="flex-1 min-w-0 pr-1">
        <p className="text-xs font-semibold text-foreground leading-snug">{item.title}</p>
        {item.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground leading-normal break-words">
            {item.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/50"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
