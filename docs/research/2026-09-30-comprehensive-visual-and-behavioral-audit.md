# Comprehensive Visual, Behavioral, and Interaction Platform Audit

**Date**: 2026-09-30  
**Branch**: `dev` (HEAD commit `2704d39`)  
**Target Environment**: Chapters Platform (React 19 + Vite 6 + Tailwind v4 + Fastify + Yjs + MCP)  
**Scope**: 135 High-Resolution CDP Artifacts, 16 Architectural Domains, 480+ DOM Controls, 6 Advanced Behavioral Suites (Concurrency, 1,000-Node Stress, 30k-Word KaTeX/Mermaid, Zero-Mouse a11y, Mobile Touch Heat Map, Drag-and-Drop Matrix, Network Chaos)  
**Quality Verification**: 133 Client Test Suites, 889 / 889 Client Tests Passing, 392 Server Tests Passing  
**Deliverables**: Interactive Report at `docs/visual-and-behavioral-audit-report.html` & Desktop Standalone `chapters-comprehensive-visual-audit.html`  

---

## 1. Executive Summary & Quality Scorecard

An exhaustive, pixel-level visual, layout, and behavioral audit of the Chapters web platform was performed using an automated Chrome DevTools Protocol (CDP) headless runner on Chromium alongside real-time interaction evaluation across all pages, drawers, modals, controls, and responsive breakpoints.

| Metric | Measured Value | Analysis & Status |
| :--- | :---: | :--- |
| **Total Screen Captures** | **135 PNG Captures** | High-res telemetry proofs in `chapters-audit-media/` |
| **Interactive HTML Deliverable** | **`docs/visual-and-behavioral-audit-report.html`** | Standalone dashboard with Defect Matrix & Lightbox |
| **Baseline Automated Tests** | **889 / 889 Passing** | 100% green Vitest component & unit tests |
| **Interactive Controls Audited** | **480+ Controls** | Every bar, button, toggle, dropdown, input & menu |
| **Graph Simulation Framerate** | **61 FPS Measured** | Hardware-accelerated canvas loop under 1,000+ nodes |
| **Mobile Touch Targets < 44px** | **38 of 39 Buttons (97.4%)** | Touch target size deficit on mobile screens |
| **Critical Defects Cataloged** | **4 Defects** | Rail occlusion, button overlap, mobile header collapse, 405 diff |
| **High Severity Defects** | **7 Defects** | UUID leaks, QR code absence, text truncation, touch target deficit, PDF drop syntax |
| **Medium / Polish Defects** | **9 Defects** | FileTree nesting clipping, draft debounce race, soft keyboard clearance, etc. |
| **Platform Visual Health Index** | **76 / 100** | Exceptional typography & tools; structural rail layout collision on content |

---

## 2. Advanced Testing Suites Telemetry & Findings

### Suite 1: Concurrency, Multi-Tab Sync & State Collisions
- **Multi-Tab Live Editing (`adv-01`, `adv-02`):** Simultaneous browser tabs editing `attention-mechanisms` verified Yjs CRDT session synchronization. Live stream edits in Tab A streamed cleanly into Tab B without desync or duplicate text.
- **Rapid Navigation Race Condition (`adv-03`, `DEF-20`):** Typing keystrokes into note editor and immediately navigating away (within 150ms before debounce save timer flushes) risks dropping unpersisted tail keystrokes upon component unmount.

### Suite 2: Extreme Data & Visual Stress
- **1,000+ Node Knowledge Graph (`adv-04`):** Canvas stress test verified an animation frame rate of **61 FPS** (`canvasWidth: 1440, canvasHeight: 813, dpr: 1`). Force simulation nodes scale without canvas freeze.
- **Massive 30,000-Word Document (`adv-05`):** Injected document with Maxwell field equations in KaTeX, topological Mermaid graphs, and 7-column wide benchmark tables. CodeMirror editor maintained fluid typing and line-wrapping without layout thrashing.
- **10-Level Deep Nested FileTree (`adv-06`, `DEF-19`):** Folders nested beyond 6 levels clip abruptly in the 240px sidebar without horizontal scrollbars or path tooltips.
- **RTL & Extreme Unicode Stress (`adv-07`):** Tested Persian/Arabic right-to-left text, rocket/galaxy emojis (`🚀 🛰️ 🛸 🪐 🌌`), and 200-character unbroken boundary strings. CodeMirror cursor tracking preserved character boundaries accurately.

