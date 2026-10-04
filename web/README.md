# VeilSplice web workbench

This `web/` package maintains the v7 website source alongside the existing Go CLI.
It is a separate TypeScript/React, Vinext and Cloudflare Workers-compatible Sites
adapter, not a wrapper around the Go executable. Publishing this source does not
make the owner-private hosted service public or provision a deployment.

See [MAINTENANCE.md](MAINTENANCE.md) for Node.js 24 setup, reproducible offline
checks, public-export differences and release steps; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing.
No live owner hash, credentials, platform IDs, private runtime configuration,
database contents or generated bundles are included.

**Platform dependency:** Sites dispatch must authenticate and set trusted identity
headers before requests reach this Worker. D1 and private owner configuration are
also required. These headers are not trustworthy on an arbitrary public origin.
The checkout can run tests and compile without a key; it is not a standalone
authentication solution. Do not deploy it directly with caller-supplied headers.

## Access and credential handling

Keep the Site owner-private, without editors or external visitors. Sites dispatch authenticates requests and sets trusted identity headers. Every data-bearing MCP and API request additionally requires both identity headers and a SHA-256 match against the verified owner email configured in OWNER_EMAIL_SHA256. A platform service bypass token alone is insufficient. Do not expose the Worker through another public origin or an untrusted proxy. Platform administrators retain administration privileges.

The owner personally enters and submits each service key in its password field on this private Site. Keys are persisted as separate owner/service rows in the existing D1 database. FinMind is reused by browser queries and MCP; Whisper is used only by the browser attachment request route. The Site does not require an additional encryption master key, new account, or paid model API.

D1 provides platform-managed encryption at rest and TLS in transit. The application-visible token column is not application-layer ciphertext. Site code and parties with database administration/read privileges can read the original token. Do not inspect or export the credential table through administrative tools. Never copy a real token into chat, source, logs, query strings, tool arguments, test fixtures, or browser storage. API and MCP responses expose only status/results, never a credential or its suffix/fingerprint. The owner submission goes directly from the same-origin browser to the Site backend; no MCP or WebMCP credential-setting tool exists.

The settings route requires the existing owner identity, exact same-origin Origin on writes, JSON content type, and matching short-lived CSRF cookie/header. The CSRF cookie is host-only, Secure, HttpOnly, SameSite=Strict and expires in ten minutes. No persistent signing/master key is generated. All settings responses are no-store. Inputs are bounded, route names fixed, and request/error bodies are never logged.

`POST /api/finmind/credential` accepts exactly `token` and explicit `consent:true`. It saves without contacting FinMind; saved does not mean upstream validated. `GET` exposes only configured status and an ephemeral CSRF token. `DELETE` clears the active token and writes a disabled marker. Subsequent browser/MCP calls then fail closed. The resolver does not fall back to FINMIND_TOKEN environment variables. Already-started requests and platform backups may outlive disabling; revoking the original FinMind token itself is a separate owner action at FinMind. Re-entering a key requires a new explicit submission.

## Fixed network contract

FinMind permits only GET https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice with stock_id and start/end dates, or GET https://api.web.finmindtrade.com/v2/user_info. The generic request editor and veilsplice_request tool accept these exact URL templates and approved fields. Bearer is constructed server-side only when an allowed alias is referenced; anonymous generic requests perform no credential lookup. Legacy fixed tools use the saved FinMind credential. Redirects/retries are disabled; legacy requests have an 8 second deadline and generic requests a 10 second deadline, with a 128 KiB response limit. Only allowlisted output is projected. Errors never echo upstream content. No query results or account payloads are stored.

Price ranges are inclusive, at most 31 days, with no future dates. Global atomic D1 quota is 12 calls per calendar minute and 120 per calendar hour, including failed upstream calls, shared by browser and MCP. Fixed-window limits can permit boundary bursts. Missing storage/limiter fails closed. Sites and FinMind plan quotas still apply.

## MCP and service entry

Stateless JSON POST /mcp: initialize, tools/list, tools/call, ping. Tools are finmind_status, finmind_prices, finmind_usage and veilsplice_request. Discovery has no private data; tool calls require owner identity. Platform OAuth/Connect is user-managed. No custom OAuth server. Existing read-only tools do not accept Whisper requests, file paths, file URLs or encoded audio.

