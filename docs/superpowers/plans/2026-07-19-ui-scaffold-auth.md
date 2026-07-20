# UI Scaffold + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `client/` React app (Vite + TypeScript + Tailwind v4 +
shadcn/ui, on the approved design system) and build every auth page needed
to get a user from a fresh instance to a logged-in session: setup, signup,
email verification, login (with inline MFA challenge), password reset, and
logout.

**Architecture:** A Vite SPA in `client/`, talking to the existing Fastify
API at `/api/*` (proxied by Vite's dev server to `localhost:3000`, so
requests are same-origin — no CORS config needed, matching the production
reverse-proxy posture). `react-router` (library mode: `createBrowserRouter`
+ `RouterProvider`) handles routing; `@tanstack/react-query` handles server
state (the session, in this plan) with a thin typed `fetch` wrapper
underneath. A `RequireAuth` route wrapper gates everything behind `/`.

**Tech Stack:** React 19, Vite 8, TypeScript 5, Tailwind CSS 4 (CSS-first
config, no `tailwind.config.js`), shadcn/ui, react-router 8 (library mode),
@tanstack/react-query 5, Vitest + React Testing Library + jsdom.

## Global Constraints

- Package manager: pnpm only, workspace already declares `client` in
  `pnpm-workspace.yaml` — no workspace config changes needed.
- Every new file's TypeScript must satisfy the root `tsconfig.base.json`'s
  `strict: true` and `verbatimModuleSyntax: true` — use `import type { X }`
  for any import used only as a type.
- Match `server/`'s existing per-package conventions exactly: `package.json`
  scripts are `dev`/`build`/`typecheck`/`test` (no per-package `lint` —
  linting is root-only, `pnpm lint` = `eslint .` at repo root); `tsconfig.json`
  extends `../tsconfig.base.json`; Vitest tests import
  `describe`/`it`/`expect` explicitly from `'vitest'` (no test globals).
- Design tokens, fonts, and the dual-accent color system come from
  `docs/superpowers/specs/2026-07-19-ui-design-system.md` — exact hex values
  are in this plan's tasks, don't re-derive them.
- Dark mode uses shadcn/Tailwind's standard `.dark` class on `<html>` (not
  the `[data-theme]` attribute used in the earlier throwaway HTML preview —
  that file was never committed; `.dark` is the idiomatic mechanism shadcn's
  generated components already expect via their `dark:` variants).
- MFA **enrollment** (`/mfa/setup`, `/mfa/enable`, `/mfa/disable`) is
  **out of scope for this plan** — it belongs to the Settings page (a later
  slice). This plan only handles the MFA **challenge at login time**
  (`POST /login` returning `mfaRequired: true`), since that's part of the
  login flow itself.
- Every backend endpoint used below is read verbatim from
  `server/src/auth/routes.ts` and `server/src/auth/mfa-routes.ts` — request/
  response shapes in this plan are exact, not inferred.
- Anti-slop tooling (`impeccable`) fires automatically on every file
  write/edit per `2026-07-19-ui-design-system.md` — findings get fixed
  before a task's commit step, not deferred.

---

### Task 1: Client workspace scaffold (Vite + React + TS + path aliases)

**Files:**
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/vite.config.ts`
- Create: `client/vitest.config.ts`
- Create: `client/index.html`
- Create: `client/src/main.tsx`
- Create: `client/src/App.tsx`
- Create: `client/src/App.test.tsx`
- Create: `client/src/test/setup.ts`
- Create: `client/src/vite-env.d.ts`

**Interfaces:**
- Produces: `App` — default-exported React component from `client/src/App.tsx`, no props. Every later task's root component composes into this.

- [ ] **Step 1: Write the failing test**

`client/src/App.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the Chapters wordmark', () => {
    render(<App />)
    expect(screen.getByText('Chapters')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Create the workspace files so the test can even run**

`client/package.json`:
```json
{
  "name": "@chapters/client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.101.2",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router": "^8.2.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "jsdom": "^29.1.1",
    "tailwindcss": "^4.3.3",
    "typescript": "^5.9.0",
    "vite": "^8.1.5",
    "vitest": "^3.2.0"
  }
}
```

`client/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

`client/vite.config.ts`:
```ts
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
```

`client/vitest.config.ts`:
```ts
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      globals: false,
    },
  }),
)
```

`client/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Chapters</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`client/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`client/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
```

`client/src/App.tsx`:
```tsx
export default function App() {
  return <div>Chapters</div>
}
```

`client/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 3: Install and run the test to verify it passes**

Run:
```bash
cd ~/Documents/chapters
pnpm install
pnpm -C client test
```
Expected: `App > renders the Chapters wordmark` passes (1 test file, 1 test).

- [ ] **Step 4: Verify typecheck and build**

Run:
```bash
pnpm -C client typecheck
pnpm -C client build
```
Expected: both exit 0. `build` produces `client/dist/`.

- [ ] **Step 5: Commit**

```bash
git add client/ pnpm-lock.yaml
git commit -m "Scaffold client/ workspace (Vite + React + TS)"
```

---

### Task 2: Tailwind v4 + shadcn/ui init, remapped to the design system palette

