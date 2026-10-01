# Comprehensive 20-Defect Remediation Plan & Phased Implementation Roadmap

**Date**: 2026-10-01  
**Target Environment**: Chapters Platform (React 19 + Vite 6 + Tailwind v4 + Fastify + Yjs + MCP)  
**Branch**: `dev` (HEAD commit `27c0ed0`)  
**Scope**: Full architectural remediation plan and 4-batch execution roadmap for all 20 cataloged defects (DEF-01 through DEF-20) identified in the 2026-09-30 visual & behavioral audit.  
**Deliverables**:
- Standalone Interactive Report: [`docs/remediation-plan-report.html`](../remediation-plan-report.html)
- Node Report Generator: [`docs/build-remediation-report.mjs`](../build-remediation-report.mjs)
- Visual Audit Report: [`docs/visual-and-behavioral-audit-report.html`](../visual-and-behavioral-audit-report.html)
- Chapters Knowledge Graph Spec Note: `spec/2026-10-01-defect-remediation-plan`

---

## 1. Executive Summary & Remediation Strategy

Following the full-spectrum visual and behavioral audit of Chapters across 135 high-resolution CDP screen captures and 6 advanced behavioral suites, 20 defects were cataloged across layout, interaction, realtime sync, and mock server routing.

This document establishes the approved remediation plan for all 20 defects. Adhering to senior engineering principles (**Ponytail Senior Dev Mode**), every fix targets the root cause rather than treating symptoms:
1. **Zero Bundle Budget Regressions**: Client initial bundle chunk strictly remains below 300KB gzipped (`client/src/bundle.test.ts`). Heavy dependencies like `qrcode` are dynamically imported on-demand (`await import('qrcode')`).
2. **Zero Automated Test Regressions**: All 889 existing client Vitest tests and 392 server tests remain passing.
3. **Platform-Native Solutions**: Native CSS and standard browser capabilities are preferred over new libraries (e.g. `interactive-widget=resizes-content` for mobile virtual keyboards; invisible pseudo-element expansion for WCAG 2.5.5 touch targets).

---

## 2. Defect Remediation Matrix

