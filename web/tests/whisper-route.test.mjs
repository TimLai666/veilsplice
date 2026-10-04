import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testEnvironment, ownerHash } from './fixtures.mjs';
import { handleWhisperRoute } from '../lib/whisper-route.ts';
import { handleProxyRoute } from '../lib/proxy-route.ts';
import { reserveRequest } from '../lib/finmind.ts';
import { reserveWhisper } from '../lib/whisper-store.ts';
import { WHISPER_TEMPLATE } from '../lib/whisper-adapter.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_WHISPER_TESTS'); };
const site = 'https://site.test';
const owner = { 'oai-authenticated-user-id': 'test-owner', 'oai-authenticated-user-email': 'owner@example.test' };
const first = '00112233445566778899aabbccddeeff', rotated = 'ffeeddccbbaa99887766554433221100';
const finmind = 'FAKE_FINMIND_IS_SEPARATE';
const input = { url: WHISPER_TEMPLATE, method: 'POST', multipart: { file: { attachment: 'audio' }, model: 'whisper-1', language: 'zh' } };
function env() {
  const e = testEnvironment(finmind);
  e.DB.sqlite.exec(readFileSync(new URL('../drizzle/0002_hard_darkstar.sql', import.meta.url), 'utf8'));
  return e;
}
function request(path, method = 'GET', body, headers = {}) {
  return new Request(site + path, { method, headers: { ...owner, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function safe(response) {
  const text = await response.text();
  for (const key of [first, rotated, finmind]) assert.equal(text.includes(key), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  return JSON.parse(text);
}
async function form(e) {
  const response = await handleWhisperRoute(request('/api/whisper/variable'), e);
  const data = await safe(response); assert.equal(response.status, 200);
  return { data, headers: { origin: site, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-csrf-token': data.csrf, cookie: response.headers.get('set-cookie').split(';')[0] } };
}
async function save(e, f, value = first) {
  const response = await handleWhisperRoute(request('/api/whisper/variable', 'POST', { value, consent: true }, f.headers), e);
  assert.deepEqual(await safe(response), { ok: true }); assert.equal(response.status, 200);
}
async function upload(f, override = {}) {
  const body = new FormData(); body.set('request', JSON.stringify(override.input ?? input));
  body.set('audio', new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'audio/wav' }), 'owner-private-name.wav');
  const wire = new Response(body);
  return new Request(site + '/api/whisper/transcribe', { method: 'POST', headers: { ...owner, ...f.headers, 'content-type': wire.headers.get('content-type'), ...override.headers }, body: await wire.arrayBuffer() });
}

test('settings metadata, save, rotation and disable are owner/service scoped with no readback', async () => {
  const e = env(), f = await form(e);
  assert.deepEqual(f.data.variable, { alias: 'whisper_token', configured: false, active: false, version: 0 });
  await save(e, f);
  assert.equal((await form(e)).data.variable.configured, true);
  assert.ok(e.DB.queries.every(sql => !/^SELECT token/i.test(sql)));
  e.DB.queries.length = 0; await save(e, f, rotated);
  assert.ok(e.DB.queries.every(sql => !/^SELECT token/i.test(sql)));
  // This is a local fake database only; assert exact service boundaries.
  const rows = e.DB.sqlite.prepare('SELECT service, token, alias FROM service_credentials WHERE owner_hash = ? ORDER BY service').all(ownerHash);
  assert.deepEqual(rows.map(row => ({ ...row })), [{ service: 'finmind', token: finmind, alias: 'finmind_token' }, { service: 'whisper', token: rotated, alias: 'whisper_token' }]);
  const response = await handleWhisperRoute(request('/api/whisper/variable', 'DELETE', {}, f.headers), e);
  assert.deepEqual(await safe(response), { ok: true });
  assert.equal((await form(e)).data.variable.configured, false);
  assert.equal(e.DB.sqlite.prepare("SELECT token FROM service_credentials WHERE service='finmind'").get().token, finmind);
  assert.equal(e.DB.sqlite.prepare("SELECT token FROM service_credentials WHERE service='whisper'").get().token, null);
});

test('authentication, CSRF, alias collision and invalid templates reject before token read or provider', async () => {
  const e = env(), f = await form(e); let sent = 0;
  const fetcher = async () => { sent++; return Response.json({ text: 'unused' }); };
  assert.equal((await handleWhisperRoute(new Request(site + '/api/whisper/variable'), e)).status, 401);
  for (const headers of [{ origin: 'https://elsewhere.test' }, { origin: '' }, { cookie: '' }, { 'x-csrf-token': '' }, { 'oai-authenticated-user-email': 'other@example.test' }]) {
    e.DB.queries.length = 0;
    const response = await handleWhisperRoute(await upload(f, { headers }), e, fetcher);
    assert.equal(response.status, 403); await safe(response);
    assert.equal(e.DB.queries.length, 0);
  }
  for (const template of [
    { ...input, url: WHISPER_TEMPLATE.replace('whisper_token', 'finmind_token') },
    { ...input, url: WHISPER_TEMPLATE.replace('infra.hazelnut-paradise.com', 'example.test') },
    { ...input, url: WHISPER_TEMPLATE.replace('{{whisper_token}}', first) },
  ]) {
    e.DB.queries.length = 0;
    const response = await handleWhisperRoute(await upload(f, { input: template }), e, fetcher);
    assert.equal(response.status, 400); await safe(response); assert.equal(e.DB.queries.length, 0);
  }
  const collision = await handleProxyRoute(request('/api/proxy/variables', 'POST', { alias: 'whisper_token', consent: true }, f.headers), e);
  assert.equal(collision.status, 403); await safe(collision);
  e.DB.sqlite.prepare("UPDATE service_credentials SET alias='whisper_token' WHERE service='finmind'").run();
  const blocked = await handleWhisperRoute(request('/api/whisper/variable', 'POST', { value: first, consent: true }, f.headers), e);
  assert.equal(blocked.status, 409); assert.equal((await safe(blocked)).error, 'alias_conflict');
  assert.equal(e.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM service_credentials WHERE service='whisper'").get().count, 0);
  assert.equal(sent, 0);
});

test('route sends only Whisper key in the exact path and rotation/disable take effect next request', async () => {
  const e = env(), f = await form(e); await save(e, f);
  let expected = first, sent = 0;
  const fetcher = async req => {
    sent++; assert.equal(req.url, WHISPER_TEMPLATE.replace('{{whisper_token}}', expected));
    assert.equal(req.redirect, 'manual'); assert.equal(req.credentials, 'omit');
    assert.equal(req.headers.get('authorization'), null); assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('oai-authenticated-user-email'), null);
    const body = await req.formData(); assert.equal(body.get('file').name, 'audio');
    assert.deepEqual(new Uint8Array(await body.get('file').arrayBuffer()), new Uint8Array([0, 0, 0, 0]));
    assert.equal(body.get('model'), 'whisper-1'); assert.equal(body.get('language'), 'zh'); assert.equal(body.get('advanced'), 'false');
    return Response.json({ text: '假轉錄', secret: expected, url: req.url });
  };
  assert.deepEqual(await safe(await handleWhisperRoute(await upload(f), e, fetcher)), { text: '假轉錄' });
  await save(e, f, rotated); expected = rotated;
  assert.deepEqual(await safe(await handleWhisperRoute(await upload(f), e, fetcher)), { text: '假轉錄' });
  await handleWhisperRoute(request('/api/whisper/variable', 'DELETE', {}, f.headers), e);
  e.DB.sqlite.prepare("DELETE FROM request_limits WHERE id='whisper'").run();
  e.WHISPER_TOKEN = first; // Forbidden fallback must stay unused.
  const stopped = await handleWhisperRoute(await upload(f), e, fetcher);
  assert.equal((await safe(stopped)).error, 'secret_unavailable'); assert.equal(sent, 2);
  assert.equal(e.DB.sqlite.prepare("SELECT token FROM service_credentials WHERE service='finmind'").get().token, finmind);
});

test('Whisper persistent quota is independent of FinMind and fails closed on missing storage', async () => {
  const e = env(), f = await form(e); await save(e, f);
  assert.equal(await reserveWhisper(e), true); assert.equal(await reserveWhisper(e), true);
  assert.equal(await reserveWhisper(e), false);
  assert.equal(await reserveRequest(e), null);
  const response = await handleWhisperRoute(await upload(f), e, async () => { throw new Error('MUST_NOT_SEND'); });
  assert.equal(response.status, 429); assert.equal((await safe(response)).error, 'rate_limited');
  const absent = { OWNER_EMAIL_SHA256: ownerHash };
  const unavailable = await handleWhisperRoute(await upload(f), absent, async () => { throw new Error('MUST_NOT_SEND'); });
  assert.equal((await safe(unavailable)).error, 'unavailable');
  const e2 = env();
  for (let n = 0; n < 12; n++) assert.equal(await reserveRequest(e2), null);
  assert.notEqual(await reserveRequest(e2), null);
  assert.equal(await reserveWhisper(e2), true);
});

test('upstream redirects, path-bearing errors and key echoes never leave route', async () => {
  for (const make of [
    () => new Response(first, { status: 302, headers: { location: 'https://example.test/' + first } }),
    () => Response.json({ text: rotated }),
    () => new Response(first, { status: 500 }),
    () => { throw new Error(WHISPER_TEMPLATE.replace('{{whisper_token}}', rotated)); },
  ]) {
    const e = env(), f = await form(e); await save(e, f, rotated); let sent = 0;
    const response = await handleWhisperRoute(await upload(f), e, async () => { sent++; return make(); });
    assert.equal(response.status, 502); const data = await safe(response);
    assert.ok(['redirect_denied', 'invalid_response', 'upstream_error', 'unavailable'].includes(data.error));
    assert.equal(sent, 1); assert.equal(response.headers.get('location'), null);
  }
});
