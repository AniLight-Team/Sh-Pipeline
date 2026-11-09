ALTER TABLE "pipeline_encoding_job" ALTER COLUMN "anidb_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN "anilist_id" integer;--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD COLUMN "anime_id" integer;--> statement-breakpoint
CREATE INDEX "sh_pipeline_job_anilist_idx" ON "pipeline_encoding_job" USING btree ("anilist_id","episode_number");--> statement-breakpoint
CREATE INDEX "sh_pipeline_job_anime_idx" ON "pipeline_encoding_job" USING btree ("anime_id");