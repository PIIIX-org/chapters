# Mobile Responsiveness Plan: Vaults, Organization & Shell

**Date**: 2026-09-21  
**Issue**: [#188](https://github.com/PIIIX-org/chapters/issues/188)  
**Branch**: `feat/mobile-responsive-vaults`  
**Target Branch**: `dev`  

---

## 1. Problem & Objectives

Chapters has a dark-first desktop console grid shell. While it works on large desktop monitors, mobile phones (360px–430px viewports) face several UX issues:
1. **Container Width**: `max-w-[80%]` in `VaultsPage.tsx` squashes content down to ~290px on a 375px phone screen, wasting 20% of horizontal space with empty margins.
2. **Toolbar Overcrowding**: The header actions (Group, Cloud/Local, View Mode, New Vault) and the search/filter/sort toolbar crowd and overflow fixed-height rows on mobile.
3. **Touch Targets**: Small button sizes (e.g. `size-3.5` icons in `h-7` buttons) require precision that is difficult on touchscreens. Touch targets should meet the standard 44×44px touch envelope.
4. **Dialog Viewport Constraints**: `VaultFolderDialog`, `CustomColorPickerDialog`, and `StorageSettingsDialog` need responsive widths (`w-[calc(100vw-1.5rem)]` on mobile) so they never overflow screens on devices like iPhone SE (375px) or Android (360px).
5. **Shell & Navigation**: `TopBar` and `AppShell` must adapt gracefully on small viewports without horizontal scrolling (`overflow-x: hidden`).

---

## 2. Solution Design

### A. Vaults Page Responsive Layout (`client/src/pages/VaultsPage.tsx`)
- **Fluid Container**: Change `max-w-[80%]` to `w-full max-w-full sm:max-w-[94%] md:max-w-[88%] lg:max-w-[80%] px-2.5 sm:px-4 py-3 sm:py-5`.
- **Adaptive PanelHeader**: Allow header actions to wrap cleanly or flow below the title on small screens while maintaining fixed height on `sm:` and up.
- **Mobile Toolbar**:
  - Search input expands to 100% width on small screens.
  - Access filter and Sort dropdowns wrap cleanly side-by-side with equal width.
  - Folder filter chips: horizontal scrollable strip (`overflow-x-auto` with touch inertia) with clean padding.
- **Card Grid**:
  - `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` ensures single-column full-width cards on phones.
  - Folder accordion headers expand full width for easy finger tapping.

### B. Mobile Touch-Friendly Vault Card (`client/src/components/vault/VaultCard.tsx`)
- Ensure minimum 44×44px hit-box on favorite star toggle, folder assign button, and row actions menu.
- Truncate long vault names and folder badges cleanly without breaking card margins.

### C. Responsive Dialogs (`VaultFolderDialog.tsx`, `CustomColorPickerDialog.tsx`, `StorageSettingsDialog`)
- Use `sm:max-w-md w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto` for dialog content containers.
- In `VaultFolderDialog.tsx`:
  - Color palette swatches: comfortable grid or wrap spacing with minimum 32px touch targets.
  - Storage indicator: full-width banner with clear readable text on mobile.
  - Action buttons: full-width or comfortable stacked/flex layout on mobile.
- In `CustomColorPickerDialog.tsx`:
  - Canvas and spectrum slider scaled to fit within mobile modal width (max 280px-320px).

### D. Shell Navigation Adaptation (`AppShell.tsx` & `TopBar.tsx`)
- `TopBar.tsx`:
  - On viewports < 640px (`sm:`), compress command search trigger to icon-only or compact button.
  - Truncate breadcrumb gracefully to prevent pushing account menu and notifications off-screen.

---

## 3. Tasks

- [x] **Task 1**: Update `client/src/pages/VaultsPage.tsx` layout container, header actions, search/filter wrap, and folder shelf for mobile.
- [x] **Task 2**: Update `client/src/components/vault/VaultCard.tsx` touch targets and mobile spacing.
- [x] **Task 3**: Update `client/src/components/vault/VaultFolderDialog.tsx` and storage dialog with mobile-first widths and button layouts.
- [x] **Task 4**: Ensure `client/src/components/vault/CustomColorPickerDialog.tsx` scales cleanly on mobile viewports (<380px).
- [x] **Task 5**: Optimize `client/src/components/shell/TopBar.tsx` for narrow mobile screens.
- [x] **Task 6**: Add automated tests in `client/src/pages/VaultsPage.test.tsx` for mobile viewports and interactions.
- [x] **Task 7**: Run full client test suite and typechecks locally.
- [ ] **Task 8**: Commit with author `Taha-Mahmoodi <85902429+Taha-Mahmoodi@users.noreply.github.com>`, push branch `feat/mobile-responsive-vaults`, and open PR targeting `dev`.
