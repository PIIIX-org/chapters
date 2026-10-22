-- #501: long revision histories are compacted instead of keeping a full copy
-- of the note per revision. A compacted revision keeps `body = ''` and stores
-- `body_delta`, the edit from its base `delta_base_id` (a full revision of
-- the same note, never itself compacted) to its body, and `body_bytes`, the
-- UTF-8 size of that body. Compaction is lossless: `note_revision_body`
-- returns every revision's body exactly (notes/revision-compaction.ts).
--
-- The schema change is additive (nullable columns, a check older code cannot
-- violate because it never sets them, and a foreign key with NO ACTION, so
-- older code can never delete a base a delta still needs), but the data is
-- not: older code reads `body` directly and shows a compacted revision as
-- empty. A code-only rollback therefore needs the UPDATE in backup.md §5
-- first, which stores every revision whole again.
ALTER TABLE "note_revisions"
  ADD COLUMN "body_delta" jsonb,
  ADD COLUMN "delta_base_id" uuid,
  ADD COLUMN "body_bytes" integer,
  ADD CONSTRAINT "note_revisions_delta_base_id_fkey" FOREIGN KEY ("delta_base_id") REFERENCES "note_revisions"("id"),
  ADD CONSTRAINT "note_revisions_delta_check" CHECK (("body_delta" IS NULL) = ("delta_base_id" IS NULL) AND ("body_delta" IS NULL) = ("body_bytes" IS NULL));--> statement-breakpoint
CREATE INDEX "note_revisions_delta_base" ON "note_revisions" ("delta_base_id") WHERE "delta_base_id" IS NOT NULL;--> statement-breakpoint
-- Per note, the `ord` of the newest revision compaction has decided on
-- (compacted or kept whole): the next run starts after it, so a revision that
-- did not compress is not diffed again at every run (#880).
CREATE TABLE "note_revision_compaction" (
  "note_id" uuid PRIMARY KEY REFERENCES "notes"("id") ON DELETE CASCADE,
  "examined_through" bigint NOT NULL
);--> statement-breakpoint
-- A delta is a JSON array of pieces, concatenated: a string is literal text,
-- a pair [from, count] copies `count` bytes of the base's UTF-8 encoding from
-- byte `from` (1-based). Pieces are cut on line boundaries, never inside a
-- character. The base is converted to bytes once (a MATERIALIZED CTE, so the
-- planner cannot inline the conversion into every piece) and every piece is
-- a bytea substring (constant time), so a patch costs the size of the
-- result, not pieces x base size (a character offset makes substr walk the
-- text from its start for every piece).
CREATE FUNCTION note_revision_patch(base text, delta jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH src AS MATERIALIZED (SELECT convert_to(base, 'UTF8') AS bytes)
  SELECT convert_from(coalesce(string_agg(
    CASE jsonb_typeof(piece) WHEN 'string' THEN convert_to(piece #>> '{}', 'UTF8')
      ELSE substring(src.bytes FROM (piece->>0)::int FOR (piece->>1)::int) END,
    ''::bytea ORDER BY i), ''::bytea), 'UTF8')
  FROM src, jsonb_array_elements(delta) WITH ORDINALITY AS pieces(piece, i)
$$;--> statement-breakpoint
-- A revision's body: `body` when it is stored whole, else its delta applied to its base's body.
CREATE FUNCTION note_revision_body(body text, delta jsonb, base_id uuid) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN delta IS NULL THEN body
    ELSE (SELECT note_revision_patch(b.body, delta) FROM note_revisions b WHERE b.id = base_id) END
$$;
