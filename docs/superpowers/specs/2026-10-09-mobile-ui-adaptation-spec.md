# Mobile UI Adaptation Architecture & Touch Ergonomics Specification

**Date**: 2026-10-09  
**Scope**: Full-spectrum mobile viewport adaptation across the Observatory Bridge client architecture, spanning Global Shell, Note View & Collaborative Editor, Vaults Dashboard, Repositories & Code Browser, Knowledge Graph 2D Canvas, Team, Admin Oversight & Settings, Authentication & Onboarding, and Responsive Table-to-Card Mobile Transformations.  
**Outcome**: 8/8 adaptation phases completed, tested with 100% green suites (137 test suites, 927 client tests, 400 server tests), bundle budget preserved at 157.40 KB gzip (< 300 KB limit), merged into `dev` via PRs #364 through #373, and promoted to `prod` via PRs #372 and #374.

---

## 1. Executive Summary & Architectural Goals

ELara's Observatory Bridge web client was originally optimized for multi-column desktop environments. When accessed on mobile devices and narrow tablets (< 768px), desktop layout paradigms generated severe ergonomic degradation:
1. Navigation rail occluded workspace contents or collided with headers.
2. Context panels and inspectors rendered as full-width blocking layers with no dismissal gesture.
3. Fixed-width tables and toolbar action bars caused horizontal page blowout.
4. Input focus triggered iOS Safari 16px auto-zoom viewport jumps.
5. Interactive elements fell below the 44px WCAG 2.2 touch target threshold.

Rather than building a separate mobile web application (`m.elara.app`) or duplicating page components with branching code forks, ELara adopted a **Unified Responsive Observatory Bridge** architecture. This pairs root-cause primitive hardening (`input.tsx`, `table.tsx`, `AppShell.tsx`) with adaptive layout modes, touch micro-drift tolerance, and mobile sheet patterns.

---

## 2. Non-Negotiable Invariants & Rules

1. **Dual-Tier Navigation Hierarchy**:
   - Desktop viewports ($\ge 768$px) render the contiguous unbroken ribbon rail (`Rail.tsx`) and sticky in-flow context panels.
   - Mobile viewports ($< 768$px) hide the rail and activate the dual-tier shell: `MobileHeader.tsx` at the top (with Command-K search trigger, universal creation button, scope selector, and panel trigger) and `MobileTabBar.tsx` pinned to the bottom thumb-zone (48px touch targets for `Graph`, `Vaults`, `Repos`, `Team`/`Admin`, `Settings`).

2. **iOS Safari Viewport Stability (16px Rule)**:
   - All text inputs, textareas, and select elements enforce `text-base` (16px / 1rem) on mobile viewports (`client/src/components/ui/input.tsx`).
   - Sizing below 16px triggers iOS Safari automatic zooming upon input focus, breaking fixed header/tab-bar alignment. On desktop screens, styling safely scales down via `sm:text-sm`.

3. **Horizontal Scroll Containment**:
   - All tables and horizontally overflowing views enforce `overflow-x-auto min-w-0 overscroll-x-contain touch-pan-x` (`client/src/components/ui/table.tsx`).
   - Prevents touch drags within tables from propagating to document scroll or triggering browser swipe-navigation gestures.

4. **Keyboard & Tab Bar Safe Clearances**:
   - Standard workspace pages enforce `pb-20 sm:pb-16` to guarantee bottom content is never occluded by the fixed `MobileTabBar`.
   - The CodeMirror collaborative editor enforces `pb-24 sm:pb-16` to clear virtual keyboards and toolbar overlays.
   - Floating HUD elements (e.g. GraphCanvas zoom controls) enforce `bottom-20 sm:bottom-14`.

5. **WCAG 2.2 Touch Target Ergonomics**:
   - Standalone primary interactive buttons meet or exceed $44 \times 44$px touch boundaries.
   - High-density list and table actions enforce minimum 32px touch bounding boxes (`size-8 sm:size-7`) with `active:scale-[0.96]` tactile physics.

