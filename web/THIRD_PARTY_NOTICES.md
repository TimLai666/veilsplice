# Third-party source and dependencies

The repository's MIT license covers original VeilSplice code. It does not replace
third-party licenses or grant rights to hosted platform services.

## Copied source

- `build/sites-vite-plugin.ts`: vendored from `@openai/sites-vite-plugin` 0.2.0.
  Copyright 2026 OpenAI, MIT; full notice is in
  `build/sites-vite-plugin.LICENSE` and `licenses/openai-sites-MIT.txt`.
  [Upstream](https://github.com/openai/sites),
  [license](https://github.com/openai/sites/blob/main/LICENSE).
- `app/chatgpt-auth.ts`: OpenAI's public create-sites auth helper, with formatting
  differences. Covered by `licenses/openai-sites-MIT.txt`.
  [Upstream source](https://github.com/openai/sites/blob/main/packages/create-sites/templates/addons/auth/app/chatgpt-auth.ts).
- `components/ui/{button,input,textarea,table}.tsx` and `lib/utils.ts`: shadcn UI
  component/utilities source, copyright 2023 shadcn, MIT. Full notice is in
  `licenses/shadcn-MIT.txt`. The originating UI export identifies shadcn 4.17.0;
  byte-for-byte version provenance was not independently established.
  [Component source](https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui),
  [license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
- `vendor/shadcn-tailwind-4.13.0.css`: shadcn Tailwind styles, MIT, with adjacent
  `vendor/shadcn-tailwind-4.13.0.LICENSE.md`. The filename records the supplied
  version; exact version-byte equivalence was not independently established.
  [Upstream CSS](https://github.com/shadcn-ui/ui/blob/main/packages/shadcn/src/tailwind.css).

The public packaging retains these notices. The unused starter connector bridge,
preview infrastructure, installation scripts, components and decorative assets
are omitted. No license is asserted for omitted platform internals.

## Dependency boundary

`package-lock.json` preserves the source snapshot's resolution. It records 893
installed/optional dependency entries, each with license metadata, including
MIT, Apache-2.0, ISC, BSD, MPL-2.0, LGPL-3.0-or-later and CC-BY-4.0 terms.
The 44 direct dependencies/devDependencies declare 38 MIT, 3 Apache-2.0,
1 ISC and 2 dual MIT OR Apache-2.0 licenses.

In particular, optional `@img/sharp`/libvips packages include LGPL terms;
lightningcss, axe-core, satori, @vercel/og and resvg include MPL terms;
caniuse-lite declares CC-BY-4.0. This tree is not wholly MIT-licensed.
The lockfile includes dependencies inherited from the original starter even
where the reduced UI no longer uses them; dependency pruning is a separate change.

Dependency source/binaries, `node_modules`, generated bundles and containers are
not part of this source import. Consult the exact installed package's license
and notices. Review the actual artifacts and their obligations before distributing
a bundled release or container; this inventory is not a complete distribution audit.

The published Vinext framework is MIT:
https://github.com/cloudflare/vinext/blob/main/LICENSE . Hosted ChatGPT Sites
identity/dispatch and Cloudflare D1 remain separate services and dependencies.
