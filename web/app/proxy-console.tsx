"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { PRICE_SCHEMA } from "@/lib/service-registry";
import { PROXY_REQUEST_SCHEMA } from "@/lib/proxy-tool-schema";
import "./proxy-console.css";

type Variable = { alias: string; configured: boolean; active: boolean; version: number };
type Settings = { variables: Variable[]; csrf: string };
type WhisperSettings = { variable: Variable; csrf: string };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Result = { status: number; anonymous: boolean; data: Json };
type RequestInput = { url: string; method: string; headers?: Record<string, string>; query?: Record<string, string>; json?: Json; form?: Record<string, string>; multipart?: { file: { attachment: "audio" }; model?: "whisper-1" | "turbo"; language?: string } };
type ToolResult = ({ ok: true; rows?: Json } & Result) | { ok: false; error: string };
type RequestKind = "ui" | "generic" | "legacy";
type RequestAction = (input: unknown, kind?: RequestKind) => Promise<ToolResult>;
type ModelContext = { registerTool: (tool: { name: string; description: string; inputSchema: typeof PRICE_SCHEMA | typeof PROXY_REQUEST_SCHEMA; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => Promise<ToolResult> }, options: { signal: AbortSignal }) => void | Promise<void> };
const PRICE_URL = "https://api.finmindtrade.com/api/v4/data";
const USAGE_URL = "https://api.web.finmindtrade.com/v2/user_info";
const DEFAULT_ALIAS = "finmind_token";
const WHISPER_ALIAS = "whisper_token";
const WHISPER_URL = "https://infra.hazelnut-paradise.com/use/whisper/{{whisper_token}}/v1/audio/transcriptions";
const AUDIO_TYPES = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/flac"];
const AUDIO_BYTES = 8 * 1024 * 1024;
const MESSAGES: Record<string, string> = {
  busy: "上一個操作仍在處理中，請等待完成。",
  tool_unavailable: "瀏覽器工具暫時無法註冊；你仍可使用下方請求編輯器。",
  invalid_alias: "變數名稱請以小寫字母開頭，只使用小寫字母、數字及底線，最多 64 字。",
  alias_conflict: "whisper_token 是 Whisper 專用名稱。若既有 FinMind 變數使用此名稱，請先為 FinMind 改名。",
  invalid_request: "請檢查請求 JSON、網址、方法與欄位格式。網址參數放在 query；本文擇一使用 json 或 form。",
  invalid_placeholder: "變數格式不正確，請使用 {{變數名稱}}，且只能引用目前啟用的變數。",
  unknown_alias: "請求引用了不存在或已停用的變數，請先檢查上方設定。",
  consent_required: "請先勾選同意此私人網站依下方範圍保存及使用 FinMind 設定。",
  invalid_value: "金鑰格式不正確，請由本人重新輸入。輸入欄已清空。",
  denied: "請求超出目前核准的目的地、方法、欄位或變數位置，已停止。",
  forbidden: "目前無法授權這個操作，請重新載入設定後再確認。",
  unauthorized: "目前的登入狀態無法使用此私人工作台，請重新登入。",
  invalid_csrf: "表單驗證已失效，請重新載入設定後再操作。",
  csrf: "表單驗證已失效，請重新載入設定後再操作。",
  not_found: "此功能尚未啟用或不存在。",
  secret_unavailable: "指定變數尚未設定、已停用或暫時無法取得。",
  not_configured: "FinMind 尚未設定或已停用。",
  invalid_policy: "伺服器的使用規則需要檢查，請稍後再試。",
  invalid_response: "回應未通過驗證，未顯示原始內容。",
  redirect_denied: "請求發生重新導向，已停止。",
  upstream_error: "FinMind 未成功回應，未顯示原始錯誤內容。",
  rate_limited: "查詢過於頻繁，請稍後再試。",
  unavailable: "無法確認操作結果。請先重新載入設定，勿直接重複提交金鑰。",
  whisper_consent_required: "請先同意依目前揭示的範圍保存及使用 Whisper 設定。",
  whisper_invalid_value: "Whisper 金鑰格式不正確，請由本人重新輸入。輸入欄已清空。",
  whisper_invalid_request: "Whisper 只接受固定 URL、POST、audio 附件；model 可省略或填 whisper-1／turbo，language 可省略或填 2 至 3 個小寫英文字母。",
  whisper_audio_required: "請先選擇要轉錄的音訊檔案。",
  whisper_audio_type: "請選擇 WAV、MP3、M4A／MP4、WebM、Ogg 或 FLAC 音訊；檔案必須具有支援的 audio MIME 類型。",
  whisper_too_large: "Whisper 音訊須大於 0 bytes，且不超過 8 MiB。",
  whisper_disabled: "Whisper 尚未啟用或目前不可用。",
  whisper_secret_unavailable: "Whisper 尚未設定、已停用或暫時無法取得，請檢查上方設定。",
  whisper_upstream_error: "Whisper 未成功回應，未顯示原始錯誤內容。",
  whisper_invalid_response: "Whisper 回應未通過驗證，未顯示原始內容。",
  whisper_rate_limited: "Whisper 請求過於頻繁，請稍後再試。",
  whisper_unavailable: "無法確認 Whisper 操作結果。請先重新載入設定，勿直接重複提交金鑰。",
  whisper_outcome_unknown: "Whisper 請求逾時或連線中斷，結果未知；上游可能已開始處理。請勿自動重送，以免重複處理。音檔選擇已清除。",
};
class ConsoleError extends Error {
  code: string;
  constructor(code: string) { const safe = Object.hasOwn(MESSAGES, code) ? code : "unavailable"; super(safe); this.code = safe; }
}
function fail(code: string): never { throw new ConsoleError(code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function only(value: unknown, keys: string[]): value is Record<string, unknown> { return record(value) && Object.keys(value).every(key => keys.includes(key)); }
function validAlias(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value); }

function validateSettings(value: unknown): Settings {
  if (!only(value, ["variables", "csrf"]) || !Array.isArray(value.variables) || value.variables.length > 1
      || typeof value.csrf !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(value.csrf)) fail("invalid_response");
  const variables = value.variables.map((row: unknown) => {
    if (!only(row, ["alias", "configured", "active", "version"]) || !validAlias(row.alias)
        || typeof row.configured !== "boolean" || typeof row.active !== "boolean"
        || !Number.isSafeInteger(row.version) || Number(row.version) < 0) fail("invalid_response");
    return { alias: row.alias, configured: row.configured, active: row.active, version: row.version as number };
  });
  return { variables, csrf: value.csrf };
}

function validateWhisperSettings(value: unknown): WhisperSettings {
  if (!only(value, ["variable", "csrf"]) || !only(value.variable, ["alias", "configured", "active", "version"])
      || value.variable.alias !== WHISPER_ALIAS || typeof value.variable.configured !== "boolean" || typeof value.variable.active !== "boolean"
      || !Number.isSafeInteger(value.variable.version) || Number(value.variable.version) < 0
      || typeof value.csrf !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(value.csrf)) fail("whisper_invalid_response");
  return { variable: { alias: WHISPER_ALIAS, configured: value.variable.configured, active: value.variable.active, version: value.variable.version as number }, csrf: value.csrf };
}

function validateJson(value: unknown, depth = 0): Json {
  if (depth > 12) fail("invalid_response");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => validateJson(item, depth + 1));
  if (!record(value)) fail("invalid_response");
  const output: Record<string, Json> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) fail("invalid_response");
    output[key] = validateJson(item, depth + 1);
  }
  return output;
}

