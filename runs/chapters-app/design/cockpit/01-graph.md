# cockpit: Surface 01 of 04 — Telemetry Matrix & Graph Radar (01-graph)

- **Composition Anchor**: `dense-grid` (multi-panel telemetry grid with active central radar)
- **Background Mode**: `flat-surface` (pure deep slate `#050507`)
- **Frame Spec**: 1440×900 desktop screen.

## Layout Specification
- **Top Telemetry Ribbon**: Live status beads: Node count `512`, Inferred Edge density `84%`, Sync Freshness `100%`, MCP Agent Status: `IDLE`.
- **Central Radar Field**: High-contrast dark graph with illuminated status indicators, vector directional arrows on edges, and Louvain hulls highlighted in vivid phosphor boundaries.
- **Side Telemetry Modules**: Real-time vector similarity inspector, node centrality rankings, active live websocket streams.

## Typography Scale
- **Telemetry Indicators**: Geist Mono, 12px / 16px, tabular-nums, `#F0F3F8`.
- **Radar Nodes**: Geist Mono, 11px / 14px, Semibold, `#38C77F`.
- **System Labels**: Geist Mono, 10px / 12px, uppercase tracked 0.08em, `#788296`.

## Paired Color Tokens & Measured Contrast
- Substrate `#050507` vs Telemetry Text `#F0F3F8`: **18.5:1** (Passes WCAG AAA)
- Substrate `#050507` vs Active Green `#38C77F`: **8.4:1** (Passes WCAG AAA)
