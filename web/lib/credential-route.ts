import { authorized, fail, type Runtime } from "./finmind.ts";
import { credentialConfigured, disableCredential, saveCredential, validToken } from "./credentials.ts";

const COOKIE = "__Host-finmind-csrf";
const TTL = 600;
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", ...extra } });
function csrfCookie(request: Request): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(COOKIE + "="));
  return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : null;
}
export function validCsrf(request: Request, now = Date.now()): boolean {
  const header = request.headers.get("x-csrf-token"), cookie = csrfCookie(request);
  if (!header || !cookie || !/^\d{13}\.[a-f0-9]{64}$/.test(header) || header.length !== cookie.length) return false;
  let difference = 0;
  for (let i = 0; i < header.length; i++) difference |= header.charCodeAt(i) ^ cookie.charCodeAt(i);
  const age = now - Number(header.split(".")[0]);
  return difference === 0 && age >= 0 && age <= TTL * 1000;
}
export function issueCsrf(request: Request): { token: string; cookie: string } {
  const existing = csrfCookie(request), now = Date.now();
  const age = existing ? now - Number(existing.split(".")[0]) : -1;
  // Keep an unexpired host-only cookie so opening another tab does not
  // invalidate an existing form. Clients refresh this before each submission.
  let token = existing && /^\d{13}\.[a-f0-9]{64}$/.test(existing) && age >= 0 && age < TTL * 1000 ? existing : "";
  if (!token) {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    token = `${now}.${random}`;
  }
  return { token, cookie: `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${TTL}` };
}
async function readInput(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? "0") > 9000 || !request.body) throw new Error("Invalid input");
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 9000) throw new Error("Invalid input");
      text += decoder.decode(part.value, { stream: true });
    }
    const data: unknown = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid input");
    return data as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); }
}
/** This owner settings route is deliberately absent from MCP and WebMCP. */
export async function handleCredential(request: Request, env: Runtime): Promise<Response> {
  const auth = await authorized(request.headers, env);
  if (auth !== 200) return json(fail(auth === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", "需要擁有者登入。"), auth);
  const url = new URL(request.url);
  if (url.pathname !== "/api/finmind/credential") return json(fail("NOT_FOUND", "找不到此操作。"), 404);
  if (url.search) return json(fail("INVALID_INPUT", "此操作不接受網址參數。"), 400);
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== url.origin) || (site && !["same-origin", "none"].includes(site))) return json(fail("FORBIDDEN", "不允許跨網站呼叫。"), 403);
  if (!["GET", "POST", "DELETE"].includes(request.method)) return json(fail("METHOD_NOT_ALLOWED", "不支援此操作。"), 405);
  try {
    if (request.method === "GET") {
      const configured = await credentialConfigured(env), csrf = issueCsrf(request);
      return json({ ok: true, configured, csrf: csrf.token }, 200, { "Set-Cookie": csrf.cookie });
    }
    if (origin !== url.origin || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !validCsrf(request)) return json(fail("FORBIDDEN", "表單驗證已失效，請重新整理後再試。"), 403);
    let data: Record<string, unknown>;
    try { data = await readInput(request); } catch { return json(fail("INVALID_INPUT", "提交內容格式不正確。"), 400); }
    if (request.method === "POST") {
      if (Object.keys(data).sort().join(",") !== "consent,token" || data.consent !== true || !validToken(data.token)) return json(fail("INVALID_INPUT", "請輸入有效格式的金鑰，並確認持續使用範圍。"), 400);
      await saveCredential(env, data.token);
      return json({ ok: true, configured: true });
    }
    if (Object.keys(data).length) return json(fail("INVALID_INPUT", "停用操作不接受其他內容。"), 400);
    await disableCredential(env);
    return json({ ok: true, configured: false });
  } catch { return json(fail("UNAVAILABLE", "安全儲存暫時無法使用，未能確認操作結果。請重新檢查狀態。"), 503); }
}