function validateResult(value: unknown): Result {
  if (!only(value, ["status", "anonymous", "data"]) || !Object.hasOwn(value, "data")
      || !Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) >= 300
      || typeof value.anonymous !== "boolean") fail("invalid_response");
  // Provider projection and secret-echo rejection remain mandatory server work.
  return { status: value.status as number, anonymous: value.anonymous, data: validateJson(value.data) };
}

function parseRequest(text: string, allowWhisper = false): RequestInput {
  if (new TextEncoder().encode(text).length > 65536) fail("invalid_request");
  let input: unknown;
  try { input = JSON.parse(text); } catch { fail("invalid_request"); }
  if (record(input) && Object.hasOwn(input, "multipart")) {
    if (!allowWhisper) fail("denied");
    if (!only(input, ["url", "method", "multipart"]) || input.url !== WHISPER_URL || input.method !== "POST"
        || !only(input.multipart, ["file", "model", "language"]) || !only(input.multipart.file, ["attachment"])
        || input.multipart.file.attachment !== "audio" || (input.multipart.model !== undefined && !["whisper-1", "turbo"].includes(input.multipart.model as string))
        || (input.multipart.language !== undefined && (typeof input.multipart.language !== "string" || !/^[a-z]{2,3}$/.test(input.multipart.language)))) fail("whisper_invalid_request");
    return input as RequestInput;
  }
  if (!only(input, ["url", "method", "headers", "query", "json", "form"])
      || typeof input.url !== "string" || typeof input.method !== "string"
      || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(input.method)
      || (Object.hasOwn(input, "json") && Object.hasOwn(input, "form"))) fail("invalid_request");
  let url: URL;
  try { url = new URL(input.url); } catch { fail("invalid_request"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[{}]/.test(input.url)) fail("invalid_request");
  for (const key of ["headers", "query", "form"]) {
    if (input[key] !== undefined && (!record(input[key]) || Object.values(input[key]).some(value => typeof value !== "string"))) fail("invalid_request");
  }
  return input as RequestInput;
}

function aliasesInRequest(input: RequestInput): string[] {
  const aliases = new Set<string>();
  const walk = (value: unknown, depth = 0) => {
    if (depth > 12) fail("invalid_request");
    if (typeof value === "string") {
      const pattern = /\{\{([a-z][a-z0-9_]{0,63})\}\}/g;
      for (const match of value.matchAll(pattern)) aliases.add(match[1]);
      if (/\{\{|\}\}/.test(value.replace(pattern, ""))) fail("invalid_placeholder");
    } else if (Array.isArray(value)) value.forEach(item => walk(item, depth + 1));
    else if (record(value)) for (const [key, item] of Object.entries(value)) {
      if (/[{}]/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail("invalid_request");
      walk(item, depth + 1);
    }
  };
  for (const key of ["headers", "query", "json", "form"] as const) walk(input[key]);
  return [...aliases];
}

async function readJson(response: Response, maxBytes = 1048576, streamError = "invalid_response"): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) fail("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch { fail(streamError); }
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); fail("invalid_response"); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (reason) { if (reason instanceof ConsoleError) throw reason; fail("invalid_response"); } finally { reader.releaseLock(); }
}

