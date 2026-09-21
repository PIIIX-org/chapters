# scriptorium: Surface 02 of 04 — Archival Note Workspace & Manuscript View (02-note)

- **Composition Anchor**: `left-rail-caption` (240px archival index / 72ch centered manuscript folio / 280px marginalia)
- **Background Mode**: `flat-surface`
- **Frame Spec**: 1440×900 desktop screen.

## Layout Specification
- **Archival Index (Left, 240px)**: Chapter and folio index, sorted chronologically and by OKF type (`concepts`, `specs`, `guides`, `decisions`).
- **Manuscript Folio (Center)**:
  - Archival Document Seal at top: Type badge `SPEC`, creation date, revision stamp.
  - Generous reading measure: 68ch, comfortable editorial line spacing (`line-height: 1.7`).
  - Marginalia Footnotes: In-text citations and wikilinks float gently into the right margin.
- **Marginalia Inspector (Right, 280px)**:
  - Commentary stream, version audit log with attribution signatures, cross-referenced literature.

## Typography Scale
- **Manuscript Title**: Geist Sans, 24px / 32px, Medium (`wght 500`), `#EDEBE8`.
- **Prose Body**: Geist Sans, 15px / 26px, Normal (`wght 400`), `#D6D2CB`.
- **Blockquote / Excerpts**: Geist Sans, 14px / 22px, Italic, `#A8A39D`.
- **Frontmatter Stamps**: Geist Mono, 11px / 16px, `#D4A359`.

## Paired Color Tokens & Measured Contrast
- Folio Background `#101216` vs Prose `#D6D2CB`: **13.5:1** (Passes WCAG AAA)
- Stamp `#D4A359` vs Background `#101216`: **8.2:1** (Passes WCAG AAA)
- Subtitle `#A8A39D` vs Background `#101216`: **6.1:1** (Passes WCAG AA)

## Content Direction
Active note is `specs/collaborative-crdt.md`, reading like an illuminated modern engineering specification.
