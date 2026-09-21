# Chapters UI/UX Redesign Specification: Observatory Bridge

**Date:** 2026-09-21  
**Status:** Approved & Implemented (MVP Phase)  
**Authors:** PIIIX Engineering & Design Team via Antigravity (`/interface`)  
**Target Surface:** `chapters-app` (Tool-shaped desktop application, 16:10 baseline @ 1440×900)  
**Reference Runs:** `runs/chapters-app/`  

---

## 1. Executive Summary & Context

Chapters was originally built with a utilitarian, functional UI intended for internal alpha/beta testing of its core technical pillars:
1. Markdown + YAML OKF note tree with live CRDT collaboration (Yjs / Hocuspocus).
2. Canvas-based real-time 2D knowledge graph with physics controls and Louvain community clustering.
3. Git repository ingestion and AST symbol graph navigation.
4. Permission-scoped AI/MCP server endpoints with pgvector semantic similarity.

With Chapters transitioning from a beta testbed to daily in-house production dogfooding and approaching public MVP status, the user interface was systematically redesigned using the `/interface` art direction pipeline.

Following a 3-concept exploration (Observatory, Scriptorium, and Cockpit), the **"Observatory Bridge"** (Astrocognitive Command Console) was selected and approved at Gate A, refined with precision motion and DTCG token specifications at Gate B, and validated across a complete 10-component, 9-data-state interactive component sheet at Gate C.

---

## 2. Core Design Archetype: Observatory Bridge

The Observatory Bridge merges the optical instrument aesthetic of astronomical cartography with the high-throughput ergonomics of an aerospace mission deck:

- **Substrate & Depth:** Deep obsidian abyss (`#070A0F`), layered through raised console surfaces (`#0F141F`) and crisp interactive borders (`#1C2433`).
- **Secondary Mode:** Warm archival Vellum (`#F7F6F2` canvas, `#FFFFFF` cards, `#E5E2D9` borders) for long-form daylight research.
- **Visual Texture:** Subtle 24px celestial coordinate grids and hairline borders (`1px solid var(--border)`).
- **Spatial Hierarchy:** Fixed 52px left navigation rail, 44px top utility bar, 240px context tree / explorer track, dynamic center canvas/editor viewport, and 300px collapsible telemetry/inspector sidecar.

---

## 3. Strict Authorship Color Semantics (Non-Negotiable)

To preserve cognitive clarity between human agency and autonomous AI/MCP operations, authorship color assignment is strictly decoupled:

| Semantic Role | Dark Mode Token | Light Mode Token | Permitted Usage |
| :--- | :--- | :--- | :--- |
| **Human Primary** | `oklch(0.68 0.16 254)` / `#5B8DEF` | `oklch(0.55 0.18 254)` / `#2F6FE0` | Human navigation, manual actions, user cursor badges, active tool state. |
| **AI / MCP Accent** | `oklch(0.72 0.14 186)` / `#3FB8AE` | `oklch(0.52 0.14 186)` / `#1F7770` | MCP query highlights, AI semantic edges, vector similarity radar, agent status. **Never used for human actions.** |
| **Success / Connected**| `oklch(0.72 0.16 142)` / `#48C774` | `oklch(0.52 0.16 142)` / `#238636` | Real-time Yjs connection, Git sync success, webhook active. |
| **Warning / Divergent**| `oklch(0.78 0.15 75)` / `#E5A93C` | `oklch(0.58 0.16 75)` / `#B07219` | Offline mode, pending approval, conflict resolution banner. |
| **Destructive / Error**| `oklch(0.65 0.22 25)` / `#F25555` | `oklch(0.50 0.22 25)` / `#D73A49` | Note purge, share revocation, network drop, validation failure. |

