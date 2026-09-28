CREATE TABLE `vl_assets` (
	`owner` text NOT NULL,
	`campaign` text NOT NULL,
	`hash` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`objectKey` text NOT NULL,
	PRIMARY KEY(`owner`, `campaign`, `hash`)
);
--> statement-breakpoint
CREATE TABLE `vl_branches` (
	`owner` text NOT NULL,
	`campaign` text NOT NULL,
	`id` text NOT NULL,
	`base` integer NOT NULL,
	`server` integer NOT NULL,
	`sha` text NOT NULL,
	`snapshot` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `vl_downloads` (
	`token` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`objectKey` text NOT NULL,
	`mime` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vl_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "atomic_precondition" CHECK("vl_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE `vl_heads` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer NOT NULL,
	`sha` text NOT NULL,
	`snapshot` text NOT NULL,
	`writer` text,
	`lease` integer NOT NULL,
	`generation` integer NOT NULL,
	`updated` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE TABLE `vl_parts` (
	`owner` text NOT NULL,
	`upload` text NOT NULL,
	`number` integer NOT NULL,
	`etag` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha` text NOT NULL,
	PRIMARY KEY(`owner`, `upload`, `number`)
);
--> statement-breakpoint
CREATE TABLE `vl_receipts` (
	`owner` text NOT NULL,
	`campaign` text NOT NULL,
	`id` text NOT NULL,
	`sha` text NOT NULL,
	`receipt` text NOT NULL,
	PRIMARY KEY(`owner`, `campaign`, `id`)
);
--> statement-breakpoint
CREATE TABLE `vl_revisions` (
	`owner` text NOT NULL,
	`campaign` text NOT NULL,
	`revision` integer NOT NULL,
	`sha` text NOT NULL,
	`snapshot` text NOT NULL,
	PRIMARY KEY(`owner`, `campaign`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `vl_uploads` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`campaign` text NOT NULL,
	`hash` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`objectKey` text NOT NULL,
	`multipart` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
