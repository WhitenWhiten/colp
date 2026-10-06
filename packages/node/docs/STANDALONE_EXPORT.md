# Standalone repository export

The supported independent repository layout keeps `packages/node/`, `protocol/`, the COLP workflow, and the small explicit closure of shared checks
inside the **new** repository. It contains no sibling application, Demos,
node_modules, local environment file, build output, or parent Git history.
Keeping this internal layout preserves generated-asset, test and evidence paths;
a flat copy of only the package directory is not the supported export procedure.

From a clean committed source checkout with `packages/node` development dependencies installed:

```sh
node packages/node/scripts/export-standalone.mjs /absolute/path/to/a-new-colp-repository
```

The destination must not exist and must be outside the current repository.
The exporter uses committed Git objects, rejects symlinks/submodules and known
non-source paths, filters secret-scanner literal exceptions to exported paths,
and checks static relative module closure. Missing required source dependencies
fail the export; it does not silently copy another application's directory.
It does not create a GitHub repository, push history, publish npm, choose a
license, or claim that the exported tree has passed its runtime tests.

Before independent release, review the exported source and license decision,
initialize and commit the new repository, run `npm ci` in `packages/node/`, rebuild the
allowlisted esbuild as in the existing COLP workflow, and regenerate the owned
conformance and MCP acceptance evidence using the existing documented ceremony.
The old certificate's source revision is not an ancestor in fresh history:
**never rewrite certificate hashes by hand or disable the ancestry check**.
Commit regenerated evidence and run `npm run check` at the exact clean new HEAD.
Run clean-tarball acceptance on the existing local Node/OS release matrix.

Fresh-history acceptance must occur where the old parent checkout is absent.
The exported `COLP_EXPORT.json` deliberately records runtime acceptance as not
run. Static module closure alone is not a build/test certificate. Keep performance
and mutation local-only. The copied CI retains the existing Ubuntu/Node baseline
and additionally routes the exported root helper changes to COLP quality jobs.
