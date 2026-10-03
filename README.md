# VeilSplice

An experimental, dependency-free Go CLI that inserts secret aliases into requests
and sends them only to administrator-approved HTTPS endpoints. MIT licensed.

**This is a request-execution building block, not a vault, a secure input form,
a deployed service, or a production-ready credential boundary.** No real key,
private account setting, provider integration, listener, or hosted service is
included. The Go module is `github.com/TimLai666/veilsplice`. Publishing this
source does not establish deployment, secure credential storage or a live
authenticated integration.

**The CLI `-policy` flag is operator input, not a safe capability for an untrusted
agent.** A caller who can choose a new policy can point an environment-variable
binding at any value its process can read and authorize an attacker destination.
Do not expose arbitrary CLI arguments or shell execution to that caller. A future
service/wrapper must pin a read-only policy under a separate runtime identity and
accept only bounded request input. The optional [fixed-policy FinMind entry point](docs/finmind-wrapper.md)
now narrows that input surface, but deployment and OS isolation are not included.

## What works

- `${secret:alias}` anywhere inside a **header value, query value, JSON string
  value, or URL-encoded form value**, including prefixes, suffixes and repeated
  placeholders. Inserted secrets are not recursively expanded.
- JSON and form values are serialized structurally, rather than concatenated into
  raw JSON or query text. JSON numbers retain their original precision.
- A trusted policy defines each exact HTTPS URL, HTTP method, secret aliases,
  header names, query names and body format. Form field names are also allowlisted.
  Request templates cannot change the URL, path, port or method. Wildcard hosts,
  literal IP destinations, credentials in URLs, redirects and proxies are absent.
- All DNS answers must be public under the conservative address policy. Connections
  use checked literal IPs, while TLS still validates the original hostname. DNS
  is not re-resolved between validation and connection. Environment proxy settings
  are ignored. TLS certificate checks remain enabled, with TLS 1.2 minimum.
- Constant error codes, no request/secret logging, no upstream response headers,
  and **response-body discard by default**.
- Optional, administrator-owned JSON projection with strict scalar types, response
  byte/item limits, and rejection of direct/common-encoding secret echoes.
- Standard library only; no custom cryptography. No listening socket is opened by
  the CLI. Tests use fake secrets, fake DNS/transports and an in-memory TLS pipe.

## Quick start without a key or network request

Use a maintained official Go release. This snapshot was verified with Go 1.27.1.

```sh
go test -race ./...
go vet ./...
go build -buildvcs=false -trimpath -o bin/veilsplice ./cmd/veilsplice
./bin/veilsplice -check -policy examples/policy.json -request examples/request.json
```

Expected check output:

```json
{"syntax_valid":true}
```

`-check` validates JSON syntax, policy structure and the named target only. It does
**not** resolve DNS, load secrets, substitute placeholders, authorize every request
field, contact an endpoint or prove that an integration works. The example host is
an illustrative placeholder; no live example request should be expected to work.

To execute later, an operator must configure a provider's **specific approved
endpoint** in a trusted policy and provision its key outside the caller/agent's
access. Then omit `-check`. Request JSON defaults to standard input; `-request`
can also name a file. Policy JSON must be a file. Never put a real key directly in
request JSON, command-line arguments, chat, source control, examples or a report.

The example intentionally demonstrates the same fake alias in several positions;
real integrations should send it only where the provider requires it. Prefer
headers over query strings, which upstream servers and network tooling may log.

## Trusted policy versus caller template

The two files have very different trust levels:

- **Policy:** administrator-controlled. The caller must not be able to modify this
  file, the executable, the environment, TLS trust roots, or the secret backend.
  Each target fixes the URL/method and allowed aliases. Keep separate targets for
  separate providers, operations and permission scopes.
- **Template:** may be created by the caller. It names a target and supplies the
  allowed request values. It may use only that target's secret aliases.

`examples/policy.json` and `examples/request.json` show all supported surfaces;
`examples/form-request.json` shows a form body. JSON placeholders are allowed only
in string values, including nested objects/arrays. Header/query/form names and
JSON property names are not expanded. Neither is the destination or path.
Unknown top-level fields, duplicate JSON properties, malformed placeholders and
mixed body formats are rejected. Input is bounded to 64 KiB, policy to 256 KiB,
individual secrets to 16 KiB, aggregate expanded string values to 1 MiB and the
serialized body to 1 MiB. Request execution has a 30-second deadline after
template/target parsing; CLI file/stdin reads and stdout writes are not covered
by that deadline.

The `secrets` map is an explicit alias-to-environment-variable map; the template
cannot choose arbitrary environment variable names. The shipped `EnvBackend` is
for controlled demos only. The `SecretBackend` interface is the insertion point
for a vetted Vault/cloud secret manager/OS keyring SDK adapter. **None of those
adapters is implemented or claimed to be connected.**

## Returning useful data

Without `response` in policy, the result is only:

```json
{"status_code":200,"body_discarded":true}
```

An administrator can opt a target into a small projection, for example:

```json
"response": {
  "json_pointer": "/data",
  "fields": { "date": "date", "open": "number", "close": "number" },
  "max_bytes": 65536,
  "max_items": 100
}
```