### Suite 3: Keyboard-Only Zero-Mouse Navigation & Accessibility (a11y)
- **Zero-Mouse Flow (`adv-08`):** Tab key cycles through Rail navigation, ScopePicker, Search, and action triggers. Focus indicators render with clear outline rings.
- **Modal Focus Trapping (`adv-09`):** In `VaultSettingsModal`, Tab key focus correctly cycles through internal modal inputs and buttons without leaking focus into the background page.
- **Automated a11y DOM Audit (`adv-10`, `DEF-14`):** Highlighted multiple icon-only toolbar buttons lacking explicit `aria-label` tags.

### Suite 4: Real Mobile Touch & Virtual Soft Keyboard Ergonomics
- **Soft Keyboard Clearance (`adv-11`, `DEF-18`):** Simulating virtual keyboard popup reducing viewport height to 480px revealed that the active cursor line does not auto-scroll into the upper visible viewport, leaving bottom typing hidden beneath the keyboard.
- **Touch Target Size Heat Map (`adv-12`, `DEF-16`):** Scanned 39 interactive buttons on a 375px mobile screen: **38 out of 39 buttons measure under 44px** (averaging 26px to 32px height, e.g. "New vault" at 28px, filter pills at 26px).

### Suite 5: Drag-and-Drop & Clipboard Handling
- **PDF Document Drag & Drop (`adv-13`, `DEF-17`):** Dropping `261142.pdf` generates image markdown syntax `![Certificate of Origin...](...pdf)`. Browsers cannot render PDF binaries in `<img>` tags, resulting in broken image icons in note preview.
- **Rich Web HTML Paste (`adv-14`):** Pasting formatted web articles with blockquotes and markdown links formats cleanly into native markdown.
- **System Clipboard Image Paste (`adv-15`):** Pasting PNG screenshot binary blobs from system clipboard cleanly generates asset links.

### Suite 6: Network Chaos & Error Boundaries
- **Offline Simulation (`adv-16`):** Throttling network to 0kb/s offline verified local caching and offline status warning banner.
- **Slow 3G Simulation (`adv-17`):** Throttling network with 2000ms latency verified button click debouncing and loading spinner states.
- **API 500 Error Boundary (`adv-18`):** Simulated 500 Internal Server Error verified that the error boundary banner renders gracefully with a "Retry Request" trigger instead of crashing the entire React tree.

---

## 3. Complete Master Defect Catalog (20 Defects)

### Critical Severity
1. **DEF-01: Structural Layout Occlusion (Shell Rail vs `<main>` Workspace)** (`Rail.tsx` & `AppShell.tsx:71`) — Rail occludes the left 90–180px of page content on `/vaults`, `/repos`, and `/team`. In `/vaults`, the search bar and first card column are partially obscured. In the Editor workspace, the rail physically cuts note names in the FileTree in half.
2. **DEF-02: Top Bar Button & Badge Collision in Repository Code Viewer** (`repos/$id/files/$.tsx:112`) — Green `• SYNCED` status pill is absolutely positioned directly over the "Connect a repository" button, cutting off the button and preventing clicks.
3. **DEF-03: Mobile Viewport (375px) Layout Breakdown & Header Overflow** (`AppShell.tsx` & `VaultHeader.tsx`) — Desktop rail does not collapse on mobile; top bar squeezes 6–7 buttons into 320px, truncating vault titles to `VA...` and search overflowing screen.
4. **DEF-04: Mock Server HTTP 405 (Method Not Allowed) on Revision Diff Preview** (`RevisionDiffModal.tsx` vs `server.mjs:160`) — Previewing historical revisions crashes with HTTP 405 because mock server omitted `get('/vaults/:id/revisions/:revisionId')`.

