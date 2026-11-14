CREATE TABLE "room_history" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_joined_at" timestamp with time zone NOT NULL,
	"last_joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_history_user_id_room_id_pk" PRIMARY KEY("user_id","room_id")
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "room_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"sender_name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_playback_states" (
	"room_id" text PRIMARY KEY NOT NULL,
	"playback" jsonb NOT NULL,
	"active_index" integer DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_played_songs" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"member_id" text NOT NULL,
	"track" jsonb NOT NULL,
	"playback_version" integer NOT NULL,
	"played_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_room_playlist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"track" jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"password_hash" text,
	"max_members" integer NOT NULL,
	"max_stage_members" integer NOT NULL,
	"current_member_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"empty_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "rooms_code_unique" UNIQUE("code"),
	CONSTRAINT "rooms_capacity_check" CHECK ("rooms"."max_members" between 2 and 50 and "rooms"."max_stage_members" between 1 and 30 and "rooms"."max_stage_members" <= "rooms"."max_members")
);
--> statement-breakpoint
ALTER TABLE "room_history" ADD CONSTRAINT "room_history_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_history" ADD CONSTRAINT "room_history_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_playback_states" ADD CONSTRAINT "room_playback_states_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_played_songs" ADD CONSTRAINT "room_played_songs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_played_songs" ADD CONSTRAINT "room_played_songs_member_id_user_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_room_playlist_items" ADD CONSTRAINT "user_room_playlist_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_history_user_time_idx" ON "room_history" USING btree ("user_id","last_joined_at","room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_one_active_idx" ON "room_members" USING btree ("user_id") WHERE "room_members"."left_at" is null;--> statement-breakpoint
CREATE INDEX "room_messages_time_idx" ON "room_messages" USING btree ("room_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_played_version_idx" ON "room_played_songs" USING btree ("room_id","playback_version");--> statement-breakpoint
CREATE INDEX "room_played_time_idx" ON "room_played_songs" USING btree ("room_id","played_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_playlist_user_track_idx" ON "user_room_playlist_items" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "room_playlist_position_idx" ON "user_room_playlist_items" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "rooms_status_active_idx" ON "rooms" USING btree ("status","last_active_at");--> statement-breakpoint
CREATE INDEX "rooms_owner_idx" ON "rooms" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "rooms_expiry_idx" ON "rooms" USING btree ("expires_at");