import handler from "vinext/server/fetch-handler";
import { handleMcp, handleApi, handleServiceCatalog } from "../lib/mcp";
import { handleCredential } from "../lib/credential-route";
import { handleProxyRoute } from "../lib/proxy-route";
import { handleWhisperRoute } from "../lib/whisper-route";
import type { Runtime } from "../lib/finmind";

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return handleMcp(request, env as Runtime);
    if (path === "/api/whisper" || path.startsWith("/api/whisper/")) return handleWhisperRoute(request, env as Runtime);
    if (path === "/api/proxy" || path.startsWith("/api/proxy/")) return handleProxyRoute(request, env as Runtime);
    if (path === "/api/finmind/credential") return handleCredential(request, env as Runtime);
    if (path === "/api/services" || path.startsWith("/api/services/")) return handleServiceCatalog(request, env as Runtime);
    if (path.startsWith("/api/finmind/")) return handleApi(request, env as Runtime);
    const response = await handler.fetch(request, env, ctx);
    if (!response.headers.get("content-type")?.includes("text/html")) return response;
    const secured = new Response(response.body, response);
    secured.headers.append("Content-Security-Policy", "frame-ancestors 'self' https://chatgpt.com; form-action 'self'; base-uri 'self'; object-src 'none'");
    secured.headers.set("Referrer-Policy", "no-referrer");
    secured.headers.set("Cache-Control", "no-store");
    return secured;
  },
};
