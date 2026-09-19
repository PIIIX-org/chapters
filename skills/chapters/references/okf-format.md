# Open Knowledge Format (OKF) in Chapters

Chapters implements Google's [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) specification for all note storage.

## Core Rules

1. **Plain Markdown on Disk**: Notes are stored directly on the filesystem as `.md` files under the vault's directory.
2. **YAML Frontmatter**: Every note must begin with a YAML frontmatter block enclosed between `---` delimiters.
3. **Paths**: File paths are organized hierarchically (e.g., `concepts/distributed-systems.md`).
4. **Links**: Inter-note relationships are expressed via wikilinks.

---

## Frontmatter Schema

```yaml
---
title: "Title of the Note"
type: concept # concept | spec | guide | decision | meeting | reference
tags:
  - architecture
  - distributed-systems
created: 2026-09-19
updated: 2026-09-19
status: active # draft | active | deprecated | archived
author: "Taha Mahmoodi"
properties:
  priority: high
  owner: "Backend Team"
---
```

### Recognized Note Types
- `concept`: Definitions, theoretical models, architectural concepts.
- `spec`: Technical specifications, design docs, RFCs.
- `guide`: How-to guides, onboarding tutorials, runbooks.
- `decision`: Architecture Decision Records (ADRs).
- `meeting`: Meeting notes, transcripts, action items.
- `reference`: API documentation, data dictionaries, cheatsheets.

---

## Wikilinks Syntax

Chapters parses and indexes wikilinks into explicit `EXTRACTED` graph edges:

1. **Simple Note Link**:
   `[[note-title]]` or `[[path/to/note]]`
   Links to another note within the vault.

2. **Aliased Link (Custom Display Text)**:
   `[[target-note|Display Text]]`
   Renders as "Display Text" while pointing to `target-note`.

3. **Repository / Code Link**:
   `[[repo:repo-id/path/to/file.ts]]`
   Links directly to a file or symbol in a connected codebase repository.
   Example: `[[repo:chapters/server/src/mcp/server.ts]]`

4. **Heading Anchors**:
   `[[note-title#Section Header]]`
   Deep-links to a specific markdown heading inside a note.