**Files:**
- Modify: `client/vite.config.ts` (add Tailwind plugin)
- Create: `client/components.json` (generated by shadcn init)
- Create: `client/src/index.css` (generated by shadcn init, then edited)
- Create: `client/src/lib/utils.ts` (generated by shadcn init — `cn()` helper)
- Modify: `client/src/main.tsx` (import `./index.css`)
- Modify: `client/src/App.tsx`
- Modify: `client/src/App.test.tsx`

**Interfaces:**
- Consumes: `App` from Task 1.
- Produces: `cn(...classes: (string | undefined | false)[]): string` from `client/src/lib/utils.ts` — every later component uses this for conditional class names (shadcn's standard convention).

- [ ] **Step 1: Update the failing test first**

`client/src/App.test.tsx` — assert the wordmark renders in the display font, proving Tailwind classes are actually applied (not just present in source):
```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the Chapters wordmark in the display font', () => {
    render(<App />)
    const wordmark = screen.getByText('Chapters')
    expect(wordmark).toHaveClass('font-display')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `App.tsx` doesn't apply any `font-display` class yet.

- [ ] **Step 3: Run shadcn init (non-interactive)**

Run:
```bash
cd ~/Documents/chapters/client
pnpm dlx shadcn@latest init -d
```
Expected: creates `components.json`, `src/lib/utils.ts`, rewrites
`src/index.css` with a Tailwind v4 `@import "tailwindcss";` plus `@theme
inline` and `:root`/`.dark` CSS variable blocks, and adds the
`@tailwindcss/vite` plugin to `vite.config.ts`.

- [ ] **Step 4: Remap the generated CSS variables to the approved palette**

Replace the `:root { ... }` and `.dark { ... }` blocks shadcn generated in
`client/src/index.css` with the design system's values (keep shadcn's
variable *names* so its components pick these up automatically — only the
*values* change), and add the three fonts:

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-display: "Petrona", serif;
  --font-sans: "Hanken Grotesk", sans-serif;
  --font-mono: "IBM Plex Mono", monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
}

:root {
  --radius: 0.5rem;
  /* Canvas / surface / ink, from the design system spec */
  --background: #F4F1EA;
  --foreground: #1C1A16;
  --card: #FAF7F0;
  --card-foreground: #1C1A16;
  /* Human accent = primary (anything a person authored) */
  --primary: #BA3B1D;
  --primary-foreground: #FAF7F0;
  --secondary: #EAE5D8;
  --secondary-foreground: #1C1A16;
  --muted: #EAE5D8;
  --muted-foreground: #6B6558;
  /* AI/machine accent used as the accent role */
  --accent: #2B6E6B;
  --accent-foreground: #FAF7F0;
  --destructive: #BA3B1D;
  --border: #D8D2C2;
  --input: #D8D2C2;
  --ring: #BA3B1D;
}

.dark {
  --background: #17140F;
  --foreground: #EDE8DD;
  --card: #201C15;
  --card-foreground: #EDE8DD;
  --primary: #E2683F;
  --primary-foreground: #17140F;
  --secondary: #0F0D0A;
  --secondary-foreground: #EDE8DD;
  --muted: #0F0D0A;
  --muted-foreground: #A39C8C;
  --accent: #4FA39F;
  --accent-foreground: #17140F;
  --destructive: #E2683F;
  --border: #322C22;
  --input: #322C22;
  --ring: #E2683F;
}

body {
  font-family: var(--font-sans);
}
```

If shadcn init pulled in `tw-animate-css` as a dependency, keep the
`@import` above; if it didn't, remove that line — check
`client/package.json` after Step 3 to confirm which happened.

- [ ] **Step 5: Add Google Fonts and wire up the display font**

`client/index.html` — add inside `<head>`, after the `<title>` tag:
```html
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Petrona:ital,wght@0,400;0,500;0,600;0,700;1,500&family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
```

`client/src/main.tsx` — import the stylesheet:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`client/src/App.tsx`:
```tsx
export default function App() {
  return <div className="font-display text-2xl">Chapters</div>
}
```

- [ ] **Step 6: Run the test, verify it passes; then typecheck and build**

Run:
```bash
pnpm -C client test
pnpm -C client typecheck
pnpm -C client build
```
Expected: test passes, typecheck and build exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/
git commit -m "Add Tailwind v4 + shadcn/ui, remapped to the design system palette"
```

---

### Task 3: shadcn primitives (Button, Input, Label, Card)

**Files:**
- Verify (already exists from Task 2's `shadcn init`): `client/src/components/ui/button.tsx`
- Create: `client/src/components/ui/input.tsx` (generated)
- Create: `client/src/components/ui/label.tsx` (generated)
- Create: `client/src/components/ui/card.tsx` (generated)
- Create: `client/src/components/ui/button.test.tsx`

**Interfaces:**
- Consumes: `cn()` from Task 2.
- Produces: `Button`, `Input`, `Label`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` — every auth page (Tasks 7–11) imports these from `@/components/ui/*`.

- [ ] **Step 1: Write the failing test**

`client/src/components/ui/button.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './button'

describe('Button', () => {
  it('renders its label and responds to clicks', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Sign in</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run it, check the result**

Run: `pnpm -C client test`
`button.tsx` already exists (Task 2's `shadcn init` artifact), so this may
already PASS rather than fail — that's fine, it means Task 2's generated
Button already satisfies this interface; the test now locks that behavior
in rather than driving new code. If it fails, treat the failure output as
the real RED step and fix `button.tsx` in Step 3 alongside adding the
other components.

- [ ] **Step 3: Add the remaining components via the shadcn CLI**

Run:
```bash
cd ~/Documents/chapters/client
pnpm dlx shadcn@latest add @shadcn/input @shadcn/label @shadcn/card
```
Expected: writes `src/components/ui/input.tsx`, `label.tsx`, and `card.tsx`.
`button.tsx` already exists from Task 2 (a `radix-nova`-preset artifact of
running `shadcn init`) — check it against what a fresh `shadcn add button`
would generate rather than re-adding it blindly; if they match, leave it,
if not, regenerate it. Task 2 established the `radix-nova` preset, which
ships Radix via the consolidated `radix-ui` meta-package (Task 2's
`button.tsx` already imports `{ Slot } from 'radix-ui'`), **not** the
scoped `@radix-ui/react-slot`/`@radix-ui/react-label` packages — expect
`class-variance-authority` and possibly a `label.tsx`-specific Radix import
from the same `radix-ui` package, not new scoped-package entries in
`client/package.json`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm -C client test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "Add shadcn Button/Input/Label/Card primitives"
```

---

### Task 4: Typed API client (`apiFetch` + `ApiError`)

**Files:**
- Create: `client/src/lib/api.ts`
- Create: `client/src/lib/api.test.ts`

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number; body: unknown }`
  - `function apiFetch<T>(path: string, init?: RequestInit): Promise<T>` — prefixes `path` with `/api`, sends `credentials: 'include'`, JSON content type, throws `ApiError` on a non-2xx response.
  - `function mockJsonResponse(status: number, body: unknown): Response` (test-only helper, exported for reuse by Task 5+).

- [ ] **Step 1: Write the failing tests**

`client/src/lib/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, ApiError, mockJsonResponse } from './api'

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefixes the path with /api and includes credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await apiFetch<{ ok: boolean }>('/me')

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('throws ApiError with the parsed body on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })),
    )

    await expect(apiFetch('/login', { method: 'POST' })).rejects.toMatchObject({
      status: 401,
      body: { error: 'invalid credentials' },
    })
  })

  it('ApiError.message falls back to the parsed error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'invalid setup token' })),
    )

    try {
      await apiFetch('/setup', { method: 'POST' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toBe('invalid setup token')
    }
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./api` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/lib/api.ts`:
```ts
export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${status})`
    super(message)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = await res.json().catch(() => undefined)
  if (!res.ok) throw new ApiError(res.status, body)
  return body as T
}

/** Test-only helper: builds a real Response for stubbed fetch calls. */
export function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm -C client test`
Expected: 3 tests pass.

- [ ] **Step 5: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.ts client/src/lib/api.test.ts
git commit -m "Add typed apiFetch client with ApiError"
```

---

### Task 5: Auth API functions

**Files:**
- Create: `client/src/api/auth.ts`
- Create: `client/src/api/auth.test.ts`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `mockJsonResponse` from Task 4.
- Produces (all from `client/src/api/auth.ts`, consumed by Tasks 6–12):
  - `interface SessionUser { id: string; email: string; status: string; role: 'member' | 'admin'; createdAt: string }`
  - `function getSession(): Promise<SessionUser>`
  - `function setupInstance(input: { token: string; email: string; password: string }): Promise<{ id: string }>`
  - `function signup(input: { email: string; password: string }): Promise<{ status: 'pending_approval' }>`
  - `function verifyEmail(input: { email: string; code: string }): Promise<{ status: 'verified' }>`
  - `interface LoginInput { email: string; password: string; totp?: string }`
  - `interface LoginResult { id: string; email: string; role: 'member' | 'admin' }`
  - `function login(input: LoginInput): Promise<LoginResult>`
  - `function logout(): Promise<{ status: 'logged_out' }>`
  - `function requestPasswordReset(email: string): Promise<{ status: 'ok' }>`
  - `function resetPassword(token: string, password: string): Promise<{ status: 'password_updated' }>`
  - `function isMfaRequired(err: unknown): boolean` — true when `err` is an `ApiError` whose body has `mfaRequired: true`.

- [ ] **Step 1: Write the failing tests**

`client/src/api/auth.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockJsonResponse } from '../lib/api'
import {
  getSession,
  isMfaRequired,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
  setupInstance,
  signup,
  verifyEmail,
} from './auth'

describe('auth api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getSession calls GET /api/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }))
    vi.stubGlobal('fetch', fetchMock)

    const session = await getSession()

    expect(session.email).toBe('a@b.com')
    expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'include' }))
  })

  it('setupInstance posts to /api/setup with the token/email/password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'admin-1' }))
    vi.stubGlobal('fetch', fetchMock)

    await setupInstance({ token: 't', email: 'a@b.com', password: 'password123' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/setup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 't', email: 'a@b.com', password: 'password123' }),
      }),
    )
  })

  it('signup posts to /api/signup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'pending_approval' })))
    const result = await signup({ email: 'a@b.com', password: 'password123' })
    expect(result.status).toBe('pending_approval')
  })

  it('verifyEmail posts to /api/verify-email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    const result = await verifyEmail({ email: 'a@b.com', code: '123456' })
    expect(result.status).toBe('verified')
  })

  it('login posts to /api/login and returns the session shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' })),
    )
    const result = await login({ email: 'a@b.com', password: 'password123' })
    expect(result).toEqual({ id: 'u1', email: 'a@b.com', role: 'member' })
  })

  it('logout posts to /api/logout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'logged_out' })))
    const result = await logout()
    expect(result.status).toBe('logged_out')
  })

  it('requestPasswordReset posts to /api/request-password-reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'ok' })))
    const result = await requestPasswordReset('a@b.com')
    expect(result.status).toBe('ok')
  })

  it('resetPassword posts to /api/reset-password', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'password_updated' })))
    const result = await resetPassword('tok', 'newpassword123')
    expect(result.status).toBe('password_updated')
  })

  it('isMfaRequired reads the mfaRequired flag off a failed login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'totp code required', mfaRequired: true })),
    )
    try {
      await login({ email: 'a@b.com', password: 'password123' })
      expect.unreachable()
    } catch (err) {
      expect(isMfaRequired(err)).toBe(true)
    }
  })

  it('isMfaRequired is false for a plain invalid-credentials error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })))
    try {
      await login({ email: 'a@b.com', password: 'wrong' })
      expect.unreachable()
    } catch (err) {
      expect(isMfaRequired(err)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./auth` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/api/auth.ts`:
```ts
import { apiFetch, ApiError } from '../lib/api.js'

export interface SessionUser {
  id: string
  email: string
  status: string
  role: 'member' | 'admin'
  createdAt: string
}

export function getSession(): Promise<SessionUser> {
  return apiFetch<SessionUser>('/me')
}

export interface SetupInput {
  token: string
  email: string
  password: string
}

export function setupInstance(input: SetupInput): Promise<{ id: string }> {
  return apiFetch('/setup', { method: 'POST', body: JSON.stringify(input) })
}

export interface SignupInput {
  email: string
  password: string
}

export function signup(input: SignupInput): Promise<{ status: 'pending_approval' }> {
  return apiFetch('/signup', { method: 'POST', body: JSON.stringify(input) })
}

export interface VerifyEmailInput {
  email: string
  code: string
}

export function verifyEmail(input: VerifyEmailInput): Promise<{ status: 'verified' }> {
  return apiFetch('/verify-email', { method: 'POST', body: JSON.stringify(input) })
}

export interface LoginInput {
  email: string
  password: string
  totp?: string
}

export interface LoginResult {
  id: string
  email: string
  role: 'member' | 'admin'
}

export function login(input: LoginInput): Promise<LoginResult> {
  return apiFetch('/login', { method: 'POST', body: JSON.stringify(input) })
}

export function logout(): Promise<{ status: 'logged_out' }> {
  return apiFetch('/logout', { method: 'POST' })
}

export function requestPasswordReset(email: string): Promise<{ status: 'ok' }> {
  return apiFetch('/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) })
}

export function resetPassword(token: string, password: string): Promise<{ status: 'password_updated' }> {
  return apiFetch('/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) })
}

/** True when a failed login's response is an MFA challenge, not a hard rejection. */
export function isMfaRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === 'object' &&
    err.body !== null &&
    'mfaRequired' in err.body &&
    (err.body as { mfaRequired: unknown }).mfaRequired === true
  )
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass (11 tests across `api.test.ts` + `auth.test.ts`).

- [ ] **Step 5: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/
git commit -m "Add typed auth API functions"
```

---

### Task 6: TanStack Query provider + `useSession` hook

**Files:**
- Create: `client/src/hooks/useSession.ts`
- Create: `client/src/hooks/useSession.test.tsx`
- Modify: `client/src/App.tsx` (wraps children in `QueryClientProvider`)
- Modify: `client/src/App.test.tsx`

**Interfaces:**
- Consumes: `getSession` from Task 5.
- Produces: `function useSession(): UseQueryResult<SessionUser, ApiError>` — Task 7's `RequireAuth` and every later page's "am I logged in" check use this. Query key is the literal `['session']` — Tasks 9 (login) and 12 (logout) invalidate this exact key.

- [ ] **Step 1: Write the failing test**

`client/src/hooks/useSession.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { useSession } from './useSession'

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('useSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves the current session on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )

    const { result } = renderHook(() => useSession(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.email).toBe('a@b.com')
  })

  it('is an error when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    const { result } = renderHook(() => useSession(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./useSession` doesn't exist yet.

- [ ] **Step 3: Implement the hook**

`client/src/hooks/useSession.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { getSession } from '../api/auth.js'
import type { ApiError } from '../lib/api.js'
import type { SessionUser } from '../api/auth.js'

export const SESSION_QUERY_KEY = ['session'] as const

export function useSession() {
  return useQuery<SessionUser, ApiError>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: getSession,
    retry: false,
  })
}
```

- [ ] **Step 4: Wire up `QueryClientProvider` in `App`**

`client/src/App.tsx`:
```tsx
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
```

`client/src/App.test.tsx` — the existing test still renders `App` directly, no change needed to the assertion, but confirm it still passes since `QueryClientProvider` wrapping doesn't change the rendered text.

- [ ] **Step 5: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/ client/src/App.tsx
git commit -m "Add QueryClientProvider and useSession hook"
```

---

### Task 7: Router + `RequireAuth` + placeholder home page

**Files:**
- Create: `client/src/router.tsx`
- Create: `client/src/pages/HomePage.tsx`
- Create: `client/src/pages/HomePage.test.tsx`
- Create: `client/src/components/RequireAuth.tsx`
- Create: `client/src/components/RequireAuth.test.tsx`
- Modify: `client/src/App.tsx` (renders `RouterProvider` instead of the static wordmark)
- Modify: `client/src/App.test.tsx`

**Interfaces:**
- Consumes: `useSession` from Task 6.
- Produces:
  - `RequireAuth` — a route element; renders `<Outlet />` when `useSession()` succeeds, redirects to `/login` otherwise. Tasks 8–12 add their routes to `router.tsx`'s `children` array alongside this pattern.
  - `router` — the `createBrowserRouter` instance exported from `client/src/router.tsx`.

- [ ] **Step 1: Write the failing tests**

`client/src/components/RequireAuth.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { RequireAuth } from './RequireAuth'

function renderWithRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      {
        element: <RequireAuth />,
        children: [{ path: '/', element: <div>Protected content</div> }],
      },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RequireAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the protected route when the session resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'a@b.com', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )

    renderWithRouter('/')

    await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument())
  })

  it('redirects to /login when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    renderWithRouter('/')

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })
})
```

`client/src/pages/HomePage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from '../lib/api'
import { HomePage } from './HomePage'

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("greets the logged-in user's email", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <HomePage />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./RequireAuth` and `./HomePage` don't exist yet.

- [ ] **Step 3: Implement**

`client/src/components/RequireAuth.tsx`:
```tsx
import { Navigate, Outlet } from 'react-router'
import { useSession } from '../hooks/useSession.js'

export function RequireAuth() {
  const session = useSession()

  if (session.isPending) return null
  if (session.isError) return <Navigate to="/login" replace />
  return <Outlet />
}
```

`client/src/pages/HomePage.tsx`:
```tsx
import { useSession } from '../hooks/useSession.js'

export function HomePage() {
  const session = useSession()

  return (
    <div className="p-8">
      <p className="font-display text-2xl">Chapters</p>
      {session.data && <p className="text-muted-foreground">{session.data.email}</p>}
    </div>
  )
}
```

`client/src/router.tsx`:
```tsx
import { createBrowserRouter } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <HomePage /> }],
  },
  { path: '/login', element: <div>Login page (Task 10)</div> },
])
```

`client/src/App.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { router } from './router.js'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
```

`client/src/App.test.tsx` — replace the old direct-render assertion, since `App` now renders whatever route the browser's real location resolves to (jsdom defaults to `/`), which redirects unauthenticated. Assert the safe, always-true behavior instead:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from './lib/api'
import App from './App'

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects to the login page when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    render(<App />)

    await waitFor(() => expect(screen.getByText('Login page (Task 10)')).toBeInTheDocument())
  })
})
```

