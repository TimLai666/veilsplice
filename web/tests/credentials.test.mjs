import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {testEnvironment,ownerHash} from './fixtures.mjs';
import {handleCredential} from '../lib/credential-route.ts';
import {handleMcp,handleApi,handleServiceCatalog} from '../lib/mcp.ts';
import {credentialConfigured} from '../lib/credentials.ts';
const fake='local-only-test-token-not-a-real-key';
const owner={'oai-authenticated-user-id':'owner-test','oai-authenticated-user-email':'owner@example.test'};
const base='https://site.test';
const req=(method='GET',headers={},body,path='/api/finmind/credential')=>new Request(base+path,{method,headers:{...owner,...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
async function form(env){const r=await handleCredential(req(),env),data=await r.json();assert.equal(r.status,200);return {csrf:data.csrf,cookie:r.headers.get('set-cookie').split(';')[0],response:r,data};}
const submission=(f,method='POST',data={token:fake,consent:true},headers={})=>req(method,{'content-type':'application/json',origin:base,'sec-fetch-site':'same-origin','x-csrf-token':f.csrf,cookie:f.cookie,...headers},data);
const rpc=(name,args={})=>new Request(base+'/mcp',{method:'POST',headers:{...owner,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,arguments:args}})});

test('owner-only settings never expose a token; status SELECT excludes credential values',async()=>{
 const env=testEnvironment(fake);
 for(const headers of [{},{'OAI-Sites-Authorization':'Bearer not-a-user'},{'x-user-email':'owner@example.test'}])assert.equal((await handleCredential(new Request(base+'/api/finmind/credential',{headers}),env)).status,401);
 assert.equal((await handleCredential(req('GET',{'oai-authenticated-user-email':'someone@example.test'}),env)).status,403);
 const f=await form(env);assert.equal(f.data.configured,true);assert.equal(JSON.stringify(f.data).includes(fake),false);assert.equal(f.response.headers.get('cache-control'),'no-store');
 assert.match(f.response.headers.get('set-cookie'),/__Host-finmind-csrf=.*; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600/);
 for(const query of env.DB.queries)assert.doesNotMatch(query,/SELECT token/i);
});

test('reject missing or mismatched CSRF, foreign or missing origin and cross-site fetch',async()=>{
 const env=testEnvironment(null),f=await form(env);
 for(const headers of [{'x-csrf-token':''},{cookie:''},{'x-csrf-token':f.csrf.slice(0,-1)+'z'},{cookie:f.cookie+'; '+f.cookie},{origin:'https://evil.test'},{origin:''},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}]){
  const r=await handleCredential(submission(f,'POST',undefined,headers),env);assert.equal(r.status,403);assert.equal((await r.text()).includes(fake),false);
 }
 const expired=(Date.now()-601000)+'.'+'a'.repeat(64);
 assert.equal((await handleCredential(submission(f,'POST',undefined,{'x-csrf-token':expired,cookie:'__Host-finmind-csrf='+expired}),env)).status,403);
 assert.equal(await credentialConfigured(env),false);
});

test('reject unconsented, malformed, oversized and arbitrary-target submissions',async()=>{
 const env=testEnvironment(null),f=await form(env);
 for(const data of [{token:fake,consent:false},{token:fake},{token:fake,consent:true,url:'https://evil.test'},{token:'short',consent:true},{token:fake+'\n',consent:true},[],{},'not json',{token:'a'.repeat(10000),consent:true}])assert.equal((await handleCredential(submission(f,'POST',data),env)).status,400);
 assert.equal((await handleCredential(req('GET',{},undefined,'/api/finmind/credential?token='+fake),env)).status,400);
 assert.equal((await handleCredential(req('GET',{},undefined,'/api/finmind/credential/extra'),env)).status,404);
 assert.equal((await handleCredential(req('PUT'),env)).status,405);
 assert.equal(await credentialConfigured(env),false);
});

