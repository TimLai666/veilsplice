import { FINMIND_SERVICE } from "./service-registry.ts";
import { credentialConfigured, credentialForRequest } from "./credentials.ts";
export { PRICE_SCHEMA } from "./service-registry.ts";
export type Runtime = { OWNER_EMAIL_SHA256?: string; DB?: D1Database };
export type PriceArgs = { stock_id: string; start_date: string; end_date: string };
export type Result = { ok: boolean; code?: string; message?: string; [key: string]: unknown };
const DATA_URL = FINMIND_SERVICE.endpoints.prices.url;
const USAGE_URL = FINMIND_SERVICE.endpoints.usage.url;
const DAY = 86400000;
export const fail = (code:string,message:string):Result => ({ok:false,code,message});
export async function status(env:Runtime):Promise<Result> {
  try { return {ok:true,configured:await credentialConfigured(env),scope:"TaiwanStockPrice, API usage",max_days:31,rate_limit:{per_minute:12,per_hour:120}}; }
  catch { return fail("UNAVAILABLE","暫時無法確認金鑰設定，請稍後再試。"); }
}
export async function authorized(headers:Headers, env:Runtime):Promise<number> {
  // Only Sites dispatch-provided identity headers are accepted. The deployment
  // must remain owner-private; the Worker has no public alternate origin.
  const id=headers.get("oai-authenticated-user-id"),email=headers.get("oai-authenticated-user-email");
  if(!id || !email) return 401;
  if(!env.OWNER_EMAIL_SHA256 || !/^[a-f0-9]{64}$/.test(env.OWNER_EMAIL_SHA256)) return 403;
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(email.trim().toLowerCase()));
  const digest=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
  return digest===env.OWNER_EMAIL_SHA256 ? 200 : 403;
}
export function validatePriceArgs(value:unknown,now=Date.now()):PriceArgs|null {
  if(!value || typeof value!=="object" || Array.isArray(value)) return null;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="end_date,start_date,stock_id")return null;
  if(typeof v.stock_id!=="string" || !/^[0-9]{4,6}[A-Z]?$/.test(v.stock_id))return null;
  for(const k of ["start_date","end_date"]){ const s=v[k]; if(typeof s!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(s))return null; const t=Date.parse(s+"T00:00:00Z"); if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==s)return null; }
  const start=Date.parse(v.start_date as string),end=Date.parse(v.end_date as string);
  const taipeiToday=new Date(now+8*3600000).toISOString().slice(0,10);
  if(start<Date.parse("1990-01-01")||end<start||(end-start)/DAY>=31||(v.end_date as string)>taipeiToday)return null;
  return v as PriceArgs;
}
const LIMIT_SQL = `INSERT INTO request_limits (id, minute_window, minute_count, hour_window, hour_count) VALUES ('finmind', ?, 1, ?, 1) ON CONFLICT(id) DO UPDATE SET minute_window=MAX(request_limits.minute_window,excluded.minute_window), minute_count=CASE WHEN request_limits.minute_window>=excluded.minute_window THEN request_limits.minute_count+1 ELSE 1 END, hour_window=MAX(request_limits.hour_window,excluded.hour_window), hour_count=CASE WHEN request_limits.hour_window>=excluded.hour_window THEN request_limits.hour_count+1 ELSE 1 END WHERE (request_limits.minute_window<excluded.minute_window OR request_limits.minute_count<12) AND (request_limits.hour_window<excluded.hour_window OR request_limits.hour_count<120) RETURNING id`;
export async function reserveRequest(env:Runtime,now=Date.now()):Promise<Result|null>{
  if(!env.DB)return fail("UNAVAILABLE","請稍後再試；安全限制暫時無法確認。");
  try { const row=await env.DB.prepare(LIMIT_SQL).bind(Math.floor(now/60000),Math.floor(now/3600000)).first(); return row ? null : fail("RATE_LIMITED","已達本工具查詢上限（每分鐘 12 次、每小時 120 次），請稍後再試。"); }catch{return fail("UNAVAILABLE","請稍後再試；安全限制暫時無法確認。");}
}
async function boundedJson(response:Response):Promise<unknown>{
  if(!response.body)throw new Error("empty");
  const reader=response.body.getReader(); let bytes=0; const chunks:Uint8Array[]=[];
  try{while(true){ const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>131072)throw new Error("size");chunks.push(value); }}finally{await reader.cancel().catch(()=>{});}
  const out=new Uint8Array(bytes);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.byteLength;}return JSON.parse(new TextDecoder().decode(out));
}
const numeric=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=1e16;
export function projectPrices(raw:unknown,args:PriceArgs):Result {
  if(!raw||typeof raw!=="object")return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
  const obj=raw as Record<string,unknown>;
  if(obj.status!==200||!Array.isArray(obj.data)||obj.data.length>31)return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
  const rows:Record<string,unknown>[]=[];const seen=new Set<string>();
  for(const row of obj.data){
    if(!row||typeof row!=="object")return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
    const r=row as Record<string,unknown>;
    if(r.stock_id!==args.stock_id||typeof r.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date+"T00:00:00Z"))||new Date(r.date+"T00:00:00Z").toISOString().slice(0,10)!==r.date||r.date<args.start_date||r.date>args.end_date||seen.has(r.date))return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
    const out:Record<string,unknown>={date:r.date,stock_id:args.stock_id};seen.add(r.date);
    for(const field of ["open","max","min","close","spread","Trading_Volume","Trading_money","Trading_turnover"]){if(!numeric(r[field]))return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");out[field]=r[field];}
    rows.push(out);
  }
  rows.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  return {ok:true,dataset:"TaiwanStockPrice",...args,rows};
}
export function projectUsage(raw:unknown):Result{
  if(!raw||typeof raw!=="object")return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
  const r=raw as Record<string,unknown>;
  for(const k of ["user_count","api_request_limit"])if(!Number.isSafeInteger(r[k])||(r[k] as number)<0)return fail("UPSTREAM_RESPONSE","資料來源回應格式不符預期。");
  return {ok:true,user_count:r.user_count,api_request_limit:r.api_request_limit};
}
export async function execute(name:string,args:unknown,env:Runtime,fetcher:typeof fetch=fetch):Promise<Result>{
  let validated:PriceArgs|null=null;
  if(name==="finmind_prices"){validated=validatePriceArgs(args);if(!validated)return fail("INVALID_INPUT","請輸入正確股票代碼與日期；區間最多 31 天，不能含未來日期。");}
  else if(name==="finmind_usage"||name==="finmind_status"){if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).length)return fail("INVALID_INPUT","此工具不接受參數。");}
  else return fail("UNKNOWN_TOOL","不支援這個工具。");
  if(name==="finmind_status")return status(env);
  let token:string|null;
  try { token=await credentialForRequest(env); } catch { return fail("UNAVAILABLE","暫時無法使用金鑰，請稍後再試。"); }
  if(!token)return fail("NOT_CONFIGURED","尚未設定金鑰或已停用。請由擁有者在私人網站親自輸入並提交 FinMind key。");
  const blocked=await reserveRequest(env);if(blocked)return blocked;
  const url=new URL(validated?DATA_URL:USAGE_URL);
  if(validated){url.searchParams.set("dataset","TaiwanStockPrice");url.searchParams.set("data_id",validated.stock_id);url.searchParams.set("start_date",validated.start_date);url.searchParams.set("end_date",validated.end_date);}
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),8000);
  try{
    // Never accept a URL, header, token, method, dataset or arbitrary path from callers.
    // No token query parameter; redirects and retries are disabled.
    const response=await fetcher(url,{method:"GET",headers:{Authorization:`Bearer ${token}`,Accept:"application/json"},redirect:"manual",signal:abort.signal});
    if(response.status===401||response.status===403)return fail("AUTH_REJECTED","FinMind 未接受金鑰，請由擁有者在私人網站重新設定並確認權限。");
    if(response.status===402||response.status===429)return fail("UPSTREAM_LIMIT","FinMind 用量已達限制，請稍後再試。");
    if(!response.ok || response.redirected)return fail("UPSTREAM_UNAVAILABLE","FinMind 目前無法提供資料，請稍後再試。");
    const raw=await boundedJson(response);return validated?projectPrices(raw,validated):projectUsage(raw);
  }catch{return fail("UPSTREAM_UNAVAILABLE","FinMind 目前無法提供資料，請稍後再試。");}finally{clearTimeout(timer);}
}
