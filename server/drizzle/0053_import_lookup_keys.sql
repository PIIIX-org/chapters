-- #1008: a sync that creates or deletes files re-resolves the import rows those paths can change.
-- `lookup_keys` holds the `lookupKey` (repositories/import-resolution.ts) of every path the resolver tried
-- for the row; the extraction worker finds the rows to re-resolve with `lookup_keys && <keys of the paths>`,
-- served by the GIN index, instead of reading every row of the repository. Null = not computed yet: the
-- boot backfill (`backfillUnresolvedImports`) computes it for the rows written before this migration.
-- A deleted target used to delete the importer's row (ON DELETE CASCADE); it now leaves the row with no
-- target, as one push without that file would, and the re-resolution looks for the next candidate.
-- Numbered 0053 @ 1793250000000 (reserved on #930).
ALTER TABLE "repository_file_imports" ADD COLUMN "lookup_keys" text[];--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_file_imports_lookup_keys_idx" ON "repository_file_imports" USING gin ("lookup_keys");--> statement-breakpoint
ALTER TABLE "repository_file_imports" DROP CONSTRAINT "repository_file_imports_resolved_target_file_id_repository_files_id_fk";--> statement-breakpoint
ALTER TABLE "repository_file_imports" ADD CONSTRAINT "repository_file_imports_resolved_target_file_id_repository_files_id_fk" FOREIGN KEY ("resolved_target_file_id") REFERENCES "public"."repository_files"("id") ON DELETE set null ON UPDATE no action;
