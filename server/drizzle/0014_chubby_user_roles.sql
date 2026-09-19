ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'owner';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'superadmin';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'moderator';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'editor';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'contributor';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'guest';
