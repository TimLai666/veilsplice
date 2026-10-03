# VeilSplice local validation snapshot

Date: 2026-10-03 17:46 UTC. Platform: Linux amd64.

Revalidated after adding the offline FinMind examples. The module is
`github.com/TimLai666/veilsplice`. This is a local validation record, not proof of
repository publication.

Official Go 1.27.1 archive was verified against the SHA-256 published by
`https://go.dev/dl/?mode=json`:

- Archive: `go1.27.1.linux-amd64.tar.gz`
- SHA-256: `63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445`

Checks against this source snapshot:

- `go test -count=1 -race -cover ./...`: PASS
  - 21 top-level test functions, with additional table-driven cases; 2 fuzz targets.
  - `cmd/veilsplice`: 67.3% statement coverage.
  - `internal/proxy`: 84.1% statement coverage.
- FinMind offline tests: three fake-transport data/anonymous/usage cases and
  rejected credential-query/body cases: PASS. No FinMind API call was made.
- All three FinMind CLI `-check` templates: PASS.
- `go vet ./...`: PASS.
- `go build -buildvcs=false -trimpath -o bin/veilsplice ./cmd/veilsplice`: PASS.
- Binary `-check` on JSON and form examples: PASS, `{"syntax_valid":true}`.
- `FuzzTemplateParser`, 5-second budget, 2 workers: PASS, 35,614 executions.
- `FuzzExpansion`, 5-second budget, 2 workers: PASS, 76,480 executions.
- Independent source/documentation review completed; no confirmed blocker to
  publishing as an experimental prototype was found. This is not a security audit.

The initial default build could not read VCS metadata from the surrounding managed
workspace. `-buildvcs=false` disables that optional stamping; it does not disable
compiler checks or transport security. The documented build command uses it.

Tests use only synthetic secrets. The full TLS test uses an in-memory network pipe
and a generated test certificate, with both trusted and untrusted-certificate
cases. No external endpoint was called, no TCP listener was started, and no real
account, key or provider integration was used or verified. Hosted CI and deployment
have not run.

These results do not establish safety of a future deployment, secure key input,
secret persistence, caller isolation, API side effects or arbitrary response-data
confidentiality. See `README.md` and `SECURITY.md` for the trust boundary and gaps.