The JSON Pointer selects an object or an array of objects. Every selected object
must contain all listed fields; only those scalar fields are returned. Supported
field types are `date` (valid `YYYY-MM-DD`), `number` (finite), `boolean`, and
`string` (at most 256 UTF-8 bytes). Prefer restrictive date/number/boolean fields
over unrestricted strings. Numbers retain their JSON representation. Nested
objects in projected fields, invalid dates, duplicate properties, oversize data,
non-JSON content types and compressed responses are rejected. `max_bytes` may not
exceed 1 MiB and `max_items` may not exceed 1,000. Non-2xx bodies are discarded.

For a fake quote response, output is:

```json
{"status_code":200,"body_discarded":false,"data":[{"close":101.5,"date":"2026-10-03","open":100.25}]}
```

The body flag means a projection was returned, never that the raw body was
forwarded. Status is the upstream numeric HTTP status. Upstream non-2xx statuses
are not transport failures: inspect `status_code`. Transport/policy/response
failures exit with status 1 and a constant JSON error code on stderr. URLs, parser
messages, backend errors, response headers and raw upstream messages are not
included in errors.

Projection is **not universal data-loss prevention**. The implementation rejects
an exact secret or common URL/base64/hex encoding in projected output, including
JSON-escaped strings. It cannot prove a value contains no transformed, split,
encrypted, truncated or indirectly encoded secret. Short or numeric secrets can
also cause false-positive rejection of benign data. A malicious allowed service
can communicate via response values, status or timing. Allowlisted providers must
be trusted; keep body discard enabled when that assumption is not acceptable.

## Threat model and limitations

See [SECURITY.md](SECURITY.md) before using credentials.

This prototype narrows accidental secret disclosure through templated requests;
it does not isolate an agent that can run arbitrary commands as the same OS user.
If that caller can inspect the environment, read process memory, change the policy
or call the backend itself, it can obtain the key without this program. Putting
this binary next to an unrestricted agent is not a security boundary.

Fixed endpoint/method/header/query rules reduce destination confusion, but do not
understand an API's business semantics. A trusted endpoint might support callback
URLs, webhooks, file exports, proxying, account changes, paid operations or prompt-
driven tool calls inside its JSON body. Such endpoints require a separate request
schema and operation policy; a host allowlist alone is insufficient. Generic JSON
body keys are not schema-validated in this prototype.

Public IP checks are defense in depth, not a substitute for network egress rules.
Private routes, transparent proxies, unusual NAT64 mappings, compromised DNS/TLS
roots, malicious public services, and newly introduced platform endpoints require
operator-level controls. The denylist is intentionally conservative and may deny
legitimate special-purpose destinations. No IP-policy maintenance service exists.

## Work still required before real deployment

1. Choose a secure user-input mechanism and audited secret backend, with explicit
   user authorization. **Secure input, encryption at rest, persistence, rotation,
   revocation, access grants and account linking remain unresolved here.**
2. The optional FinMind wrapper fixes endpoints, alias, dataset, input bounds and
   response schema. Run that executor and its backend under an identity the caller
   cannot inspect or modify, with tightly scoped backend access and OS/network egress controls.
3. Add authentication, caller/target authorization, request schemas, rate limits,
   audit events containing no secrets, and provider-specific response review.
4. Review API side effects, allowed response fields and data recipients. A safe
   storage backend cannot make an overprivileged API request safe.
5. Conduct an independent security review and verify the actual integration with
   explicitly authorized test credentials before production or publication claims.

No proprietary data or real credentials were used to build this snapshot. Tests
can run offline after Go is installed. The build commands neither publish a
repository nor perform deployment; local test results do not confirm publication.

## Provider example

The [FinMind read-only example](examples/finmind/README.md) includes two exact
documented endpoints, backend-referenced Bearer templates, anonymous/authenticated
request fixtures and offline projected-response tests. It does not establish a
live authenticated connection. The [secure-input gap assessment](docs/secure-input-gap.md)
identifies the minimum missing input, backend, isolation and verification work.
The separate [fixed-policy FinMind wrapper](docs/finmind-wrapper.md) rejects
caller-supplied policies, headers, destinations and aliases, and enforces bounded
stock/date input. It still requires isolated deployment and an approved backend.

## Development

```sh
make check
go test -run '^$' -fuzz FuzzTemplateParser -fuzztime 5s ./internal/proxy
go test -run '^$' -fuzz FuzzExpansion -fuzztime 5s ./internal/proxy
```

The supplied CI workflow runs vet, race-enabled tests and a build. It is only a
configuration until the code is published and the CI runner executes it. Test
coverage includes field substitution, escaping, malformed inputs, secret binding,
private/mixed DNS answers, IP pinning, redirects, certificate trust, response
projection, echo rejection, byte/item bounds and sanitized failures.

Reference documentation: [Go HTTP transport](https://pkg.go.dev/net/http#Transport),
[Go TLS configuration](https://pkg.go.dev/crypto/tls#Config),
[Go IP address classification](https://pkg.go.dev/net/netip#Addr.IsPrivate).
