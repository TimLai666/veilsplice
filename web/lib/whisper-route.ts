import { authorized, type Runtime } from './finmind.ts';
import { issueCsrf, validCsrf } from './credential-route.ts';
import { handleWhisper } from './whisper-adapter.ts';
import { disableWhisper, reserveWhisper, saveWhisper, validWhisperToken, whisperAliasAvailable, whisperKeyForRequest, whisperMetadata } from './whisper-store.ts';

const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra,
} });
async function readInput(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body) throw new Error('invalid_request');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1024) throw new Error('invalid_request'); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
    return value as Record<string, unknown>;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Owner-only settings and execution. No credential reader or credential tool. */
export async function handleWhisperRoute(request: Request, env: Runtime, fetcher: (request: Request) => Promise<Response> = fetch): Promise<Response> {
  try {
    const auth = await authorized(request.headers, env);
    if (auth !== 200) return send({ error: auth === 401 ? 'unauthorized' : 'forbidden' }, auth);
    const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (url.protocol !== 'https:' || url.search || url.hash || origin && origin !== url.origin || site && !['same-origin', 'none'].includes(site)) return send({ error: 'forbidden' }, 403);
    if (url.pathname === '/api/whisper/transcribe' && request.method === 'POST') {
      return handleWhisper(request, {
        authorizeOwner: async () => true, // Dispatch identity verified immediately above.
        validateCsrf: async req => validCsrf(req),
        reserveWhisper: async () => reserveWhisper(env),
        resolveWhisperKey: async alias => alias === 'whisper_token' ? whisperKeyForRequest(env) : null,
        fetch: fetcher,
      }, { enabled: true });
    }
    if (url.pathname !== '/api/whisper/variable') return send({ error: 'not_found' }, 404);
    if (request.method === 'GET') {
      const variable = await whisperMetadata(env), csrf = issueCsrf(request);
      return send({ variable, csrf: csrf.token }, 200, { 'set-cookie': csrf.cookie });
    }
    if (!['POST', 'DELETE'].includes(request.method)) return send({ error: 'not_found' }, 404);
    if (origin !== url.origin || !validCsrf(request)) return send({ error: 'forbidden' }, 403);
    let value: Record<string, unknown>;
    try { value = await readInput(request); } catch { return send({ error: 'invalid_request' }, 400); }
    if (request.method === 'POST') {
      if (Object.keys(value).sort().join(',') !== 'consent,value' || value.consent !== true || !validWhisperToken(value.value)) return send({ error: 'invalid_request' }, 400);
      if (!await whisperAliasAvailable(env)) return send({ error: 'alias_conflict' }, 409);
      await saveWhisper(env, value.value);
    } else {
      if (Object.keys(value).length) return send({ error: 'invalid_request' }, 400);
      await disableWhisper(env);
    }
    return send({ ok: true });
  } catch {
    // Never serialize database/transport exceptions, request URLs or key values.
    return send({ error: 'unavailable' }, 503);
  }
}
