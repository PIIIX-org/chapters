# FEEDBACK.md — inter.face Plugin Harvest

> Run: `chapters-app` (Redesign of Second Brain & Knowledge Graph Web App)  
> Generated: 2026-09-21

---

## 1. Findings About the Plugin

### Finding 1: Visual Presentation at Human Gates
- **What happened**: At Gate B, presenting raw markdown files and local file paths to the user caused immediate friction ("i can not see anything, what am i approving"). Users in agent chat environments need visual evidence directly in their conversation flow.
- **What prevented it**: Conductor invoked `generate_image` to render high-resolution UI screen mockups and embedded them in an interactive Markdown artifact with an active local preview server.
- **Proposed improvement to `loops/01-direction.md` & `loops/02-craft.md`**: When running in chat harnesses with image generation capabilities, the conductor should automatically generate high-fidelity UI visual renders of the primary surface comps to present alongside `board.html`.

### Finding 2: Worker Subagent Output Depth Enforcement
- **What happened**: When worker subagents (`surface-designer`, `system-builder`) were initially dispatched with broad instructions, they defaulted to concise code skeletons / stubs rather than exhaustive implementations.
- **What prevented it**: The conductor re-asserted the full schema and rebuilt the components with full state coverage and complete DTCG token compliance.
- **Proposed improvement to `agents/*.md`**: Add explicit minimal line-count and state-completeness acceptance criteria to subagent prompts.

### Finding 3: Tool-Shaped Reposition Flow
- **What worked**: The `REDESIGN.md` brownfield extraction followed by the `Reposition` fork proved exceptionally effective for taking a functional beta application and elevating it to an authentic, high-craft MVP design system with zero aesthetic guesswork left for the build phase.
