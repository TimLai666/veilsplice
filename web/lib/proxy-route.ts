import { authorized, projectPrices, projectUsage, reserveRequest, validatePriceArgs, type Runtime } from './finmind.ts';
import { credentialForRequest, validToken } from './credentials.ts';
import { issueCsrf, validCsrf } from './credential-route.ts';
import { FINMIND_SERVICE } from './service-registry.ts';
import { executeProxy, ProxyError, safeProxyErrorCode, type Policy } from './generic-proxy.ts';
import { disableVariable, saveVariable, validVariableName, variableMetadata } from './proxy-variables.ts';

const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...extra,
} });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
async function readBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body) throw new ProxyError('invalid_request');
  const reader = request.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 65536) throw new Error(); chunks.push(part.value); }
    const value = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch { throw new ProxyError('invalid_request'); }
  finally { await reader.cancel().catch(() => {}); }
}
function scopedRequest(input: unknown) {
  if (!record(input) || input.method !== 'GET') throw new ProxyError('denied');
  if (input.url === FINMIND_SERVICE.endpoints.prices.url) {
    if (!record(input.query) || input.query.dataset !== 'TaiwanStockPrice') throw new ProxyError('denied');
    const args = validatePriceArgs({ stock_id: input.query.data_id, start_date: input.query.start_date, end_date: input.query.end_date });
    if (!args) throw new ProxyError('invalid_request');
    return { kind: 'prices' as const, args };
  }
  if (input.url === FINMIND_SERVICE.endpoints.usage.url) return { kind: 'usage' as const, args: null };
  throw new ProxyError('denied');
}
function policy(alias?: string): Policy {
  const prices = new URL(FINMIND_SERVICE.endpoints.prices.url), usage = new URL(FINMIND_SERVICE.endpoints.usage.url);
  return {
    aliases: alias ? { [alias]: { origins: [prices.origin, usage.origin], locations: ['header:authorization'] } } : {},
    routes: [
      { id: 'finmind-prices', origin: prices.origin, path: prices.pathname, methods: ['GET'], headers: ['authorization', 'accept'], query: ['dataset', 'data_id', 'start_date', 'end_date'], body: 'none', response: { pointer: '/data', fields: { date: 'date', stock_id: 'string', open: 'number', max: 'number', min: 'number', close: 'number', spread: 'number', Trading_Volume: 'number', Trading_money: 'number', Trading_turnover: 'number' }, maxBytes: 131072, maxItems: 31 } },
      { id: 'finmind-usage', origin: usage.origin, path: usage.pathname, methods: ['GET'], headers: ['authorization', 'accept'], query: [], body: 'none', response: { pointer: '', fields: { user_count: 'number', api_request_limit: 'number' }, maxBytes: 131072, maxItems: 1 } },
    ],
  };
}
// Owner authentication belongs to the calling route/tool; this function never
// calls legacy execute(), which would automatically load a key for anonymous input.
export async function executeOwnerTemplate(input: unknown, env: Runtime, fetcher: (request: Request) => Promise<Response> = fetch) {
  const scope = scopedRequest(input);
  const template = input as Record<string, unknown>;
  const usesPlaceholder = JSON.stringify(template).includes('{{');
  const alias = usesPlaceholder ? (await variableMetadata(env)).alias : undefined;
  if (record(template.headers)) for (const [name, value] of Object.entries(template.headers)) {
    if (name.toLowerCase() === 'authorization' && value !== `Bearer {{${alias}}}`) throw new ProxyError('denied');
  }
  return executeProxy(template, policy(alias), {
    resolve: async name => name === alias ? credentialForRequest(env) : null,
    fetch: async request => {
      const blocked = await reserveRequest(env);
      if (blocked) throw new ProxyError(blocked.code === 'RATE_LIMITED' ? 'rate_limited' : 'unavailable');
      return fetcher(request);
    },
    projectResponse: raw => {
      const result = scope.kind === 'prices' ? projectPrices(raw, scope.args!) : projectUsage(raw);
      if (!result.ok) throw new ProxyError('invalid_response');
      return scope.kind === 'prices' ? { data: result.rows } : result;
    },
  });
}
// All browser mutation and execution calls use the existing host-only CSRF form.
// No raw-key reader, MCP credential tool, alternate identity or new recipient.
export async function handleProxyRoute(request: Request, env: Runtime, fetcher?: (request: Request) => Promise<Response>): Promise<Response> {
  try {
    const auth = await authorized(request.headers, env);
    if (auth !== 200) return send({ error: auth === 401 ? 'unauthorized' : 'forbidden' }, auth);
    const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (url.search || url.hash || origin && origin !== url.origin || site && !['same-origin', 'none'].includes(site)) return send({ error: 'forbidden' }, 403);
    if (url.pathname === '/api/proxy/variables' && request.method === 'GET') {
      const variable = await variableMetadata(env), csrf = issueCsrf(request);
      return send({ variables: [variable], csrf: csrf.token }, 200, { 'set-cookie': csrf.cookie });
    }
    const deletion = /^\/api\/proxy\/variables\/([a-z][a-z0-9_]{0,63})$/.exec(url.pathname);
    const save = url.pathname === '/api/proxy/variables' && request.method === 'POST';
    const execute = url.pathname === '/api/proxy/execute' && request.method === 'POST';
    if (!save && !execute && !(deletion && request.method === 'DELETE')) return send({ error: 'not_found' }, 404);
    if (origin !== url.origin || !validCsrf(request)) return send({ error: 'forbidden' }, 403);
    const input = await readBody(request);
    if (execute) return send(await executeOwnerTemplate(input, env, fetcher));
    if (save) {
      if (record(input) && input.alias === 'whisper_token') throw new ProxyError('denied');
      if (!record(input) || Object.keys(input).some(key => !['alias', 'value', 'consent'].includes(key)) || !validVariableName(input.alias) || input.consent !== true || Object.hasOwn(input, 'value') && !validToken(input.value)) throw new ProxyError('invalid_request');
      await saveVariable(env, input.alias, input.value as string | undefined);
    } else {
      if (!record(input) || Object.keys(input).length || !deletion || !validVariableName(deletion[1])) throw new ProxyError('invalid_request');
      if ((await variableMetadata(env)).alias !== deletion[1]) throw new ProxyError('denied');
      await disableVariable(env, deletion[1]);
    }
    return send({ ok: true });
  } catch (error) {
    const code = safeProxyErrorCode(error);
    return send({ error: code }, code === 'rate_limited' ? 429 : code === 'denied' ? 403 : code === 'invalid_request' || code === 'invalid_placeholder' ? 400 : 502);
  }
}
