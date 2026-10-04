CREATE TABLE `service_credentials` (
	`owner_hash` text NOT NULL,
	`service` text NOT NULL,
	`token` text,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	PRIMARY KEY(`owner_hash`, `service`)
);
