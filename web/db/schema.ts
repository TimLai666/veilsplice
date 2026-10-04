import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
// Bounded shared request counters. No account payloads or price data are stored.
export const requestLimits = sqliteTable("request_limits", {
 id: text("id").primaryKey(), minuteWindow: integer("minute_window").notNull(), minuteCount: integer("minute_count").notNull(), hourWindow: integer("hour_window").notNull(), hourCount: integer("hour_count").notNull(),
});

// Platform-managed D1 encryption at rest, not application-layer ciphertext.
// Only owner-submitted, service-scoped FinMind and Whisper tokens are stored. Never inspect this table's
// values through admin tools or expose a token-reading application endpoint.
export const serviceCredentials = sqliteTable("service_credentials", {
 ownerHash: text("owner_hash").notNull(), service: text("service").notNull(),
 token: text("token"), updatedAt: integer("updated_at").notNull(), disabledAt: integer("disabled_at"),
 alias: text("alias").notNull().default("finmind_token"),
}, table => [primaryKey({ columns: [table.ownerHash, table.service] })]);
