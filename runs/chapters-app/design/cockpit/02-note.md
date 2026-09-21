# cockpit: Surface 02 of 04 — Dual-Pane Editor & Telemetry Deck (02-note)

- **Composition Anchor**: `split-field` (50% code/markdown editor / 50% live rendered telemetry)
- **Background Mode**: `flat-surface`
- **Frame Spec**: 1440×900 desktop screen.

## Layout Specification
- **Split Workspace**: Left pane displays raw markdown + YAML with monospaced precision and inline line numbers; right pane displays live formatted output with interactive AST tokens and link telemetry.
- **Flight Header**: Direct keyboard shortcuts (`Ctrl+1` switch pane, `Ctrl+S` sync, `Ctrl+P` properties).
- **Status Deck (Bottom 28px)**: Words `1,420`, Reading time `6m`, Frontmatter validation `VALID OKF`, CRDT peers `3 CONNECTED`.

## Typography Scale
- **Header & File Path**: Geist Mono, 13px / 18px, Medium, `#F0F3F8`.
- **Editor Text**: Geist Mono, 13px / 20px, Normal, `#DDE2EB`.
- **Status Bar**: Geist Mono, 11px / 14px, tabular-nums, `#788296`.

## Paired Color Tokens & Measured Contrast
- Substrate `#050507` vs Editor Text `#DDE2EB`: **16.1:1** (Passes WCAG AAA)
- Substrate `#050507` vs Status Text `#788296`: **4.8:1** (Passes WCAG AA)
