# Security composition cookbook

Practical wiring guide for integrators who compose COLP Security guards at a request boundary. This is **not** a Profile claim, a full HTTP middleware stack, or a conformance suite.

**Related progress:** `docs/progress/SECURITY.md` (repository-only progress record)
**Ownership boundary:** [`docs/HOST_INTEGRATION_BOUNDARY.md`](HOST_INTEGRATION_BOUNDARY.md)

**Public export:** `@collection-protocol/node/security` (`package.json` → `./security`)

---

## 1. Scope honesty

| Claim | Reality |
|---|---|
| What this package surface is | A **library / port layer**: fail-closed decision functions, request-boundary composition helpers, and typed ports (rate limit, credential restrictions, OAuth provenance, DPoP/mTLS, publisher admission). |
| What it is **not** | A framework middleware stack, HTTP server, or standalone Security Profile. Exporting `./security` alone does not create a deployment Publisher claim. |
| Conformance | Package Profile evidence is a **verified repository-tracked certificate** for an earlier clean source revision; each deployment must separately pass its black-box probes. |
| Package status | Package is **`private: true`**, version `0.0.0-development`. These are publication-maturity fields. Framework route/middleware ownership remains with the host and is not a package-completeness criterion. |
| Residual trust | Misclassified *deployment evidence* (wrong `networkExposure`, untrusted “TLS terminated” signals) can still under-enforce. That residual is deployment trust, not a free caller flag on composition APIs. |

Atomic guards remain internal implementation details available through their source modules for low-level tests. `enforceHttpsEndpoint` and `enforceOriginGuard` are intentionally absent from the public `./security` subpath. Production handlers use composition APIs that derive remote/applicability from trusted evidence.

---

## 2. Trusted transport evidence

### Rule

`TrustedTransportEvidence` must be built by the **deployment / framework** from:

- listen / peer address classification → `networkExposure` (`loopback` | `private` | `public`)
- trusted reverse-proxy / TLS terminator signals → `tlsTerminated`
- observed or terminator-asserted scheme → `transportScheme` (`https` | `http` | `other`)
- application protocol → `protocol` (`streamable-http` | `other`)
- origin-form or absolute request target → `requestTarget`
- request `Origin` header value(s) when needed → `origin`

**Never** populate evidence from untrusted client body fields, self-declared “I’m local” headers, or business-layer JSON alone.

Evidence is plain own-data only. Proxies, accessors, unknown keys, and incomplete fields fail closed (throws on snapshot helpers; composition decisions return denials).

### Shape (authoritative)

```ts
interface TrustedTransportEvidence {
  readonly networkExposure: 'loopback' | 'private' | 'public';
  readonly tlsTerminated: boolean;
  readonly transportScheme: 'https' | 'http' | 'other';
  readonly protocol: 'streamable-http' | 'other';
  readonly requestTarget: string;
  readonly origin?: string | readonly string[];
}
```

### How remote is derived

`deriveRemoteApplicability` sets remote/HTTPS applicability **only** from `networkExposure`:

| `networkExposure` | `remote` | HTTPS applicability |
|---|---|---|
| `public` or `private` | `true` | `applicable` |
| `loopback` | `false` | `not_applicable` |

There is **no** free-form `remote` override on the composition API.

### Preferred entry points

| Context | API |
|---|---|
| Publisher Streamable HTTP (any adapter) | `enforcePublisherStreamableHttpBoundary(evidence, { allowedOrigins })` — ordered **HTTPS → Origin**, fail closed on first denial. Denials: `invalid_options` (allowlist shape) vs `invalid_evidence` (transport evidence) vs stage denials |
| Lower-level composition | `enforceHttpsFromTransport` / `enforceOriginFromTransport` |

**Do not** call atomic `enforceHttpsEndpoint` / `enforceOriginGuard` from their source modules in a production handler with a self-asserted `remote`. Those functions are not exported from `./security`; production must use composition APIs that derive remote from trusted evidence.

Import this boundary from `@collection-protocol/node/security` for both Publisher and MCP adapters. The `publisher` entry also re-exports it and the evidence type; `mcp` does not. The host still owns transport attachment and must derive evidence from trusted framework/deployment state.

This small public-API example is compiled and executed from the installed tarball:

<!-- colp-consumer: security-transport -->
```ts
import {
  enforcePublisherStreamableHttpBoundary,
  type TrustedTransportEvidence,
} from '@collection-protocol/node/security';

export function checkWriteTransport(evidence: TrustedTransportEvidence) {
  return enforcePublisherStreamableHttpBoundary(evidence, {
    allowedOrigins: ['https://app.example.test'],
  });
}
```

