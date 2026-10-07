# Host integration boundary

This document defines the ownership boundary between `@know-n/colp`
and any application that embeds it. The package is a Node.js implementation of
The Collection Protocol. It does not know which product, service, HTTP framework,
database, identity provider, or deployment topology will host it.

## Three distinct claims

1. **Protocol conformance** is defined by The Collection Protocol and its
   Requirement Registry.
2. **Package capability** means this package implements a Profile's reusable
   contracts and behavior and has the required package-level evidence. The exact
   package-verified set is exported as `supportedProfiles`.
3. **Deployment capability** means one concrete deployment has mounted the real
   endpoints, supplied the required runtime ports, and passed the Profile-specific
   black-box probes. Only this layer may publish a Manifest Profile claim.

`packageStatus`, npm publication metadata, and `private` describe packaging
maturity. They do not turn host-owned HTTP routing or persistence into missing
package behavior. Conversely, a Profile appearing in `supportedProfiles` does
not prove that any deployment exposes it.

## Responsibility matrix

| Concern | Package responsibility | Host deployment responsibility |
|---|---|---|
| Protocol contracts | Canonical Schema, generated types, Wire DTO contracts, Requirement mappings, and semantic validation | Select the protocol/package version and reject traffic that cannot be represented by the supported contracts |
| Application behavior | Framework-neutral coordinators, immutable results, stable errors, and composition helpers | Map authenticated requests into coordinator inputs and map returned results without changing protocol semantics |
| HTTP contract | Methods, media types, Header semantics, status/Problem mappings, endpoint declaration contracts, and client behavior | Choose real URLs, register routes, preserve raw Header cardinality, parse request bytes, and serialize actual responses |
| Framework integration | Public framework-neutral APIs; internal examples or factories may demonstrate composition but are not deployment modules | Own Controllers, Modules, Providers, middleware, guards, interceptors, Fastify plugins, Express handlers, or equivalent framework code |
| Security | Fail-closed validation and decision functions, trusted-evidence types, required guard order, and policy ports | Establish trusted proxy/TLS facts, construct transport evidence, attach guards to every applicable route, and integrate credential/identity providers |
| Persistence and transactions | Store, transaction, Unit of Work, clock, signing, rate-limit, and other port contracts | Implement ports with the required durability, isolation, uniqueness, rollback, key lifecycle, and cross-process behavior |
| Operations | Conformance scope planner, probe definitions, runners, and `evaluateProfileClaims` / `assertProfileClaims` | Declare only real generic deployment roles, supply a real target environment, run its exact plan against adapters and endpoints, retain release evidence, and publish only asserted Manifest claims |

## Integration rule

A remote request crosses the boundary in this order:

1. The host captures raw framework input and derives trusted connection facts.
2. The host invokes the package's transport, credential, authorization,
   rate-limit, parsing, Schema, and semantic boundaries in the documented order.
3. The host maps validated data to a framework-neutral coordinator request.
4. The coordinator uses injected transaction-bound ports; the host adapters make
   those guarantees real.
5. The host serializes the returned Wire DTO, Headers, status, or Problem result
   without inventing a second protocol implementation.

Framework request objects and persistence records must not be passed directly to
coordinators. They are adapter inputs and must be snapshotted, validated, and
mapped at their owning boundary.

## Framework-specific code

No NestJS, Fastify, Express, or other framework module is required for package
Profile completion. A framework-specific helper kept inside this repository is
an internal composition aid unless it is explicitly listed in `package.json`
exports. It does not register production routes, configure trusted proxies,
attach middleware, or provide a deployment claim.

The host may wrap public package APIs in any framework. The framework choice does
not move route ownership into the package.

## Profile publication

Before publishing a Profile in a Manifest, the host must:

1. pin a package version whose `supportedProfiles` contains the Profile and all
   required dependencies;
2. mount every required endpoint and provide every required runtime port;
3. call `createDeploymentConformancePlan` with the exact explicit Profile list and enabled generic capabilities, and inspect the immutable plan;
4. run `runDeploymentConformanceProbes` with the same scope against the real deployment; any MCP Profile also requires the `mcpConformance` binding shown below;
5. pass the opaque scope-bound evidence and the exact requested Profile list to
   `assertProfileClaims`; and
6. serialize the immutable assertion result, not a configuration list or an
   `evaluateProfileClaims` diagnostic result.

Test fixtures that return cooperative adapter observations are not a real
deployment. They must not be copied into production probes or used to publish
a Manifest.

### MCP binding

Scopes containing `mcp-read` or `mcp-write` must provide
`mcpConformance: { packageVersion, requirementsDigest }`.
Take both values from the installed package's `bundledConformanceEvidence`
export in `@know-n/colp/conformance`: it is the evidence shipped
with that exact package version. Do not copy test-fixture values or read
internal files from another checkout.

`requirementsDigest` is `sha256:` followed by 64 lowercase hexadecimal characters.
The runner validates and snapshots the binding before invoking any target operation.
The planner alone can inspect a Profile scope without this binding, but cannot
issue publishable evidence.

<!-- colp-consumer: mcp-deployment-binding -->
```ts
import {
  bundledConformanceEvidence,
  createDeploymentConformancePlan,
  runDeploymentConformanceProbes,
  type DeploymentConformanceScope,
  type DeploymentConformanceTarget,
} from '@know-n/colp/conformance';

export function mcpReadScopeFromInstalledPackage(): DeploymentConformanceScope {
  const { packageVersion, requirementsDigest } = bundledConformanceEvidence;
  return {
    profiles: ['core', 'mcp-read'],
    capabilities: [],
    mcpConformance: { packageVersion, requirementsDigest },
  };
}

export async function checkMcpReadDeployment(target: DeploymentConformanceTarget) {
  const scope = mcpReadScopeFromInstalledPackage();
  const plan = createDeploymentConformancePlan(scope);
  const evidence = await runDeploymentConformanceProbes(target, scope);
  return { scope, plan, evidence };
}
```

Supply the real deployment adapter as `target`, inspect the plan, and pass
the returned evidence to `assertProfileClaims` with the matching runtime
ports, endpoints and exact Profile list. The bundled package evidence does
not prove the deployment has mounted or implemented those endpoints.
For MCP Write, the explicit closure is `['core', 'publication', 'publisher', 'mcp-read', 'mcp-write']`;
include any additional deployment capabilities before planning and execution.

Profile dependency edges do not enable unrelated deployment roles. In
particular, a read-only `core + publication` host supplies no optional
capabilities and runs only the Publication HTTP contract. A host that exposes
ordinary authoritative writes but does not accept or store the optional
`managed-bookmarks` Folder role declares `core-authoritative-writes` without
`managed-bookmark-writes`; it must not synthesize Managed Bookmark data merely
to satisfy a probe. Publisher and Sync automatically add both write
capabilities because their generic Node mutation paths can encounter Managed
Nodes; Sync also adds unknown-Extension storage. AI writes, browser-local
Profile ID persistence, and server Profile ID HMAC lifecycle are declared only
by deployments that expose those roles. Capability names are package-level
conformance scope identifiers, not Manifest Profiles or product-specific
configuration keys.

The package is not incomplete merely because it does not ship a ready-to-run
application server. A deployment is not conformant merely because it installed a
package with the desired Profile in `supportedProfiles`.
