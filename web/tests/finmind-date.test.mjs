import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectPrices, execute } from '../lib/finmind.ts';
import { handleProxyRoute } from '../lib/proxy-route.ts';
import { testEnvironment } from './fixtures.mjs';

globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN'); };
const fake = 'FAKE_date_boundary_key';
const price = { date: '2026-01-01', stock_id: '2330', open: 100, max: 102, min: 99, close: 101, spread: 1, Trading_Volume: 1000, Trading_money: 101000, Trading_turnover: 30 };
const args = { stock_id: '2330', start_date: '2026-01-01', end_date: '2026-01-31' };
const owner = { 'oai-authenticated-user-id': 'test-owner', 'oai-authenticated-user-email': 'owner@example.test' };
const invalid = ['2026-13-01', '2026-00-01', '2026-01-32', '2026-02-30'];
const inputFor = date => date === '2026-02-30' ? { ...args, start_date: '2026-02-01', end_date: '2026-02-28' } : args;
const payloadFor = date => ({ status: 200, data: [{ ...price, date, token: fake, debug: 'PRIVATE_UPSTREAM_MARKER' }] });

for (const date of invalid) {
  test('projectPrices returns a fixed failure without throwing for ' + date, () => {
    assert.deepEqual(projectPrices(payloadFor(date), inputFor(date)), {
      ok: false, code: 'UPSTREAM_RESPONSE', message: '資料來源回應格式不符預期。',
    });
  });
  test('legacy execute consistently classifies malformed upstream date ' + date, async () => {
    const env = testEnvironment(fake); let calls = 0;
    try {
      const result = await execute('finmind_prices', inputFor(date), env, async () => {
        calls++; return Response.json(payloadFor(date));
      });
      assert.equal(calls, 1);
      assert.deepEqual(result, { ok: false, code: 'UPSTREAM_RESPONSE', message: '資料來源回應格式不符預期。' });
    } finally { env.DB.sqlite.close(); }
  });
  test('HTTP proxy rejects malformed upstream date with fixed 502 for ' + date, async () => {
    const env = testEnvironment(fake); let calls = 0;
    try {
      env.DB.sqlite.exec(readFileSync(new URL('../drizzle/0002_hard_darkstar.sql', import.meta.url), 'utf8'));
      const setup = await handleProxyRoute(new Request('https://site.test/api/proxy/variables', { headers: owner }), env);
      assert.equal(setup.status, 200);
      const { csrf } = await setup.json();
      const range = inputFor(date);
      const input = { url: 'https://api.finmindtrade.com/api/v4/data', method: 'GET',
        query: { dataset: 'TaiwanStockPrice', data_id: range.stock_id, start_date: range.start_date, end_date: range.end_date } };
      const result = await handleProxyRoute(new Request('https://site.test/api/proxy/execute', {
        method: 'POST', headers: { ...owner, origin: 'https://site.test', 'content-type': 'application/json',
          'x-csrf-token': csrf, cookie: setup.headers.get('set-cookie').split(';')[0] },
        body: JSON.stringify(input),
      }), env, async request => {
        calls++; assert.equal(request.headers.get('authorization'), null);
        return Response.json(payloadFor(date));
      });
      assert.equal(calls, 1); assert.equal(result.status, 502);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await result.json(), { error: 'invalid_response' });
    } finally { env.DB.sqlite.close(); }
  });
}
test('valid calendar dates keep exact projection, sorting and leap-day behavior', () => {
  for (const dates of [['2026-01-31', '2026-01-01'], ['2024-02-29', '2024-02-01']]) {
    const range = { ...args, start_date: dates[1], end_date: dates[0] };
    const result = projectPrices({ status: 200, data: dates.map(date => ({ ...price, date, token: fake })) }, range);
    assert.deepEqual(result, { ok: true, dataset: 'TaiwanStockPrice', ...range,
      rows: [...dates].sort().map(date => ({ ...price, date })) });
  }
});
