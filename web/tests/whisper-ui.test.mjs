// Local fake React hooks/fetch/timers and source extraction only.
// No DOM/browser acceptance, real keys, playable audio, or network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../app/proxy-console.tsx', import.meta.url), 'utf8');
const start = source.indexOf('type Variable =');
const end = source.indexOf('  const status =');
assert.ok(start >= 0 && end > start);
const component = source.slice(start, end).replace('export default function ProxyConsole', 'function ProxyConsole') + `
  return { requestAction, requestActionRef, mounted, locked, keyInput, whisperKeyInput, audioInput,
    save, saveWhisper, disableWhisper, reload, execute, setConsent, setAlias, setWhisperConsent, setRequestText,
    view: {variables, loaded, busy, result, error, notice, whisperVariable, whisperLoaded, whisperConsent} };
}`;
const compiled = stripTypeScriptTypes(component, { mode: 'strip' }) + ';return {ProxyConsole,parseRequest,whisperExample,validateWhisperSettings};';
const event = { preventDefault() {} };
const fakeKey = '0'.repeat(32);
const fakeFile = (type = 'audio/wav', bytes = 'fake audio bytes') => new File([bytes], 'private-original-name.wav', { type });
const template = { url: 'https://infra.hazelnut-paradise.com/use/whisper/{{whisper_token}}/v1/audio/transcriptions', method: 'POST', multipart: { file: { attachment: 'audio' }, model: 'whisper-1', language: 'zh' } };

function harness(handler) {
  const states = [], refs = [], effects = [], registered = [], calls = [], timers = new Map(), listeners = new Map();
  let stateIndex = 0, refIndex = 0, firstRender = true, timerId = 0, csrfVersion = 0;
  const csrf = () => `${1780000000000 + ++csrfVersion}.` + 'a'.repeat(64);
  let metadata = { alias: 'whisper_token', configured: true, active: true, version: 1 };
  const invokeFetch = async (path, options) => {
    const snapshot = options.body instanceof FormData ? [...options.body.entries()] : options.body === undefined ? undefined : JSON.parse(options.body);
    const call = { path, options, snapshot }; calls.push(call);
    if (handler) {
      const response = await handler(call, { csrf, metadata, calls });
      if (response) return response;
    }
    if (path === '/api/whisper/variable' && options.method === 'GET') return Response.json({ variable: metadata, csrf: csrf() });
    if (path === '/api/proxy/variables' && options.method === 'GET') return Response.json({ variables: [{ alias: 'finmind_token', configured: true, active: true, version: 1 }], csrf: csrf() });
    if (path === '/api/whisper/variable' && ['POST', 'DELETE'].includes(options.method)) {
      metadata = { ...metadata, configured: options.method === 'POST', active: options.method === 'POST', version: metadata.version + 1 };
      return new Response(null, { status: 204 });
    }
    if (path === '/api/whisper/transcribe' && options.method === 'POST') return Response.json({ text: '這是本地假轉錄。' });
    if (path === '/api/proxy/execute' && options.method === 'POST') return Response.json({ status: 200, anonymous: true, data: [] });
    throw new Error('Unexpected local fake route');
  };
  const runtime = new Function('useEffect', 'useRef', 'useState', 'flushSync', 'PRICE_SCHEMA', 'PROXY_REQUEST_SCHEMA', 'document', 'window', 'fetch', 'setTimeout', 'clearTimeout', compiled)(
    effect => { if (firstRender) effects.push(effect); },
    initial => { const i = refIndex++; return refs[i] ??= { current: initial }; },
    initial => { const i = stateIndex++; if (firstRender) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], value => { states[i] = value; }]; },
    update => update(), {}, {},
    { modelContext: { async registerTool(tool, options) { registered.push({ tool, options }); } } },
    { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
    invokeFetch,
    (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    id => timers.delete(id),
  );
  const render = () => { stateIndex = 0; refIndex = 0; const app = runtime.ProxyConsole(); firstRender = false; return app; };
  const app = render(); app.mounted.current = true; app.locked.current = false;
  return { app, render, runtime, calls, effects, registered, timers, listeners };
}

function attachFile(app, file = fakeFile()) {
  let files = file ? [file] : [], value = file ? 'fake-selected-audio' : '', reads = 0;
  const field = {
    get value() { return value; },
    set value(next) { value = next; if (next === '') files = []; },
    get files() { reads++; return files; },
  };
  app.audioInput.current = field;
  return { field, reads: () => reads, remaining: () => files.length };
}

async function registerTools(h) {
  h.effects[1]();
  const cleanup = h.effects[2]();
  await new Promise(resolve => setImmediate(resolve));
  return cleanup;
}

