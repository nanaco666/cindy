CREATE TABLE `bot_group_member_watermarks` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `bot_group_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_member_watermarks_room_bot_thread` ON `bot_group_member_watermarks` (`room_id`,`bot_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_group_member_watermarks_room_thread` ON `bot_group_member_watermarks` (`room_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `bot_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`member_session_id` text NOT NULL,
	`roster_order` integer NOT NULL,
	`watermark` integer DEFAULT 0 NOT NULL,
	`hold_at` integer,
	`hold_message_id` text,
	`hold_thread_id` text,
	`hold_noted` integer DEFAULT false NOT NULL,
	`stranded_before_sequence` integer,
	`stranded_thread_id` text,
	`stranded_started_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `bot_group_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_members_room_bot` ON `bot_group_members` (`room_id`,`bot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_members_room_order` ON `bot_group_members` (`room_id`,`roster_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_members_session` ON `bot_group_members` (`member_session_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_group_members_bot_room` ON `bot_group_members` (`bot_id`,`room_id`);--> statement-breakpoint
CREATE TABLE `bot_group_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`room_session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`running` integer DEFAULT false NOT NULL,
	`needs_user` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_rooms_session` ON `bot_group_rooms` (`room_session_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_group_rooms_status_updated` ON `bot_group_rooms` (`status`,`updated_at`);