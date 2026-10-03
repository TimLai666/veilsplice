# FinMind read-only example

This directory is a **configuration and offline-fixture example**, not a connected
FinMind account. It contains no real credential. Do not submit the fake test token
to FinMind. No production API request is performed by the tests below.

## Exact documented destinations

The policy deliberately uses two distinct hosts, not a wildcard:

- Data: `GET https://api.finmindtrade.com/api/v4/data`.
- Usage: `GET https://api.web.finmindtrade.com/v2/user_info`.

FinMind's [official usage documentation](https://finmind.github.io/en/api_usage_count/)
defines the usage endpoint and Bearer header, and also demonstrates Bearer
requests to the data endpoint. Its [data API guide](https://finmind.github.io/en/quickstart/)
defines the read-only data GET and query fields. The
[stock-price documentation](https://finmind.github.io/en/tutor/TaiwanMarket/Technical/)
describes the `TaiwanStockPrice` dataset. Documentation was checked on 2026-10-03.

Including these endpoints in a sample is not authorization to send a real key.
An operator must obtain the user's explicit approval for the chosen credential,
backend access and both intended destinations before a real integration. There is
no login, account creation, token update, purchase or other write endpoint here.

## Files and behavior

- `policy.json`: exact GET URLs, no request bodies, `Authorization` as the only
  caller header, and four data-query names. Usage accepts no query parameters.
  The alias `finmind_token` references the backend binding
  `VEILSPLICE_FINMIND_TOKEN`; no secret value is embedded in policy.
- `request-prices.json`: authenticated template with
  `Bearer ${secret:finmind_token}` and a small example date interval.
- `request-anonymous.json`: the same data request without a Bearer header. This
  path must not access the secret backend.
- `request-usage.json`: authenticated template for quota counters.
- `fixtures/`: clearly fake token, synthetic upstream responses and expected
  projected results. Prices and usage figures are invented test values, not
  historical market observations, account information or quota guarantees.

Data projection selects `/data` and returns only `date`, `open` and `close` from
each row, bounded to 100 rows and 64 KiB. Usage projection returns only numeric
`user_count` and `api_request_limit`, bounded to 4 KiB. Fixture-only token/private
fields demonstrate that unselected fields are dropped. The generic response
projection's non-DLP limitations still apply; see the main README and SECURITY.md.

These rules allow listed query **names**, not only the example query values.
`TaiwanStockPrice`, the stock ID and date range are not pinned or semantically
validated by this prototype. The policy also permits an omitted authorization
header, as the explicit anonymous example demonstrates. A deployment that must
require authentication, pin a dataset or cap date ranges needs those additional
request constraints in its trusted wrapper before exposure to untrusted callers.
Those restrictions are now available in the separate
[fixed-policy wrapper](../../docs/finmind-wrapper.md); they do not change the generic
CLI examples above and still require OS/runtime isolation.

## Run checks without FinMind traffic

From the repository root:

```sh
go test -run '^TestFinMind' ./internal/proxy
./bin/veilsplice -check -policy examples/finmind/policy.json -request examples/finmind/request-prices.json
./bin/veilsplice -check -policy examples/finmind/policy.json -request examples/finmind/request-anonymous.json
./bin/veilsplice -check -policy examples/finmind/policy.json -request examples/finmind/request-usage.json
```

The Go tests substitute both the DNS resolver and HTTP transport. They inject only
the fake fixture through an in-memory backend. They verify both exact URLs, GET,
absence of a body, Bearer placement, absence of credentials in URLs, no backend
access for anonymous requests, and the expected projected output. Additional
cases reject token/password query parameters and JSON request bodies. They do not
contact FinMind or inspect an existing environment token.

`-check` is syntax/policy checking only; it is not an authentication test. Do not
omit `-check` with the fake fixture or treat a fixture pass as account connectivity.

## Verification status: keep three claims separate

1. **Prior anonymous REST smoke test:** on 2026-10-03, the development environment
   separately received HTTP 200 and a successful JSON result from the official
   data endpoint for a small `TaiwanStockPrice` sample, without credentials. That
   one-off test did not use VeilSplice; it is not this project's live-integration
   test, a guarantee of current availability, or evidence of authenticated access.
2. **This repository's FinMind example:** offline fake-transport tests verify
   request construction and projection. The fixtures are synthetic.
3. **Authenticated data and usage:** not tested against the live service. No real
   key has been provisioned, read, sent or persisted by this project. Secure input,
   a production secret backend and isolated execution are still outstanding.

See [the minimum connection gap assessment](../../docs/secure-input-gap.md) for
what must be built and approved before accepting a real key.