test('Whisper parser permits only the fixed template, attachment and approved model/language scope', () => {
  const { runtime } = harness();
  const parse = input => runtime.parseRequest(JSON.stringify(input), true);
  assert.deepEqual(parse(template), template);
  const withoutLanguage = structuredClone(template); delete withoutLanguage.multipart.language;
  assert.deepEqual(parse(withoutLanguage), withoutLanguage);
  const defaults = structuredClone(withoutLanguage); delete defaults.multipart.model;
  assert.deepEqual(parse(defaults), defaults);
  const turbo = structuredClone(template); turbo.multipart.model = 'turbo'; turbo.multipart.language = 'en';
  assert.deepEqual(parse(turbo), turbo);
  const threeLetterLanguage = structuredClone(template); threeLetterLanguage.multipart.language = 'eng';
  assert.deepEqual(parse(threeLetterLanguage), threeLetterLanguage);
  assert.throws(() => runtime.parseRequest(JSON.stringify(template)), /denied/);
  for (const mutate of [
    x => { x.url = 'https://example.test/'; },
    x => { x.url = x.url.replace('{{whisper_token}}', fakeKey); },
    x => { x.url = x.url.replace('whisper_token', 'finmind_token'); },
    x => { x.url += '?source=other'; },
    x => { x.method = 'GET'; },
    x => { x.headers = { Authorization: 'Bearer {{finmind_token}}' }; },
    x => { x.multipart.model = 'other-model'; },
    x => { x.multipart.language = 'zh-TW'; },
    x => { x.multipart.language = 'EN'; },
    x => { x.multipart.language = null; },
    x => { x.multipart.file.attachment = 'another-file'; },
    x => { x.multipart.file.url = 'https://example.test/audio'; },
    x => { x.multipart.advanced = true; },
    x => { x.multipart.file = 'audio'; },
  ]) {
    const invalid = structuredClone(template); mutate(invalid);
    assert.throws(() => parse(invalid), /whisper_invalid_request/);
  }
});

test('one UI submission refreshes Whisper CSRF, sends two parts only, shows text and drops audio', async () => {
  let selected;
  const h = harness(call => {
    assert.equal(selected.remaining(), 0, 'native selection cleared before the first asynchronous operation');
    if (call.path === '/api/whisper/transcribe') assert.ok([...h.timers.values()].some(timer => timer.ms === 75000));
  });
  selected = attachFile(h.app);
  const result = await h.app.requestAction(JSON.stringify(template), 'ui');
  assert.deepEqual(result, { ok: true, status: 200, anonymous: false, data: { text: '這是本地假轉錄。' } });
  assert.deepEqual(h.calls.map(call => [call.path, call.options.method]), [['/api/whisper/variable', 'GET'], ['/api/whisper/transcribe', 'POST']]);
  const sent = h.calls[1];
  assert.deepEqual(sent.snapshot.map(([key]) => key), ['request', 'audio']);
  assert.deepEqual(JSON.parse(sent.snapshot[0][1]), template);
  assert.equal(sent.snapshot[1][1].name, 'audio', 'original filename is not transmitted');
  assert.equal(sent.options.headers['content-type'], undefined, 'browser supplies the multipart boundary');
  assert.equal(sent.options.headers['x-csrf-token'], '1780000000001.' + 'a'.repeat(64));
  assert.equal(sent.options.credentials, 'same-origin');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.referrerPolicy, 'no-referrer');
  assert.equal(sent.options.body.has('audio'), false, 'temporary FormData releases its audio reference');
  assert.equal(selected.remaining(), 0);
  assert.equal(h.render().view.result.data.text, '這是本地假轉錄。');
  assert.equal(h.render().view.busy, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: 'whisper_audio_required' });
  assert.equal(h.calls.length, 2, 'second submit does not resend the completed attachment');
});

test('missing, empty, oversized and disallowed audio fail locally without metadata or upload calls', async () => {
  for (const [file, code] of [[null, 'whisper_audio_required'], [fakeFile('audio/wav', ''), 'whisper_too_large'], [fakeFile('audio/wav', new Uint8Array(8 * 1024 * 1024 + 1)), 'whisper_too_large'], [fakeFile('video/webm'), 'whisper_audio_type'], [fakeFile(''), 'whisper_audio_type']]) {
    const h = harness(); const selected = attachFile(h.app, file);
    assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: code });
    assert.equal(h.calls.length, 0); assert.equal(selected.remaining(), 0);
  }
  const h = harness(); attachFile(h.app, fakeFile('audio/flac', new Uint8Array(8 * 1024 * 1024)));
  assert.equal((await h.app.requestAction(JSON.stringify(template), 'ui')).ok, true, 'exact byte limit accepted');
});