- [ ] **Step 4: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 5: Typecheck and build**

Run:
```bash
pnpm -C client typecheck
pnpm -C client build
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "Add router, RequireAuth guard, and placeholder HomePage"
```

---

### Task 8: SetupPage (one-time instance bootstrap)

**Files:**
- Create: `client/src/pages/auth/SetupPage.tsx`
- Create: `client/src/pages/auth/SetupPage.test.tsx`
- Modify: `client/src/router.tsx`

**Interfaces:**
- Consumes: `setupInstance` from Task 5, `SESSION_QUERY_KEY` from Task 6.
- Produces: route `/setup`.

- [ ] **Step 1: Write the failing tests**

`client/src/pages/auth/SetupPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { SetupPage } from './SetupPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/setup', element: <SetupPage /> },
      { path: '/', element: <div>Home</div> },
    ],
    { initialEntries: ['/setup'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SetupPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits the setup token/email/password and navigates home on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'admin-1' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'the-setup-token')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
  })

  it('shows an error when the token is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(403, { error: 'invalid setup token' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'wrong-token')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText('invalid setup token')).toBeInTheDocument())
  })

  it('shows a specific message when setup is already complete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(404, { error: 'setup is not available' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Setup token'), 'tok')
    await user.type(screen.getByLabelText('Email'), 'admin@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Create admin account' }))

    await waitFor(() => expect(screen.getByText(/this instance is already set up/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./SetupPage` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/pages/auth/SetupPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { setupInstance } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'
