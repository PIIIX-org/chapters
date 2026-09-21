# Keyboard Walkthrough Verification (§15 Hard Rule)

> Surface: `chapters-app` (Tool-Shaped Daily Knowledge Console)  
> Audit standard: Complete keyboard workflow without mouse or pointer dependency.

---

## 1. Global Navigation & Spatial Chords

| Chord / Key | Action | Focus Movement | Focus Ring Appearance | Return Path |
|---|---|---|---|---|
| `g g` | Jump to Knowledge Graph Observatory | Moves focus to central root node in Canvas 2D | Double dashed halo (`#3FB8AE`) | `Esc` deselects node |
| `g v` | Jump to Vaults | Focuses search filter input in Vault list | 2px solid `#3FB8AE` with 2px offset | `Tab` moves to note cards |
| `g r` | Jump to Repositories | Focuses repository selector combobox | 2px solid `#3FB8AE` | `Tab` enters file tree |
| `g t` | Jump to Team | Focuses team member search input | 2px solid `#3FB8AE` | `Tab` moves to role table |
| `g s` | Jump to Settings | Focuses first settings tab | 2px solid `#5B8DEF` | `Tab` moves through settings |
| `g a` | Jump to Admin | Focuses admin user approval queue | 2px solid `#5B8DEF` | `Esc` returns to previous view |

---

## 2. Command Bridge (Omni-Search) Workflow

- **Trigger**: `⌘K` or `Ctrl+K` from any view at any time.
- **Focus Trap**: Traps focus inside the command input immediately upon opening.
- **List Navigation**:
  - `ArrowDown` / `ArrowUp` cycles through search results.
  - `Tab` filters between categories (All, Vault Notes, Code Symbols, MCP Tools).
  - `Enter` executes the action or navigates to the selected note/file.
- **Escape / Return**: `Esc` closes the command bridge and returns focus precisely to the element that held focus before `⌘K` was pressed.

---

## 3. Note Workspace & Editor Workflow

- **Tree to Editor**: `Tab` from folder tree moves directly into active note title or frontmatter.
- **Save / Persist**: Automatic via Yjs CRDT debounced sync; manual flush via `Ctrl+S`.
- **Panel Toggles**:
  - `[` toggles Left Context Tree (240px).
  - `]` toggles Right Inspector Rail (300px).
  - Toggling adjusts layout width without disrupting editor cursor position or reflowing text.

---

## 4. Accessibility & Verification Verdict

- **Focus Visibility**: Every focus ring passes WCAG AA (≥ 3.0:1 against adjacent substrates).
- **Zero Pointer Traps**: No modal or container traps keyboard navigation without an accessible `Esc` exit.
- **§15 Completeness Verdict**: **VERIFIED COMPLETE**. All core workflows are 100% executable by keyboard alone.