`lib/service-registry.ts` is the code-owned FinMind read-tool registry. Whisper uses a separate scoped route described below. Adding further providers requires explicit authorization of destinations, data scope and access. `GET /api/services` returns only registered FinMind tool IDs/configured booleans and requires owner identity. All routes match exact paths. The credential table is scoped by verified owner hash and service; status queries never return the token field.

## Whisper attachments

The workbench supports a single owner-selected audio file and this exact request template:

```json
{"url":"https://infra.hazelnut-paradise.com/use/whisper/{{whisper_token}}/v1/audio/transcriptions","method":"POST","multipart":{"file":{"attachment":"audio"},"model":"whisper-1","language":"zh"}}
```

`language` is optional (two or three lowercase letters); model may be `whisper-1` or `turbo`. The adapter sends multipart fields `file`, `model`, `advanced=false`, and optional `language`. It returns only `{ "text": "..." }`. Advanced diarization and arbitrary multipart fields are not enabled. The actual live proxy-to-transcription-service binding remains an end-to-end acceptance check; source compatibility alone does not prove deployment configuration.

`/api/whisper/variable` reuses the existing owner identity and host-only CSRF cookie. GET returns only variable metadata and CSRF; POST accepts exactly `{value, consent:true}`; DELETE accepts `{}`. The fixed alias is `whisper_token`, stored exclusively under service `whisper`. New FinMind settings cannot claim this name. A pre-existing FinMind alias with this name must be renamed by the owner before Whisper setup. No key copy, migration or backfill is performed, and the existing schema needs no migration.

`POST /api/whisper/transcribe` requires same-origin multipart input with exactly two parts: `request` (the JSON template) and `audio` (one File). The server verifies the owner and CSRF before parsing and resolving the key. The key is substituted only in the fixed token path segment on the approved HTTPS host. No arbitrary destinations, redirects, cookies, authorization headers, retries, attachment URLs or local paths are forwarded. The outgoing filename is normalized to `audio`.

The v7 adapter limits files to 8 MiB (MIME allowlist: WAV, MPEG, MP4, WebM, Ogg, FLAC), a 64 KiB multipart overhead, a 256 KiB response and a 60 second total server deadline. MIME checking does not decode or validate audio contents/duration. Whisper reserves its own atomic D1 budget of 2 calls per minute and 20 per hour, including failed upstream calls. FinMind limits are unchanged. These are application limits, not verified provider/hosting capacities. The UI waits up to 75 seconds, clears the selected file after submission, and does not retry automatically. A post-dispatch transport error/timeout has an unknown outcome: the upstream may already be processing, and aborting does not prove cancellation.

The provided service authenticates with a token in its URL path. This code does not log the expanded URL, request body or raw exceptions, and rejects direct/common encoded key echoes in returned text. The receiving proxy and its operators nevertheless receive the full path; the checked public infra-manager source records that path. No upstream logging changes are included. Platform/proxy logging and arbitrary deliberate upstream obfuscation are not solved by response filtering.

The included automated tests use only fake keys and fake audio. They do not establish a successful live transcription or offer a remote MCP attachment lifecycle. Owner entry/submission, approved deployment and one intentionally selected audio request are required for live acceptance; a known Cloudflare denial must not be bypassed.

## Verification

After `npm ci --ignore-scripts` under Node.js 24, run `npm run check` (tests, full TypeScript check, ESLint and a compile-only build). Tests use fake tokens/local SQLite only. Do not perform an authenticated live FinMind call until the owner has personally submitted the key and authorized the intended query. Do not read back a real key to verify setup; use owner-visible status and allowlisted results.

Migrations are schema-only and appended. The existing request_limits table is unchanged. The new service_credentials table stores the owner-submitted key under the disclosed platform encryption model.

## Sources

- https://developers.cloudflare.com/d1/reference/data-security/
- https://learn.chatgpt.com/docs/sites#configure-runtime-environment-values
- https://learn.chatgpt.com/docs/sites#collaborate-on-a-site
- https://finmind.github.io/api_usage_count/
- https://finmind.github.io/quickstart/

## Feature boundary

This snapshot preserves v7: FinMind returns its allowlisted JSON projection;
Whisper accepts the selected audio upload and returns transcription JSON. No
generic file-response/download endpoint or remote MCP attachment lifecycle is
enabled or included. The source import does not change a running Site.