---

## 3. Recommended request pipeline order

Publisher **Streamable HTTP** example. Order matters: transport trust before credentials, credentials before identity/scopes, scopes before costly work, parse after admission where practical.

| Step | What to run | Notes |
|:---:|---|---|
| **1** | Parse transport evidence (framework) | Map listen address, TLS terminator, scheme, protocol, request target, Origin → `TrustedTransportEvidence`. Not a security export; adapter-owned. |
| **2** | `enforcePublisherStreamableHttpBoundary` | Public, framework-neutral HTTPS → Origin composition. Framework adapters call this exported function after constructing trusted evidence. |
| **3** | Credential transport (route-scoped) | **API-key routes:** `enforceApiKeyOnlyTransport` (alias of `enforceApiKeyTransport`). **OAuth routes:** `enforceOAuth21Profile`. **Never** install the API-key guard as global middleware before OAuth routes — non-API-key Bearer tokens (including OAuth access tokens) fail with `invalid_authorization` by design. |
| **4** | Identities + effective scopes | `resolveRequestIdentities` (or equivalent) then `evaluateEffectiveScopes` / `hasEffectiveScope`. Empty / malformed `grantedScopes` fail closed to an empty set. |
| **5** | Credential restrictions (if applicable) | `enforceCredentialRestrictions` (IP/subnet, Origin, validity, node subtree, operation budget, Public Exposure opt-in). |
| **6** | Sender constraints (remote high-risk admin) | `enforceSenderConstraint` for remote Key / ACL / Public Exposure / Purge (DPoP or mTLS). Local and other ops need explicit `not_applicable` classification. |
| **7** | Rate limit | Prefer `enforceRateLimitForOperation` (classifies canonical bucket then charges). Do **not** pass free-form bucket IDs; non-canonical buckets throw/`TypeError` or fail closed. Attach RFC 9651 headers via `serializeRateLimitFields` (not legacy aliases). |
| **8** | Operation cost / subscription | For batch / sync / MCP expansion: `enforcePublisherAdmission` and/or `enforceSubscriptionLimits` as applicable (SEC-0013 ports). |
| **9** | I-JSON parse for write bodies | Server boundary: `parseIJson` / `validateServerWireDocument` from `@collection-protocol/node/server` (stricter server guard). Do not treat raw `JSON.parse` as the write gate. |
| **10** | Content integrity (response side) | **Emit** only: `emitContentIntegrityHeaders`. Success disposition is `headers_emitted`. Cryptographic verify and JWKS/Manifest retrieval are **adapter-owned**. Mutable resources use `enforceMutableResourceIntegrity` (verify path) separately (SEC-0018). |

### Why this order

1. Untrusted transport classification would skip HTTPS/Origin MUSTS before any auth runs.  
2. API-key-only middleware destroys OAuth Bearer routes if applied globally.  
3. Scope evaluation without resolved identities (or with empty grants) silently denies — fail-closed, not a grant.  
4. Protocol rate limit and admission use authoritative operation classification after authentication. Charge the canonical protocol bucket once. A host may additionally use a separate coarse IP/connection budget before authentication to protect its authentication service; this does not replace the authenticated protocol quota or justify charging that quota twice.
5. Parse after cheap denials reduces DoS work; integrity emit is response construction, not request verify.

---

## 4. Host adapter types that are not decisions

`AuthorizationAdapter` is the host adapter shape accepted by `CollectionProtocolModuleOptions.authorization`. It is not a Security decision API: authorization decisions come from `evaluateEffectiveScopes` / `hasEffectiveScope` with credential adapters at the boundary. Rate limits are composed at the route boundary with `enforceRateLimit` / `enforceRateLimitForOperation` and an `AtomicRateLimitPort` (SEC-0004 / SEC-0012), and `serializeRateLimitFields` emits the RFC 9651 fields (SEC-0014). MCP Plan approval belongs to the MCP module, not Security.

---

## 5. Common footguns

1. **Self-asserted `remote: false`**  
   Calling internal atomic guards with `remote: false` skips remote MUST controls. Use `TrustedTransportEvidence` + the public `enforcePublisherStreamableHttpBoundary` export.

2. **API-key guard as global middleware**  
   `enforceApiKeyOnlyTransport` rejects non-API-key Bearer tokens. Route it only on API-key paths; OAuth routes use `enforceOAuth21Profile`.