> [!IMPORTANT]
> In `.dark`, `--primary-foreground` is set to `#070a0f` (dark obsidian). This guarantees WCAG AA contrast (≥ 4.5:1) when collaborator name tags are rendered on vibrant collaborator inks (ochre `#d9b24c`, vermillion `#f07a5a`, mint `#4ec9b0`).

---

## 4. Typography & Metrics

- **Primary Typeface:** `Geist Variable` (sans-serif), self-hosted via `@fontsource-variable/geist`.
- **Code & Telemetry:** `Geist Mono Variable` (monospace), self-hosted via `@fontsource-variable/geist-mono`.
- **Figures:** `font-variant-numeric: tabular-nums` enforced on all coordinates, timestamps, token counters, and telemetry pills.
- **Scale:**
  - Display Title: 20px / 24px line-height, semi-bold (600).
  - Section Heading: 14px / 18px line-height, medium (500), tracking `0.02em`.
  - Body Text: 13px / 19px line-height, regular (400).
  - Meta / Badges / Code: 11px / 15px line-height, mono regular/medium.

---

## 5. Component Sheet & 9 Data States

All 10 foundational component families were extracted and rendered in `runs/chapters-app/system/sheet.html` across all standard states (`Default`, `Hover`, `Focus-Visible`, `Active`, `Disabled`, `Error`, `Loading`) and the tool-shaped 9 data states:

1. **Empty State:** Illustrated empty constellations with direct primary action (`Cmd+N` create note / import repository).
2. **Loading State:** Skeleton coordinate lines with sub-second shimmer.
3. **Partial State:** Progressive community rendering on graph canvas while semantic vectors compute.
4. **Error State:** High-contrast error banner with inline retry trigger and detailed error code.
5. **Permission Denied State:** Read-only banner with badge displaying vault owner contact and request access workflow.
6. **Offline State:** Amber telemetry banner indicating local indexedDB cache is active; queues outgoing CRDT changes.
7. **Stale State:** Pulse indicator showing git background sync is behind remote HEAD with manual re-sync button.
8. **Conflict State:** Visual 3-way merge review for simultaneous non-CRDT file imports.
9. **Bulk State:** Multi-node selection chip displaying batch actions (tag, move, export, delete).

---

## 6. Motion & Performance Budgets

- **Motion Curve:** `cubic-bezier(0.16, 1, 0.3, 1)` (aerospace deceleration curve).
- **Durations:** Enter 240ms, Exit 160ms, Quick Micro-interaction 120ms.
- **Accessibility:** `@media (prefers-reduced-motion: reduce)` collapses all transitions to `0.01ms`.
- **Performance Tiers:**
  - **Tier 1 (Core Shell):** `client/src/index.css` compiled weight is `77.77 kB` (raw) and `13.72 kB` (gzipped), well within the 85 kB budget.
  - **Tier 2 (Heavy Canvas):** Graph physics and WebGL/Canvas rendering dynamically code-split into lazy chunks (<150 kB initial).

---

## 7. Verification & Test Suite

The redesign was verified with 100% green status across the entire automated test suite:
- **Test Files:** 120 passed (120/120)
- **Individual Tests:** 761 passed (761/761)
- **Accessibility:** 0 `vitest-axe` violations across all components, focus rings, dialogs, and navigation elements.
- **Bundle Integrity:** Verified initial shell gzip constraint via `src/bundle.test.ts`.

---

## 8. Artifact Locations

- Design System Tokens: `runs/chapters-app/tokens.json`
- Full Direction Spec: `runs/chapters-app/DIRECTION.md`
- Prototype Graph: `runs/chapters-app/prototypes/graph-observatory.html`
- Prototype Command Bridge: `runs/chapters-app/prototypes/command-bridge.html`
- Component State Sheet: `runs/chapters-app/system/sheet.html`
- Keyboard Walk Audit: `runs/chapters-app/system/keyboard-walk.md`
- Gap Audit Report: `runs/chapters-app/system/gaps.md`
- Live Review Gallery: `http://localhost:4321/`
