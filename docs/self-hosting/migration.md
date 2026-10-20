# Store migration (ADR-003): dry run and rehearsal

Elara is moving to one authoritative store for notes: Postgres holds the
truth, and the `.md` files, directory `index.md` files, `.crdt` state and
embeddings become projections rebuilt from it (vault note
`decision/adr-003-authoritative-store`). The move lands in slices. This
release (S1) adds the database schema and a **read-only dry run** that tells
you what the real migration will do to your data. Nothing about how Elara
behaves changes yet.

## What this release changes

- **Migration 0021** runs at boot. It only adds: two columns and a trigger on
  `notes`, three columns and two partial unique indexes on `note_revisions`,
  five new tables (`note_crdt`, `note_updates`, `note_projections`,
  `projected_files`, `jobs`) and two marker columns on `instance_state`.
  Building the two indexes scans `note_revisions` once while holding a write
  lock on it; the time grows with that table's size (the dry run reports it).
- Nothing reads or writes the new objects yet.
- Rolling back to an older release over 0021 needs **no SQL**: older code
  ignores the new tables and columns, its inserts take the defaults and its
  deletes cascade (backup.md §5).

## Run the dry run

Run it on a **copy** of production first (the #703 rehearsal), then, if you
like, on production itself: it is read-only either way.

```bash
docker compose exec app pnpm migrate-store --dry-run --report /tmp/migration-dry-run.json
docker compose cp app:/tmp/migration-dry-run.json ./migration-dry-run.json
```

- It reads every note (live and trashed) in one `REPEATABLE READ READ ONLY`
  transaction, in batches of 100, plus each note's `.md` file and `.crdt` bin.
  Postgres refuses any write inside that transaction.
- It reads only columns that exist before 0021, so it also runs on an
  instance still on the previous release, or a copy restored from it.
- It writes one file: the `--report` path. It refuses to overwrite an
  existing file. Without `--report` the JSON goes to stdout and a one-line
  summary to stderr. `--vault <uuid>` limits it to one vault.
- It runs no migrations. Without `--dry-run` it exits with code 2: the
  migration itself ships with the next slice (S2a).

## Reading the report

`counts` has the totals; `notes` has one entry per note with these classes:

| Field | Values | Meaning for the migration |
|---|---|---|
| `file` | `consistent` | file and row agree |
| | `differs` | file ≠ row: listed in `conflicts`; **the file wins** (Q5) and the row's text is kept as a revision |
| | `missing` | row without file: the row is kept and the file is written |
| | `unparseable` | the file has no valid frontmatter: the row is kept, the file is copied aside and rewritten (`detail` has the parse error) |
| `serializeNoteForm` | `true` / `false` / `null` | whether the file's bytes are exactly what Elara writes; `false` means hand-formatted YAML, kept as it is (adopted) |
| `revision` | `consistent` / `gap` / `none` | whether the newest revision equals the row; a gap or no revision gets a backfill revision |
| `crdt` (live notes) | `matches-row`, `matches-file`, `matches-revision` | the bin is attached to the note in S2b (its history is kept) |
| | `mismatch`, `undecodable` | the bin is set aside in S2b and the note is seeded fresh on first open |
| | `missing` | no bin; seeded on first open, as today |
| `projection` | `applied` / `adopted` / `create` / `rewrite` | what happens to the file: nothing, kept as it is, written, or rewritten after a conflict copy |
| `embedding` | `applied` / `pending` | pending embeddings are computed after the migration |

- **`conflicts`**: every `file ≠ row` note, with `rowUpdatedAt` against
  `fileMtime`, `newer` (`row`, `file` or `same`), the differing frontmatter
  keys, whether the body differs and the sha256 of both sides. Crashes leave
  the row newer than the file; a hand or `git` edit leaves the file newer.
  Review this list before migrating production: the file wins by default.
- **`filesThatChangeBytes`**: files the migration will create or rewrite.
- **`missingRows`**: `.md` files with no live note at their path,
  `.trash/<id>.md` files with no trashed note, and `.crdt` bins with no live
  note. They are not deleted; later slices move unowned `.md` files to
  `.orphans/`. Generated directory `index.md` files are counted in
  `counts.dirIndexFiles`, not listed; `counts.tempFiles` counts leftover
  `*.tmp` files from interrupted writes.
- **`database`**: whether the transaction was read-only, whether 0021 is
  applied, and the backfill markers.

## Estimating the migration time

`timingsMs`, `sizes` and `estimate` give the inputs of the cost model

T ≈ T_index(`note_revisions` bytes) + N × t_note + F × t_write

with N notes and F files that change bytes. `estimate.measuredMsPerNote` is
the read-only work per note measured by the dry run (file read, YAML parse,
Yjs decode); the real migration adds one commit per note and the index build.
The production estimate is the rehearsal's wall time × the ratio between the
two hosts. If the rehearsal suggests more than 5 minutes, the migration plan
goes back to the owner (ADR-003 Q6) before production migrates.
