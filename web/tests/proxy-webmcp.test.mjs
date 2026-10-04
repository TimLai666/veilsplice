// Helper extraction + mocked React hooks, flushSync, fetch, and tool registry.
// This is NOT acceptance testing in a supported browser/WebMCP implementation.
// It verifies source-level action/registration behavior only; it does not build
// TSX, render React DOM, validate real browser registration, or make a network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

test('mock WebMCP actions preserve aliases/anonymous input, commit before return, and clean up safely', async t => {
  const source = readFileSync(new URL('../app/proxy-console.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('type Variable =');
  const end = source.indexOf('  const status =');
  assert.ok(start >= 0 && end > start, 'Expected component/helper extraction markers');
  const prefix = source.slice(start, end)
    .replace('export default function ProxyConsole', 'function ProxyConsole')
    + 'return { requestAction, requestActionRef, mounted, locked };}';
  const js = stripTypeScriptTypes(prefix, { mode: 'strip' })
    + ';return {ProxyConsole,legacyPriceRequest};';

  const states = [], effects = [], registered = [];
  let commits = 0;
  const useState = initial => {
    const index = states.length;
    states.push(typeof initial === 'function' ? initial() : initial);
    return [states[index], value => { states[index] = value; }];
  };
  const document = {
    modelContext: {
      async registerTool(tool, options) { registered.push({ tool, options }); },
    },
  };
  const componentModule = new Function(
    'useEffect', 'useRef', 'useState', 'flushSync', 'PRICE_SCHEMA',
    'PROXY_REQUEST_SCHEMA', 'document', 'window', js,
  )(
    effect => effects.push(effect), value => ({ current: value }), useState,
    update => { update(); commits++; }, { type: 'object' }, { type: 'object' },
    document, { addEventListener() {}, removeEventListener() {} },
  );
  const app = componentModule.ProxyConsole();
  // Initial browser loading is not invoked in this isolated mock.
  app.mounted.current = true;
  app.locked.current = false;

  const savedFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = savedFetch; });
  const csrf = '1780000000000.' + 'a'.repeat(64);
  const requests = [];
  let metadata = { variables: [{ alias: 'fresh_alias', configured: true, active: true, version: 2 }], csrf };
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return Response.json(path === '/api/proxy/variables' ? metadata : {
      status: 200,
      anonymous: !JSON.stringify(JSON.parse(options.body)).includes('{{'),
      data: [{ date: '2026-10-01', close: 42 }],
    });
  };

  effects[1](); // Install the latest action ref.
  const cleanup = effects[2](); // Register only the two browser tools.
  t.after(cleanup);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(registered.map(item => item.tool.name), ['read_finmind_prices', 'veilsplice_request']);
  assert.ok(registered.every(item => item.tool.annotations.readOnlyHint === true));

  const legacyInput = { stock_id: '2330', start_date: '2026-10-01', end_date: '2026-10-02' };
  const legacy = await registered[0].tool.execute(legacyInput);
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.rows, legacy.data);
  assert.equal(JSON.parse(requests[1].options.body).headers.Authorization, 'Bearer {{fresh_alias}}');
  assert.equal(states[7].data[0].close, 42, 'Mock visible result is committed before resolution');
  assert.equal(states[2], false, 'Mock busy state is cleared before resolution');
  assert.ok(commits >= 4);

  const anonymousInput = {
    url: 'https://api.finmindtrade.com/api/v4/data', method: 'GET',
    query: { dataset: 'TaiwanStockPrice', data_id: '2330', start_date: '2026-10-01', end_date: '2026-10-02' },
  };
  const anonymous = await registered[1].tool.execute(anonymousInput);
  assert.equal(anonymous.anonymous, true);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), anonymousInput);
  assert.ok(requests.every(item =>
    item.path === '/api/proxy/variables' && item.options.method === 'GET'
    || item.path === '/api/proxy/execute' && item.options.method === 'POST'),
  'Tools only read metadata and execute requests; no credential mutation route');

  app.locked.current = true;
  const previousCount = requests.length;
  assert.deepEqual(await registered[1].tool.execute(anonymousInput), { ok: false, error: 'busy' });
  assert.equal(requests.length, previousCount);
  app.locked.current = false;

  metadata = { ...metadata, variables: [{ ...metadata.variables[0], active: false }] };
  assert.deepEqual(await registered[0].tool.execute(legacyInput), { ok: false, error: 'secret_unavailable' });
  globalThis.fetch = async () => { throw new Error('FAKE_DO_NOT_RETURN'); };
  assert.deepEqual(await registered[1].tool.execute(anonymousInput), { ok: false, error: 'unavailable' });

  cleanup();
  assert.ok(registered.every(item => item.options.signal.aborted));
  assert.deepEqual(await registered[1].tool.execute(anonymousInput), { ok: false, error: 'unavailable' });
});