### High Severity
5. **DEF-05: Raw Backend UUIDs Rendered in Repository Share List** (`RepositorySettingsDialog.tsx:142`) — Shared members list renders raw `granteeId` UUIDs instead of user names/emails.
6. **DEF-06: Two-Factor Authentication (TOTP) Setup Missing Visual QR Code** (`settings/index.tsx:280`) — Only text URI and raw base32 secret displayed; no visual QR code for mobile camera scanning.
7. **DEF-07: Action Button Text Truncation in MCP Tokens Table** (`settings/index.tsx:410`) — Table action button is clipped to `Rev` instead of `Revoke` due to column boundaries.
8. **DEF-08: Duplicate Overlapping "OFFLINE" Badge on Mobile Note Editor** (`NoteEditor.tsx:88`) — Renders twice simultaneously on mobile, directly colliding with warning text.
9. **DEF-09: Non-Dismissing Colliding Popovers** (`AppShell.tsx:112`) — Clicking Notification Bell fails to auto-dismiss active Scope Picker, causing overlapping dropdowns.
10. **DEF-16: Mobile Touch Target Size Deficit** (`VaultHeader.tsx` & `button.tsx`) — 38 out of 39 mobile interactive buttons measure under the 44x44px minimum touch target standard (averaging 26px to 32px).
11. **DEF-17: PDF File Drop Image Tag Generation** (`imageDecorations.ts:138`) — Dropping PDF documents inserts `![name](...pdf)` syntax which produces broken image icons instead of document links.

### Medium Severity & Polish
12. **DEF-10: Synthetic Click Event Failure on Radix UI Tabs** (`admin/index.tsx:64`) — Radix tabs swallow synthetic JS click events, requiring hardware pointer events.
13. **DEF-11: Concept Pathfinding UI Unexposed in Graph Visualizer** (`GraphControls.tsx:42`) — `find_graph_path` backend tool is not exposed in the visual canvas UI.
14. **DEF-12: Wikilink Autocomplete Dropdown Bounds Clipping** (`WikilinkExtension.ts`) — Autocomplete popup renders off-screen without auto-flipping upward when typing near the bottom.
15. **DEF-13: Missing Confirmation Guard on Vault Deletion in Settings Modal** (`VaultSettingsDialog.tsx:190`) — Destructive delete button executes immediately without requiring the user to type the vault title to confirm.
16. **DEF-14: Icon-Only Buttons Lacking `aria-label` Attributes** (`NoteRichToolbar.tsx`) — Toolbar icon buttons announce generic "button" to screen readers.
17. **DEF-15: Tag Filter Empty State in Vault Browser** (`vaults/$id/index.tsx:180`) — Blank screen when 0 notes match tag filter without guidance or clear filter button.
18. **DEF-18: Soft Keyboard Viewport Clipping** (`NoteEditor.tsx`) — Virtual keyboard on mobile obscures the active cursor line without auto-scrolling into the visible area.
19. **DEF-19: Unconstrained Deep FileTree Horizontal Overflow** (`FileTree.tsx`) — Deeply nested hierarchies (6+ levels) clip folder titles abruptly without horizontal scrolling or tooltips.
20. **DEF-20: Rapid Navigation Unpersisted Draft Loss** (`NoteEditor.tsx:145`) — Rapid note switching before debounce save can lose tail edits upon unmount.

---

## 4. Phase 2 Remediation Plan

1. **Fix Shell Root Layout**: Add `pl-16` or dynamic margin to `<main>` in `AppShell.tsx`, and conditionally render the floating rail only on viewports `lg:` (`>= 1024px`), swapping to `BottomNav` on mobile.
2. **Correct Code Viewer Button Collision**: Wrap the top bar in `repos/$id/files/$.tsx` in a flex container with `gap-3` and remove absolute positioning on the status badge.
3. **Register Missing Mock Server GET Route**: Add `get('/vaults/:id/revisions/:revisionId')` in `client/mock/server.mjs`.
4. **Hydrate Repository Share Grantees**: Join grantee UUIDs against the user roster in `RepositorySettingsDialog.tsx`.
5. **Add QR Code Generator in MFA Setup**: Integrate a lightweight SVG QR code component for `otpauth://` URIs in `settings/index.tsx`.
6. **Mobile Touch Target Optimization**: Enforce 44px min-height / padding on mobile buttons.
7. **Document Drop Handling**: Fix `imageDecorations.ts` to insert `[name](url)` for non-image assets like PDFs.
