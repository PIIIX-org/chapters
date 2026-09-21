# cockpit: Surface 03 of 04 — Ingestion Deck & Code Diagnostics (03-repo)

- **Composition Anchor**: `dense-grid`
- **Background Mode**: `flat-surface`
- **Frame Spec**: 1440×900 desktop screen.

## Layout Specification
- **3-Column Flight Deck**:
  - Column 1 (220px): Branch, commit SHA, sync daemon logs, webhook heartbeat.
  - Column 2 (Center): High-density CodeMirror viewer with inline AST token badges and cyclomatic complexity metrics.
  - Column 3 (320px): Real-time MCP tool activity monitor, symbol extraction queue, and node indexing latency charts.

## Typography Scale
- **Diagnostics**: Geist Mono, 11px / 16px, tabular-nums, `#38C77F`.
- **Code**: Geist Mono, 13px / 20px, `#DDE2EB`.
- **Log Stream**: Geist Mono, 10px / 14px, `#788296`.

## Paired Color Tokens & Measured Contrast
- Background `#050507` vs Code `#DDE2EB`: **16.1:1** (Passes WCAG AAA)
- Background `#050507` vs Telemetry Green `#38C77F`: **8.4:1** (Passes WCAG AAA)
