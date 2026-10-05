ALTER TABLE "repository_file_symbols" ADD COLUMN "snippet" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "repository_file_symbols" ADD COLUMN "embedding" vector(384); EXCEPTION WHEN OTHERS THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX "repository_file_symbols_name_idx" ON "repository_file_symbols" USING btree ("name");