| Defect ID | Severity | Category / Batch | Target File(s) | Remediation Summary |
| :--- | :---: | :--- | :--- | :--- |
| **DEF-01** | High | Batch A (Shell & Mobile) | `DashboardPage.tsx`, `RepositoriesPage.tsx`, `TeamPage.tsx`, `NoteView.tsx` | Standardize page left padding (`pl-[72px] sm:pl-20`), set context panel to `left-[68px]`, dynamic `NoteView` editor offset. |
| **DEF-02** | Medium | Batch A (Shell & Mobile) | `RepositoryPage.tsx:357` | Expand right padding to `pr-52` (208px) to clear TopBar's green `• SYNCED` badge by 48px. |
| **DEF-03** | High | Batch A (Shell & Mobile) | `Rail.tsx:146,163`, `BottomBar.tsx` | Hide rail card wrappers (`max-md:hidden`) on mobile; remove desktop margins in `BottomBar.tsx`. |
| **DEF-04** | High | Batch B (Data & Sync) | `server.mjs:1803` | Add `get('/vaults/:id/revisions/:revisionId')` mock route returning complete snapshot payloads. |
| **DEF-05** | Medium | Batch B (Data & Sync) | `server/src/repositories/routes.ts:279`, `RepositoryShareList.tsx` | Join `users` table on user shares to return user names & emails instead of raw UUIDs. |
| **DEF-06** | Medium | Batch B (Data & Sync) | `MfaSection.tsx` | Dynamically import `qrcode` (`await import('qrcode')`) to render 192x192 SVG QR code without bloating initial bundle chunk. |
| **DEF-07** | Low | Batch B (Data & Sync) | `VaultMcpPanel.tsx:71,187` | Assign `w-24 shrink-0` to action table cell and `whitespace-nowrap` to `<Button>`. |
| **DEF-08** | Low | Batch A (Shell & Mobile) | `CollabStatusLine.tsx:64` | Add `hidden sm:inline-flex` to `<Pill>` tags so TopBar owns the single mobile status indicator. |
| **DEF-09** | Medium | Batch A (Shell & Mobile) | `ScopePicker.tsx` | Add window `pointerdown` outside-click listener guarded against Radix popper portals. |
| **DEF-10** | High | Batch D (Graph & Polish) | `tabs.tsx:23-37` | Forward primary `mousedown` on `onClick` when inactive so synthetic clicks and assistive tech activate Radix tabs. |
| **DEF-11** | Medium | Batch D (Graph & Polish) | `GraphCanvas.tsx:600` | Add dedicated `Route` button in top action bar and provide helpful guidance state when viewing un-drilled community graphs. |
| **DEF-12** | Medium | Batch C (Editor & Files) | `useCodeMirrorEditor.ts:164` | Configure `@codemirror/view` `tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() })` and `maxHeight: 260px` to auto-flip upward near container edges. |
| **DEF-13** | High | Batch D (Graph & Polish) | `VaultActions.tsx:87-105`, `VaultSettingsModal.tsx` | Add Danger Zone section and require typing exact vault title (`typedName === vault.name`) before unlocking deletion. |
| **DEF-14** | Low | Batch C (Editor & Files) | `ExpandableSearch.tsx:78`, toolbar triggers | Add explicit `aria-label="Open command palette"` and tooltips on icon-only triggers. |
| **DEF-15** | Medium | Batch D (Graph & Polish) | `VaultNotesPage.tsx` | Aggregate frontmatter tags and elevate empty filtered state to `PanelState` (`status="empty"` with clear filter button). |
| **DEF-16** | Medium | Batch A (Shell & Mobile) | `button-variants.ts:7` | Add centered invisible pseudo-element expansion (`after:min-w-[44px] after:min-h-[44px] md:after:hidden`) satisfying WCAG 2.5.5. |
| **DEF-17** | Medium | Batch C (Editor & Files) | `imageDecorations.ts:122-139` | Inspect MIME type/extension; insert image syntax `![name](url)` only for images, and standard link `[name.pdf](url)` for PDFs and documents. |
| **DEF-18** | High | Batch A (Shell & Mobile) | `client/index.html:5`, `useCodeMirrorEditor.ts` | Add `interactive-widget=resizes-content` to viewport meta and attach `visualViewport` resize listener to scroll active selection into view. |
| **DEF-19** | Low | Batch C (Editor & Files) | `FileTree.tsx:30,40-52`, `VaultLayout.tsx:92` | Add title tooltips with full paths, enable horizontal scrolling on navigation container (`overflow-x-auto scrollbar-thin`). |
| **DEF-20** | Critical | Batch B (Data & Sync) | `useCollabDoc.ts:258-270` | Flush pending CRDT updates on unmount; defer provider destruction if unsynced changes exist until synced or 1000ms safety timeout. |

---

## 3. Detailed Architectural Remediations by Batch

### Batch A: Shell Layout & Mobile Ergonomics

#### DEF-01: Structural Layout Occlusion (Shell Rail vs `<main>` Workspace)
- **Root Cause**: Desktop Rail width was increased to 68px (`w-[68px]`), but pages used inconsistent left margins/paddings (`ml-16` = 64px, `pl-16` = 64px, or `pl-4` = 16px).
- **Remediation**:
  - In `DashboardPage.tsx`, `RepositoriesPage.tsx`, and `TeamPage.tsx`, standardize root container to `pl-[72px] sm:pl-20`.
  - In `ContextPanel.tsx`, anchor desktop drawer to `left-[68px]` instead of `left-16`.
  - In `NoteView.tsx`, compute dynamic `leftPad = (isContextOpen && !isMobile) ? 'pl-[320px]' : 'pl-0'` to prevent sidebar clipping while keeping the editor centered.

#### DEF-02: Action Bar / Status Pill Collision
- **Root Cause**: `RepositoryPage.tsx` applied `pr-16` (64px) to the actions row, but TopBar anchors a 96px `• SYNCED` pill at `right-4`, leaving only 16px clearance and overlapping action buttons.
- **Remediation**:
  - In `RepositoryPage.tsx:357`, expand right padding to `pr-52` (208px), giving a clean 48px clearance from the status badge.

