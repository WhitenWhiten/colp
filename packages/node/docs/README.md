# Package documentation

Everything written about `@know-n/colp`, grouped by what you are trying to do. The guides ship with the package; the reference documents and records live in the repository. If you are new, read the [package README](../README.md) first, then the [API guide](API.md). The protocol itself is specified in [`protocol/`](https://github.com/WhitenWhiten/colp/blob/main/protocol/README.md).

## Guides

Step-by-step help for building on the package.

| Guide | Read it when you want to… |
|---|---|
| [API guide](API.md) | find the right entry point for a task, with a short example for each |
| [Publication quickstart](PUBLICATION_QUICKSTART.md) | serve the read-only `core + publication` endpoints from your own HTTP framework |
| [Publisher quickstart](PUBLISHER_QUICKSTART.md) | accept authenticated writes with idempotency keys and real transactions |
| [Sync host composition](SYNC_HOST_COMPOSITION.md) | host the Sync endpoints that browser and app replicas talk to |
| [Browser batch integration](BROWSER_BATCH_INTEGRATION.md) | apply a batch of browser bookmark changes from an extension |
| [MCP host guide](MCP_HOST_GUIDE.md) | let AI assistants read and change collections over MCP |
| [Security composition](SECURITY_COMPOSITION.md) | put the HTTPS, origin, rate-limit, OAuth, and credential checks in the right order at your request boundary |
| [Host integration boundary](HOST_INTEGRATION_BOUNDARY.md) | know exactly what the package does and what your application still has to do |

## Reference

| Document | What it is |
|---|---|
| [Architecture](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/ARCHITECTURE.md) | How the package is organized, where its contracts come from, and why the boundaries are where they are |
| [Traceability](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/TRACEABILITY.md) | Generated: every protocol requirement, the modules that implement it, and the tests that prove it |
| [Sync wire completeness](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/SYNC_WIRE_COMPLETENESS.md) | Which Sync capabilities the package implements and which pieces a host must wire itself |
| [MCP SDK policy](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/MCP_SDK_POLICY.md) | How the upstream MCP SDK is pinned and which of its types may cross the package's public API |

## For maintainers

| Document | What it is |
|---|---|
| [Testing strategy](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/TESTING.md) | Test layers, coverage floors, and naming conventions |
| [Release checklist](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/RELEASE_CHECKLIST.md) | What must be decided and verified before the first npm release |
| [Release artifact](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/RELEASE_ARTIFACT.md) | How to publish exactly the tarball that was tested, without rebuilding it |
| [Clean tarball acceptance](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/CLEAN_TARBALL_ACCEPTANCE.md) | Installing a packed tarball into an isolated consumer before a release |
| [Local performance review](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/LOCAL_PERFORMANCE_REVIEW.md) | Measuring the publication pipeline on your own machine |

## Records

Decisions and changes kept for history. They explain what was done and why; they are not instructions.

| Record | What it covers |
|---|---|
| [Protocol corrections](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/PROTOCOL_CORRECTION.md) | Specification bugs found while implementing the package, how they were fixed, and how to migrate |
| [Review dispositions](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/REVIEW_DISPOSITIONS.md) | Audit findings closed by design or accepted as deployment responsibilities, with the conditions that would reopen them |
| [Security Cloud remediation, 2026-10-06](https://github.com/WhitenWhiten/colp/blob/main/packages/node/docs/SECURITY_CLOUD_2026_10_06.md) | Hardening done in response to a security scan |
