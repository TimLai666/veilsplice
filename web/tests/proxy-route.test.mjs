import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testEnvironment, ownerHash } from './fixtures.mjs';
import { handleProxyRoute } from '../lib/proxy-route.ts';
import { reserveRequest } from '../lib/finmind.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_IS_FORBIDDEN_IN_PROXY_INTEGRATION_TESTS'); };
const site = 'https://site.test';
const owner = { 'oai-authenticated-user-id': 'test-owner', 'oai-authenticated-user-email': 'owner@example.test' };
const first = 'FAKE_first_owner_entered_key', rotated = 'FAKE_rotated_owner_entered_key';
const price = { date: '2026-09-01', stock_id: '2330', open: 100, max: 102, min: 99, close: 101, spread: 1, Trading_Volume: 1000, Trading_money: 101000, Trading_turnover: 30 };
const prices = { url: 'https://api.finmindtrade.com/api/v4/data', method: 'GET', query: { dataset: 'TaiwanStockPrice', data_id: '2330', start_date: '2026-09-01', end_date: '2026-09-02' } };
const usage = alias => ({ url: 'https://api.web.finmindtrade.com/v2/user_info', method: 'GET', ...(alias ? { headers: { Authorization: `Bearer {{${alias}}}` } } : {}) });
function env(token = first) {
  const value = testEnvironment(token);
  // Apply the actual generated migration to the fake, in-memory v5 database.
  value.DB.sqlite.exec(readFileSync(new URL('../drizzle/0002_hard_darkstar.sql', import.meta.url), 'utf8'));
  return value;
}
function request(path, method = 'GET', body, headers = {}) {
  return new Request(site + path, { method, headers: { ...owner, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function safe(response) {
  const text = await response.text();
  assert.equal(text.includes(first), false); assert.equal(text.includes(rotated), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return JSON.parse(text);
}
async function form(e) {
  const response = await handleProxyRoute(request('/api/proxy/variables'), e);
  const data = await safe(response); assert.equal(response.status, 200);
  return { data, headers: { origin: site, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-csrf-token': data.csrf, cookie: response.headers.get('set-cookie').split(';')[0] } };
}
const call = (e, f, input, fetcher) => handleProxyRoute(request('/api/proxy/execute', 'POST', input, f.headers), e, fetcher);

test('owner auth, CSRF and same-origin checks reject before key access or transport', async () => {
  const e = env(), f = await form(e); let sent = 0;
  const fetcher = async () => { sent++; return Response.json({}); };
  const unauth = new Request(site + '/api/proxy/variables');
  assert.equal((await handleProxyRoute(unauth, e, fetcher)).status, 401);
  for (const extra of [{ 'x-csrf-token': '' }, { cookie: '' }, { origin: 'https://elsewhere.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'oai-authenticated-user-email': 'other@example.test' }]) {
    e.DB.queries.length = 0;
    const response = await handleProxyRoute(request('/api/proxy/execute', 'POST', usage('finmind_token'), { ...f.headers, ...extra }), e, fetcher);
    assert.equal(response.status, 403); await safe(response);
    assert.ok(e.DB.queries.every(q => !/^SELECT token/i.test(q)));
  }
  assert.equal(sent, 0);
});

test('default alias and rename are metadata-only and preserve the exact existing FinMind row', async () => {
  const e = env(), f = await form(e);
  assert.deepEqual(f.data.variables, [{ alias: 'finmind_token', configured: true, active: true, version: f.data.variables[0].version }]);
  assert.ok(e.DB.queries.every(q => !/^SELECT token/i.test(q)));
  e.DB.queries.length = 0;
  const response = await handleProxyRoute(request('/api/proxy/variables', 'POST', { alias: 'market_key', consent: true }, f.headers), e);
  assert.deepEqual(await safe(response), { ok: true });
  assert.ok(e.DB.queries.every(q => !/^SELECT token/i.test(q)));
  const row = e.DB.sqlite.prepare('SELECT owner_hash, service, token, alias FROM service_credentials').get();
  assert.deepEqual({ ...row }, { owner_hash: ownerHash, service: 'finmind', token: first, alias: 'market_key' });
  assert.equal((await form(e)).data.variables[0].alias, 'market_key');
});

test('anonymous execution performs no credential metadata/token lookup and sends no Authorization', async () => {
  for (const token of [first, null]) {
    const e = env(token), f = await form(e); e.DB.queries.length = 0;
    let sent = 0;
    const response = await call(e, f, prices, async req => {
      sent++; assert.equal(req.headers.get('authorization'), null);
      assert.equal(req.redirect, 'manual'); assert.equal(req.credentials, 'omit');
      return Response.json({ status: 200, data: [{ ...price, token: first, email: 'do-not-return' }] });
    });
    const data = await safe(response); assert.equal(data.anonymous, true); assert.deepEqual(data.data, [price]);
    assert.equal(sent, 1);
    assert.ok(e.DB.queries.every(q => !/service_credentials/i.test(q)), 'Only the existing request counter may be touched');
  }
});

test('owner rotation and disable affect alias requests without copying keys or legacy fallback', async () => {
  const e = env(), f = await form(e); let expected = first, sent = 0;
  const fetcher = async req => { sent++; assert.equal(req.headers.get('authorization'), 'Bearer ' + expected); return Response.json({ user_count: 2, api_request_limit: 600, token: expected }); };
  assert.equal((await safe(await call(e, f, usage('finmind_token'), fetcher))).anonymous, false);
  let response = await handleProxyRoute(request('/api/proxy/variables', 'POST', { alias: 'market_key', value: rotated, consent: true }, f.headers), e);
  assert.deepEqual(await safe(response), { ok: true }); expected = rotated;
  assert.equal((await safe(await call(e, f, usage('market_key'), fetcher))).data.user_count, 2);
  assert.equal((await call(e, f, usage('finmind_token'), fetcher)).status, 403);
  response = await handleProxyRoute(request('/api/proxy/variables/market_key', 'DELETE', {}, f.headers), e);
  assert.deepEqual(await safe(response), { ok: true });
  e.FINMIND_TOKEN = first;
  assert.equal((await safe(await call(e, f, usage('market_key'), fetcher))).error, 'secret_unavailable');
  assert.equal(sent, 2);
  assert.equal((await form(e)).data.variables[0].configured, false);
});

test('unapproved providers, datasets, body/method and token placements fail before secret lookup and quota', async () => {
  for (const input of [
    { ...prices, url: 'https://example.com/data' },
    { ...prices, query: { ...prices.query, dataset: 'UnapprovedDataset' } },
    { ...prices, query: { ...prices.query, end_date: '2026-10-02' } },
    { ...prices, method: 'POST', json: { token: '{{finmind_token}}' } },
    { ...prices, query: { ...prices.query, token: '{{finmind_token}}' } },
    { ...prices, headers: { Authorization: 'Bearer literal-value' } },
    usage('unknown_key'),
  ]) {
    const e = env(), f = await form(e); e.DB.queries.length = 0; let sent = 0;
    const response = await call(e, f, input, async () => { sent++; return Response.json({}); });
    assert.ok([400, 403].includes(response.status)); await safe(response);
    assert.equal(sent, 0);
    assert.ok(e.DB.queries.every(q => !/^SELECT token/i.test(q) && !/INSERT INTO request_limits/i.test(q)));
  }
});

test('generic requests share the legacy persistent quota and upstream failures return only fixed errors', async () => {
  const e = env(), f = await form(e); let sent = 0;
  for (let n = 0; n < 11; n++) assert.equal(await reserveRequest(e), null);
  let response = await call(e, f, usage(), async () => { sent++; return Response.json({ user_count: 2, api_request_limit: 600 }); });
  assert.equal(response.status, 200); await safe(response);
  response = await call(e, f, usage('finmind_token'), async () => { sent++; return Response.json({}); });
  assert.equal(response.status, 429); assert.equal((await safe(response)).error, 'rate_limited'); assert.equal(sent, 1);
  for (const make of [() => new Response(first, { status: 302, headers: { location: 'https://elsewhere.test/' + first } }), () => new Response(rotated, { status: 500 }), () => { throw new Error(first); }, () => Response.json({ user_count: first, api_request_limit: 600 })]) {
    const ready = env(), current = await form(ready);
    response = await call(ready, current, usage('finmind_token'), async () => make());
    assert.equal(response.status, 502); assert.ok(['redirect_denied', 'upstream_error', 'unavailable', 'invalid_response'].includes((await safe(response)).error));
  }
});
