# Local braces security patch

The Web lint toolchain uses `braces@3.0.3`, which has no published fix for CVE-2026-93687 (GHSA-vfj7-8cjw-p6xm). The local `3.0.4-colp.1` version identifies a COLP-patched artifact, not an upstream release.

`braces/` contains the npm 3.0.3 runtime sources and MIT license. The five changed `lib` files apply the runtime diff from https://github.com/micromatch/braces/pull/72 at commit `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`: parser and AST nesting are capped at 100, including parentheses, and cyclic expansion parent chains are rejected. Normal glob expansion remains unchanged. The npm override uses the committed tarball so CI and Docker install these exact sources without lifecycle scripts or network access to a fork.

Rebuild after reviewing any source change:

```sh
cd packages/web/vendor
npm pack ./braces --ignore-scripts
```

Run `node --test packages/web/scripts/braces-security.test.mjs`, the CSS lint, and the full development dependency audit. Remove this override when an upstream release or a toolchain update removes the affected dependency.
