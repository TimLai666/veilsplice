/** Bounded multipart transport. The owner route supplies scoped storage and fetch. */
export const WHISPER_TEMPLATE = 'https://infra.hazelnut-paradise.com/use/whisper/{{whisper_token}}/v1/audio/transcriptions';
export const LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, envelopeOverhead: 65536, responseBytes: 256 * 1024, totalMs: 60000 });
export const DEFAULT_CONFIG = Object.freeze({ enabled: false, totalMs: LIMITS.totalMs });
type Config = { enabled?: boolean; totalMs?: number };
export type Dependencies = {
  authorizeOwner: (request: Request, signal: AbortSignal) => Promise<boolean>;
  validateCsrf: (request: Request, signal: AbortSignal) => Promise<boolean>;
  // Must reserve only an independently persisted Whisper budget in deployment.
  reserveWhisper: (signal: AbortSignal) => Promise<boolean>;
  resolveWhisperKey: (alias: 'whisper_token', signal: AbortSignal) => Promise<string | null>;
  fetch: (request: Request) => Promise<Response>;
};
type Code = 'disabled' | 'forbidden' | 'invalid_request' | 'too_large' | 'rate_limited' | 'secret_unavailable' | 'redirect_denied' | 'upstream_error' | 'invalid_response' | 'timeout' | 'unavailable';
class Failure extends Error {
  code: Code;
  constructor(code: Code) { super(code); this.code = code; }
}
const codes = new Set<Code>(['disabled', 'forbidden', 'invalid_request', 'too_large', 'rate_limited', 'secret_unavailable', 'redirect_denied', 'upstream_error', 'invalid_response', 'timeout', 'unavailable']);
function fail(code: Code): never { throw new Failure(code); }
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" } });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function only(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); fail('timeout'); }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Failure('timeout'));
    signal.addEventListener('abort', aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function boundedBody(message: Request | Response, max: number, signal: AbortSignal, error: Code): Promise<Uint8Array<ArrayBuffer>> {
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) fail(error);
  if (!message.body) fail(error);
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      count += part.value.byteLength;
      if (count > max) fail(error);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function containsKey(text: string, key: string): boolean {
  // Reject direct and common encoded echoes of this URL-safe key. This is a
  // response guard, not a claim to detect every deliberate obfuscation.
  let decoded = text;
  for (let n = 0; n < 2; n++) decoded = decoded.replace(/%([0-9a-f]{2})/gi, (_all, code: string) => String.fromCharCode(parseInt(code, 16)));
  return decoded.toLowerCase().includes(key) || text.includes(btoa(key));
}
async function attachment(request: Request, signal: AbortSignal): Promise<{ file: File; model: string; language?: string }> {
  const type = request.headers.get('content-type') ?? '';
  if (type.length > 256 || !/^multipart\/form-data\s*;/i.test(type)) fail('invalid_request');
  const bytes = await boundedBody(request, LIMITS.fileBytes + LIMITS.envelopeOverhead, signal, 'too_large');
  let form: FormData;
  try { form = await abortable(new Response(bytes, { headers: { 'content-type': type } }).formData(), signal); }
  catch (error) { if (error instanceof Failure) throw error; fail('invalid_request'); }
  const seen = new Set<string>();
  for (const [name] of form) {
    if (!['request', 'audio'].includes(name) || seen.has(name)) fail('invalid_request');
    seen.add(name);
  }
  if (seen.size !== 2) fail('invalid_request');
  const encoded = form.get('request'), file = form.get('audio');
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).length > 16384 || !(file instanceof File) || file.size === 0) fail('invalid_request');
  if (file.size > LIMITS.fileBytes) fail('too_large');
  // Candidate MIME allowlist, not a claim that file contents/duration are decoded.
  if (!['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/flac'].includes(file.type)) fail('invalid_request');
  let template: unknown;
  try { template = JSON.parse(encoded); } catch { fail('invalid_request'); }
  if (!only(template, ['url', 'method', 'multipart']) || template.url !== WHISPER_TEMPLATE || template.method !== 'POST') fail('invalid_request');
  const parts = template.multipart;
  if (!only(parts, ['file', 'model', 'language']) || !only(parts.file, ['attachment']) || parts.file.attachment !== 'audio') fail('invalid_request');
  if (parts.model !== undefined && !['whisper-1', 'turbo'].includes(parts.model as string)) fail('invalid_request');
  // Deliberately narrow candidate subset; wider language forms require review.
  if (parts.language !== undefined && (typeof parts.language !== 'string' || !/^[a-z]{2,3}$/.test(parts.language))) fail('invalid_request');
  return { file, model: typeof parts.model === 'string' ? parts.model : 'whisper-1', ...(parts.language === undefined ? {} : { language: parts.language as string }) };
}

