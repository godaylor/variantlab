CREATE TABLE `vl_render_batches` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`campaign` text NOT NULL,
	`revision` integer NOT NULL,
	`requestHash` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vl_render_request` ON `vl_render_batches` (`owner`,`requestHash`);--> statement-breakpoint
CREATE TABLE `vl_render_jobs` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`batch` text NOT NULL,
	`campaign` text NOT NULL,
	`job` text NOT NULL,
	`manifest` text NOT NULL,
	`state` text NOT NULL,
	`generation` integer NOT NULL,
	`lease` integer NOT NULL,
	`token` text NOT NULL,
	`artifact` text,
	`sha` text,
	`bytes` integer,
	`uploadId` text,
	`uploadKey` text,
	`parts` text,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `vl_render_dispatch` ON `vl_render_jobs` (`state`,`lease`);--> statement-breakpoint
CREATE INDEX `vl_render_batch` ON `vl_render_jobs` (`owner`,`batch`);--> statement-breakpoint
CREATE TABLE `vl_render_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`expires` integer NOT NULL
);
