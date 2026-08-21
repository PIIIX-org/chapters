import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // happy-dom (not jsdom): react-router's data router builds a native
      // Request on every client-side navigation, including <Navigate>
      // redirects. jsdom shadows AbortController/AbortSignal but not
      // Request/fetch, so undici rejects the mismatched signal with
      // "TypeError: RequestInit: Expected signal ... to be an instance of
      // AbortSignal" (vitest-dev/vitest#8374, remix-run/react-router#10158).
      // happy-dom doesn't hit this.
      environment: 'happy-dom',
      setupFiles: ['./src/test/setup.ts'],
      globals: false,
    },
  }),
)
