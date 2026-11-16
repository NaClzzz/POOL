CREATE TABLE "room_summaries" (
	"room_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempt_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"content" text,
	"started_at" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "room_summary_status_check" CHECK ("room_summaries"."status" in ('generating','failed','succeeded')),
	CONSTRAINT "room_summary_content_check" CHECK (("room_summaries"."status" = 'succeeded' and "room_summaries"."content" is not null and "room_summaries"."generated_at" is not null) or ("room_summaries"."status" <> 'succeeded' and "room_summaries"."content" is null))
);
--> statement-breakpoint
ALTER TABLE "room_summaries" ADD CONSTRAINT "room_summaries_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_summaries" ADD CONSTRAINT "room_summaries_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;