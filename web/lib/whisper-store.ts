import type { Runtime } from './finmind.ts';

export const WHISPER_ALIAS = 'whisper_token';
export const WHISPER_SERVICE = 'whisper';
// infra-manager's published generator produces 16 random bytes as lowercase hex.
export const validWhisperToken = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
function db(env: Runtime): D1Database {
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.OWNER_EMAIL_SHA256 ?? '')) throw new Error('unavailable');
  return env.DB;
}
export async function whisperMetadata(env: Runtime) {
  // No plaintext key is selected for settings/status responses.
  const row = await db(env).prepare('SELECT alias, updated_at, CASE WHEN disabled_at IS NULL AND token IS NOT NULL THEN 1 ELSE 0 END AS configured FROM service_credentials WHERE owner_hash = ? AND service = ?')
    .bind(env.OWNER_EMAIL_SHA256!, WHISPER_SERVICE).first<{ alias: string; updated_at: number; configured: number }>();
  if (row && (row.alias !== WHISPER_ALIAS || !Number.isSafeInteger(row.updated_at) || row.updated_at < 0 || ![0, 1].includes(row.configured))) throw new Error('unavailable');
  return { alias: WHISPER_ALIAS, configured: row?.configured === 1, active: row?.configured === 1, version: row?.updated_at ?? 0 };
}
export async function whisperAliasAvailable(env: Runtime): Promise<boolean> {
  // Check only metadata; a pre-existing FinMind alias may need an owner rename.
  const conflict = await db(env).prepare('SELECT 1 AS conflict FROM service_credentials WHERE owner_hash = ? AND service = ? AND alias = ?')
    .bind(env.OWNER_EMAIL_SHA256!, 'finmind', WHISPER_ALIAS).first();
  return !conflict;
}
export async function saveWhisper(env: Runtime, value: string): Promise<void> {
  if (!validWhisperToken(value)) throw new Error('invalid_request');
  await db(env).prepare('INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at, alias) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(owner_hash, service) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at, disabled_at = NULL, alias = excluded.alias')
    .bind(env.OWNER_EMAIL_SHA256!, WHISPER_SERVICE, value, Date.now(), WHISPER_ALIAS).run();
}
export async function disableWhisper(env: Runtime): Promise<void> {
  const now = Date.now();
  // Clear only this service's current row; backups/in-flight jobs are unaffected.
  await db(env).prepare('INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at, alias) VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(owner_hash, service) DO UPDATE SET token = NULL, updated_at = excluded.updated_at, disabled_at = excluded.disabled_at, alias = excluded.alias')
    .bind(env.OWNER_EMAIL_SHA256!, WHISPER_SERVICE, now, now, WHISPER_ALIAS).run();
}
export async function whisperKeyForRequest(env: Runtime): Promise<string | null> {
  const row = await db(env).prepare('SELECT token FROM service_credentials WHERE owner_hash = ? AND service = ? AND alias = ? AND disabled_at IS NULL')
    .bind(env.OWNER_EMAIL_SHA256!, WHISPER_SERVICE, WHISPER_ALIAS).first<{ token: string | null }>();
  return validWhisperToken(row?.token) ? row.token : null;
}
const LIMIT_SQL = `INSERT INTO request_limits (id, minute_window, minute_count, hour_window, hour_count) VALUES ('whisper', ?, 1, ?, 1) ON CONFLICT(id) DO UPDATE SET minute_window=MAX(request_limits.minute_window,excluded.minute_window), minute_count=CASE WHEN request_limits.minute_window>=excluded.minute_window THEN request_limits.minute_count+1 ELSE 1 END, hour_window=MAX(request_limits.hour_window,excluded.hour_window), hour_count=CASE WHEN request_limits.hour_window>=excluded.hour_window THEN request_limits.hour_count+1 ELSE 1 END WHERE (request_limits.minute_window<excluded.minute_window OR request_limits.minute_count<2) AND (request_limits.hour_window<excluded.hour_window OR request_limits.hour_count<20) RETURNING id`;
export async function reserveWhisper(env: Runtime, now = Date.now()): Promise<boolean> {
  // Shared persistent D1 mechanism, independently keyed budget: 2/minute, 20/hour.
  // Store failure propagates as unavailable, never as permission to proceed.
  return !!await db(env).prepare(LIMIT_SQL).bind(Math.floor(now / 60000), Math.floor(now / 3600000)).first();
}
