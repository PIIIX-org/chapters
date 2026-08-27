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
      // The collaboration relay is a second listener on its own port
      // (COLLAB_PORT, default 3001). It is served from the app's own origin at
      // /collab, which is the only shape that survives the documented
      // production deployment — a single reverse proxy on one public port,
      // where 3001 is neither exposed nor certificated. Dev routes the same
      // path so the ticket URL from `server/src/sync/routes.ts` is correct in
      // both. Path forwarded as-is, exactly as nginx's
      // `proxy_pass http://127.0.0.1:3001;` does.
      '/collab': { target: 'ws://localhost:3001', ws: true },
    },
  },
})