test('owner submit persists across requests; browser and MCP share server-side injection; revoke stops both',async(t)=>{
 const env=testEnvironment(null),f=await form(env);let calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url:String(url),options});return Response.json({user_count:2,api_request_limit:600,token:fake});});
 let r=await handleCredential(submission(f),env);assert.deepEqual(await r.json(),{ok:true,configured:true});
 const fresh={DB:env.DB,OWNER_EMAIL_SHA256:ownerHash};
 const stored=env.DB.sqlite.prepare('SELECT token FROM service_credentials').get();assert.equal(stored.token,fake);
 // Application-visible text is expected with PLATFORM at-rest encryption.
 r=await handleMcp(rpc('finmind_usage'),fresh);let body=await r.json();assert.equal(body.result.structuredContent.ok,true);assert.equal(JSON.stringify(body).includes(fake),false);
 r=await handleApi(req('POST',{'content-type':'application/json'}, {},'/api/finmind/usage'),fresh);assert.equal((await r.json()).ok,true);
 assert.equal(calls.length,2);for(const call of calls){assert.equal(call.url,'https://api.web.finmindtrade.com/v2/user_info');assert.equal(call.options.headers.Authorization,'Bearer '+fake);assert.equal(call.options.redirect,'manual');}
 r=await handleCredential(submission(f,'DELETE',{}),fresh);assert.deepEqual(await r.json(),{ok:true,configured:false});
 assert.equal(env.DB.sqlite.prepare('SELECT token FROM service_credentials').get().token,null);
 // Legacy env credentials must never resurrect a disabled credential.
 fresh.FINMIND_TOKEN=fake;
 r=await handleMcp(rpc('finmind_usage'),fresh);body=await r.json();assert.equal(body.result.structuredContent.code,'NOT_CONFIGURED');
 r=await handleApi(req('POST',{'content-type':'application/json'}, {},'/api/finmind/usage'),fresh);assert.equal((await r.json()).code,'NOT_CONFIGURED');assert.equal(calls.length,2);
 r=await handleServiceCatalog(req('GET',{},undefined,'/api/services'),fresh);assert.deepEqual(await r.json(),{ok:true,services:[{id:'finmind',configured:false}]});
 r=await handleCredential(submission(f,'DELETE',{}),fresh);assert.equal(r.status,200);
});

test('replacement takes effect on the next request and credential scope excludes another owner',async(t)=>{
 const env=testEnvironment(fake),f=await form(env),replacement='another-local-fake-token';
 await handleCredential(submission(f,'POST',{token:replacement,consent:true}),env);
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer '+replacement);return Response.json({user_count:1,api_request_limit:600});});
 assert.equal((await (await handleMcp(rpc('finmind_usage'),env)).json()).result.structuredContent.ok,true);
 const other={...env,OWNER_EMAIL_SHA256:createHash('sha256').update('other@example.test').digest('hex')};
 assert.equal(await credentialConfigured(other),false);
});

test('database and upstream failures do not echo credentials or raw errors',async(t)=>{
 const env=testEnvironment(null),f=await form(env),broken={...env,DB:{prepare(){throw new Error(fake);}}};
 for(const request of [req(),submission(f),submission(f,'DELETE',{})]){const r=await handleCredential(request,broken);assert.equal(r.status,503);assert.equal((await r.text()).includes(fake),false);}
 const ready=testEnvironment(fake);t.mock.method(globalThis,'fetch',async()=>{throw new Error(fake);});
 const r=await handleMcp(rpc('finmind_usage'),ready),body=await r.text();assert.equal(body.includes(fake),false);assert.match(body,/UPSTREAM_UNAVAILABLE/);
});

test('MCP cannot submit/read credentials and client code has no credential persistence',async()=>{
 const env=testEnvironment(fake);
 for(const name of ['finmind_set_key','finmind_get_key','finmind_credential']){
  const r=await handleMcp(rpc(name,{token:fake}),env),text=await r.text();assert.match(text,/UNKNOWN_TOOL/);assert.equal(text.includes(fake),false);
 }
 for(const name of ['finmind_status','finmind_usage']){const r=await handleMcp(rpc(name,{token:fake}),env),text=await r.text();assert.match(text,/INVALID_INPUT/);assert.equal(text.includes(fake),false);}
 const client=readFileSync(new URL('../app/credential-settings.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(client,/localStorage|sessionStorage|indexedDB|console\./);
 assert.match(client,/type="password"/);assert.match(client,/input\.current\.value = ""/);
});

test('unexpired CSRF is reused across tabs; expired cookie receives a new form token',async()=>{
 const env=testEnvironment(null),a=await form(env);
 const b=await handleCredential(req('GET',{cookie:a.cookie}),env),bData=await b.json();assert.equal(bData.csrf,a.csrf);
 assert.equal((await handleCredential(submission(a),env)).status,200);
 const old=(Date.now()-601000)+'.'+'a'.repeat(64);
 const fresh=await handleCredential(req('GET',{cookie:'__Host-finmind-csrf='+old}),env),freshData=await fresh.json();assert.notEqual(freshData.csrf,old);
 const client=readFileSync(new URL('../app/credential-settings.tsx',import.meta.url),'utf8');
 assert.match(client,/const current = await loadSettings\(\)/);assert.match(client,/"X-CSRF-Token": current\.csrf/);
});
