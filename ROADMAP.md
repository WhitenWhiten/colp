# Roadmap

COLP is a `0.1-draft`. This page lists what is done and what comes next. Issues hold the details, and [Discussions](https://github.com/WhitenWhiten/colp/discussions) is the place to suggest changes to the plan. Items marked "help wanted" are good places to start.

## Toward the first release

- [x] Specification, JSON Schema, executable examples, and requirement registry
- [x] Node.js reference package covering all seven profiles, with every MUST and MUST NOT mapped to tests
- [x] Runnable example server
- [x] Black-box conformance runner for `core + publication`
- [ ] Work through the [release checklist](packages/node/docs/RELEASE_CHECKLIST.md): version baseline, cross-platform test run, and the first npm release
- [ ] Publish the specification as a website at its canonical URLs
- [ ] Decide the minimum Node.js version for ESM-only dependencies ([#9](https://github.com/WhitenWhiten/colp/pull/9), [#11](https://github.com/WhitenWhiten/colp/pull/11))

## Conformance runner

- [ ] Authenticated reads ([#12](https://github.com/WhitenWhiten/colp/issues/12), help wanted)
- [ ] Feed profile ([#13](https://github.com/WhitenWhiten/colp/issues/13), help wanted)
- [ ] Publisher and Sync profiles, run against a disposable test Collection because they write
- [ ] MCP profiles

## Reference package and examples

- [ ] Paginated Snapshots in the example server ([#14](https://github.com/WhitenWhiten/colp/issues/14), good first issue)
- [ ] Build with TypeScript 7 ([#15](https://github.com/WhitenWhiten/colp/issues/15), help wanted)
- [ ] Require an issuer on stored OAuth records ([#16](https://github.com/WhitenWhiten/colp/issues/16))
- [x] [API guide](packages/node/docs/API.md) to the package's export subpaths

## Ecosystem (help wanted)

- [ ] A second, independent implementation in another language, verified with the conformance runner
- [ ] A browser extension that syncs bookmark trees through the Sync profile
