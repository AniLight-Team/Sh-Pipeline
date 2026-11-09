CREATE TABLE "pipeline_encoding_batch" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"trigger_reason" text DEFAULT 'window_30m' NOT NULL,
	"kaggle_username" text,
	"dataset_slug" text,
	"kernel_slug" text,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"job_count" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_encoding_job" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"anidb_id" integer NOT NULL,
	"episode_number" integer NOT NULL,
	"types" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"known_titles" jsonb,
	"metadata" jsonb,
	"callback_url" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"torrent_magnet" text,
	"torrent_title" text,
	"torrent_id" integer,
	"staged_file_path" text,
	"size_bytes" bigint,
	"tracks_config" jsonb,
	"subtitles_payload" jsonb,
	"result_payload" jsonb,
	"batch_id" bigint,
	"last_error" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_encoding_job" ADD CONSTRAINT "pipeline_encoding_job_batch_id_pipeline_encoding_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."pipeline_encoding_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sh_pipeline_batch_status_idx" ON "pipeline_encoding_batch" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sh_pipeline_batch_user_idx" ON "pipeline_encoding_batch" USING btree ("kaggle_username","status");--> statement-breakpoint
CREATE INDEX "sh_pipeline_batch_heartbeat_idx" ON "pipeline_encoding_batch" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "sh_pipeline_job_status_idx" ON "pipeline_encoding_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sh_pipeline_job_anidb_idx" ON "pipeline_encoding_job" USING btree ("anidb_id","episode_number");--> statement-breakpoint
CREATE INDEX "sh_pipeline_job_batch_idx" ON "pipeline_encoding_job" USING btree ("batch_id");