async function api(path: string, signal: AbortSignal, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, csrf?: string, read = true): Promise<unknown> {
  const response = await fetch(path, {
    method, signal, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(csrf ? { "x-csrf-token": csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.redirected) fail("redirect_denied");
  if (!response.ok) {
    if (response.status === 401) fail("unauthorized");
    const error = await readJson(response);
    fail(only(error, ["error"]) && typeof error.error === "string" ? error.error : "unavailable");
  }
  // Never parse successful write responses, even if an integration returns a body.
  if (!read) { await response.body?.cancel(); return undefined; }
  return readJson(response);
}
async function loadSettings(signal: AbortSignal): Promise<Settings> { return validateSettings(await api("/api/proxy/variables", signal)); }

async function whisperApi(path: "/api/whisper/variable" | "/api/whisper/transcribe", signal: AbortSignal, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown, csrf?: string, read = true): Promise<unknown> {
  const multipart = body instanceof FormData;
  // A body-stream failure after dispatch cannot establish the transcription outcome.
  const streamError = path === "/api/whisper/transcribe" ? "whisper_outcome_unknown" : "invalid_response";
  const response = await fetch(path, {
    method, signal, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { accept: "application/json", ...(body === undefined || multipart ? {} : { "content-type": "application/json" }), ...(csrf ? { "x-csrf-token": csrf } : {}) },
    ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
  });
  if (response.redirected) fail("redirect_denied");
  if (!response.ok) {
    if (response.status === 401) fail("unauthorized");
    const error = await readJson(response, 262144, streamError);
    if (!only(error, ["error", "outcome"]) || typeof error.error !== "string" || (error.outcome !== undefined && error.outcome !== "unknown")) fail("whisper_invalid_response");
    if (error.outcome === "unknown" || error.error === "timeout") fail("whisper_outcome_unknown");
    const codes: Record<string, string> = {
      disabled: "whisper_disabled", not_found: "whisper_disabled", invalid_request: "whisper_invalid_request", too_large: "whisper_too_large",
      consent_required: "whisper_consent_required", invalid_value: "whisper_invalid_value", secret_unavailable: "whisper_secret_unavailable",
      not_configured: "whisper_secret_unavailable", upstream_error: "whisper_upstream_error", invalid_response: "whisper_invalid_response",
      rate_limited: "whisper_rate_limited", unavailable: "whisper_unavailable", alias_conflict: "alias_conflict",
      forbidden: "forbidden", invalid_csrf: "invalid_csrf", csrf: "csrf", unauthorized: "unauthorized", redirect_denied: "redirect_denied",
    };
    fail(Object.hasOwn(codes, error.error) ? codes[error.error] : "whisper_unavailable");
  }
  if (!read) { await response.body?.cancel(); return undefined; }
  return readJson(response, 262144, streamError);
}
async function loadWhisperSettings(signal: AbortSignal): Promise<WhisperSettings> { return validateWhisperSettings(await whisperApi("/api/whisper/variable", signal)); }

function whisperExample(): string {
  return JSON.stringify({ url: WHISPER_URL, method: "POST", multipart: { file: { attachment: "audio" }, model: "whisper-1", language: "zh" } }, null, 2);
}

function legacyPriceRequest(value: unknown, settings: Settings): RequestInput {
  if (!only(value, ["stock_id", "start_date", "end_date"]) || typeof value.stock_id !== "string"
      || !/^[0-9]{4,6}[A-Z]?$/.test(value.stock_id) || typeof value.start_date !== "string"
      || typeof value.end_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.start_date)
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.end_date)) fail("invalid_request");
  const active = settings.variables.filter(row => row.configured && row.active);
  if (active.length !== 1) fail("secret_unavailable");
  return { url: PRICE_URL, method: "GET", headers: { Authorization: `Bearer {{${active[0].alias}}}` },
    query: { dataset: "TaiwanStockPrice", data_id: value.stock_id, start_date: value.start_date, end_date: value.end_date } };
}

function example(kind: "anonymous" | "prices" | "usage", alias = DEFAULT_ALIAS): string {
  const end = new Date(); end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 13);
  const input: RequestInput = {
    url: kind === "usage" ? USAGE_URL : PRICE_URL, method: "GET",
    headers: kind === "anonymous" ? {} : { Authorization: `Bearer {{${alias}}}` },
    query: kind === "usage" ? {} : { dataset: "TaiwanStockPrice", data_id: "2330", start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) },
  };
  return JSON.stringify(input, null, 2);
}

