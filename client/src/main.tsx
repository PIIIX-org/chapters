import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import App from './App.js'
import { themeStore } from './lib/theme.js'
import './index.css'

// Before the first paint: index.html ships with `class="dark"` (the default),
// so this only ever changes anything for a stored light/system preference.
themeStore.boot()

// Auto-recover once from stale dynamic chunk imports following redeployments
window.addEventListener('vite:preloadError', (event) => {
  const key = 'elara_chunk_reload'
  const last = Number(sessionStorage.getItem(key) ?? 0)
  if (Date.now() - last > 10_000) {
    sessionStorage.setItem(key, String(Date.now()))
    event.preventDefault()
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
