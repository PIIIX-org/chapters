import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      // Same port as the API: the relay rides the app's own HTTP server on
      // /collab rather than listening separately, so there is no second port
      // to route to — in dev or in production. This entry existed pointing at
      // :3001 for exactly as long as it took to notice collaboration was dead
      // on every dev machine.
      '/collab': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