export default function ProxyConsole() {
  const keyInput = useRef<HTMLInputElement>(null);
  const whisperKeyInput = useRef<HTMLInputElement>(null), audioInput = useRef<HTMLInputElement>(null);
  const requestActionRef = useRef<RequestAction | null>(null);
  const mounted = useRef(false), locked = useRef(true), task = useRef<AbortController | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(true);
  const [alias, setAlias] = useState(DEFAULT_ALIAS), [consent, setConsent] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [requestText, setRequestText] = useState(() => example("anonymous"));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState("");
  const [whisperVariable, setWhisperVariable] = useState<Variable | null>(null), [whisperLoaded, setWhisperLoaded] = useState(false);
  const [whisperConsent, setWhisperConsent] = useState(false), [confirmWhisperDisable, setConfirmWhisperDisable] = useState(false);
  const variable = variables[0];
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ""; };
  const clearWhisperKey = () => { if (whisperKeyInput.current) whisperKeyInput.current.value = ""; };
  const clearAudio = () => { if (audioInput.current) audioInput.current.value = ""; };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); task.current = controller;
    const field = keyInput.current, whisperField = whisperKeyInput.current, audioField = audioInput.current;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const clearAndAbort = () => { if (field) field.value = ""; if (whisperField) whisperField.value = ""; if (audioField) audioField.value = ""; task.current?.abort(); };
    window.addEventListener("pagehide", clearAndAbort);
    const reportLoadError = (reason: unknown) => {
      if (mounted.current && task.current === controller) setError(reason instanceof ConsoleError ? reason.code : "unavailable");
    };
    void Promise.allSettled([
      loadSettings(controller.signal).then(settings => {
        if (!controller.signal.aborted && mounted.current) {
          setVariables(settings.variables); setAlias(settings.variables[0]?.alias ?? DEFAULT_ALIAS); setLoaded(true);
        }
      }).catch(reportLoadError),
      loadWhisperSettings(controller.signal).then(settings => {
        if (!controller.signal.aborted && mounted.current) { setWhisperVariable(settings.variable); setWhisperLoaded(true); }
      }).catch(reportLoadError),
    ]).finally(() => {
      clearTimeout(timeout);
      if (mounted.current && task.current === controller) { locked.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; clearTimeout(timeout); clearAndAbort(); window.removeEventListener("pagehide", clearAndAbort); };
  }, []);

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null); setNotice("");
    const controller = new AbortController(); task.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try { await operation(controller.signal); }
    catch (reason) { if (mounted.current) setError(reason instanceof ConsoleError ? reason.code : "unavailable"); }
    finally {
      clearTimeout(timeout); clearKey(); clearWhisperKey();
      if (mounted.current) { locked.current = false; setBusy(false); }
    }
  }

  async function reload() {
    clearKey(); clearWhisperKey();
    await run(async signal => {
      const [finmind, whisper] = await Promise.allSettled([loadSettings(signal), loadWhisperSettings(signal)]);
      if (!mounted.current || signal.aborted) return;
      if (finmind.status === "fulfilled") { setVariables(finmind.value.variables); setAlias(finmind.value.variables[0]?.alias ?? DEFAULT_ALIAS); setLoaded(true); }
      if (whisper.status === "fulfilled") { setWhisperVariable(whisper.value.variable); setWhisperLoaded(true); }
      if (finmind.status === "rejected") throw finmind.reason;
      if (whisper.status === "rejected") throw whisper.reason;
      setNotice("兩項服務的設定狀態已更新。");
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let value = keyInput.current?.value ?? "";
    clearKey(); // Before validation, CSRF refresh, or any asynchronous operation.
    const requestedAlias = alias.trim(), accepted = consent;
    setConsent(false); setConfirmDisable(false);
    try {
      await run(async signal => {
        if (!validAlias(requestedAlias)) fail("invalid_alias");
        if (requestedAlias === WHISPER_ALIAS) fail("alias_conflict");
        if (!accepted) fail("consent_required");
        if (new TextEncoder().encode(value).length > 8192 || value.includes("\0")) fail("invalid_value");
        const fresh = await loadSettings(signal); // Refresh the HttpOnly CSRF cookie and paired token.
        if (mounted.current && !signal.aborted) setVariables(fresh.variables);
        const hadValue = value.trim().length > 0;
        await api("/api/proxy/variables", signal, "POST", { alias: requestedAlias, ...(hadValue ? { value } : {}), consent: true }, fresh.csrf, false);
        value = "";
        const updated = await loadSettings(signal);
        if (mounted.current && !signal.aborted) {
          setVariables(updated.variables); setAlias(updated.variables[0]?.alias ?? requestedAlias); setLoaded(true);
          setNotice(hadValue ? "設定已保存，金鑰輸入欄已清空。尚未向 FinMind 驗證金鑰。" : "變數名稱已保存；未提交新的金鑰。");
        }
      });
    } finally { value = ""; clearKey(); }
  }

  async function disable() {
    clearKey(); setConsent(false); setConfirmDisable(false);
    const targetAlias = variable?.alias;
    await run(async signal => {
      if (!targetAlias) fail("unknown_alias");
      const fresh = await loadSettings(signal);
      if (!fresh.variables.some(row => row.alias === targetAlias && row.configured)) fail("unknown_alias");
      await api(`/api/proxy/variables/${encodeURIComponent(targetAlias)}`, signal, "DELETE", {}, fresh.csrf, false);
      const updated = await loadSettings(signal);
      if (mounted.current && !signal.aborted) { setVariables(updated.variables); setAlias(updated.variables[0]?.alias ?? targetAlias); setLoaded(true); setNotice("已停用並移除目前保存的金鑰。變數狀態已更新。"); }
    });
  }

  async function saveWhisper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let value = whisperKeyInput.current?.value ?? "";
    clearWhisperKey(); // Clear before validation, CSRF refresh, or any await.
    const accepted = whisperConsent;
    setWhisperConsent(false); setConfirmWhisperDisable(false);
    try {
      await run(async signal => {
        if (!accepted) fail("whisper_consent_required");
        if (!/^[a-f0-9]{32}$/.test(value)) fail("whisper_invalid_value");
        const fresh = await loadWhisperSettings(signal);
        if (mounted.current && !signal.aborted) setWhisperVariable(fresh.variable);
        await whisperApi("/api/whisper/variable", signal, "POST", { value, consent: true }, fresh.csrf, false);
        value = "";
        const updated = await loadWhisperSettings(signal);
        if (mounted.current && !signal.aborted) { setWhisperVariable(updated.variable); setWhisperLoaded(true); setNotice("Whisper 設定已保存，輸入欄已清空。尚未向上游驗證金鑰。"); }
      });
    } finally { value = ""; clearWhisperKey(); }
  }

  async function disableWhisper() {
    clearWhisperKey(); clearAudio(); setWhisperConsent(false); setConfirmWhisperDisable(false);
    await run(async signal => {
      const fresh = await loadWhisperSettings(signal);
      if (!fresh.variable.configured) fail("whisper_secret_unavailable");
      await whisperApi("/api/whisper/variable", signal, "DELETE", {}, fresh.csrf, false);
      const updated = await loadWhisperSettings(signal);
      if (mounted.current && !signal.aborted) { setWhisperVariable(updated.variable); setWhisperLoaded(true); setNotice("Whisper 已停用並移除保存的金鑰。音檔選擇已清除。"); }
    });
  }

  async function transcribeWhisper(input: RequestInput, signal: AbortSignal): Promise<Result> {
    let audio: File | null = audioInput.current?.files?.[0] ?? null;
    clearAudio();
    let envelope: FormData | null = null, dispatched = false;
    try {
      if (!audio) fail("whisper_audio_required");
      if (audio.size === 0 || audio.size > AUDIO_BYTES) fail("whisper_too_large");
      if (!AUDIO_TYPES.includes(audio.type)) fail("whisper_audio_type");
      const fresh = await loadWhisperSettings(signal);
      if (!mounted.current || signal.aborted) fail("whisper_unavailable");
      setWhisperVariable(fresh.variable); setWhisperLoaded(true);
      if (!fresh.variable.configured || !fresh.variable.active) fail("whisper_secret_unavailable");
      envelope = new FormData();
      envelope.set("request", JSON.stringify(input));
      envelope.set("audio", audio, "audio");
      dispatched = true;
      const output = await whisperApi("/api/whisper/transcribe", signal, "POST", envelope, fresh.csrf);
      if (!mounted.current || signal.aborted) fail("whisper_outcome_unknown");
      if (!only(output, ["text"]) || typeof output.text !== "string") fail("whisper_invalid_response");
      return { status: 200, anonymous: false, data: { text: output.text } };
    } catch (reason) {
      if (dispatched && signal.aborted) return fail("whisper_outcome_unknown");
      if (reason instanceof ConsoleError) throw reason;
      return fail(dispatched ? "whisper_outcome_unknown" : "whisper_unavailable");
    } finally { envelope?.delete("audio"); envelope = null; audio = null; clearAudio(); }
  }

  async function requestAction(raw: unknown, kind: RequestKind = "generic"): Promise<ToolResult> {
    if (!mounted.current) return { ok: false, error: "unavailable" };
    if (locked.current) return { ok: false, error: "busy" };
    locked.current = true;
    const controller = new AbortController(); task.current = controller;
    const signal = controller.signal;
    let timeout = setTimeout(() => controller.abort(), 30000);
    flushSync(() => { setBusy(true); setError(null); setNotice(""); setResult(null); });
    try {
      // Tool calls do not read, clear, save, or disable the credential input.
      let input: RequestInput | null = null;
      if (kind !== "legacy") {
        const text = kind === "ui" ? raw : JSON.stringify(raw);
        if (typeof text !== "string") fail("invalid_request");
        input = parseRequest(text, kind === "ui");
      }
      if (kind === "ui" && input?.multipart) {
        clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), 75000);
        flushSync(() => setRequestText(JSON.stringify(input, null, 2)));
        const output = await transcribeWhisper(input, signal);
        flushSync(() => { setResult(output); setNotice("Whisper 轉錄完成，只顯示 text。音檔選擇已清除；如要再次送出，請重新選檔。"); });
        return { ok: true, ...output };
      }
      const fresh = await loadSettings(signal);
      if (!mounted.current || signal.aborted) fail("unavailable");
      if (kind === "legacy") input = legacyPriceRequest(raw, fresh);
      if (!input) fail("invalid_request");
      const references = aliasesInRequest(input);
      flushSync(() => { setVariables(fresh.variables); setRequestText(JSON.stringify(input, null, 2)); setLoaded(true); });
      if (references.some(name => !fresh.variables.some(row => row.alias === name && row.configured && row.active))) fail("unknown_alias");
      // Preserve the template. Only the server may resolve aliases and enforce scope.
      const output = validateResult(await api("/api/proxy/execute", signal, "POST", input, fresh.csrf));
      if (!mounted.current || signal.aborted) fail("unavailable");
      // Commit the visible result before resolving either browser tool.
      flushSync(() => { setResult(output); setNotice("請求完成。下方只顯示清理後的回應。"); });
      return { ok: true, ...output, ...(kind === "legacy" ? { rows: output.data } : {}) };
    } catch (reason) {
      const code = reason instanceof ConsoleError && Object.hasOwn(MESSAGES, reason.code) ? reason.code : "unavailable";
      if (mounted.current) flushSync(() => setError(code));
      return { ok: false, error: code };
    } finally {
      clearTimeout(timeout); locked.current = false;
      if (mounted.current) flushSync(() => setBusy(false));
    }
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); clearKey(); clearWhisperKey();
    try { await requestAction(requestText, "ui"); } finally { clearAudio(); }
  }

  // Refresh the action ref after every commit; registrations remain stable.
  useEffect(() => { requestActionRef.current = requestAction; });
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const life = new AbortController();
    const invoke = (input: unknown, kind: RequestKind): Promise<ToolResult> => {
      if (life.signal.aborted || !requestActionRef.current) return Promise.resolve({ ok: false, error: "unavailable" });
      return requestActionRef.current(input, kind);
    };
    const register = async () => {
      try {
        await context.registerTool({ name: "read_finmind_prices", description: "Read up to 31 calendar days of one stock's TaiwanStockPrice using the currently active saved FinMind alias. Show the same sanitized result in the page. Never accepts or returns a key.", inputSchema: PRICE_SCHEMA, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => invoke(input, "legacy") }, { signal: life.signal });
        if (life.signal.aborted) return;
        await context.registerTool({ name: "veilsplice_request", description: "Run an approved read-only FinMind request template and show its sanitized result in this page. Use {{alias}} only in Bearer Authorization; omit placeholders for anonymous requests. Current scope: GET TaiwanStockPrice for one stock up to 31 days, or API usage. No credential setting, new scope, or raw secrets.", inputSchema: PROXY_REQUEST_SCHEMA, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: input => invoke(input, "generic") }, { signal: life.signal });
      } catch {
        if (!life.signal.aborted && mounted.current) setError("tool_unavailable");
        life.abort();
      }
    };
    void register();
    return () => { life.abort(); requestActionRef.current = null; };
  }, []);

  const status = !loaded ? busy ? "載入中" : "狀態未確認" : !variable?.configured ? "未設定" : variable.active ? "已設定" : "已停用";
  const whisperStatus = !whisperLoaded ? busy ? "載入中" : "狀態未確認" : !whisperVariable?.configured ? "未設定" : whisperVariable.active ? "已設定" : "已停用";
  const requestNeedsWhisper = (() => { try { return Object.hasOwn(JSON.parse(requestText), "multipart"); } catch { return false; } })();
  return <main className="proxy-console">
    <header className="proxy-console-header"><div><h1>VeilSplice 私人 API 工作台</h1><p>以變數引用金鑰，組合並檢查你的 API 請求。</p></div><span className="proxy-private">僅擁有者</span></header>
    <section className="proxy-settings" aria-labelledby="proxy-variables-title">
      <div className="proxy-section-heading"><div><h2 id="proxy-variables-title">變數設定</h2><p>FinMind 與 Whisper 各自保存一筆。保存後只顯示名稱與狀態，不提供金鑰讀回。</p></div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>重新載入</Button></div>
      <form onSubmit={save} noValidate autoComplete="off">
        <Table className="proxy-variable-table"><TableHeader><TableRow><TableHead>服務</TableHead><TableHead>變數名稱</TableHead><TableHead>新的金鑰值</TableHead><TableHead>狀態</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell><strong>FinMind</strong></TableCell><TableCell><label className="proxy-sr-only" htmlFor="proxy-alias">FinMind 變數名稱</label><Input id="proxy-alias" value={alias} onChange={event => setAlias(event.target.value)} disabled={busy || !loaded} maxLength={64} spellCheck={false} autoCapitalize="none" aria-describedby="proxy-alias-help" /></TableCell>
            <TableCell><label className="proxy-sr-only" htmlFor="proxy-key">本人輸入的新 FinMind key</label><Input id="proxy-key" ref={keyInput} type="password" disabled={busy || !loaded} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={8192} placeholder="留空只修改名稱" aria-describedby="proxy-key-help proxy-storage-disclosure" /></TableCell>
            <TableCell><span className={`proxy-variable-status${variable?.configured && variable.active ? " is-active" : ""}`}>{status}</span></TableCell></TableRow></TableBody>
        </Table>
        <div className="proxy-field-help"><span id="proxy-alias-help">小寫字母開頭，可加數字與底線；whisper_token 留給 Whisper。</span><span id="proxy-key-help">提交時立即清空金鑰欄；留空不會更換金鑰。</span></div>
        <p id="proxy-storage-disclosure" className="proxy-storage-disclosure">金鑰由你本人輸入並保存於此私人網站既有後端；伺服器及資料庫管理者仍可讀取原值。用途限下列 FinMind 範圍，直到你停用。此頁不把金鑰寫入瀏覽器儲存。</p>
        <label className="proxy-consent"><input type="checkbox" checked={consent} disabled={busy || !loaded} onChange={event => setConsent(event.target.checked)} /><span>我同意保存這項設定，並依目前核准範圍使用 FinMind 金鑰。</span></label>
        <div className="proxy-setting-actions"><Button type="submit" disabled={busy || !loaded || !consent}>保存設定</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { clearKey(); setConsent(false); }}>清空輸入</Button>
          {variable?.configured && !confirmDisable && <Button type="button" variant="ghost" disabled={busy} onClick={() => { clearKey(); setConfirmDisable(true); }}>停用並移除金鑰</Button>}
          {confirmDisable && <><Button type="button" variant="destructive" disabled={busy} onClick={() => void disable()}>確認停用並移除</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDisable(false)}>取消</Button></>}
        </div>
        {confirmDisable && <p className="proxy-field-help">停止後續查詢；備份及已開始的請求不一定立即清除。若要撤銷 key 本身，請到 FinMind 操作。</p>}
      </form>
      <form className="proxy-whisper-settings" onSubmit={saveWhisper} noValidate autoComplete="off" aria-labelledby="proxy-whisper-title">
        <div className="proxy-section-heading"><div><h3 id="proxy-whisper-title">Whisper 音訊轉錄</h3><p>獨立服務 whisper；固定變數 whisper_token，只供下方本人選檔後提交。</p></div></div>
        <Table className="proxy-variable-table"><TableHeader><TableRow><TableHead>服務</TableHead><TableHead>固定變數名稱</TableHead><TableHead>新的金鑰值</TableHead><TableHead>狀態</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell><strong>Whisper</strong></TableCell><TableCell><code className="proxy-fixed-alias">whisper_token</code></TableCell>
            <TableCell><label className="proxy-sr-only" htmlFor="proxy-whisper-key">本人輸入的新 Whisper key</label><Input id="proxy-whisper-key" ref={whisperKeyInput} type="password" disabled={busy || !whisperLoaded} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={32} placeholder="輸入新金鑰以保存或更新" aria-describedby="proxy-whisper-key-help proxy-whisper-disclosure" /></TableCell>
            <TableCell><span className={`proxy-variable-status${whisperVariable?.configured && whisperVariable.active ? " is-active" : ""}`}>{whisperStatus}</span></TableCell></TableRow></TableBody>
        </Table>
        <p id="proxy-whisper-key-help" className="proxy-field-help">提交前立即清空金鑰欄；更新須重新輸入，不可修改變數名稱。</p>
        <p id="proxy-whisper-disclosure" className="proxy-storage-disclosure">Whisper 金鑰由你本人輸入並保存於此私人網站既有後端；伺服器及資料庫管理者仍可讀取原值。限下方揭示的 Whisper 轉錄範圍使用，直到你停用。上游 infra.hazelnut-paradise.com 會收到音檔及 URL 路徑中的金鑰；此頁不保存金鑰於瀏覽器儲存。</p>
        <label className="proxy-consent"><input type="checkbox" checked={whisperConsent} disabled={busy || !whisperLoaded} onChange={event => setWhisperConsent(event.target.checked)} /><span>我同意保存 Whisper 設定，並依上述目的地與轉錄範圍使用金鑰。</span></label>
        <div className="proxy-setting-actions"><Button type="submit" disabled={busy || !whisperLoaded || !whisperConsent}>保存 Whisper 設定</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { clearWhisperKey(); setWhisperConsent(false); }}>清空 Whisper 輸入</Button>
          {whisperVariable?.configured && !confirmWhisperDisable && <Button type="button" variant="ghost" disabled={busy} onClick={() => { clearWhisperKey(); setConfirmWhisperDisable(true); }}>停用 Whisper 並移除金鑰</Button>}
          {confirmWhisperDisable && <><Button type="button" variant="destructive" disabled={busy} onClick={() => void disableWhisper()}>確認停用 Whisper</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmWhisperDisable(false)}>取消</Button></>}
        </div>
        {confirmWhisperDisable && <p className="proxy-field-help">停止後續轉錄；備份與已開始的請求不一定立即清除。撤銷原金鑰須由本人至上游服務操作。</p>}
      </form>
    </section>

    <section className="proxy-scope" aria-labelledby="proxy-scope-title"><h2 id="proxy-scope-title">目前核准範圍</h2><p>FinMind TaiwanStockPrice：一次一檔股票、最多 31 天；以及 API 用量查詢。僅允許 GET，變數只能放在 Authorization: Bearer {`{{${variable?.alias ?? DEFAULT_ALIAS}}}`}。</p><p>行情：{PRICE_URL}<br />用量：{USAGE_URL}</p><p>FinMind 可填寫 headers、query、json 或 form；未核准的目的地、方法、本文與金鑰位置會由伺服器拒絕。更改變數名不會擴大授權。</p><p className="proxy-whisper-scope">Whisper 僅允許 POST 至 {WHISPER_URL}。model 可選 whisper-1 或 turbo，省略時使用 whisper-1；language 可省略，或填 2 至 3 個小寫英文字母，例如 zh、en。只回傳轉錄文字 text；不提供音訊播放、字幕時間軸或其他欄位。瀏覽器工具仍僅提供 FinMind 唯讀查詢，不能讀取或送出音檔。</p></section>

    <section className="proxy-request-section" aria-labelledby="proxy-request-title"><div className="proxy-section-heading"><div><h2 id="proxy-request-title">請求工作區</h2><p>真實 Key 只填上方遮罩欄；請求框使用 {"{{變數名稱}}"}。沒有變數引用時，不會自動附加已保存金鑰。</p></div></div>
      <div className="proxy-request-layout"><form className="proxy-request-pane" onSubmit={execute}><div className="proxy-pane-toolbar"><label htmlFor="proxy-request">請求 JSON</label><div className="proxy-examples"><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setRequestText(example("anonymous"))}>匿名行情</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setRequestText(example("prices", variable?.alias ?? DEFAULT_ALIAS))}>帶變數行情</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setRequestText(example("usage", variable?.alias ?? DEFAULT_ALIAS))}>API 用量</Button><Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setRequestText(whisperExample())}>Whisper 轉錄</Button></div></div>
        <Textarea id="proxy-request" className="proxy-request-editor" value={requestText} onChange={event => setRequestText(event.target.value)} readOnly={busy} maxLength={65536} spellCheck={false} autoCapitalize="none" autoComplete="off" aria-describedby="proxy-request-help" />
        <div className="proxy-audio-picker"><label htmlFor="proxy-audio">Whisper 音訊附件</label><Input id="proxy-audio" ref={audioInput} type="file" accept={AUDIO_TYPES.join(",")} disabled={busy} aria-describedby="proxy-audio-help" /><p id="proxy-audio-help">限 8 MiB 以內的 WAV、MP3、M4A／MP4、WebM、Ogg、FLAC 音訊。選檔後按「送出請求」才會上傳；僅 Whisper multipart 範例使用附件。伺服器期限 60 秒，頁面最長等待 75 秒。逾時結果未知，請勿自動重送；每次結束皆清除選檔。</p></div>
        <div className="proxy-editor-footer"><span id="proxy-request-help">FinMind 網址參數填入 query，本文使用 json 或 form；Whisper 使用固定 multipart 範例與音訊附件。</span><Button type="submit" disabled={busy || !(requestNeedsWhisper ? whisperLoaded : loaded)}>{busy ? "處理中…" : "送出請求"}</Button></div></form>
        <div className="proxy-response-pane" aria-labelledby="proxy-response-title"><div className="proxy-pane-toolbar"><h3 id="proxy-response-title">回應</h3><span>{result ? `${result.status} · ${result.anonymous ? "匿名" : "使用變數"}` : "尚無回應"}</span></div>
          {result ? <pre className="proxy-response-json" tabIndex={0} aria-label="清理後的回應 JSON">{JSON.stringify(result.data, null, 2)}</pre> : <div className="proxy-empty-response"><h3>回應會顯示在這裡</h3><p>送出請求後，僅顯示清理後的資料與固定錯誤訊息。</p></div>}
          <p className="proxy-response-note">變數由伺服器代入；不顯示原始上游錯誤。</p></div>
      </div>
    </section>
    <p className={`proxy-feedback${error ? " is-error" : ""}`} role="status" aria-live="polite" aria-atomic="true">{busy ? "處理中…" : error ? MESSAGES[error] ?? MESSAGES.unavailable : notice}</p>
    <footer className="proxy-console-footer"><span>FinMind 僅開放兩項唯讀查詢；Whisper 僅提供本人選檔轉錄。</span><span>回應可能有誤，請自行核對。</span></footer>
  </main>;
}
