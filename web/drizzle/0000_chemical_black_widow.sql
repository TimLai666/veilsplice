CREATE TABLE `request_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`minute_window` integer NOT NULL,
	`minute_count` integer NOT NULL,
	`hour_window` integer NOT NULL,
	`hour_count` integer NOT NULL
);
