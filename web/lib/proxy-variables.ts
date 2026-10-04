import { credentialConfigured, disableCredential, validToken } from './credentials.ts';
import type { Runtime } from './finmind.ts';
export const validVariableName = (value: unknown): value is string => typeof value === 'string'
  && /^[a-z][a-z0-9_]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const DEFAULT_ALIAS = 'finmind_token';
function db(env: Runtime): D1Database {
  if (!env.DB || !/^[a-f0-9]{64}$/.test(env.OWNER_EMAIL_SHA256 ?? '')) throw new Error('Unavailable');
  return env.DB;
}
export async function variableMetadata(env: Runtime) {
  // The SELECT never retrieves the token column. Empty stores keep the default name.
  const row = await db(env).prepare('SELECT alias, updated_at FROM service_credentials WHERE owner_hash = ? AND service = ?')
    .bind(env.OWNER_EMAIL_SHA256!, 'finmind').first<{ alias: string; updated_at: number }>();
  const alias = row ? row.alias : DEFAULT_ALIAS;
  if (!validVariableName(alias) || row && (!Number.isSafeInteger(row.updated_at) || row.updated_at < 0)) throw new Error('Unavailable');
  const configured = await credentialConfigured(env);
  return { alias, configured, active: configured, version: row?.updated_at ?? 0 };
}
export async function saveVariable(env: Runtime, alias: string, value?: string): Promise<void> {
  if (!validVariableName(alias) || value !== undefined && !validToken(value)) throw new Error('Invalid input');
  const now = Date.now();
  if (value !== undefined) {
    // One atomic replacement of the existing FinMind row; never copy/read back a key.
    await db(env).prepare('INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at, alias) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(owner_hash, service) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at, disabled_at = NULL, alias = excluded.alias')
      .bind(env.OWNER_EMAIL_SHA256!, 'finmind', value, now, alias).run();
  } else {
    // Renaming needs no token read. An absent credential remains disabled.
    await db(env).prepare('INSERT INTO service_credentials (owner_hash, service, token, updated_at, disabled_at, alias) VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(owner_hash, service) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at')
      .bind(env.OWNER_EMAIL_SHA256!, 'finmind', now, now, alias).run();
  }
}
export async function disableVariable(env: Runtime, alias: string): Promise<void> {
  if ((await variableMetadata(env)).alias !== alias) throw new Error('Invalid input');
  await disableCredential(env);
}