#### DEF-03: Mobile Viewport (375px) Layout Breakdown & Header Overflow
- **Root Cause**: `Rail.tsx` rendered the full card container on mobile screens, colliding with top content; `BottomBar.tsx` contained desktop margins inducing horizontal scrolling.
- **Remediation**:
  - In `Rail.tsx:146,163`, apply `max-md:hidden` so only the standalone `CH` logo renders on mobile.
  - In `BottomBar.tsx`, remove negative desktop margins and restrict container width to `w-full max-w-full`.

#### DEF-08: Duplicate Overlapping OFFLINE Badge on Mobile
- **Root Cause**: Both `TopBar.tsx` and `CollabStatusLine.tsx` rendered offline status indicators simultaneously on mobile.
- **Remediation**:
  - In `CollabStatusLine.tsx:64`, add `hidden sm:inline-flex` to `<Pill>` tags so TopBar owns the single mobile status indicator.

#### DEF-09: Non-Dismissing Colliding Popovers (ScopePicker vs NotificationBell)
- **Root Cause**: `ScopePicker.tsx` handled outside clicks with an internal ref listener that did not account for Radix portals.
- **Remediation**:
  - In `ScopePicker.tsx`, add a window `pointerdown` listener that checks `!containerRef.current?.contains(target) && !target.closest('[data-radix-popper-content-wrapper]')` and closes the picker cleanly.

#### DEF-16: Mobile Touch Target Size Deficit (< 44px)
- **Root Cause**: Mini/compact icon buttons measure 24px–32px, failing WCAG 2.5.5 touch target size (44x44px).
- **Remediation**:
  - In `button-variants.ts:7`, add `after:content-[''] after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:min-w-[44px] after:min-h-[44px] md:after:hidden`. Expands touchable hitbox without modifying visual layouts.

#### DEF-18: Soft Keyboard Viewport Clipping
- **Root Cause**: Mobile virtual keyboards reduce viewport height, obscuring active cursor lines in CodeMirror.
- **Remediation**:
  - In `client/index.html:5`, add `interactive-widget=resizes-content` to `<meta name="viewport">`.
  - In `useCodeMirrorEditor.ts`, add a `window.visualViewport` resize listener that triggers `view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) })`.

---

### Batch B: Data Integrity & Realtime Sync

#### DEF-04: Mock Server HTTP 405 on Revision Diff Route
- **Root Cause**: Mock development server (`client/mock/server.mjs`) had `get('/vaults/:id/revisions')` but omitted the singular `get('/vaults/:id/revisions/:revisionId')` route.
- **Remediation**:
  - In `client/mock/server.mjs:1803`, add `get('/vaults/:id/revisions/:revisionId')` handler returning full revision snapshots for the diff preview modal.

#### DEF-05: Raw Backend UUIDs in Repository Share List
- **Root Cause**: `server/src/repositories/routes.ts` queried `repository_shares` but did not join the `users` table for user shares.
- **Remediation**:
  - In `server/src/repositories/routes.ts:279`, join `users` table when `granteeType === 'user'` to return `name` and `email` alongside `granteeId`. Update `RepositoryShareList.tsx` to render user identities.

#### DEF-06: Two-Factor Authentication (TOTP) Missing Visual QR Code
- **Root Cause**: Only text secret and `otpauth://` URI were presented during 2FA setup.
- **Remediation**:
  - In `MfaSection.tsx`, dynamically import `qrcode` (`const QRCode = await import('qrcode')`) to generate and render a 192x192 SVG QR code. Zero impact on initial bundle chunk size.

#### DEF-07: MCP Token Revoke Button Clipped
- **Root Cause**: Action cell in `VaultMcpPanel.tsx` lacked fixed width and `whitespace-nowrap`.
- **Remediation**:
  - In `VaultMcpPanel.tsx:71,187`, assign `w-24 shrink-0` to the action table cell and `whitespace-nowrap` to `<Button>`.