6. **Canvas 2D Touch Calibration**:
   - Knowledge graph touch interaction allows up to 12px tap micro-drift before classifying gestures as pan/drag operations, eliminating missed node selections on touchscreens.
   - Expanded hit-test bounding box slop (+6px radius) enables reliable finger tapping on 6px member nodes.
   - Tooltip HUD popovers automatically dismiss on `touchstart` to prevent sticky touch artifacts.

---

## 3. Subsystem Adaptation Breakdown

### Phase 1: Global Shell & Navigation (PR #364)
- **Files**: `AppShell.tsx`, `MobileHeader.tsx`, `MobileTabBar.tsx`, `ScopePicker.tsx`.
- **Changes**:
  - Implemented responsive shell coordination with breakpoint-aware rendering.
  - Added `MobileTabBar` with fixed thumb-zone positioning and safe-area padding (`pb-safe`).
  - Added `MobileHeader` with compact scope selector, universal creation modal trigger, and slide-over panel trigger.
  - Constrained `ScopePicker` popover width with ellipsis truncation on long vault names.

### Phase 2: Note View & Collaborative Editor (PR #366)
- **Files**: `NoteView.tsx`, `NoteRichToolbar.tsx`.
- **Changes**:
  - Transformed rich formatting bar into a single-row horizontally scrollable toolbar (`overflow-x-auto no-scrollbar scroll-smooth flex-nowrap`).
  - Enlarged formatting buttons to `size-8 sm:size-7` and suppressed desktop width pickers on touch viewports.
  - Transitioned editor context and metadata sidebars to a bottom slide-over sheet (`z-40`) with tabbed switching and tap-to-dismiss backdrop scrim.
  - Added bottom padding `pb-24 sm:pb-16` for virtual keyboard clearance in CodeMirror 6.

### Phase 3: Vaults Dashboard & Organization (PR #365)
- **Files**: `VaultsPage.tsx`, `VaultCard.tsx`, `VaultSettingsModal.tsx`.
- **Changes**:
  - Applied symmetric mobile padding (`px-3 sm:px-4 md:px-6`).
  - Adapted vault cards with stacked layout, accessible badge wrapping, and touch-sized settings/action buttons.
  - Contained vault list tables with horizontal scrolling and sticky headers.
  - Converted vault settings modals into responsive mobile bottom sheets.

### Phase 4: Repositories & Code Browser (PR #367)
- **Files**: `ReposPage.tsx`, `RepositoryPage.tsx`, `RepoCard.tsx`, `RepositoryFileTree.tsx`, `CodeViewer.tsx`.
- **Changes**:
  - Responsive action headers with collapsible branch switchers, search bars, and sync triggers.
  - Horizontal overscroll containment across repository status and commit lists.
  - Expanded file tree rows to $\ge 32$px tap targets with touch chevron expanders.
  - Truncated path breadcrumbs in `CodeViewer` with remote Git link actions and mobile bottom tab bar clearance.

### Phase 5: Knowledge Graph Canvas & Controls (PR #368)
- **Files**: `GraphCanvas.tsx`, `GraphOutline.tsx`, `CommunityDetail.tsx`, `GraphFilters.tsx`, `GraphPathfinder.tsx`, `PhysicsControls.tsx`.
- **Changes**:
  - Reclaimed desktop rail offset on mobile (`left-3 sm:left-4 md:left-14 lg:left-16`).
  - Elevated floating zoom controls (`bottom-20 sm:bottom-14`) to clear `MobileTabBar`.
  - Calibrated touch tap gesture detection (12px micro-drift tolerance) and expanded small-node hit-testing slop.
  - Dismissed persistent HUD tooltips on touch gestures.
  - Eliminated iOS Safari 16px auto-zoom jumps across graph filter and pathfinder select inputs.
  - Converted graph community outline and inspector panels into touch-friendly slide-up sheets.

