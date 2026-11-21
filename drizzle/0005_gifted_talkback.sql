CREATE TABLE "pipeline_anime_rule" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"anilist_id" integer,
	"anime_id" integer,
	"episode_offset" integer DEFAULT 0 NOT NULL,
	"source_tsukihime_id" integer,
	"source_anidb_id" integer,
	"search_titles" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_anime_rule_anilist_id_unique" UNIQUE("anilist_id")
);
--> statement-breakpoint
CREATE INDEX "sh_pipeline_anime_rule_anime_idx" ON "pipeline_anime_rule" USING btree ("anime_id");