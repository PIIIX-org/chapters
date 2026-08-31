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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
