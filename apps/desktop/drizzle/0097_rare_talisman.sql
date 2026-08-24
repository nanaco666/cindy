ALTER TABLE `bot_group_rooms` ADD `avatar` text DEFAULT '👥' NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_profiles` ADD `hidden_at` integer;--> statement-breakpoint
ALTER TABLE `bot_profiles` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `bot_profiles` ADD `attention_reason` text;--> statement-breakpoint
ALTER TABLE `bot_profiles` ADD `attention_at` integer;