#### DEF-20: Rapid Navigation Unpersisted Draft Loss
- **Root Cause**: Rapidly switching notes before the 250ms debounce save timer flushes unmounts `useCollabDoc`, synchronously calling `provider.destroy()` and dropping buffered tail keystrokes.
- **Remediation**:
  - In `useCollabDoc.ts:258-270`, call `provider.flushPendingUpdates?.()` on unmount; if `hasUnsyncedChanges` is true, clear awareness and defer socket teardown and `ydoc.destroy()` until synced or a 1000ms safety timeout expires.

---

### Batch C: Editor & File Handling

#### DEF-17: PDF File Drop Image Tag Generation
- **Root Cause**: `imageDecorations.ts` wrapped all dropped files in image markdown syntax `![name](url)`.
- **Remediation**:
  - In `imageDecorations.ts:122-139`, check MIME type and file extension. Use `![name](url)` only for image MIME types; insert standard markdown links `[name.pdf](url)` for PDFs and document binaries.

#### DEF-12: Wikilink Dropdown Bounds Clipping
- **Root Cause**: Autocomplete tooltip in CodeMirror lacked viewport bounding constraints, overflowing off-screen near bottom container edges.
- **Remediation**:
  - In `useCodeMirrorEditor.ts:164`, configure `@codemirror/view` `tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() })` and `maxHeight: 260px` to auto-flip upward near container edges.

#### DEF-14: Icon-Only Buttons Lacking `aria-label`
- **Root Cause**: Search triggers and editor action buttons rendered SVG icons without accessible screen reader names.
- **Remediation**:
  - In `ExpandableSearch.tsx:78` and toolbar buttons, add explicit `aria-label` and `title` attributes.

#### DEF-19: Unconstrained Deep FileTree Overflow
- **Root Cause**: Deep folder hierarchies (6+ levels) truncated text abruptly inside fixed-width sidebars.
- **Remediation**:
  - In `FileTree.tsx:30,40-52`, add `title={note.path ? `${note.name} (${note.path})` : note.name}` on `NavLink`, `title={type}` on Eyebrow. Set `overflow-y-auto overflow-x-auto scrollbar-thin` on `VaultLayout.tsx:92` with `min-w-full w-max` on `<nav>`.

---

### Batch D: Graph & Polish

#### DEF-11: Concept Pathfinding UI Unexposed
- **Root Cause**: `find_graph_path` algorithm existed in backend but lacked a prominent canvas UI trigger.
- **Remediation**:
  - Add dedicated `Route` button in `GraphCanvas.tsx:600` top action bar, keep rail button visible, and provide guidance state when viewing un-drilled community graphs.

#### DEF-13: Vault Deletion Confirmation Guard
- **Root Cause**: Destructive vault delete action executed on single click without typing verification.
- **Remediation**:
  - Add Danger Zone section to `VaultSettingsModal.tsx` and guard inline delete in `VaultActions.tsx:87-105` requiring the user to type the exact vault name (`typedName === vault.name`) before unlocking deletion.

#### DEF-15: Tag Filter Empty State in Vault Browser
- **Root Cause**: Filtering by tags with 0 matches resulted in an unstyled blank screen.
- **Remediation**:
  - Add frontmatter tag aggregation and dropdown in `VaultNotesPage.tsx`; elevate zero-match state to `PanelState` (`status="empty"`, specific tag message, and "Clear filters" button).

#### DEF-10: Synthetic Click Event Failure on Radix Tabs
- **Root Cause**: Radix UI `TabsTrigger` attaches handlers to `onMouseDown` and `onKeyDown`, swallowing standard JavaScript `.click()` events.
- **Remediation**:
  - In `tabs.tsx:23-37`, attach an `onClick` listener to `TabsTrigger` that dispatches primary `mousedown` if `data-state !== 'active'`, ensuring standard `.click()` and assistive devices activate tabs.

---

## 4. Verification Protocol

1. **Automated Test Suite**:
   ```bash
   npm --prefix client test
   ```
   All 133 suites and 889+ tests must remain 100% green.
2. **Bundle Budget Verification**:
   ```bash
   npm --prefix client test src/bundle.test.ts
   ```
   Initial gzipped chunk size must remain strictly under 300KB.
3. **Responsive Visual Verification**:
   Verify layout across 375px mobile and 1440px desktop breakpoints via CDP runner.