3. **Treating `headers_emitted` as verify**  
   `emitContentIntegrityHeaders` **emits** digests and signature headers from caller-supplied signature bytes. It does **not** verify Ed25519. Verify is adapter-owned. Mutable integrity is a separate API (`enforceMutableResourceIntegrity`).

4. **Empty or missing `grantedScopes`**  
   Effective scope starts from the credential grant and intersects every policy layer. Empty grants / malformed untrusted input → empty effective set (fail closed). That is not an open ACL.

5. **Misclassified `networkExposure`**  
   Marking a public listen address as `loopback` disables remote HTTPS/Origin MUSTS via composition. Classification must come from deployment truth (listen address / peer), not the client.

6. **Free-form rate-limit buckets**  
   Only the seven canonical `RateLimitBucketId` values are valid. Prefer `enforceRateLimitForOperation` so classification is bound to charging.

7. **Building evidence from the request body**  
   Client JSON cannot assert TLS termination, loopback, or Origin allowlist membership.

8. **Assuming Profile completeness**  
   Local unit acceptance, package release evidence, and a production deployment claim are three different boundaries. A package Profile in `supportedProfiles` still requires deployment endpoints, ports, and black-box probe evidence before Manifest publication.

9. **`resolveRequestIdentities` vs evaluator**  
   Direct `resolveRequestIdentities` may throw on bad input; `evaluateEffectiveScopes` / `hasEffectiveScope` convert many malformation cases to an empty set. Wire identities carefully at the boundary.

10. **Looking for Plan approval in Security**  
    MCP Plan approval is MCP module work, not Security module work.

11. **Shared credential query denylist includes short name `key`**  
    SEC-0008 and SEC-0009 share `CREDENTIAL_QUERY_PARAMETER_NAMES`, which includes `key` (plus `api_key`, `access_token`, `authorization`, `x-api-key`, …). Case-insensitive match on decoded query names. A legitimate non-secret `?key=` on an OAuth or API-key route fails closed with `credential_in_query`. Prefer non-credential query names on those routes; do not silently re-narrow the denylist to only `access_token`.

12. **Boundary `invalid_options` vs `invalid_evidence`**  
    `enforcePublisherStreamableHttpBoundary` returns `invalid_options` when `{ allowedOrigins }` fails snapshot (missing, non-plain options, non-dense/non-string allowlist). It returns `invalid_evidence` only when trusted transport evidence fails. Options failures are not evidence failures — check Nest/factory wiring vs deployment evidence classification separately.

13. **Time units are not interchangeable (L-3)**  
    Credential restriction `notBefore` / `expiresAt` are **epoch milliseconds**. OAuth access-token `issuedAt` / `expiresAt`, DPoP times, and mutable-integrity claims are **Unix whole seconds**. Helpers `assertEpochMilliseconds` / `assertUnixSeconds` run at those validation sites; do not convert units at call sites without an explicit scale change.

---

## 6. Server write-body validation

`validateServerWireDocument` takes `(validators, definition, source, validateSemantics, limits?)`.
`definition` is the Schema definition name, for example `syncPush`, not an already parsed object or a validator result. The semantic callback receives the structurally validated value and must apply the endpoint's domain rules. Parsing and structural failures return before that callback. Dispatch a write only when `result.valid` is true; map parse, structural, and semantic denials to the endpoint's registered Problem response.

<!-- colp-consumer: server-write-body -->
```ts
import {
  createValidatorRegistry,
  type DefinitionName,
  type IJsonParseLimits,
  type SemanticValidationResultLike,
} from '@collection-protocol/node/schema';
import { validateServerWireDocument } from '@collection-protocol/node/server';

const validators = createValidatorRegistry();

export function validateWriteBody<Value, Issue>(
  definition: DefinitionName,
  rawBodyText: string,
  validateSemantics: (value: Value) => SemanticValidationResultLike<Issue>,
  limits: IJsonParseLimits = {},
) {
  return validateServerWireDocument(
    validators, definition, rawBodyText, validateSemantics, limits,
  );
}
```

## 7. Minimal code sketch (illustrative)

Pseudo-wiring only — not a full server. Import names match the public security subpath and server parse boundary.

