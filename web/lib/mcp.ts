import { authorized,execute,status,fail,type Runtime,type Result } from "./finmind.ts";
import { REGISTERED_SERVICES,listToolDefinitions } from "./service-registry.ts";
import { executeOwnerTemplate } from './proxy-route.ts';
import { variableMetadata } from './proxy-variables.ts';
import { safeProxyErrorCode } from './generic-proxy.ts';
export const TOOLS=listToolDefinitions();
async function readBody(request:Request,max:number):Promise<string>{
 const claimed=Number(request.headers.get("content-length")??"0");if(Number.isFinite(claimed)&&claimed>max)throw new Error("size");
 if(!request.body)return "";const reader=request.body.getReader();const decoder=new TextDecoder();let bytes=0,out="";
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)throw new Error("size");out+=decoder.decode(value,{stream:true});}return out+decoder.decode();}finally{await reader.cancel().catch(()=>{});}
}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
const rpcError=(id:unknown,code:number,message:string,http=200)=>json({jsonrpc:"2.0",id:id??null,error:{code,message}},http);
export async function handleMcp(request:Request,env:Runtime):Promise<Response>{
  if(request.method!=="POST")return json({error:"Method not allowed"},405);
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Forbidden origin"},403);
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))return json({error:"JSON required"},415);
  let data:Record<string,unknown>;
  try{const text=await readBody(request,4096);const parsed:unknown=JSON.parse(text);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return rpcError(null,-32600,"Invalid request",400);data=parsed as Record<string,unknown>;}catch{return rpcError(null,-32700,"Invalid JSON",400);}
  if(!data||Array.isArray(data)||data.jsonrpc!=="2.0"||typeof data.method!=="string"||Object.keys(data).some(k=>!["jsonrpc","id","method","params"].includes(k)))return rpcError(data?.id,-32600,"Invalid request",400);
  const id=data.id;if(id!==undefined&&typeof id!=="string"&&typeof id!=="number"&&id!==null)return rpcError(null,-32600,"Invalid id",400);
  if(data.method==="notifications/initialized")return new Response(null,{status:202});
  if(data.method==="initialize")return json({jsonrpc:"2.0",id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"VeilSplice",version:"1.1.0"},instructions:"Owner-only, read-only adapter. The owner personally configures the FinMind key on the private website. The server stores it and injects it into approved FinMind requests. Never request, display, or transmit a key through tool arguments or results. This is a Worker adapter, not the Go VeilSplice runtime."}});
  if(data.method==="ping")return json({jsonrpc:"2.0",id,result:{}});
  if(data.method==="tools/list")return json({jsonrpc:"2.0",id,result:{tools:TOOLS}});
  if(data.method!=="tools/call")return rpcError(id,-32601,"Method not found");
  const auth=await authorized(request.headers,env);if(auth!==200)return rpcError(id,-32001,auth===401?"Authentication required":"Owner access required",auth);
  const p=data.params as Record<string,unknown>|null;if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(k=>!["name","arguments","_meta"].includes(k))||typeof p.name!=="string")return rpcError(id,-32602,"Invalid tool parameters");
  let result: Result;
  try {
    result = p.name === 'veilsplice_request'
      ? { ok: true, ...await executeOwnerTemplate(p.arguments ?? {}, env) }
      : await execute(p.name,p.arguments??{},env);
    // Discovery stays public/data-free. Alias metadata is available only after
    // the same verified owner check as every other data-bearing tool call.
    if (p.name === 'finmind_status' && result.ok) result = { ...result, variables: [await variableMetadata(env)] };
  } catch (error) {
    result = fail(safeProxyErrorCode(error), '請求未完成；未回傳原始錯誤或金鑰。');
  }
  return json({jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result,isError:!result.ok}});
}
export async function handleApi(request:Request,env:Runtime):Promise<Response>{
  const auth=await authorized(request.headers,env);if(auth!==200)return json(fail(auth===401?"UNAUTHENTICATED":"FORBIDDEN","需要擁有者登入。"),auth);
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json(fail("FORBIDDEN","不允許跨網站呼叫。"),403);
  const url=new URL(request.url);
  if(url.search)return json(fail("INVALID_INPUT","此操作不接受網址參數。"),400);
  const routes:Record<string,string>={"/api/finmind/status":"status","/api/finmind/prices":"prices","/api/finmind/usage":"usage"};
  const name=routes[url.pathname];
  if(request.method==="GET"&&name==="status")return json(await execute("finmind_status",{},env));
  if(request.method!=="POST"||!["prices","usage"].includes(name??""))return json(fail("NOT_FOUND","找不到此操作。"),404);
  if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))return json(fail("INVALID_INPUT","需要 JSON 格式。"),415);
  let args:unknown;try{const body=await readBody(request,1024);args=JSON.parse(body);}catch{return json(fail("INVALID_INPUT","參數格式不正確。"),400);}
  return json(await execute(`finmind_${name}`,args,env));
}

/** Read-only catalogue; credential material never leaves an adapter. */
export async function handleServiceCatalog(request:Request,env:Runtime):Promise<Response>{
 const auth=await authorized(request.headers,env);
 if(auth!==200)return json(fail(auth===401?"UNAUTHENTICATED":"FORBIDDEN","需要擁有者登入。"),auth);
 const url=new URL(request.url),origin=request.headers.get("origin");
 if(origin&&origin!==url.origin)return json(fail("FORBIDDEN","不允許跨網站呼叫。"),403);
 if(url.pathname!=="/api/services")return json(fail("NOT_FOUND","找不到此操作。"),404);
 if(request.method!=="GET")return json(fail("METHOD_NOT_ALLOWED","此入口僅提供唯讀狀態。"),405);
 if(url.search)return json(fail("INVALID_INPUT","此操作不接受網址參數。"),400);
 // Explicit binding per reviewed provider. Never index env with request input
 // or a registry secret name, and never return the env object or secret value.
 const finmind=await status(env);
 if(!finmind.ok)return json(finmind,503);
 const configuredByService={finmind:finmind.configured===true};
 return json({ok:true,services:REGISTERED_SERVICES.map(service=>({id:service.id,configured:configuredByService[service.id]}))});
}