import { SESSION_QUERY_KEY } from '../../hooks/useSession.js'

export function SetupPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [alreadySetUp, setAlreadySetUp] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setAlreadySetUp(false)
    setSubmitting(true)
    try {
      await setupInstance({ token, email, password })
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAlreadySetUp(true)
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Set up Chapters</CardTitle>
        </CardHeader>
        <CardContent>
          {alreadySetUp ? (
            <p className="text-sm text-muted-foreground">
              This instance is already set up. Go to <a href="/login" className="text-primary underline">login</a>.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-token">Setup token</Label>
                <Input id="setup-token" value={token} onChange={(e) => setToken(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-email">Email</Label>
                <Input id="setup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-password">Password</Label>
                <Input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Create admin account
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

Note: `Input`/`Label` need `htmlFor`/`id` pairing for
`screen.getByLabelText` to work — shadcn's generated `Label` renders a
native `<label>`, so this works without extra wiring.

- [ ] **Step 4: Add the route**

`client/src/router.tsx`:
```tsx
import { createBrowserRouter } from 'react-router'
import { RequireAuth } from './components/RequireAuth.js'
import { HomePage } from './pages/HomePage.js'
import { SetupPage } from './pages/auth/SetupPage.js'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <HomePage /> }],
  },
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <div>Login page (Task 10)</div> },
])
```

- [ ] **Step 5: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/
git commit -m "Add SetupPage"
```

---

### Task 9: SignupPage + VerifyEmailPage

**Files:**
- Create: `client/src/pages/auth/SignupPage.tsx`
- Create: `client/src/pages/auth/SignupPage.test.tsx`
- Create: `client/src/pages/auth/VerifyEmailPage.tsx`
- Create: `client/src/pages/auth/VerifyEmailPage.test.tsx`
- Modify: `client/src/router.tsx`

**Interfaces:**
- Consumes: `signup`, `verifyEmail` from Task 5.
- Produces: routes `/signup`, `/verify-email`. `SignupPage` navigates to `/verify-email` with the submitted email in router state (`location.state.email`); `VerifyEmailPage` pre-fills from that state if present, otherwise shows an editable email field.

- [ ] **Step 1: Write the failing tests**

`client/src/pages/auth/SignupPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { SignupPage } from './SignupPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/signup', element: <SignupPage /> },
      { path: '/verify-email', element: <div>Verify email page</div> },
    ],
    { initialEntries: ['/signup'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('SignupPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits and navigates to verify-email on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'pending_approval' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'a-strong-password')
    await user.click(screen.getByRole('button', { name: 'Sign up' }))

    await waitFor(() => expect(screen.getByText('Verify email page')).toBeInTheDocument())
  })
})
```

`client/src/pages/auth/VerifyEmailPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { VerifyEmailPage } from './VerifyEmailPage'

function renderPage(state?: { email: string }) {
  const router = createMemoryRouter(
    [
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [{ pathname: '/verify-email', state }] },
  )
  render(<RouterProvider router={router} />)
}

describe('VerifyEmailPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pre-fills the email from router state and submits the code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'verified' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com')
    await user.type(screen.getByLabelText('Verification code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByText(/verified/i)).toBeInTheDocument())
  })

  it('shows an error for an invalid code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(400, { error: 'invalid code' })))
    renderPage({ email: 'new@example.com' })
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Verification code'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(screen.getByText('invalid code')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — neither page exists yet.

- [ ] **Step 3: Implement**

`client/src/pages/auth/SignupPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { signup } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function SignupPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signup({ email, password })
      navigate('/verify-email', { state: { email } })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Create an account</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-email">Email</Label>
              <Input id="signup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-password">Password</Label>
              <Input
                id="signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting}>
              Sign up
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

`client/src/pages/auth/VerifyEmailPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { verifyEmail } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function VerifyEmailPage() {
  const location = useLocation()
  const initialEmail = (location.state as { email?: string } | null)?.email ?? ''
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await verifyEmail({ email, code })
      setVerified(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Verify your email</CardTitle>
        </CardHeader>
        <CardContent>
          {verified ? (
            <p className="text-sm text-muted-foreground">
              Email verified. An admin needs to approve your account before you can log in.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="verify-email">Email</Label>
                <Input id="verify-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="verify-code">Verification code</Label>
                <Input id="verify-code" value={code} onChange={(e) => setCode(e.target.value)} required />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Verify
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Add the routes**

`client/src/router.tsx` — add two entries:
```tsx
  { path: '/signup', element: <SignupPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
```
with the corresponding imports (`SignupPage` from `./pages/auth/SignupPage.js`, `VerifyEmailPage` from `./pages/auth/VerifyEmailPage.js`) added alongside the existing ones.

- [ ] **Step 5: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/
git commit -m "Add SignupPage and VerifyEmailPage"
```

---

### Task 10: LoginPage (with inline MFA challenge)

**Files:**
- Create: `client/src/pages/auth/LoginPage.tsx`
- Create: `client/src/pages/auth/LoginPage.test.tsx`
- Modify: `client/src/router.tsx` (replace the Task 6/7 placeholder `/login` route)

**Interfaces:**
- Consumes: `login`, `isMfaRequired` from Task 5, `SESSION_QUERY_KEY` from Task 6.
- Produces: route `/login`, replacing the placeholder.

- [ ] **Step 1: Write the failing tests**

`client/src/pages/auth/LoginPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { LoginPage } from './LoginPage'

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/', element: <div>Home</div> },
    ],
    { initialEntries: ['/login'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in and navigates home on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' })),
    )
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
  })

  it('shows an error for invalid credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'invalid credentials' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await waitFor(() => expect(screen.getByText('invalid credentials')).toBeInTheDocument())
  })

  it('shows an inline TOTP field when MFA is required, then completes login', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse(401, { error: 'totp code required', mfaRequired: true }))
      .mockResolvedValueOnce(mockJsonResponse(200, { id: 'u1', email: 'a@b.com', role: 'member' }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    const totpField = await screen.findByLabelText('Authentication code')
    await user.type(totpField, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify code' }))

    await waitFor(() => expect(screen.getByText('Home')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/login',
      expect.objectContaining({
        body: JSON.stringify({ email: 'a@b.com', password: 'password123', totp: '123456' }),
      }),
    )
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — `./LoginPage` doesn't exist yet.

- [ ] **Step 3: Implement**

`client/src/pages/auth/LoginPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { isMfaRequired, login } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'
import { SESSION_QUERY_KEY } from '../../hooks/useSession.js'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [mfaChallenge, setMfaChallenge] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function attemptLogin(withTotp: boolean) {
    setError(null)
    setSubmitting(true)
    try {
      await login({ email, password, totp: withTotp ? totp : undefined })
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
      navigate('/')
    } catch (err) {
      if (isMfaRequired(err)) {
        setMfaChallenge(true)
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault()
    void attemptLogin(false)
  }

  function handleTotpSubmit(e: FormEvent) {
    e.preventDefault()
    void attemptLogin(true)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Log in</CardTitle>
        </CardHeader>
        <CardContent>
          {mfaChallenge ? (
            <form onSubmit={handleTotpSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-totp">Authentication code</Label>
                <Input id="login-totp" value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Verify code
              </Button>
            </form>
          ) : (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                Log in
              </Button>
              <a href="/forgot-password" className="text-center text-sm text-muted-foreground underline">
                Forgot your password?
              </a>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Replace the placeholder route**

`client/src/router.tsx` — replace `{ path: '/login', element: <div>Login page (Task 10)</div> }` with:
```tsx
  { path: '/login', element: <LoginPage /> },
```
adding `import { LoginPage } from './pages/auth/LoginPage.js'` alongside the other imports.

- [ ] **Step 5: Update tests that depended on the old placeholder text**

`client/src/App.test.tsx` and `client/src/components/RequireAuth.test.tsx` asserted on the literal text `'Login page (Task 10)'` or `'Login page'` for the *standalone* router fixtures they build themselves — `RequireAuth.test.tsx` builds its own `createMemoryRouter` with an inline `{ path: '/login', element: <div>Login page</div> }`, so it's unaffected. `App.test.tsx` renders the *real* `router` from `client/src/router.tsx`, which now renders the real `LoginPage` — update its assertion:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { mockJsonResponse } from './lib/api'
import App from './App'

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redirects to the login page when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(401, { error: 'unauthorized' })))

    render(<App />)

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument())
  })
})
```

- [ ] **Step 6: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 7: Typecheck and build**

Run:
```bash
pnpm -C client typecheck
pnpm -C client build
```
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add client/src/
git commit -m "Add LoginPage with inline MFA challenge"
```

---

### Task 11: RequestPasswordResetPage + ResetPasswordPage

**Files:**
- Create: `client/src/pages/auth/RequestPasswordResetPage.tsx`
- Create: `client/src/pages/auth/RequestPasswordResetPage.test.tsx`
- Create: `client/src/pages/auth/ResetPasswordPage.tsx`
- Create: `client/src/pages/auth/ResetPasswordPage.test.tsx`
- Modify: `client/src/router.tsx`

**Interfaces:**
- Consumes: `requestPasswordReset`, `resetPassword` from Task 5.
- Produces: routes `/forgot-password`, `/reset-password`. `ResetPasswordPage` reads the token from the `?token=` query parameter.

- [ ] **Step 1: Write the failing tests**

`client/src/pages/auth/RequestPasswordResetPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { RequestPasswordResetPage } from './RequestPasswordResetPage'

function renderPage() {
  const router = createMemoryRouter([{ path: '/forgot-password', element: <RequestPasswordResetPage /> }], {
    initialEntries: ['/forgot-password'],
  })
  render(<RouterProvider router={router} />)
}

describe('RequestPasswordResetPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('always shows the same confirmation message (anti-enumeration)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'ok' })))
    renderPage()
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Email'), 'a@b.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    await waitFor(() =>
      expect(screen.getByText(/if an account exists for that email/i)).toBeInTheDocument(),
    )
  })
})
```

`client/src/pages/auth/ResetPasswordPage.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../../lib/api'
import { ResetPasswordPage } from './ResetPasswordPage'

function renderPage(initialPath: string) {
  const router = createMemoryRouter(
    [
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
}

describe('ResetPasswordPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the token from the query string and submits a new password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(200, { status: 'password_updated' }))
    vi.stubGlobal('fetch', fetchMock)
    renderPage('/reset-password?token=abc123')
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('New password'), 'a-new-strong-password')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/reset-password',
      expect.objectContaining({
        body: JSON.stringify({ token: 'abc123', password: 'a-new-strong-password' }),
      }),
    )
  })

  it('shows an error for an invalid or expired token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(400, { error: 'invalid or expired token' })))
    renderPage('/reset-password?token=expired')
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('New password'), 'a-new-strong-password')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    await waitFor(() => expect(screen.getByText('invalid or expired token')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — neither page exists yet.

- [ ] **Step 3: Implement**

`client/src/pages/auth/RequestPasswordResetPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { requestPasswordReset } from '../../api/auth.js'

export function RequestPasswordResetPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await requestPasswordReset(email)
    } finally {
      // Always show the same confirmation, success or failure — no enumeration.
      setSubmitted(true)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Reset your password</CardTitle>
        </CardHeader>
        <CardContent>
          {submitted ? (
            <p className="text-sm text-muted-foreground">
              If an account exists for that email, a reset link is on its way.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reset-request-email">Email</Label>
                <Input
                  id="reset-request-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={submitting}>
                Send reset link
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

`client/src/pages/auth/ResetPasswordPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { resetPassword } from '../../api/auth.js'
import { ApiError } from '../../lib/api.js'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await resetPassword(token, password)
      navigate('/login')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Choose a new password</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting}>
              Reset password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Add the routes**

`client/src/router.tsx` — add, with matching imports:
```tsx
  { path: '/forgot-password', element: <RequestPasswordResetPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
```

- [ ] **Step 5: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C client typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add client/src/
git commit -m "Add password reset request/confirm pages"
```

---

### Task 12: Logout action on HomePage

**Files:**
- Modify: `client/src/pages/HomePage.tsx`
- Modify: `client/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: `logout` from Task 5, `SESSION_QUERY_KEY` from Task 6.

- [ ] **Step 1: Write the failing test**

`client/src/pages/HomePage.test.tsx` — add a second test alongside the existing one:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { mockJsonResponse } from '../lib/api'
import { HomePage } from './HomePage'

function renderWithRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: <HomePage /> },
      { path: '/login', element: <div>Login page</div> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('HomePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("greets the logged-in user's email", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      ),
    )
    renderWithRouter()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
  })

  it('logs out and navigates to /login', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/logout') return Promise.resolve(mockJsonResponse(200, { status: 'logged_out' }))
      return Promise.resolve(
        mockJsonResponse(200, { id: 'u1', email: 'taha@piiix.org', status: 'active', role: 'member', createdAt: '2026-01-01' }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithRouter()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('taha@piiix.org')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm -C client test`
Expected: FAIL — no "Log out" button exists yet.

- [ ] **Step 3: Implement**

`client/src/pages/HomePage.tsx`:
```tsx
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Button } from '../components/ui/button.js'
import { useSession, SESSION_QUERY_KEY } from '../hooks/useSession.js'
import { logout } from '../api/auth.js'

export function HomePage() {
  const session = useSession()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  async function handleLogout() {
    await logout()
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-8 py-4">
        <span className="font-display text-xl">Chapters</span>
        {session.data && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{session.data.email}</span>
            <Button variant="secondary" onClick={() => void handleLogout()}>
              Log out
            </Button>
          </div>
        )}
      </header>
      <main className="flex-1 p-8">
        <p className="text-muted-foreground">The rest of Chapters is under construction.</p>
      </main>
    </div>
  )
}
```

- [ ] **Step 4: Run all tests, verify they pass**

Run: `pnpm -C client test`
Expected: all pass.

- [ ] **Step 5: Typecheck and build**

Run:
```bash
pnpm -C client typecheck
pnpm -C client build
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/
git commit -m "Add logout action to HomePage"
```

---

### Task 13: Root config wiring, docs, final verification

**Files:**
- Modify: `eslint.config.mjs` (React lint rules scoped to `client/**`)
- Modify: `README.md` ("Running it" section)
- Modify: `docs/agents/STATE.md`

**Interfaces:** none — this task wires up cross-cutting config and docs, no new runtime code.

- [ ] **Step 1: Add React lint rules for `client/`**

`eslint.config.mjs`:
```js
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
  ...tseslint.configs.recommended,
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
)
```

Add the two new dev dependencies at the repo root (they lint `client/` but
aren't a runtime dependency of any package, so they belong in the root
`package.json`, matching where `typescript-eslint` itself already lives):

`package.json` (repo root) — add to `devDependencies`:
```json
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.3"
```

- [ ] **Step 2: Run the full root install and lint**

Run:
```bash
cd ~/Documents/chapters
pnpm install
pnpm lint
```
Expected: exit 0 — no findings across `server/` or `client/`.

- [ ] **Step 3: Run everything, end to end**

Run:
```bash
pnpm typecheck
pnpm -r test
pnpm -C client build
```
Expected: all exit 0.

- [ ] **Step 4: Update README.md**

Add a paragraph to the existing "Running it" section (after the Docker/
`.env.example` paragraph) in `README.md`:
```markdown

The frontend (`client/`) is a Vite + React app. In development, run the
API (`pnpm -C server dev`) and the frontend (`pnpm -C client dev`)
side by side — Vite proxies `/api/*` to the API on port 3000, so no CORS
configuration is needed locally. `pnpm -C client build` produces a static
`client/dist/` bundle to serve behind the same reverse proxy as the API in
production.
```

- [ ] **Step 5: Update STATE.md**

Read the current `docs/agents/STATE.md`, then replace its "Current task"
and "Next step" bullets to reflect that Slice 1 (Scaffold + Auth) is done
and Slice 2 (Editor) is next — keep the file under 40 lines total per its
own header instruction, trimming older detail if needed to make room.

- [ ] **Step 6: Commit**

```bash
git add eslint.config.mjs package.json pnpm-lock.yaml README.md docs/agents/STATE.md
git commit -m "Wire up client lint rules, update README and STATE.md"
```

---

## Self-Review

**Spec coverage:** every page in `2026-07-17-hosted-ui-structure-design.md`'s
Auth section (setup → signup → verify → approve → login → optional TOTP →
reset) has a task. MFA *enrollment* is explicitly out of scope (Global
Constraints) — it's Settings-page work, a later slice, not a gap. The
design system's fonts, colors, and `.dark` mode mechanism are wired into
Tailwind in Task 2. The ink-fade-decay and collaboration-cursor signature
interactions have no task here on purpose — neither the Graph page nor the
Editor exists yet; they're Slices 2 and 4.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code.

**Type consistency:** `SessionUser`, `LoginInput`, `LoginResult` are defined
once in Task 5 and imported (never redefined) everywhere else. `SESSION_QUERY_KEY`
is defined once in Task 6 and imported by Tasks 8, 10, 12 rather than each
task inventing its own `['session']` literal — checked against every task
above.
