import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWhisper, WHISPER_TEMPLATE, LIMITS } from '../lib/whisper-adapter.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const fakeKey = '00112233445566778899aabbccddeeff';
const enabled = { enabled: true };
const site = 'https://candidate.test';
// Self-generated 25 ms, 16 kHz, mono, PCM16 silence; no real recording.
function silenceWav() {
  const bytes = new Uint8Array(44 + 800), v = new DataView(bytes.buffer);
  const label = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
  label(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  label(36, 'data'); v.setUint32(40, 800, true); return bytes;
}
const wav = silenceWav();
const template = () => ({ url: WHISPER_TEMPLATE, method: 'POST', multipart: { file: { attachment: 'audio' }, model: 'whisper-1' } });
async function request(options = {}) {
  const form = new FormData();
  form.append('request', JSON.stringify(options.template ?? template()));
  form.append('audio', new Blob([options.bytes ?? wav], { type: options.mime ?? 'audio/wav' }), 'private-local-name.wav');
  if (options.mutate) options.mutate(form);
  // Simulate received wire bytes, not a concurrently running client-side encoder.
  const wire = new Response(form), body = await wire.arrayBuffer();
  return new Request(site + '/api/whisper/transcribe', { method: 'POST', body, headers: { 'content-type': wire.headers.get('content-type'), origin: site, 'sec-fetch-site': 'same-origin', ...options.headers } });
}
function deps(overrides = {}) {
  const seen = { auth: 0, csrf: 0, reserve: 0, resolve: 0, fetch: 0 };
  return { seen, value: {
    authorizeOwner: async () => { seen.auth++; return true; },
    validateCsrf: async () => { seen.csrf++; return true; },
    reserveWhisper: async () => { seen.reserve++; return true; },
    resolveWhisperKey: async alias => { seen.resolve++; assert.equal(alias, 'whisper_token'); return fakeKey; },
    fetch: async () => { seen.fetch++; return Response.json({ text: 'fake transcript' }); },
    ...overrides,
  } };
}
async function result(req, d, config = enabled) {
  const response = await handleWhisper(await req, d.value, config), text = await response.text();
  assert.equal(text.includes(fakeKey), false); assert.equal(text.includes('private-local-name'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: JSON.parse(text) };
}

test('default gates, owner, Origin and CSRF reject before attachment/key/upstream', async () => {
  for (const config of [undefined, {}, { enabled: false }, { ...enabled, totalMs: LIMITS.totalMs + 1 }]) {
    const d = deps(); const r = await result(request(), d, config === undefined ? {} : config);
    assert.equal(r.body.error, 'disabled'); assert.deepEqual(d.seen, { auth: 0, csrf: 0, reserve: 0, resolve: 0, fetch: 0 });
  }
  assert.equal((await handleWhisper(await request(), deps().value)).status, 503);
  for (const patch of [{ authorizeOwner: async () => false }, { validateCsrf: async () => false }]) {
    const d = deps(patch); assert.equal((await result(request(), d)).status, 403);
    assert.equal(d.seen.reserve + d.seen.resolve + d.seen.fetch, 0);
  }
  for (const headers of [{ origin: 'https://unapproved.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    const d = deps(); assert.equal((await result(request({ headers }), d)).status, 403); assert.equal(d.seen.auth, 0);
  }
});

test('legal multipart preserves silence bytes and known fields; key is only in exact upstream path', async () => {
  let calls = 0;
  const input = template(); input.multipart.language = 'zh';
  const d = deps({ fetch: async req => {
    calls++; assert.equal(req.url, 'https://infra.hazelnut-paradise.com/use/whisper/' + fakeKey + '/v1/audio/transcriptions');
    assert.equal(req.method, 'POST'); assert.equal(req.redirect, 'manual'); assert.equal(req.credentials, 'omit');
    assert.equal(req.headers.get('authorization'), null); assert.equal(req.headers.get('cookie'), null);
    assert.equal([...req.headers].some(([, value]) => value.includes(fakeKey)), false);
    const form = await req.formData(); assert.deepEqual([...form.keys()].sort(), ['advanced', 'file', 'language', 'model']);
    assert.equal(form.get('model'), 'whisper-1'); assert.equal(form.get('advanced'), 'false'); assert.equal(form.get('language'), 'zh');
    assert.equal(form.get('file').name, 'audio');
    assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()), wav);
    return Response.json({ text: '靜音測試', segments: [{ unwanted: fakeKey }], url: req.url });
  } });
  assert.deepEqual(await result(request({ template: input }), d), { status: 200, body: { text: '靜音測試' } });
  assert.equal(calls, 1); assert.equal(d.seen.reserve, 1); assert.equal(d.seen.resolve, 1);
});

test('scope, aliases, duplicate/unknown parts, malformed MIME and actual byte overruns never dispatch', async () => {
  const cases = [
    { template: { ...template(), url: WHISPER_TEMPLATE.replace('whisper_token', 'finmind_token') } },
    { template: { ...template(), url: WHISPER_TEMPLATE.replace('/transcriptions', '/translations') } },
    { template: { ...template(), method: 'GET' } },
    { template: { ...template(), headers: { authorization: 'literal' } } },
    { template: { ...template(), multipart: { ...template().multipart, advanced: true } } },
    { template: { ...template(), multipart: { file: { attachment: 'https://unapproved.test/file' } } } },
    { mutate: form => form.append('request', '{}') },
    { mutate: form => form.append('audio', new Blob([wav]), 'second.wav') },
    { mutate: form => form.append('extra', 'value') },
    { mime: 'text/html' },
    { bytes: new Uint8Array(LIMITS.fileBytes + 1), headers: { 'content-length': '1' } },
    { bytes: new Uint8Array(LIMITS.fileBytes + LIMITS.envelopeOverhead + 1) },
  ];
  for (const input of cases) {
    const d = deps(); const r = await result(request(input), d);
    assert.ok([400, 413].includes(r.status)); assert.equal(d.seen.reserve + d.seen.resolve + d.seen.fetch, 0);
  }
});

test('independent budget/key failures and redirect, echo, malformed/oversize output fail closed, with no retry', async () => {
  const blocked = deps({ reserveWhisper: async () => false });
  assert.equal((await result(request(), blocked)).status, 429); assert.equal(blocked.seen.resolve + blocked.seen.fetch, 0);
  for (const key of [null, '', 'finmind-fake-key', '../' + fakeKey, fakeKey.toUpperCase()]) {
    const d = deps({ resolveWhisperKey: async () => key });
    assert.equal((await result(request(), d)).body.error, 'secret_unavailable'); assert.equal(d.seen.fetch, 0);
  }
  const responses = [
    ['redirect_denied', () => new Response(fakeKey, { status: 302, headers: { location: 'https://unapproved.test/' + fakeKey } })],
    ['upstream_error', () => new Response(fakeKey, { status: 500 })],
    ['invalid_response', () => Response.json({ text: fakeKey })],
    ['invalid_response', () => Response.json({ text: fakeKey.toUpperCase() })],
    ['invalid_response', () => Response.json({ text: [...fakeKey].map(c => '%' + c.charCodeAt(0).toString(16)).join('') })],
    ['invalid_response', () => Response.json({ text: btoa(fakeKey) })],
    ['invalid_response', () => Response.json({ text: 1 })],
    ['invalid_response', () => new Response('<html>' + fakeKey)],
    ['invalid_response', () => Response.json({ text: 'x'.repeat(LIMITS.responseBytes) })],
    ['unavailable', () => { throw new Error('transport URL contains ' + fakeKey); }],
  ];
  for (const [error, response] of responses) {
    let calls = 0; const d = deps({ fetch: async () => { calls++; return response(); } });
    assert.equal((await result(request(), d)).body.error, error); assert.equal(calls, 1);
  }
});

test('total deadline aborts both stalled upload and upstream; post-dispatch outcome unknown, zero retries', async () => {
  let observed; let calls = 0;
  const d = deps({ fetch: async req => { calls++; observed = req.signal; return new Promise(() => {}); } });
  const r = await result(request(), d, { ...enabled, totalMs: 20 });
  assert.deepEqual(r, { status: 504, body: { error: 'timeout', outcome: 'unknown' } });
  assert.equal(observed.aborted, true); assert.equal(calls, 1);
  let cancelled = false;
  const slow = new Request(site + '/api/whisper/transcribe', { method: 'POST', duplex: 'half', headers: { origin: site, 'content-type': 'multipart/form-data; boundary=test' }, body: new ReadableStream({ cancel() { cancelled = true; } }) });
  const uploadDeps = deps(); const slowResult = await result(slow, uploadDeps, { ...enabled, totalMs: 20 });
  assert.equal(slowResult.body.error, 'timeout'); assert.equal(slowResult.body.outcome, undefined);
  assert.equal(cancelled, true); assert.equal(uploadDeps.seen.reserve + uploadDeps.seen.resolve + uploadDeps.seen.fetch, 0);
});