test('browser tools reject Whisper before reading or clearing audio or credential fields', async () => {
  const h = harness(); const cleanup = await registerTools(h);
  const forbiddenField = new Proxy({}, { get() { throw new Error('tool touched input'); }, set() { throw new Error('tool touched input'); } });
  h.app.audioInput.current = forbiddenField; h.app.keyInput.current = forbiddenField; h.app.whisperKeyInput.current = forbiddenField;
  assert.deepEqual(h.registered.map(({tool}) => tool.name), ['read_finmind_prices', 'veilsplice_request']);
  assert.ok(h.registered.every(({tool}) => tool.annotations.readOnlyHint));
  assert.deepEqual(await h.registered[1].tool.execute(template), { ok: false, error: 'denied' });
  assert.equal(h.calls.length, 0);
  const anonymous = { url: 'https://api.finmindtrade.com/api/v4/data', method: 'GET', query: { dataset: 'TaiwanStockPrice', data_id: '2330', start_date: '2026-10-01', end_date: '2026-10-02' } };
  assert.equal((await h.registered[1].tool.execute(anonymous)).ok, true);
  assert.ok(h.calls.every(call => call.path.startsWith('/api/proxy/')));
  cleanup();
});

test('Whisper save clears masked input before fresh GET, never reads write body, then reloads metadata', async () => {
  let app;
  const h = harness(call => {
    assert.equal(app.whisperKeyInput.current.value, '');
    if (call.options.method === 'POST') {
      assert.deepEqual(call.snapshot, { value: fakeKey, consent: true });
      assert.equal(call.options.headers['x-csrf-token'], '1780000000001.' + 'a'.repeat(64));
      const response = new Response('FAKE_BODY_MUST_NOT_RENDER', { headers: { 'content-type': 'text/plain' } });
      return response;
    }
  });
  h.app.setWhisperConsent(true); app = h.render();
  app.whisperKeyInput.current = { value: fakeKey };
  await app.saveWhisper(event);
  assert.deepEqual(h.calls.map(call => call.options.method), ['GET', 'POST', 'GET']);
  const state = h.render().view;
  assert.equal(state.whisperConsent, false); assert.equal(state.whisperLoaded, true); assert.equal(state.error, null);
  assert.equal(app.whisperKeyInput.current.value, '');
  assert.ok(!JSON.stringify(state).includes(fakeKey), 'fake key never enters React state');
  assert.ok(!JSON.stringify(state).includes('FAKE_BODY_MUST_NOT_RENDER'));
});

test('Whisper validation and missing consent clear keys without dispatch; FinMind reserved alias remains loadable', async () => {
  for (const [consent, value, code] of [[false, fakeKey, 'whisper_consent_required'], [true, '', 'whisper_invalid_value'], [true, 'not-a-key', 'whisper_invalid_value']]) {
    const h = harness(); h.app.setWhisperConsent(consent); const app = h.render(); app.whisperKeyInput.current = { value };
    await app.saveWhisper(event);
    assert.equal(app.whisperKeyInput.current.value, ''); assert.equal(h.calls.length, 0); assert.equal(h.render().view.error, code);
  }
  const h = harness(); h.app.setAlias('whisper_token'); h.app.setConsent(true); const app = h.render(); app.keyInput.current = { value: '' };
  await app.save(event);
  assert.equal(h.render().view.error, 'alias_conflict'); assert.equal(h.calls.length, 0);
  assert.doesNotThrow(() => h.runtime.validateWhisperSettings({ variable: { alias: 'whisper_token', configured: true, active: true, version: 1 }, csrf: '1780000000000.' + 'a'.repeat(64) }));
});

test('Whisper disable uses its own fresh CSRF and fixed route, clears selection and refreshes status', async () => {
  const h = harness(); const selected = attachFile(h.app); h.app.whisperKeyInput.current = { value: fakeKey };
  await h.app.disableWhisper();
  assert.deepEqual(h.calls.map(call => [call.path, call.options.method]), [['/api/whisper/variable', 'GET'], ['/api/whisper/variable', 'DELETE'], ['/api/whisper/variable', 'GET']]);
  assert.deepEqual(h.calls[1].snapshot, {});
  assert.equal(h.calls[1].options.headers['x-csrf-token'], '1780000000001.' + 'a'.repeat(64));
  assert.equal(h.render().view.whisperVariable.active, false); assert.equal(selected.remaining(), 0); assert.equal(h.app.whisperKeyInput.current.value, '');
});

