# cockpit: Surface 04 of 04 — Command Bridge & Agent HUD (04-command)

- **Composition Anchor**: `top-left-lead`
- **Background Mode**: `flat-surface`
- **Frame Spec**: 1440×900 desktop screen.

## Layout Specification
- **Top Command Deck**: Instant command line prompt `chapters> ` spanning top 48px with autocomplete suggestions.
- **Quick Key Grid**: 4×2 quick-action matrix (`[1] Search`, `[2] Graph`, `[3] Sync`, `[4] New Note`, `[5] Agent Exec`, `[6] Export`).
- **Telemetry Readout Below**: Active background worker jobs, sync queues, and MCP agent execution transcripts.

## Typography Scale
- **Command Prompt**: Geist Mono, 15px / 22px, Bold, `#F0F3F8`.
- **Key Matrix**: Geist Mono, 12px / 16px, Semibold, `#38C77F`.
- **System Log**: Geist Mono, 11px / 16px, `#788296`.

## Paired Color Tokens & Measured Contrast
- Substrate `#050507` vs Command Text `#F0F3F8`: **18.5:1** (Passes WCAG AAA)
- Substrate `#050507` vs Action Green `#38C77F`: **8.4:1** (Passes WCAG AAA)