export async function handleWhisper(request: Request, deps: Dependencies, config: Config = DEFAULT_CONFIG): Promise<Response> {
  // Only the authenticated server route enables execution. A live service binding
  // remains an end-to-end acceptance check, not an assertion made by this flag.
  if (config.enabled !== true) return json({ error: 'disabled' }, 503);
  const budget = config.totalMs ?? LIMITS.totalMs;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > LIMITS.totalMs) return json({ error: 'disabled' }, 503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const onCancel = () => controller.abort();
  request.signal.addEventListener('abort', onCancel, { once: true });
  if (request.signal.aborted) controller.abort();
  let key = '', dispatched = false;
  try {
    const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (url.protocol !== 'https:' || url.pathname !== '/api/whisper/transcribe' || url.search || url.hash || request.method !== 'POST') fail('invalid_request');
    if (origin !== url.origin || site && !['same-origin', 'none'].includes(site)) fail('forbidden');
    if (!await abortable(deps.authorizeOwner(request, controller.signal), controller.signal) || !await abortable(deps.validateCsrf(request, controller.signal), controller.signal)) fail('forbidden');
    const input = await attachment(request, controller.signal);
    if (!await abortable(deps.reserveWhisper(controller.signal), controller.signal)) fail('rate_limited');
    key = await abortable(deps.resolveWhisperKey('whisper_token', controller.signal), controller.signal) ?? '';
    if (!/^[0-9a-f]{32}$/.test(key)) fail('secret_unavailable');
    const outgoing = new FormData();
    // Fixed filename avoids copying unrelated local path/filename metadata.
    outgoing.set('file', input.file, 'audio');
    outgoing.set('model', input.model);
    outgoing.set('advanced', 'false');
    if (input.language !== undefined) outgoing.set('language', input.language);
    const target = WHISPER_TEMPLATE.replace('{{whisper_token}}', key);
    const upstream = new Request(target, { method: 'POST', body: outgoing, redirect: 'manual', credentials: 'omit', signal: controller.signal });
    dispatched = true;
    const response = await abortable(deps.fetch(upstream), controller.signal);
    if (response.status >= 300 && response.status < 400 || response.redirected || response.type === 'opaqueredirect') { void response.body?.cancel().catch(() => {}); fail('redirect_denied'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); fail('upstream_error'); }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => {}); fail('invalid_response'); }
    const body = await boundedBody(response, LIMITS.responseBytes, controller.signal, 'invalid_response');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { fail('invalid_response'); }
    if (!record(value) || typeof value.text !== 'string' || containsKey(value.text, key)) fail('invalid_response');
    // Untrusted additional fields never leave the adapter.
    return json({ text: value.text });
  } catch (error) {
    const code = error instanceof Failure && codes.has(error.code) ? error.code : controller.signal.aborted ? 'timeout' : 'unavailable';
    const status = code === 'forbidden' ? 403 : code === 'too_large' ? 413 : code === 'invalid_request' ? 400 : code === 'rate_limited' ? 429 : code === 'timeout' ? 504 : 502;
    // An aborted/failed transport cannot establish whether compute was started.
    return json({ error: code, ...(dispatched && ['timeout', 'unavailable'].includes(code) ? { outcome: 'unknown' } : {}) }, status);
  } finally {
    clearTimeout(timer); controller.abort(); request.signal.removeEventListener('abort', onCancel); key = '';
  }
}
