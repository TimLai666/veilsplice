/** Server-only FinMind credential storage.
 * D1 provides platform-managed encryption at rest. The application and database
 * administrators can read the original token; this is NOT application ciphertext.
 * Never import this module into client code or return a stored token to a caller.
 */
export type CredentialRuntime = { OWNER_EMAIL_SHA256?: string; DB?: D1Database };
const SERVICE = "finmind";
export const validToken = (token: unknown): token is string => typeof token === "string" && token.length >= 10 && token.length <= 8192 && /^[\x21-\x7E]+$/.test(token);
function requireStore(env: CredentialRuntime): D1Database {
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.OWNER_EMAIL_SHA256 ?? "")) throw new Error("Credential storage unavailable");
  return env.DB;
}
export async function credentialConfigured(env: CredentialRuntime): Promise<boolean> {
  // Status never selects the token column.
  const row = await requireStore(env).prepare("SELECT 1 AS configured FROM service_credentials WHERE owner_hash = ? AND service = ? AND disabled_at IS NULL AND token IS NOT NULL")
    .bind(env.OWNER_EMAIL_SHA256!, SERVICE).first<{ configured: number }>();
  return row?.configured === 1;
}
export async function credentialForRequest(env: CredentialRuntime): Promise<string | null> {
  const row = await requireStore(env).prepare("SELECT token FROM service_credentials WHERE owner_hash = ? AND service = ? AND disabled_at IS NULL")
    .bind(env.OWNER_EMAIL_SHA256!, SERVICE).first<{ token: string | null }>();
  return validToken(row?.token) ? row.token : null;
}
export async function saveCredential(env: CredentialRuntime, token: string): Promise<void> {
  if (!validToken(token)) throw new Error("Invalid credential format");
  await requireStore(env).prepare("INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(owner_hash, service) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at, disabled_at = NULL")
    .bind(env.OWNER_EMAIL_SHA256!, SERVICE, token, Date.now()).run();
}
export async function disableCredential(env: CredentialRuntime): Promise<void> {
  const now = Date.now();
  // Retain a disabled marker; never fall back to a legacy environment token.
  // This does not erase platform backups or cancel already-started requests.
  await requireStore(env).prepare("INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at) VALUES (?, ?, NULL, ?, ?) ON CONFLICT(owner_hash, service) DO UPDATE SET token = NULL, updated_at = excluded.updated_at, disabled_at = excluded.disabled_at")
    .bind(env.OWNER_EMAIL_SHA256!, SERVICE, now, now).run();
}
