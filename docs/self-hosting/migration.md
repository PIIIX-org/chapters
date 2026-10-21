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

**Before the upgrade** (the usual case: the instance still runs the previous
release). Check out the new release and build its image, but do not start
it: the app applies 0021 when it boots. Run the dry run in a one-off
container of the new image instead, next to the database that is already
running:

```bash
docker compose build app         # builds the new image; the running app is not replaced
docker compose run --rm --no-deps app pnpm migrate-store --dry-run --report /data/elara/migration-dry-run.json
```

`run --rm` throws the container's own filesystem away when it exits, so the
report must go onto the data volume (`/data/elara`, the `DATA_DIR`), not
`/tmp`. It is then on the host wherever that volume lives (or copy it out of
any running container that mounts the volume). The file sits next to
`vaults/`, not inside it, so it does not show up in any vault.

**After the upgrade** (0021 applied, the new app running):

```bash
docker compose exec app pnpm migrate-store --dry-run --report /data/elara/migration-dry-run.json
```

- It reads every note (live and trashed) in one `REPEATABLE READ READ ONLY`
  transaction, in batches of 100, plus each note's `.md` file and `.crdt` bin.
  Postgres refuses any write inside that transaction.
- It reads only columns that exist before 0021, so it runs against a
  database still on the previous release (the `run` form above), or a copy
  restored from it.
- It writes one file: the `--report` path. It creates that file before it
  starts and refuses an existing file, a symlink or a directory it cannot
  write to (exit code 2, nothing read); if the run itself fails, it removes
  the file again. Without `--report` the JSON goes to stdout and a one-line
  summary to stderr. `--vault <uuid>` limits it to one vault.
- It runs no migrations. Without `--dry-run` it exits with code 2: the
  migration itself ships with the next slice (S2a).
- **On a live instance, edits made during the run show up as conflicts.**
  The database is read from one snapshot taken at the start, but each file
  is read when the walk reaches it, so a note saved in between looks like
  `file ≠ row`. That is why the rehearsal runs on a copy. If you run it on
  production, run it again before acting on a single conflict (the same
  advice as for `check-notes`, backup.md §4).

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
| `collab` (live notes) | `attach` / `set-aside` / `seed` / `has-state` | what the S2b backfill does with the note: attaches its bin, moves the bin to `.migration/<date>/bins/`, nothing until first open (no bin), or nothing because the note already has its CRDT state in the database; `counts.collab` has the totals |
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

## S2b: the editors' state moves into the database

The release with ADR-003 S2b stops using `.crdt/<path>.bin` files. Each
note's live-editing state (Yjs) is kept in Postgres (`note_crdt` and
`note_updates`), written in the same transaction as the note, and the
editor names a note's live document by the note id instead of its path.

- **Upgrade prerequisite:** reload every open editor tab before upgrading,
  or make sure nobody types during the upgrade. The server refuses a tab
  still running the older page; the newer page shows "Reload to keep
  editing". Details and rollback: [backup.md §5](backup.md).
- **First boot:** before it serves requests, the server attaches each live
  note's bin when its text equals the note's row, its file or one of its
  revisions (with the change to the row's text on top), moves any other bin
  to `vaults/<id>/.migration/<date>/bins/`, then sets
  `instance_state.collab_migrated_at`, renames each vault's `.crdt/` to
  `.crdt.pre-adr-003/` and writes `DATA_DIR/collab-migration-report-<time>.json`.
  Notes without an attached bin get their state on first open. Run the dry
  run first: its `collab` column says which notes fall in which class.
- **Every boot** then merges into each note's state any change made to the
  row outside the server (manual SQL, an older release) and folds editors'
  typing that had not reached the row yet.
