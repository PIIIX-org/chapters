import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="font-display text-2xl">Chapters</div>
    </QueryClientProvider>
  )
}
