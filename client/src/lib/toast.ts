import { createContext, useContext } from 'react'

export type ToastVariant = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  duration: number
}

export interface ToastOptions {
  id?: string
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

export type ToastListener = (toasts: ToastItem[]) => void

class ToastStore {
  private toasts: ToastItem[] = []
  private listeners = new Set<ToastListener>()
  private counter = 0

  subscribe(listener: ToastListener): () => void {
    this.listeners.add(listener)
    listener([...this.toasts])
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify() {
    const copy = [...this.toasts]
    for (const listener of this.listeners) {
      listener(copy)
    }
  }

  add(options: ToastOptions): string {
    const id = options.id ?? `toast-${Date.now()}-${++this.counter}`
    const item: ToastItem = {
      id,
      title: options.title,
      description: options.description,
      variant: options.variant ?? 'info',
      duration: options.duration ?? 4000,
    }

    // Keep at most 5 visible toasts
    this.toasts = [item, ...this.toasts.filter((t) => t.id !== id)].slice(0, 5)
    this.notify()
    return id
  }

  remove(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id)
    this.notify()
  }

  clear(): void {
    this.toasts = []
    this.notify()
  }

  getToasts(): ToastItem[] {
    return [...this.toasts]
  }
}

export const toastStore = new ToastStore()

export interface ToastFunction {
  (options: ToastOptions): string
  success: (title: string, description?: string, duration?: number) => string
  error: (title: string, description?: string, duration?: number) => string
  warning: (title: string, description?: string, duration?: number) => string
  info: (title: string, description?: string, duration?: number) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const toast: ToastFunction = Object.assign(
  (options: ToastOptions) => toastStore.add(options),
  {
    success: (title: string, description?: string, duration?: number) =>
      toastStore.add({ title, description, variant: 'success', duration }),
    error: (title: string, description?: string, duration?: number) =>
      toastStore.add({ title, description, variant: 'error', duration }),
    warning: (title: string, description?: string, duration?: number) =>
      toastStore.add({ title, description, variant: 'warning', duration }),
    info: (title: string, description?: string, duration?: number) =>
      toastStore.add({ title, description, variant: 'info', duration }),
    dismiss: (id: string) => toastStore.remove(id),
    clear: () => toastStore.clear(),
  },
)

export const ToastContext = createContext<ToastFunction>(toast)

export function useToast(): ToastFunction {
  return useContext(ToastContext)
}
