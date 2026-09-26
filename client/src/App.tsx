import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { router } from './router.js'
import { ToastProvider } from './components/ui/Toast.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

