/** Public-safe, code-owned service catalogue. No runtime credentials or dynamic URLs.
 * New providers require reviewed code plus explicit approval of their destinations,
 * data scope and secret configuration. Registering metadata does not grant access.
 */
import { PROXY_REQUEST_SCHEMA } from './proxy-tool-schema.ts';
export const PRICE_SCHEMA = { type: "object", properties: { stock_id: {type:"string",pattern:"^[0-9]{4,6}[A-Z]?$"}, start_date:{type:"string",format:"date"}, end_date:{type:"string",format:"date"}}, required:["stock_id","start_date","end_date"], additionalProperties:false };
const EMPTY_SCHEMA = { type:"object", properties:{}, additionalProperties:false };
export const FINMIND_SERVICE = {
 id:"finmind", name:"FinMind", summary:"台股每日行情與 API 用量", secretName:"FINMIND_TOKEN",
 endpoints: {
  prices:{method:"GET",url:"https://api.finmindtrade.com/api/v4/data",scope:"TaiwanStockPrice，每次一檔、最多 31 天"},
  usage:{method:"GET",url:"https://api.web.finmindtrade.com/v2/user_info",scope:"僅使用次數與使用上限"}
 },
 tools:[
  {name:"finmind_status",title:"設定狀態",summary:"確認是否已設定與變數名稱，不回傳金鑰",description:"Check configuration and the current variable alias metadata. Does not return credentials or call FinMind. Use the alias in veilsplice_request templates.",inputSchema:EMPTY_SCHEMA,external:false},
  {name:"finmind_prices",title:"每日行情",summary:"讀取一檔台股的每日價格與成交量",description:"Read FinMind TaiwanStockPrice daily market data for one stock and an inclusive range of up to 31 calendar days. Requires owner identity and configured token; returns only fixed numeric price/volume fields.",inputSchema:PRICE_SCHEMA,external:true},
  {name:"finmind_usage",title:"API 用量",summary:"讀取已使用次數與使用上限",description:"Read only FinMind API request count and request limit. Requires owner identity; never returns other account data or credentials.",inputSchema:EMPTY_SCHEMA,external:true},
  {name:"veilsplice_request",title:"變數 API 請求",summary:"匿名或以變數讀取既有 FinMind 範圍",description:"Execute a request template through the same owner-only proxy as the page. Only the approved FinMind GET price and usage endpoints are enabled. A missing placeholder means no saved-key lookup or injection. Read finmind_status for the current alias; reference it only as Authorization: Bearer {{alias}}. Never provide a literal key. Returns only projected data and fixed errors; cannot save, read or disable keys.",inputSchema:PROXY_REQUEST_SCHEMA,external:true}
 ]
} as const;
export const REGISTERED_SERVICES = [FINMIND_SERVICE] as const;
export type ServiceId = typeof REGISTERED_SERVICES[number]["id"];
export function listToolDefinitions(){
 return REGISTERED_SERVICES.flatMap(service=>service.tools.map(tool=>({
  name:tool.name,description:tool.description,inputSchema:tool.inputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:tool.external}
 })));
}
