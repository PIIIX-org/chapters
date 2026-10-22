# Store migration (ADR-003): dry run, migration and rollback

Postgres is the one authoritative store for notes: it holds the truth, and
the `.md` files, directory `index.md` files and embeddings are projections
rebuilt from it (vault note `decision/adr-003-authoritative-store`). This has
shipped, in slices: **S1** (schema, migration 0021, and the read-only dry
run below), **S2a** (every server write is one database transaction; your
notes are migrated once, at the first boot; `store-export-legacy` for a
rollback), **S2b** (the editors' live state moves from `.crdt/` files into
the database, below) and **S3** (editor typing is committed to the database
before the editor is told it is saved). The current release has all of
them. Promotion step A (`ae6ffb9`; `prod` commit `f3724d0`, which reports
that `version`) shipped S1 and the S2a migration only, without
`store-export-legacy` and without S2b and S3.

## Before you upgrade

1. Take a verified backup right before: the pg_dump and the data volume
   (backup.md §1). From the first boot of the new release on, the database
   is the copy that matters, and for some releases restoring this backup is
   the only way back (backup.md §5, "Which way back").
2. Run the dry run below on a copy (or on production: it is read-only) and
   read its `conflicts` list: those notes' files win over their rows.
3. Reload every open editor tab, and upgrade when nobody is typing.
4. Plan for the app being down during the first boot (next section).

## The first boot: the app is down while it migrates

The server answers nothing, `/health` included, until the migrations, the
store backfill, the projector's first run and (from S2b) the collab
backfill have finished; only then does it listen. Docker reports the
container as `starting` meanwhile. On the #703 rehearsals, a copy of
production with 944 notes, 3206 revisions (32 MB) and 355 `.crdt` bins,
`docker compose up` to the first `/health` answer took:

| Release | First boot | Of which |
|---|---|---|
| Step A (S2a, migrations 0021–0025) | 27–54 s | store backfill 21–32 s |
| S2a + S2b (`aa73289`) | 28–33 s | store backfill 12–16 s, collab backfill 4–5 s |

Plan for 30–60 s at that size; the time grows with the number of notes and
the size of `note_revisions` (see "Estimating the migration time"). The
spread comes from the host's load, not from how the previous release
stopped. Later boots skip the backfills (their markers are set) and take a
few seconds.

## What happens at the first boot

- **Migration 0021** (if S1 has not applied it yet) runs first. It only
  adds: two columns and a trigger on `notes`, three columns and two partial
  unique indexes on `note_revisions`, five new tables (`note_crdt`,
  `note_updates`, `note_projections`, `projected_files`, `jobs`) and two
  marker columns on `instance_state`. Building the two indexes scans
  `note_revisions` once while holding a write lock on it.
- **The backfill** runs before the app answers any request (no write can
  interleave), once: `instance_state.store_migrated_at` marks it done. It
  walks every note, live and trashed, one transaction per note, so a crash
  or a kill rolls back only the note in flight and the next boot resumes.
  Per note it does what the dry run reports: a file that differs from its
  row wins (the row's text is kept as a `migration:row-kept` revision), an
  unparseable file is copied to `vaults/<id>/.migration/<date>/unparseable/`
  and the row kept, a hand-formatted file whose content equals the row is
  adopted with its bytes, and every note gets a revision at its current
  `seq`. Leftover `*.tmp` files are deleted. `.crdt/` is not touched here
  (the S2b collab backfill, below, moves it into the database).
- It writes `DATA_DIR/migration-report-<time>.json` (counts per class, the
  conflict list, failures) and logs a one-line `[store] backfill:` summary.
  A note that fails is listed and the marker is not set, so the next boot
  tries it again; the app still starts.
- Once the backfill has finished, the projector writes every file that
  changes bytes, with the old bytes copied to `vaults/<id>/.conflicts/`
  first, and the server starts serving only once files equal rows. (For an
  unparseable file that copy holds the same bytes as its
  `.migration/<date>/unparseable/` copy; `pnpm doctor` lists it as
  `INFO migration-copy`, not as a problem: backup.md "The doctor".)
  While the app runs afterwards, each save is written to its file a moment
  after it commits.
- On every later boot: rows changed outside the store (an older release
  during a rollback, a restore, manual SQL) get their projection rows and a
  revision at their `seq`; after an unclean shutdown every file is verified
  against its row; `.md` files with no owner are moved to
  `vaults/<id>/.orphans/` (never deleted). See backup.md "Files Elara set
  aside".

## Rolling back

Starting an older release on a database this migration has run on is not
safe by itself. Releases before S2a read the `.md` files as the truth, and
here they can lag behind the database. Promotion step A reads the rows, but
its editor relay reads `.crdt/` bins, which S2b moved into the database, and
it reads revision bodies whole, which migration 0026 compacts. Which way
back you have depends on the release you run; backup.md §5, "Which way
back", has the table. In short:

- **From a release with `store-export-legacy`** (the current release, from
  promotion step B on) to promotion step A or any older release: stop the
  app, run the export, run the migration 0026 `UPDATE`, start the older
  release. This is the only way that keeps what was written since the
  upgrade.
- **From promotion step A** (`ae6ffb9`, `prod` commit `f3724d0`: S2a
  without the export): restore the pre-upgrade backup. What was written
  since the upgrade is lost.
- **Either way**, restoring the pre-upgrade backup works.

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
- It runs no migrations and needs `--dry-run` (exit code 2 without it): the
  migration itself runs at the first boot of S2a (above).
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
| `crdt` (live notes) | `matches-row`, `matches-file`, `matches-revision` | the bin is attached to the note in S2b (its history is kept); these compare the body only, `collab` says whether the frontmatter matches too |
| | `mismatch`, `undecodable` | the bin is set aside in S2b and the note is seeded fresh on first open |
| | `missing` | no bin; seeded on first open, as today |
| `collab` (live notes) | `attach-equal` / `attach-diffed` / `set-aside` / `seed` / `has-state` | what the S2b backfill does with the note: attaches its bin as is (body and frontmatter equal the row as S2a leaves it: the file's content when the file wins) or with a diff to that row on top (the boot report's `attached.equal` / `attached.diffed`), moves the bin to `.migration/<date>/bins/`, nothing until first open (no bin), or nothing because the note already has its CRDT state in the database; `counts.collab` has the totals |
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
  note. The dry run does not delete them; S2a's boot moves unowned `.md`
  files to `.orphans/`. Generated directory `index.md` files are counted in
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
