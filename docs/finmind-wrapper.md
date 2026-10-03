# Fixed-policy FinMind wrapper

`veilsplice-finmind` is a separate, narrower Go entry point. It does not replace
the generic `veilsplice` CLI. It accepts JSON on standard input and only the
optional `-check` flag. There is no policy filename, request filename, destination,
header, token, secret alias, dataset or response-schema command-line option.

**This closes the caller-chosen-policy input path in this entry point. It is not
OS isolation or a secure vault.** The operator must still protect the executable,
runtime environment and backend from the caller, and use an independent identity
or equivalently enforced execution boundary. Giving a caller arbitrary shell
access, the generic CLI with credential access, or permission to change this
binary defeats the intended boundary. No deployment or system permission change
is supplied.

## Input schema

Exactly three operations are supported:

- `prices_anonymous`: one stock, no secret lookup, no authentication header.
- `prices_authenticated`: one stock; the wrapper always supplies the fixed
  `finmind_token` alias as a Bearer header. A missing, empty or failed backend value
  aborts execution; it never falls back to anonymous access.
- `usage_authenticated`: only the operation field is accepted; it always supplies
  the same fixed Bearer alias. No stock, date or other field may be present.

Both price operations require `stock_id`, `start_date` and `end_date`. Stock IDs
must be strings of 4 to 6 ASCII digits. One request names exactly one stock; lists,
comma-separated IDs, prefixes and request batching are not supported. This is a
narrow symbol format, not a claim that every matching code exists. Symbols with
letters or exchange prefixes require a separately reviewed future extension.

Dates must be real calendar dates in exact `YYYY-MM-DD` format. The start must not
follow the end. The inclusive interval is at most 31 calendar days, regardless of
how many trading sessions occur. A same-day request is valid. The parser rejects
unknown or noncanonical-case field names, duplicate properties, null values and
wrong value types. Input is at most 2 KiB. Bounds are compiled constants, not
caller settings.

Example:

```json
{
  "operation": "prices_authenticated",
  "stock_id": "2330",
  "start_date": "2020-04-02",
  "end_date": "2020-04-06"
}
```

## Compiled policy

- Both price operations use `GET https://api.finmindtrade.com/api/v4/data` with
  `dataset=TaiwanStockPrice`. Only the validated stock/date values vary.
- Usage uses `GET https://api.web.finmindtrade.com/v2/user_info` without a query.
- Authenticated operations use only alias `finmind_token`. The demo adapter binds
  it to `VEILSPLICE_FINMIND_TOKEN`. The caller cannot change that binding through
  wrapper arguments or request JSON.
- Anonymous policy authorizes no secret alias and no caller header.
- There are no request bodies, login/write endpoints or automatic redirects.
- Price responses project only date/open/close, with date/numeric types, at most
  31 rows and 64 KiB. Usage projects only numeric user_count/api_request_limit,
  with a 4 KiB bound. The response policy is not caller-editable.

The wrapper uses the existing public-address DNS checks, pinned-IP HTTPS
transport, operation deadline, constant errors and response-echo defense. No new
network or cryptography implementation is introduced. Upstream contents are still
trusted for correctness: projection does not independently verify market prices,
row date membership or data provenance, and does not defeat all covert channels.
No per-caller rate limit or aggregate quota across requests exists yet.

Official endpoint and authentication references remain in the
[FinMind provider example](../examples/finmind/README.md).

## Build and validate without secrets or network

```sh
go build -buildvcs=false -trimpath -o bin/veilsplice-finmind ./cmd/veilsplice-finmind
./bin/veilsplice-finmind -check < examples/finmind/wrapper/prices-authenticated.json
./bin/veilsplice-finmind -check < examples/finmind/wrapper/prices-anonymous.json
./bin/veilsplice-finmind -check < examples/finmind/wrapper/usage-authenticated.json
go test -run 'TestFinMindWrapper|TestFinMindAnonymous' ./internal/proxy
```

Successful `-check` returns `{"request_valid":true}`. Unlike the generic CLI's
syntax-only check, it validates this entry point's entire input schema and fixed
request construction. It does not inspect DNS, read a secret, prove a token exists
or validate live authentication. Omit `-check` only in an appropriately isolated,
authorized deployment. The current backend remains a demo environment adapter;
secure input and persistence are still not implemented.

Tests use a fake backend, DNS resolver and HTTP transport. They exercise fixed
aliases/endpoints, denial before DNS/backend access, 31/32-day boundaries, leap
dates, one-stock limits, explicit anonymous/authenticated paths, mandatory auth
without downgrade, output schema/row limits and sanitized errors. They do not
read real keys, connect to FinMind or start a service.
