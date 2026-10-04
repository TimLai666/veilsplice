// Pure Worker-compatible candidate. No credentials, database access or live routes.
const errorCodes = new Set([
  'invalid_request', 'invalid_placeholder', 'denied', 'secret_unavailable',
  'invalid_policy', 'invalid_response', 'unavailable', 'redirect_denied', 'upstream_error', 'rate_limited',
]);
export class ProxyError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = errorCodes.has(code) ? code : 'unavailable';
    super(safe); this.name = 'ProxyError'; this.code = safe;
  }
}
// Dependencies can throw or mutate an exported error. Revalidate at each
// public boundary; never forward the original error object or its message.
export function safeProxyErrorCode(error: unknown): string {
  try {
    const code = error instanceof ProxyError ? error.code : undefined;
    if (typeof code === 'string' && errorCodes.has(code)) return code;
  } catch {}
  return 'unavailable';
}
export type FieldType = 'string' | 'number' | 'boolean' | 'date';
export type RoutePolicy = {
  id: string; origin: string; path: string; methods: readonly string[];
  headers: readonly string[]; query: readonly string[]; body: 'none' | 'json' | 'form';
  response: { pointer: string; fields: Record<string, FieldType>; maxBytes: number; maxItems: number };
};
export type Policy = {
  routes: readonly RoutePolicy[];
  aliases: Record<string, { origins: readonly string[]; locations: readonly string[] }>;
};
export type Dependencies = {
  resolve: (alias: string, signal?: AbortSignal) => Promise<string | null>;
  fetch: (request: Request) => Promise<Response>;
  // Code-owned provider projection, never supplied by an editor request.
  projectResponse?: (raw: unknown) => unknown;
};
export type ProxyResult = { status: number; data: unknown; anonymous: boolean };
function fail(code: string): never { throw new ProxyError(code); }
const aliasPattern = /^[a-z][a-z0-9_]{0,63}$/;
const placeholder = /\{\{([a-z][a-z0-9_]{0,63})\}\}/g;
const encoder = new TextEncoder();
function object(x: unknown): x is Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return (proto === null || proto === Object.prototype) && Object.values(Object.getOwnPropertyDescriptors(x)).every(d => 'value' in d);
}
function map(x: unknown): Record<string, string> {
  if (x === undefined) return Object.create(null);
  if (!object(x) || Object.keys(x).length > 100) fail('invalid_request');
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(x)) {
    if (!key || key.length > 128 || /[\x00-\x1f\x7f{}]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string') fail('invalid_request');
    out[key] = value;
  }
  return out;
}
function refs(value: string): string[] {
  const found = [...value.matchAll(placeholder)].map(m => m[1]);
  if (value.replace(placeholder, '').includes('{{') || value.replace(placeholder, '').includes('}}')) fail('invalid_placeholder');
  return found;
}
function publicURL(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x20\x7f{}?#]/.test(raw)) fail('denied');
  let url: URL; try { url = new URL(raw); } catch { return fail('denied'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !host.includes('.') || /[\[\]:]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || host.endsWith('.')) fail('denied');
  return url;
}
function jsonWalk(x: unknown, visit: (s: string, where: string) => string, path = '', depth = 0): unknown {
  if (depth > 8) fail('invalid_request');
  if (typeof x === 'string') return visit(x, 'json:' + path);
  if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return x;
  if (Array.isArray(x)) {
    if (x.length > 100) fail('invalid_request');
    return x.map((v, i) => jsonWalk(v, visit, path + '/' + i, depth + 1));
  }
  if (!object(x) || Object.keys(x).length > 100) fail('invalid_request');
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(x)) {
    if (/[{}\x00-\x1f\x7f]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid_request');
    out[key] = jsonWalk(value, visit, path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), depth + 1);
  }
  return out;
}
function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) fail('invalid_policy');
  for (const piece of pointer.slice(1).split('/')) {
    const key = piece.replaceAll('~1', '/').replaceAll('~0', '~');
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) fail('invalid_response');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function validField(x: unknown, type: FieldType): boolean {
  switch (type) {
    case 'number': return typeof x === 'number' && Number.isFinite(x);
    case 'boolean': return typeof x === 'boolean';
    case 'string': return typeof x === 'string' && x.length <= 4096;
    case 'date': return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
    default: return false;
  }
}
function secretEcho(value: unknown, secrets: Iterable<string>): boolean {
  const strings: string[] = [];
  const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(value); strings.push(JSON.stringify(value));
  const percentCase = (s: string) => s.replace(/%[0-9a-f]{2}/gi, part => part.toUpperCase());
  const normalized = strings.map(percentCase);
  for (const secret of secrets) {
    // URLSearchParams uses form encoding (including space -> + and ~ -> %7E),
    // which differs from encodeURIComponent for values we actually send.
    const form = new URLSearchParams({ value: secret }).toString().slice('value='.length);
    const variants = [secret, encodeURIComponent(secret), form, JSON.stringify(secret).slice(1, -1)].map(percentCase);
    if (normalized.some(s => variants.some(v => s.includes(v)))) return true;
  }
  return false;
}
async function boundedJSON(response: Response, max: number): Promise<unknown> {
  if (!Number.isSafeInteger(max) || max < 1 || max > 1048576) fail('invalid_policy');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) fail('invalid_response');
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > max) { await reader.cancel(); fail('invalid_response'); }
      chunks.push(next.value);
    }
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch { return fail('invalid_response'); } finally { reader.releaseLock(); }
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail('unavailable');
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ProxyError('unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function executeProxy(input: unknown, policy: Policy, deps: Dependencies): Promise<ProxyResult> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  const secrets = new Map<string, string>();
  try {
    if (!object(input) || Object.keys(input).some(k => !['url', 'method', 'headers', 'query', 'json', 'form'].includes(k))) fail('invalid_request');
    if (encoder.encode(JSON.stringify(input)).byteLength > 65536) fail('invalid_request');
    const url = publicURL(input.url);
    if (typeof input.method !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(input.method)) fail('denied');
    const route = policy.routes.find(r => r.origin === url.origin && r.path === url.pathname && r.methods.includes(input.method as string));
    if (!route) fail('denied');
    const headers = map(input.headers), query = map(input.query), form = map(input.form);
    const headerNames = new Set<string>();
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || headerNames.has(lower) || !route.headers.map(h => h.toLowerCase()).includes(lower) || /^(host|cookie|set-cookie|content-length|content-type|connection|transfer-encoding|proxy-.*|oai-.*|x-forwarded-.*)$/i.test(lower) || /[\r\n\x00]/.test(value)) fail('denied');
      headerNames.add(lower);
    }
    for (const key of Object.keys(query)) if (!route.query.includes(key)) fail('denied');
    if (route.body === 'none' && (Object.hasOwn(input, 'json') || Object.hasOwn(input, 'form'))) fail('denied');
    if (route.body === 'json' && (!Object.hasOwn(input, 'json') || Object.hasOwn(input, 'form'))) fail('denied');
    if (route.body === 'form' && (!Object.hasOwn(input, 'form') || Object.hasOwn(input, 'json'))) fail('denied');
    if (['GET', 'HEAD'].includes(input.method) && route.body !== 'none') fail('denied');
    const used = new Set<string>();
    const inspect = (value: string, location: string) => {
      for (const alias of refs(value)) {
        const rule = Object.hasOwn(policy.aliases, alias) ? policy.aliases[alias] : undefined;
        if (!aliasPattern.test(alias) || !rule || !rule.origins.includes(url.origin) || !rule.locations.includes(location)) fail('denied');
        used.add(alias);
      }
      return value;
    };
    for (const [key, value] of Object.entries(headers)) inspect(value, 'header:' + key.toLowerCase());
    for (const [key, value] of Object.entries(query)) inspect(value, 'query:' + key);
    for (const [key, value] of Object.entries(form)) inspect(value, 'form:' + key);
    if (route.body === 'json') jsonWalk(input.json, inspect);
    // Authorization cannot be used as a raw-key input field in this UI.
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === 'authorization' && refs(value).length === 0) fail('denied');
    for (const alias of used) {
      const value = await abortable(deps.resolve(alias, controller.signal), controller.signal);
      if (typeof value !== 'string' || !value || encoder.encode(value).byteLength > 16384 || value.includes('\x00')) fail('secret_unavailable');
      secrets.set(alias, value);
    }
    const expand = (value: string) => value.replace(placeholder, (_match, alias) => secrets.get(alias) ?? fail('secret_unavailable'));
    const outgoing = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      const expanded = expand(value); if (/[\r\n\x00]/.test(expanded)) fail('denied'); outgoing.set(key, expanded);
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.append(key, expand(value));
    let body: string | undefined;
    if (route.body === 'json') { body = JSON.stringify(jsonWalk(input.json, expand)); outgoing.set('content-type', 'application/json'); }
    if (route.body === 'form') { const params = new URLSearchParams(); for (const [key, value] of Object.entries(form)) params.append(key, expand(value)); body = params.toString(); outgoing.set('content-type', 'application/x-www-form-urlencoded'); }
    if ((body && encoder.encode(body).byteLength > 262144) || url.href.length > 16384) fail('invalid_request');
    const request = new Request(url, { method: input.method, headers: outgoing, body, redirect: 'manual', credentials: 'omit', signal: controller.signal });
    const response = await abortable(deps.fetch(request), controller.signal);
    if (response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') fail('redirect_denied');
    if (response.status < 200 || response.status >= 300) fail('upstream_error');
    const received = await abortable(boundedJSON(response, route.response.maxBytes), controller.signal);
    const raw = deps.projectResponse ? deps.projectResponse(received) : received;
    const selected = atPointer(raw, route.response.pointer), array = Array.isArray(selected), rows = array ? selected : [selected];
    if (!Number.isSafeInteger(route.response.maxItems) || route.response.maxItems < 1 || rows.length > route.response.maxItems || Object.keys(route.response.fields).length === 0) fail('invalid_response');
    const result = rows.map(row => {
      if (!object(row)) fail('invalid_response'); const projected: Record<string, unknown> = Object.create(null);
      for (const [field, type] of Object.entries(route.response.fields)) {
        if (!Object.hasOwn(row, field) || !validField(row[field], type)) fail('invalid_response'); projected[field] = row[field];
      }
      return projected;
    });
    const data = array ? result : result[0]; if (secretEcho(data, secrets.values())) fail('invalid_response');
    return { status: response.status, data, anonymous: used.size === 0 };
  } catch (error) {
    throw new ProxyError(safeProxyErrorCode(error));
  } finally { clearTimeout(timer); secrets.clear(); }
}
