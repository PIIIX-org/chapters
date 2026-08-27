# Unit 5 — Trash, revision history, and import

Implements the unit 5 section of
`docs/superpowers/specs/2026-08-22-remaining-ui-design.md` against
`docs/superpowers/specs/2026-07-15-data-export-portability-design.md`.

## What is actually missing

Every endpoint below already exists and has no caller. Concretely today: a
deleted note is unrecoverable through the app, a note's history is invisible,
and the vault-delete confirmation ends with "you can restore it from Trash
below until you purge it" — a promise about a control that does not exist.

| Surface | Endpoint | State |
|---|---|---|
| Note trash + restore | `GET /vaults/:id/trash`, `POST /vaults/:id/trash/:noteId/restore` | no caller |
| Revision history | `GET /vaults/:id/history/*` | no caller |
| Revert | `POST /vaults/:id/revert/*` | no caller |
| Revision purge (owner/admin) | `DELETE /vaults/:id/revisions/:revisionId` | no caller |
| Vault purge (owner) | `POST /vaults/:id/purge` | no caller, but promised in copy |
| Import | `POST /api/import` | no caller |

## Import creates a new vault — the spec's stated hazard does not exist

The UI spec groups import here because "an import that silently collides with
existing notes is the same class of hazard as an unrecoverable delete". Reading
`export/routes.ts`, it never collides: it `INSERT`s a new vault every time, per
the export spec's "Import always creates a *new* vault".

So the confirm copy must state what it *does* do, which is a different set of
surprises: you become the owner of a brand-new vault; shares in the manifest
are re-granted only where the email matches an account on this instance, and
every unmatched one is silently dropped. The response already reports
`imported`, `skipped` and `unmatchedShares` — the result screen shows all
three, because "23 notes imported" while four collaborators lost access is not
a success message.

## Backend gap

`GET /vaults/:id/history/*` returns `select()` — every revision, with its full
`frontmatter` and `body`, unpaginated. Performance rule 3 is "every list
endpoint paginates, no unbounded reads, ever", and this is the one endpoint
unit 5 makes a person actually hit, on the notes with the most history.

The route gets `limit`/`offset` and a metadata projection (id, actorType,
actorId, action, createdAt) via a new `listRevisionMeta`. Revert needs only a
`revisionId`, so no body is needed to drive the panel; a per-revision content
endpoint is YAGNI until something previews or diffs.

**Left alone deliberately**: the MCP `note_history` tool still calls
`listRevisions` and still returns full unpaginated rows. Changing the payload
of a shipped agent-facing tool is its own decision, not a side effect of a UI
unit. Flagged in the PR.

## Where each surface lives

- **Note trash** — the vault settings modal stack, beside sharing and export.
  It is vault-scoped, and that stack is where vault-scoped things already are.
- **Vault purge** — in `VaultActions`, next to the delete that promises it.
- **Revision history** — the Editor rail, per spec.
- **Import** — Settings, directly beneath the account export it is the
  counterpart to. It creates a vault you own, so it is account-level, not
  vault-scoped.

## Tasks

1. Backend: paginate + project the history route; tests.
2. Client contract: `api/revisions.ts`, `api/import.ts`, trash additions to
   `api/notes.ts`, and their hooks (written first).
3. `NoteTrashPanel` — trashed notes with restore, in the vault settings stack.
4. `RevisionHistory` — the Editor rail panel: revisions newest first, who and
   when, revert with inline consequence, and revision purge for owner/admin
   only.
5. `VaultImport` — file picker, the consequence copy above, and a result that
   reports unmatched shares as prominently as the note count.
6. Vault purge in `VaultActions`, closing the dangling promise in its own copy.
7. Wiring: modal stack entry, editor rail, settings section.
8. README + STATE.md.

## Testing

Client: vitest + happy-dom, an axe assertion per component, **every test
mutation-verified**. Server: real-database tests for the pagination and the
projection (including that a body is NOT served).

Unit 4's lesson stands: a real browser pass against a running server before
this is called done — restore a note, revert a revision, purge a vault, import
a zip exported from the same instance.
