# Dynamic Chunk Loading & Graph Viewport Framing Resolution Report

**Date**: 2026-10-01  
**Scope**: Targeted full-stack remediation resolving dynamic route chunk loading failures on active server deployments (Issue #327) and graph visualizer viewport framing, panel ergonomics, and control collisions (Issue #328).  
**Outcome**: Root causes diagnosed and remediated with zero regressions. All 1,293 automated tests passing (900 client, 393 server across 188 test files). Merged into `dev` via PR #329 and promoted to `prod` via PR #330.

---

## 1. Anomalies Discovered & Resolved

### Issue 1 (#327 - High): Dynamic Route Chunk Loading Failures & RouteErrorBoundary Crashes
- **Symptom**: When navigating to `/vaults` (or any lazy-loaded route) on an active Chapters deployment after an update or rebuild, users encountered the `RouteErrorBoundary` ("Observatory Anomaly") with a syntax error (`SyntaxError: Unexpected token '<'`) or chunk import failure (`Failed to fetch dynamically imported module`). Clicking browser reload immediately resolved the issue.
- **Root Cause**:
  1. *Server Fallback Misclassification*: In `server/src/static.ts`, the SPA history fallback handler returned `index.html` (HTTP 200 with `text/html`) for *any* unhandled GET request that did not match `/api`, `/collab`, `/mcp`, or `/repositories`. When a client browser held a cached entry bundle requesting an outdated Vite chunk hash (e.g. `/assets/VaultsPage-OLD_HASH.js`), the server served `index.html` instead of HTTP 404. The browser then attempted to parse `<!doctype html>` as JavaScript, crashing the route.
  2. *Cache Retention on Entry Shell*: `index.html` lacked explicit no-cache headers, allowing intermediate proxies or browsers to cache entry chunks.
  3. *Client Recovery Absence*: Neither React Router nor Vite's module loader automatically recovered from stale chunk failures or network glitches during client-side route transitions.
- **Resolution**:
  1. **Static Assets 404 Guard** (`server/src/static.ts`): In `app.setNotFoundHandler`, any request under `/assets/*` returns HTTP `404 Not Found` if the file does not exist on disk, while preserving SPA history fallback for deep note routes (including those containing periods like `/vaults/:id/notes/my.note`).
  2. **Cache Header Hardening** (`server/src/static.ts`): Set `Cache-Control: no-cache, no-store, must-revalidate` on `index.html` (while keeping content-hashed `/assets/` files cached with `public, max-age=31536000, immutable`).
  3. **Vite Preload Error Handler** (`client/src/main.tsx`): Attached a global `window.addEventListener('vite:preloadError')` handler that checks `sessionStorage` (with a 10s debounce) to automatically force-reload the window and fetch fresh entry chunk hashes.
  4. **Resilient Lazy Route Wrapper** (`client/src/router.tsx`): Implemented `lazyRoute()` around all lazy-loaded route imports to catch module import rejections and trigger seamless reloads before error boundaries take over.
  5. **React Hook Purity Guard** (`client/src/components/ErrorBoundary.tsx`): Ensured `RouteErrorBoundary` encapsulates chunk reload side-effects within `useEffect` without mutating state during render cycles, fully compliant with React compiler and purity lint rules.

---

### Issue 2 (#328 - Medium/High): Graph Visualizer Viewport Framing & Panel Collisions
- **Symptom**: On initial canvas load and viewport resize, graph nodes were positioned directly behind the floating `COMMUNITIES` panel (left) or clipped by the `INSPECTOR` panel (right). Users could not close side panels once expanded, and header controls collided on viewports smaller than 1280px.
- **Root Cause**:
  1. *Centering Offset Blindness*: `fitToViewport()` in `client/src/components/graph/GraphCanvas.tsx` centered the d3 force simulation relative to the entire canvas width (`canvas.width`), ignoring overlapping floating side panels (Context panel at ~308px, Inspector at ~340px).
  2. *Static Initial Placement*: Camera transform snapped to static world center `(0, 0)` on mount before simulation forces had distributed the nodes, resulting in nodes clustering under left-hand cards.
  3. *Missing Panel Dismiss Trigger*: Floating panels in `client/src/components/shell/ShellPanels.tsx` lacked an accessible close button, requiring users to hunt for external triggers.
  4. *Header Control Density*: `StatsStrip` collided with `ScopePicker`, `Pathfinder`, and `ColorModeToggle` on medium tablet and small desktop widths (< 1280px).
- **Resolution**:
  1. **Unobstructed Viewport Centering** (`client/src/components/graph/GraphCanvas.tsx`): Implemented `getUnobstructedViewport()` calculating the actual visible bounds between the left shell rail/context drawer and right floating inspector.
  2. **Simulation Settle Auto-Fit** (`client/src/components/graph/GraphCanvas.tsx`): Automatically fits and recenters nodes within the unobstructed bounds when the simulation stabilizes (`sim.alpha() < sim.alphaMin()`), only if the user has not manually panned or zoomed (`hasUserInteractedRef.current`).
  3. **Dynamic Resize Observer & Panel Redraw**: Attached a `ResizeObserver` to the graph container and an effect on shell panel states (`isContextOpen`, `isInspectorOpen`, `isSidebarExpanded`) that automatically refits and redraws untinkered graphs.
  4. **Accessible Close Button** (`client/src/components/shell/ShellPanels.tsx`): Pinned a header bar across floating cards with panel title and an accessible `[X]` button calling `shell.setPanelOpen(kind, false)`.
  5. **Header De-Collision**: Applied `hidden xl:flex` to `StatsStrip` and `hidden md:inline` to `Pathfinder` text to maintain clean control spacing on all screen dimensions.

---

## 2. Verification & Metrics

- **Client Tests**: 135 / 135 test suites passed (900 / 900 tests, 100% green).
- **Server Tests**: 53 / 53 test suites passed (393 / 393 tests, 100% green).
- **Total Tests**: 1,293 automated tests passing across 188 files.
- **TypeScript**: 0 errors across workspace (`pnpm typecheck`).
- **ESLint**: 0 errors, 0 warnings (`pnpm lint`).
- **Bundle Budget**: Initial shell strictly under 300KB gzipped budget (`client/src/bundle.test.ts`).
- **Deployments**:
  - Pull Request #329 merged into `dev` (commit `039ff95`).
  - Pull Request #330 merged into `prod` (commit `80a208f`).
