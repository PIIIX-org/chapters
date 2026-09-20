CREATE TABLE "user_vault_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"storage_mode" text DEFAULT 'online' NOT NULL,
	"folders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"folder_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vault_colors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"favorites" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_vault_preferences" ADD CONSTRAINT "user_vault_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
