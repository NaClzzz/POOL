CREATE TABLE "liked_songs" (
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text,
	"author" text,
	"album" text,
	"duration_ms" integer,
	"cover_url" text,
	"extra" jsonb,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liked_songs_user_id_source_source_id_pk" PRIMARY KEY("user_id","source","source_id"),
	CONSTRAINT "liked_songs_source_check" CHECK ("liked_songs"."source" in ('netease', 'bilibili')),
	CONSTRAINT "liked_songs_duration_check" CHECK ("liked_songs"."duration_ms" is null or "liked_songs"."duration_ms" > 0)
);
--> statement-breakpoint
ALTER TABLE "liked_songs" ADD CONSTRAINT "liked_songs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "liked_songs_user_added_idx" ON "liked_songs" USING btree ("user_id","added_at" DESC NULLS LAST);