test('inactive Whisper, fixed errors and untrusted output never become a successful result', async () => {
  for (const [response, code] of [
    [Response.json({ error: 'alias_conflict' }, {status: 409}), 'alias_conflict'],
    [Response.json({ error: 'upstream_error' }, {status: 502}), 'whisper_upstream_error'],
    [Response.json({ error: 'FAKE_DO_NOT_SHOW' }, {status: 500}), 'whisper_unavailable'],
    [Response.json({ text: 'safe text', private: 'FAKE_DO_NOT_SHOW' }), 'whisper_invalid_response'],
    [Response.json({ text: 42 }), 'whisper_invalid_response'],
  ]) {
    const h = harness(call => call.path === '/api/whisper/transcribe' ? response : undefined); const selected = attachFile(h.app);
    assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: code });
    assert.equal(h.render().view.result, null); assert.equal(selected.remaining(), 0); assert.equal(h.calls.length, 2);
  }
  const h = harness((call, ctx) => call.path === '/api/whisper/variable' ? Response.json({ variable: {...ctx.metadata, active: false}, csrf: ctx.csrf() }) : undefined);
  attachFile(h.app);
  assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: 'whisper_secret_unavailable' });
  assert.equal(h.calls.length, 1);
});

test('unknown server outcome and interrupted transport show unknown once, with no automatic retry', async () => {
  for (const mode of ['server', 'transport', 'timeout', 'body-timeout']) {
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const h = harness(async call => {
      if (call.path !== '/api/whisper/transcribe') return;
      entered();
      if (mode === 'server') return Response.json({ error: 'timeout', outcome: 'unknown' }, { status: 504 });
      if (mode === 'transport') throw new Error('FAKE_TRANSPORT_DETAIL');
      if (mode === 'body-timeout') return new Response(new ReadableStream({ start(controller) { call.options.signal.addEventListener('abort', () => controller.error(new Error('FAKE_BODY_INTERRUPTION')), { once: true }); } }), { headers: { 'content-type': 'application/json' } });
      return new Promise((resolve, reject) => call.options.signal.addEventListener('abort', () => reject(new Error('FAKE_ABORT')), { once: true }));
    });
    const selected = attachFile(h.app);
    const pending = h.app.requestAction(JSON.stringify(template), 'ui');
    await reached;
    if (mode.endsWith('timeout')) {
      const timeout = [...h.timers.values()].find(timer => timer.ms === 75000);
      assert.ok(timeout); timeout.fn();
    }
    assert.deepEqual(await pending, { ok: false, error: 'whisper_outcome_unknown' });
    assert.equal(h.calls.length, 2); assert.equal(selected.remaining(), 0); assert.equal(h.timers.size, 0);
    assert.equal(h.render().view.result, null); assert.equal(h.render().view.busy, false);
  }
});

test('concurrent submit is blocked and pagehide aborts in-flight upload while clearing every input', async () => {
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const h = harness(call => {
    if (call.path === '/api/whisper/transcribe') {
      entered();
      return new Promise((resolve, reject) => call.options.signal.addEventListener('abort', () => reject(new Error('FAKE_PAGEHIDE')), {once: true}));
    }
  });
  h.app.keyInput.current = { value: 'FAKE_FINMIND_INPUT' }; h.app.whisperKeyInput.current = { value: fakeKey };
  const selected = attachFile(h.app);
  const cleanup = h.effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  const pending = h.app.requestAction(JSON.stringify(template), 'ui');
  await reached;
  const count = h.calls.length;
  assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), {ok: false, error: 'busy'});
  assert.equal(h.calls.length, count);
  h.listeners.get('pagehide')();
  assert.deepEqual(await pending, {ok: false, error: 'whisper_outcome_unknown'});
  assert.equal(h.app.keyInput.current.value, ''); assert.equal(h.app.whisperKeyInput.current.value, ''); assert.equal(selected.remaining(), 0);
  cleanup(); assert.equal(h.listeners.has('pagehide'), false);
});

test('UI source keeps owner keys and audio uncontrolled and explicitly discloses URL token and unknown outcomes', () => {
  assert.match(source, /id="proxy-whisper-key" ref=\{whisperKeyInput\} type="password"/);
  assert.doesNotMatch(source, /id="proxy-whisper-key"[^>]*(?:value|onChange)=/);
  assert.match(source, /id="proxy-audio" ref=\{audioInput\} type="file"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(?:log|error|debug)|URL\.createObjectURL|\.click\(/);
  assert.match(source, /URL 路徑中的金鑰/); assert.match(source, /伺服器期限 60 秒/); assert.match(source, /75 秒/); assert.match(source, /結果未知/);
});


test('review: a response body connection drop after dispatch reports unknown and never resends', async () => {
  let calls = 0;
  const h = harness(call => {
    if (call.path !== '/api/whisper/transcribe') return;
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"partial'));
        queueMicrotask(() => controller.error(new TypeError('FAKE_NETWORK_TERMINATED')));
      },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const selected = attachFile(h.app);
  assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: 'whisper_outcome_unknown' });
  assert.equal(calls, 1);
  assert.equal(selected.remaining(), 0);
  assert.equal(h.render().view.busy, false);
  assert.equal(h.render().view.result, null);
  assert.deepEqual(await h.app.requestAction(JSON.stringify(template), 'ui'), { ok: false, error: 'whisper_audio_required' });
  assert.equal(calls, 1);
});
