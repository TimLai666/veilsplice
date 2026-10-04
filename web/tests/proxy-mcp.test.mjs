import test from 'node:test';
import assert from 'node:assert/strict';
import { testEnvironment } from './fixtures.mjs';
import { handleMcp } from '../lib/mcp.ts';
import { saveVariable, disableVariable } from '../lib/proxy-variables.ts';

globalThis.fetch = async () => { throw new Error('NETWORK_IS_FORBIDDEN_IN_PROXY_MCP_TESTS'); };
const secret = 'FAKE_mcp_owner_only_key', next = 'FAKE_mcp_rotated_key';
const owner = { 'oai-authenticated-user-id': 'test-owner', 'oai-authenticated-user-email': 'owner@example.test' };
const usage = alias => ({ url: 'https://api.web.finmindtrade.com/v2/user_info', method: 'GET', ...(alias ? { headers: { Authorization: `Bearer {{${alias}}}` } } : {}) });
function environment() {
  const env = testEnvironment(secret);
  env.DB.sqlite.exec("ALTER TABLE service_credentials ADD COLUMN alias TEXT NOT NULL DEFAULT 'finmind_token'");
  return env;
}
function rpc(method, params, headers = owner) {
  return new Request('https://site.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 17, method, ...(params === undefined ? {} : { params }) }) });
}
async function safe(response) {
  const text = await response.text();
  for (const key of [secret, next]) assert.equal(text.includes(key), false);
  return JSON.parse(text);
}
const call = (env, name, args = {}, headers = owner) => handleMcp(rpc('tools/call', { name, arguments: args }, headers), env);

test('generic MCP discovery remains data-free and alias metadata requires existing owner identity without key reads', async () => {
  const env = environment();
  await saveVariable(env, 'research_key');
  const discovery = await safe(await handleMcp(rpc('tools/list', undefined, {}), env));
  assert.deepEqual(discovery.result.tools.map(tool => tool.name), ['finmind_status', 'finmind_prices', 'finmind_usage', 'veilsplice_request']);
  assert.ok(discovery.result.tools.every(tool => tool.annotations.readOnlyHint === true));
  assert.equal(JSON.stringify(discovery).includes('research_key'), false);
  env.DB.queries.length = 0;
  for (const headers of [{}, { 'OAI-Sites-Authorization': 'Bearer fake-platform-only' }, { ...owner, 'oai-authenticated-user-email': 'other@example.test' }]) {
    const response = await call(env, 'veilsplice_request', usage('research_key'), headers);
    assert.ok([401, 403].includes(response.status)); await safe(response);
  }
  assert.equal(env.DB.queries.length, 0);
  const status = await safe(await call(env, 'finmind_status'));
  assert.equal(status.result.structuredContent.variables[0].alias, 'research_key');
  assert.deepEqual(Object.keys(status.result.structuredContent.variables[0]), ['alias', 'configured', 'active', 'version']);
  assert.ok(env.DB.queries.every(query => !/^SELECT token/i.test(query)));
});

test('generic MCP uses the existing proxy for anonymous/alias/rotation/disable and never permits key-management tools', async t => {
  const env = environment(); let expected = null, sent = 0;
  t.mock.method(globalThis, 'fetch', async request => {
    assert.ok(request instanceof Request); sent++;
    assert.equal(request.headers.get('authorization'), expected);
    assert.equal(request.redirect, 'manual');
    return Response.json({ user_count: 1, api_request_limit: 600, token: next });
  });
  env.DB.queries.length = 0;
  let result = (await safe(await call(env, 'veilsplice_request', usage()))).result;
  assert.equal(result.isError, false); assert.equal(result.structuredContent.anonymous, true);
  assert.ok(env.DB.queries.every(query => !/service_credentials/i.test(query)));
  expected = 'Bearer ' + secret;
  result = (await safe(await call(env, 'veilsplice_request', usage('finmind_token')))).result;
  assert.equal(result.structuredContent.anonymous, false);
  await saveVariable(env, 'research_key', next); expected = 'Bearer ' + next;
  assert.equal((await safe(await call(env, 'veilsplice_request', usage('research_key')))).result.isError, false);
  assert.equal((await safe(await call(env, 'veilsplice_request', usage('finmind_token')))).result.isError, true);
  await disableVariable(env, 'research_key');
  assert.equal((await safe(await call(env, 'veilsplice_request', usage('research_key')))).result.structuredContent.code, 'secret_unavailable');
  for (const name of ['finmind_set_key', 'finmind_get_key', 'veilsplice_save_variable', 'veilsplice_disable_variable']) {
    assert.equal((await safe(await call(env, name, { token: secret }))).result.structuredContent.code, 'UNKNOWN_TOOL');
  }
  assert.equal(sent, 3);
});

test('generic MCP rejects other scopes and returns fixed redirect/transport failures without key material', async t => {
  const env = environment(); let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return new Response(secret, { status: 302, headers: { location: 'https://unapproved.example/' + secret } }); });
  for (const input of [{ ...usage('finmind_token'), url: 'https://unapproved.example/data' }, { ...usage('finmind_token'), method: 'POST', json: {} }, { ...usage(), query: { token: '{{finmind_token}}' } }]) {
    env.DB.queries.length = 0;
    const body = await safe(await call(env, 'veilsplice_request', input));
    assert.equal(body.result.isError, true);
    assert.ok(env.DB.queries.every(query => !/^SELECT token/i.test(query)));
  }
  assert.equal(sent, 0);
  const redirected = await safe(await call(env, 'veilsplice_request', usage('finmind_token')));
  assert.equal(redirected.result.structuredContent.code, 'redirect_denied'); assert.equal(sent, 1);
});
