# Chapters

An open-source, self-hostable "second brain" platform: a team knowledge base
built on plain markdown files, a live-preview editor, and an AI-navigable
knowledge graph.

**Status: research & structural design phase.** Nothing has been implemented
yet. This repository currently contains design specs only — see
[`docs/superpowers/specs/`](docs/superpowers/specs/).

## Why we're building this

Every note-taking tool we looked at forced a trade-off we didn't want to
make:

- **Obsidian** is excellent for a single person's notes, but it's a local
  desktop/mobile app with no server mode — there's no way to run it as a
  shared, always-available team knowledge base, and it's closed source, so
  we can't fix that ourselves.
- **Closed SaaS tools** (Recall.ai and similar) solve "access from
  anywhere," but your notes live in someone else's proprietary format and
  graph — you can't point your own tools (or an AI assistant) at the raw
  data.
- **Enterprise data catalogs** (like Google Cloud's Knowledge Catalog) solve
  structured, AI-navigable knowledge at scale, but they're built for
  corporate data governance, not for a team quickly writing and linking
  notes together.

We wanted the parts of each that actually matter — Obsidian's fast,
local-first editing feel; a real server so the whole team can reach the
same knowledge base from anywhere; and a knowledge graph structured well
enough that an AI assistant can navigate it accurately without burning
tokens re-deriving structure that should already be explicit.

## Design principles

- **Notes are plain files, always.** Every note is markdown + YAML
  frontmatter, following Google's [Open Knowledge Format
  (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
  spec — a vendor-neutral, version-controllable way to represent knowledge
  as `type/name` files with typed frontmatter and linked relationships. No
  proprietary database holding your notes hostage.
- **The graph is a first-class citizen, not an afterthought.** Relationship
  modeling is inspired by [Graphify](https://github.com/Graphify-Labs/graphify):
  explicit (`EXTRACTED`) edges from real links, and derived (`INFERRED`)
  edges from shared structure or semantic similarity, with automatic
  community detection on top.
- **AI access is a permission-aware, first-class feature**, not a bolt-on.
  Every account can connect an AI assistant via MCP — scoped to exactly the
  vaults that account can already see, respecting the same read/edit rules
  as the UI.
- **Self-hosted and open source.** One deployment serves one organization.
  The code is open so anyone can run their own instance.

## Project structure

This is being built as a sequence of dependency-ordered sub-projects, each
with its own design spec before any code is written:

1. **Auth & Vault/Sharing model** — accounts, teams, vaults, granular
   sharing permissions. Everything else depends on this.
2. **Editor** — live-preview markdown editing (CodeMirror 6), OKF-compliant
   by construction.
3. **Graph engine & view** — the OKF/Graphify-inspired knowledge graph,
   customizable clustering, filtering, and merged cross-vault views.
4. **Full-text search** — tuned for accurate, fast AI recall.
5. **Real-time collaborative editing** — live multi-user editing.
6. **MCP integration** — scoped AI-assistant access per account and per
   vault.

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for the detailed
design of each completed sub-project.

## Contributing

This project is in early, active design. Nothing is implemented yet, so the
most useful contribution right now is design feedback on the specs, not
code.