```ts
/**
 * Illustrative publisher Streamable HTTP edge wiring.
 * Not a complete server; ports and HTTP framework binding are deployment-owned.
 */
import {
  type TrustedTransportEvidence,
  type AtomicRateLimitPort,
  type AtomicPublisherAdmissionPort,
  enforcePublisherStreamableHttpBoundary,
  enforceApiKeyOnlyTransport,
  enforceOAuth21Profile,
  resolveRequestIdentities,
  evaluateEffectiveScopes,
  hasEffectiveScope,
  enforceCredentialRestrictions,
  enforceSenderConstraint,
  enforceRateLimitForOperation,
  enforcePublisherAdmission,
  enforceSubscriptionLimits,
  emitContentIntegrityHeaders,
  serializeRateLimitFields,
} from '@collection-protocol/node/security';
// Relative equivalent while developing in-tree:
// import { ... } from '../src/security/index.js';

import {
  parseIJson,
  validateServerWireDocument,
} from '@collection-protocol/node/server';

async function handlePublisherStreamableHttp(ctx: {
  /** Built ONLY from listen address, TLS terminator, scheme, protocol, target, Origin */
  evidence: TrustedTransportEvidence;
  allowedOrigins: readonly string[];
  routeKind: 'api-key' | 'oauth';
  // ... raw target, Authorization, auth result, policy chain, ports, body text, etc.
  rateLimitPort: AtomicRateLimitPort;
  admissionPort: AtomicPublisherAdmissionPort;
}): Promise<void> {
  // 1–2. Transport boundary (HTTPS → Origin)
  const boundary = enforcePublisherStreamableHttpBoundary(ctx.evidence, {
    allowedOrigins: ctx.allowedOrigins,
  });
  if (!boundary.allowed) {
    // Map reason: invalid_options | invalid_evidence | https_denied | origin_denied
    return; // deny
  }

  // 3. Credential transport — route-scoped, never global API-key-only middleware
  if (ctx.routeKind === 'api-key') {
    const apiKey = enforceApiKeyOnlyTransport(/* ApiKeyTransportInput */);
    if (!apiKey.allowed) return;
  } else {
    const oauth = await enforceOAuth21Profile(/* ports */, /* OAuth21ProfileInput */);
    if (!oauth.allowed) return;
  }

  // 4. Identities + effective scopes
  const scopeInput = {
    identityResolution: /* IdentityResolution from credential adapter */,
    grantedScopes: /* ReadonlySet<ScopeName> from credential */,
    policyChain: /* serverDefault, collection, ancestors, object */,
  } as const;
  // resolveRequestIdentities may throw; evaluateEffectiveScopes fails closed to empty set
  void resolveRequestIdentities(scopeInput.identityResolution);
  const effective = evaluateEffectiveScopes(scopeInput);
  if (!hasEffectiveScope(scopeInput, 'nodes:write') || effective.size === 0) {
    return;
  }

  // 5–6. Optional credential restrictions + remote high-risk sender constraint
  // await enforceCredentialRestrictions(ports, request)
  // await enforceSenderConstraint(ports, input)

  // 7. Rate limit — operation-bound classification, not free-form bucket
  const limited = await enforceRateLimitForOperation(ctx.rateLimitPort, {
    authentication: /* anonymous | authenticated */,
    operation: /* canonical publisher operation */,
    cost: 1,
    ipAddress: /* trusted peer IP */,
    instanceId: /* deployment instance */,
    ceilings: /* credential + IP + instance */,
    // credentialId optional when authenticated
  });
  if (!limited.allowed) {
    // Attach limited.headers / serializeRateLimitFields(...)
    return;
  }

  // 8. Batch / sync / MCP admission & subscription (when applicable)
  // await enforcePublisherAdmission(ctx.admissionPort, ...)
  // await enforceSubscriptionLimits(...)

  // 9. Write body I-JSON gate (server entry)
  // const value = parseIJson(rawBodyText /*, limits */);
  // const wire = validateServerWireDocument(validators, definitionName, rawBodyText, validateSemantics /*, limits */);

  // 10. Response content integrity — emit only; verify is adapter-owned
  // const integrity = emitContentIntegrityHeaders({ ... body bytes, signature blob, key ids ... });
  // if (integrity.allowed && integrity.disposition === 'headers_emitted') { set headers }
}
```

---

## Residuals (do not over-claim)

- Full end-to-end HTTP route attachment and framework middleware stack are **host-owned**, not promised by this package surface.
- The repository-tracked conformance certificate covers package source; deployment probe evidence has a separate lifecycle and remains host-owned.
- `./security` alone does not add a Profile or authorize a deployment claim. The package-level Profile set remains the exact exported `supportedProfiles` list.
- Atomic ports (`AtomicRateLimitPort`, admission, subscription, DPoP verify, etc.) require real deployment adapters.
- Historical-release path in SEC-0018 is **shape/URI validation only** (`shape_validated`), not crypto verify.

When in doubt: fail closed, prefer composition over self-asserted remote flags, and keep credential transport route-scoped.
