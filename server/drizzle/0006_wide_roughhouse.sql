CREATE TYPE "public"."repository_ingestion_method" AS ENUM('git', 'local_path', 'agent_push');--> statement-breakpoint
CREATE TYPE "public"."repository_sync_status" AS ENUM('idle', 'syncing', 'error');--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"ingestion_method" "repository_ingestion_method" NOT NULL,
	"git_url" text,
	"git_credential_encrypted" text,
	"webhook_secret_encrypted" text,
	"local_path" text,
	"mergeable" boolean DEFAULT false NOT NULL,
	"sync_status" "repository_sync_status" DEFAULT 'idle' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"language" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"size" integer NOT NULL,
	"source_modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_graph_preferences" (
	"user_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"include" boolean DEFAULT false NOT NULL,
	CONSTRAINT "repository_graph_preferences_user_id_repository_id_pk" PRIMARY KEY("user_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "repository_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"grantee_type" "grantee_type" NOT NULL,
	"grantee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_sync_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "repository_sync_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_graph_preferences" ADD CONSTRAINT "repository_graph_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_graph_preferences" ADD CONSTRAINT "repository_graph_preferences_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_shares" ADD CONSTRAINT "repository_shares_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_sync_tokens" ADD CONSTRAINT "repository_sync_tokens_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repositories_owner_idx" ON "repositories" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_files_repo_path" ON "repository_files" USING btree ("repository_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_shares_unique" ON "repository_shares" USING btree ("repository_id","grantee_type","grantee_id");--> statement-breakpoint
CREATE INDEX "repository_shares_grantee_idx" ON "repository_shares" USING btree ("grantee_type","grantee_id");--> statement-breakpoint
CREATE INDEX "repository_sync_tokens_repo_idx" ON "repository_sync_tokens" USING btree ("repository_id");