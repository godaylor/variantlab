CREATE TABLE `vl_render_batch_jobs` (
	`owner` text NOT NULL,
	`batch` text NOT NULL,
	`job` text NOT NULL,
	PRIMARY KEY(`owner`, `batch`, `job`)
);
--> statement-breakpoint
ALTER TABLE `vl_render_jobs` ADD `idempotency` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vl_render_idempotency` ON `vl_render_jobs` (`owner`,`idempotency`);