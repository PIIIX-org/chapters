ALTER TABLE "repository_file_symbols" ADD COLUMN "snippet" text;--> statement-breakpoint
ALTER TABLE "repository_file_symbols" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
CREATE INDEX "repository_file_symbols_name_idx" ON "repository_file_symbols" USING btree ("name");