### Phase 6: Team, Admin Oversight & Settings (PR #369)
- **Files**: `TeamPage.tsx`, `AdminPage.tsx`, `SettingsPage.tsx`, `ConfirmAction.tsx`, `SecretReveal.tsx`, `MfaSection.tsx`, `input.tsx`, `table.tsx`.
- **Changes**:
  - Hardened shared `input.tsx` with root-cause `text-base sm:text-sm` font sizing to prevent iOS Safari auto-zoom.
  - Hardened shared `table.tsx` with `overscroll-x-contain touch-pan-x`.
  - Implemented mobile horizontal segmented pill navigation strips across Admin and Settings for instantaneous 1-tap tab switching without vertical stacking.
  - Normalized container padding (`px-3 sm:px-6 pb-20 sm:pb-16`).
  - Standardized 32–44px touch targets across admin confirmation dialogues, user rosters, approval queues, MFA TOTP verification, and notification toggles.

### Phase 7: Authentication & Onboarding Screens (PR #371)
- **Files**: `LoginPage.tsx`, `RegisterPage.tsx`, `OnboardingPage.tsx`, `MfaChallengePage.tsx`, `VerifyEmailPage.tsx`.
- **Changes**:
  - Full mobile viewport adaptation across authentication and onboarding flows.
  - Normalized screen container padding (`px-4 sm:px-6`) and centered single-column stacked card layouts on narrow viewports.
  - Enforced 44px minimum touch targets on all submission, OAuth, and secondary navigation buttons.
  - Applied iOS Safari 16px auto-zoom prevention on all authentication input fields.
  - Responsive branding headers, clear error alert boundaries, and thumb-friendly spacing.

### Phase 8: Admin & Oversight Table-to-Card Responsive Transformation (PR #373, PR #374)
- **Files**: `ApprovalQueue.tsx`, `UserRoster.tsx`, `VaultOversight.tsx`, `AccessOversight.tsx`, `InstanceActivity.tsx`, `VaultMcpPanel.tsx`, `VaultReachExpansion.tsx`, `TeamPage.tsx`.
- **Changes**:
  - Eliminated horizontal scroll trapping, nested scroll collision, and cutoff content across all admin and oversight tables on mobile viewports (< 640px).
  - Implemented an accessible CSS display transformation pattern:
    - `Table`: `w-full` with preserved semantic structure.
    - `TableHeader`: `hidden sm:table-header-group` (headers hidden on mobile, column context labeled inline).
    - `TableBody`: `block sm:table-row-group divide-y divide-border sm:divide-y-0`.
    - `TableRow`: `block sm:table-row p-3.5 sm:p-0 space-y-2.5 sm:space-y-0 rounded-lg sm:rounded-none bg-card/60 sm:bg-transparent border border-border sm:border-none mb-3 sm:mb-0`.
    - `TableCell`: `block sm:table-cell py-1 sm:py-2.5 px-0 sm:px-3 text-left`.
  - Transformed actions and badges into full-width flex rows with 44px touch targets on mobile and right-aligned buttons on desktop.
  - Zero DOM duplication: maintains semantic HTML `<table>` elements and 100% Axe accessibility compliance (`role="table"`, 0 violations), preserving unit test DOM queries (`tr`/`td`).

---

## 4. Verification & Benchmarks

| Metric | Target | Result | Status |
| :--- | :--- | :--- | :--- |
| Client Test Suites | 100% Passing | 137 / 137 suites passing | PASS |
| Client Tests | 100% Passing | 927 / 927 tests passing | PASS |
| Server Tests | 100% Passing | 400 / 400 tests passing | PASS |
| Initial Client Bundle (gzip) | < 300 KB | 157.40 KB gzip | PASS (47.5% under budget) |
| TypeScript Diagnostics | 0 errors | 0 errors | PASS |
| ESLint Diagnostics | 0 errors | 0 errors | PASS |
| WCAG Touch Target Compliance | $\ge 44$px primary, $\ge 32$px dense | 100% compliant | PASS |

---

## 5. Architectural Cross-References

- **OKF Spec Note**: `[[spec/2026-10-09-mobile-ui-adaptation-spec]]`
- **OKF Codebase Note**: `[[codebase/chapters]]`
- **OKF Project Note**: `[[project/chapters]]`
- **OKF Sticky Panels Spec**: `[[spec/2026-10-07-sticky-docked-side-panels-and-ribbon-navigation]]`
- **OKF Observatory Bridge Design**: `[[design/observatory-bridge]]`

