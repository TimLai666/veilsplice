# Web source maintenance

## Baseline and scope

This is the website's v7 application source snapshot. FinMind and Whisper remain
separate fixed-policy adapters. It contains no generic file-response endpoint,
attachment-download protocol or pending file-response feature.

The website does not invoke the Go CLI. The Go and TypeScript implementations
have separate policies, limits and trust boundaries; changes must be tested in
the implementation they affect. The CLI's `${secret:alias}` and the web editor's
`{{alias}}` syntax are not interchangeable.

Public-export differences from the original web snapshot are limited to:

- separate `web/` package and maintenance documentation;
- generic build configuration with a placeholder local D1 identifier;
- removal of unused connector/preview integration, starter installation scripts,
  unused UI components and unused assets;
- package command/name changes, third-party notices and one lint-only test-variable
  rename;
- no credentials, deployment IDs, owner identity configuration or database data.

The FinMind/Whisper request handlers, browser workbench and schema migrations are
preserved. No running Site is changed by checking out, testing or publishing this
repository. Do not copy a repository build into a live Site without reviewing its
platform integration and obtaining deployment approval.

## Reproducible local checks

Use Node.js 24 and npm 11. The source uses Node's experimental SQLite and
TypeScript-stripping APIs in tests. From the repository root:

```sh
cd web
npm ci --ignore-scripts
npm run check
```

`check` runs the offline fake-data tests, full TypeScript check, ESLint and Vinext
build. After installation, the tests use in-memory SQLite and mocked fetch/React
hooks; they need no key, account, network request or live database. A test pass is
not a browser/DOM acceptance test or a live provider integration result.

The build writes `dist/` and a generic ignored `.openai/hosting.json` descriptor
containing only the `DB` binding name. The preparation script does not overwrite
an existing descriptor. The local D1 UUID in Vite is a dummy. No live database is
created or migrated by `npm run check`. Generated output is not committed.

The copied MIT Sites plugin contains an optional local mock sign-in feature;
this project's Vite configuration explicitly disables it. A standalone `npm run
dev` is a compile/serve aid and cannot authenticate a real owner: the sign-in
routes, trusted identity boundary and owner configuration are not supplied.
Never expose this Worker directly to untrusted requests or synthesize identity
headers as production authentication.

## Changes and release review

1. Keep Go changes and web changes scoped. Run `make check` from the root for Go
   changes, and `npm run check` in `web/` for web changes. For both, run both.
2. Add regression tests for changed policy, owner/CSRF authorization, quota,
   credential lifecycle, response filtering, UI interruption and repeated-click
   behavior. Schema migrations are appended, never edited after application.
3. Scan the exact tracked-file set before pushing. Reject `.openai`, `.env*`,
   `.dev.vars*`, `.wrangler`, DB files/backups, live owner hashes, tokens, logs,
   `node_modules`, build output and internal notes. Fake test fixtures must remain
   obviously synthetic. Do not inspect/export live credential tables.
4. Review dependency versions and actual licenses; retain notices. A source
   publication does not authorize redistribution of a bundled binary/container.
5. Verify the exact pushed commit and its Go/Web GitHub Actions. CI has read-only
   repository permissions and no deployment credentials. It does not deploy.
6. Release deployment separately: an authorized operator must establish Sites
   owner-private dispatch, a trusted identity path, the `DB` binding, schema
   migrations and privately configured `OWNER_EMAIL_SHA256`. No such values or
   access setup are carried by this repository. Credential entry remains an
   owner-only action through the disclosed secure page.
7. Perform separately authorized browser/live acceptance with selected inputs;
   verify owner denial, credential status, exact provider destination, output
   filtering and timeout/unknown-outcome behavior. Do not bypass provider or
   hosting security blocks, or interpret a build as live integration success.
