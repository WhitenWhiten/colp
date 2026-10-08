import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootOption = process.argv.indexOf('--root');
const root = rootOption >= 0
  ? resolve(process.argv[rootOption + 1] ?? '')
  : fileURLToPath(new URL('../src/', import.meta.url));

const sourceRoot = rootOption >= 0 ? root : root;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Generated/vendor/build trees are never architecture input.
      if (['node_modules', 'dist', 'build', 'coverage', 'generated', 'vendor'].includes(entry.name)) return [];
      return walk(path);
    }
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [resolve(path)] : [];
  });
}

if (!existsSync(sourceRoot)) {
  console.error(`import boundary root does not exist: ${sourceRoot}`);
  process.exit(1);
}

const files = walk(sourceRoot);
const knownFiles = new Set(files);

function readAliases() {
  const tsconfigCandidates = rootOption >= 0
    ? [resolve(sourceRoot, 'tsconfig.json'), resolve(sourceRoot, '../tsconfig.json')]
    : [resolve(sourceRoot, '../tsconfig.json')];
  const tsconfig = tsconfigCandidates.find((candidate) => existsSync(candidate));
  if (!tsconfig) return { baseDir: sourceRoot, entries: new Map() };
  try {
    const paths = JSON.parse(readFileSync(tsconfig, 'utf8')).compilerOptions?.paths ?? {};
    return {
      baseDir: dirname(tsconfig),
      entries: new Map(Object.entries(paths).filter(([, values]) => Array.isArray(values) && values.length)),
    };
  } catch {
    return { baseDir: dirname(tsconfig), entries: new Map() };
  }
}

const aliasConfig = readAliases();

function importSpecifiers(source) {
  // Include exports/re-exports, dynamic import(), and CommonJS require() calls.
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function aliasCandidates(specifier) {
  const candidates = [specifier];
  for (const [pattern, values] of aliasConfig.entries) {
    const star = pattern.indexOf('*');
    if (star < 0 ? pattern !== specifier : !specifier.startsWith(pattern.slice(0, star))) continue;
    const suffix = star < 0 ? '' : specifier.slice(star ? pattern.slice(0, star).length : pattern.length);
    for (const value of values) {
      candidates.push(resolve(aliasConfig.baseDir, value.replace('*', suffix)));
    }
  }
  // These aliases are conventional in the backend and are also useful in
  // isolated fixtures where no tsconfig is present.
  for (const prefix of ['@/', '#/', '~/']) {
    if (specifier.startsWith(prefix)) candidates.push(specifier.slice(prefix.length));
  }
  if (specifier.startsWith('@src/')) candidates.push(specifier.slice('@src/'.length));
  return candidates;
}

function resolveLocalImport(source, specifier) {
  const candidates = aliasCandidates(specifier);
  for (const candidateSpecifier of candidates) {
    const isRelative = candidateSpecifier.startsWith('.');
    if (!isRelative) continue;
    const candidate = resolve(dirname(source), candidateSpecifier);
    const choices = extname(candidate) === '.js'
      ? [`${candidate.slice(0, -3)}.ts`, `${candidate.slice(0, -3)}.tsx`]
      : [candidate, `${candidate}.ts`, `${candidate}.tsx`, join(candidate, 'index.ts'), join(candidate, 'index.tsx')];
    const match = choices.find((choice) => knownFiles.has(choice));
    if (match) return match;
  }
  for (const candidateSpecifier of candidates) {
    if (candidateSpecifier.startsWith('.')) continue;
    const candidate = resolve(sourceRoot, candidateSpecifier);
    const choices = extname(candidate) === '.js'
      ? [`${candidate.slice(0, -3)}.ts`, `${candidate.slice(0, -3)}.tsx`]
      : [candidate, `${candidate}.ts`, `${candidate}.tsx`, join(candidate, 'index.ts'), join(candidate, 'index.tsx')];
    const match = choices.find((choice) => knownFiles.has(choice));
    if (match) return match;
  }
  return undefined;
}

function relativeParts(path) {
  const parts = relative(sourceRoot, path).split(/[\\/]/).filter(Boolean);
  // The production invocation scans `src` directly, while isolated checks may
  // pass the repository root. Treat `src` as the source-root prefix in either
  // layout so the same layer rules apply.
  return parts[0] === 'src' ? parts.slice(1) : parts;
}

function isIndexFile(part) {
  return /^index\.(?:ts|tsx|mts|cts)$/.test(part);
}

function stripSourceExtension(part) {
  return part.replace(/\.(?:ts|tsx|mts|cts)$/, '');
}

function isMcpApplicationService(layer) {
  return layer.kind === 'module'
    && layer.moduleName === 'mcp'
    && typeof layer.fileName === 'string'
    && layer.fileName.startsWith('application-');
}

function layerOf(path) {
  const parts = relativeParts(path);
  const fileName = stripSourceExtension(parts.at(-1) ?? '');
  const relativePath = parts.join('/');
  if (!parts.length) return { kind: 'root', key: 'root', publicFacade: true };
  if (parts.length === 1 && isIndexFile(parts[0])) return { kind: 'root', key: 'root', publicFacade: true };
  if (parts[0] === 'modules' && isIndexFile(parts[1] ?? '')) {
    return { kind: 'modules-root', key: 'modules-root', publicFacade: true, fileName, relativePath };
  }
  if (parts[0] === 'modules' && parts[1]) {
    const moduleName = stripSourceExtension(parts[1]);
    const layer = parts[2] && !isIndexFile(parts[2]) ? stripSourceExtension(parts[2]) : 'facade';
    const publicFacade = (parts.length === 2 && isIndexFile(parts[1])) || (parts.length === 3 && isIndexFile(parts[2]));
    return { kind: 'module', key: `module:${moduleName}:${layer}`, moduleName, layer, publicFacade, fileName, relativePath };
  }
  if (parts[0] === 'infrastructure' && parts[1] === 'colp') {
    return { kind: 'colp', key: 'colp', infrastructureName: 'colp', publicFacade: parts.length === 3 && isIndexFile(parts[2]), fileName, relativePath };
  }
  if (parts[0] === 'infrastructure') {
    const name = stripSourceExtension(parts[1] ?? 'shared');
    return { kind: 'infrastructure', key: `infrastructure:${name}`, infrastructureName: name, publicFacade: parts.length === 3 && isIndexFile(parts[2]), fileName, relativePath };
  }
  const kind = stripSourceExtension(parts[0]);
  return { kind, key: kind, publicFacade: parts.length === 1, fileName, relativePath };
}

const moduleEdges = {
  // Known-Command-Id idempotency: the identity avatar upload path consumes the
  // commands facade receipt port (same pattern as notifications/reading-progress).
  identity: new Set(['commands']),
  // A2 (Better Auth migration): the business-account mapping/ensure application
  // consumes ONLY the identity module facade (account/profile/handle domain
  // types + ports + handle reservation). Never a deep identity path.
  // Account-credential issuance/grants persist Product command receipts.
  auth: new Set(['identity', 'commands']),
  commands: new Set(),
  // Read-only browser subscriptions compose domain ports in infrastructure, never billing.
  'bookmark-subscriptions': new Set(['commands']),
  'access-policy': new Set(['identity', 'commands']),
  // P4A-I08: the upload-intent use case authorizes through the access-policy
  // facade (authorizeCapability + AccessPolicyFactsPort + ActorPrincipal).
  // No identity edge is needed: the trusted actor (principal/subject) is
  // resolved by the caller before the use case is invoked.
  attachments: new Set(['access-policy']),
  collections: new Set(['access-policy', 'identity', 'commands']),
  // CS-01: community vote commands reuse the durable command-receipt contract
  // exported by the commands facade (same port pattern as social).
  community: new Set(['commands']),
  publisher: new Set(['collections', 'access-policy', 'identity', 'commands']),
  // P4A-R06: publication/mcp/search may depend ONLY on the approved
  // eligibility gate symbols exported from the attachments facade. The edge is
  // symbol-gated below (CONSUMER_GATE_MODULES + I12_APPROVED_GATE_SYMBOLS) and
  // pinned by tests/unit/phase4a/phase4a-i12-architecture.test.ts — any non-approved
  // facade symbol from these modules is an import-boundary violation.
  // FIX-L-033 (SYNC-R17): sync holds NO attachments edge — the exposure gate
  // is mapped onto the minimal Sync AttachmentExposurePolicyPort by the
  // composition adapter (infrastructure/database + bootstrap) instead.
  // BF-04: Product public Collection pages JOIN live bookmark_icons through
  // the collections icon URL helper. Collections must not import publication.
  // COLP Server: publication/search/mcp read shared-exposure eligibility from
  // the exposure facade (deny-by-default until attachments ship).
  publication: new Set(['access-policy', 'identity', 'sync', 'attachments', 'collections', 'commands', 'exposure']),
  'reading-progress': new Set(['commands']),
  sync: new Set(['collections', 'identity']),
  search: new Set(['access-policy', 'commands', 'attachments', 'exposure']),
  social: new Set(['commands']),
  // Report read tools content-load the public/owned report surfaces the reports
  // facade exports; MCP reads reports through that facade only.
  // nodes.search reads through the search facade.
  mcp: new Set(['identity', 'publication', 'access-policy', 'commands', 'collections', 'attachments', 'community', 'reports', 'search', 'exposure']),
  notifications: new Set(['commands']),
  // ND-02 reports application reuses the shared command cursor codec and
  // publication-owned canonical slug predicate through the public facade.
  reports: new Set(['commands', 'publication']),
  governance: new Set(['commands', 'collections', 'reports', 'publication', 'access-policy']),
};
const infrastructureEdges = {
  // Transaction composition for browser projections and atomic follow exit.
  'bookmark-subscriptions': new Set(['database','collections','reports','identity','telemetry']),
  'access-policy': new Set(['database']),
  // F1 (legacy quarantine): infrastructure:auth is the single legacy OIDC
  // boundary surface. It may re-export ONLY from the legacy identity
  // infrastructure surface (JWKS client + OIDC transaction repositories);
  // everything else stays a leaf.
  // A2: business-account repositories/unit-of-work additionally consume the
  // identity repositories (accounts/profiles/handles bound to the same
  // transaction) and the database transaction surface (createUnitOfWork +
  // DatabaseSchema + error classification for the serialization/deadlock
  // retry loop).
  // Unbound-invite purge on email change / account delete walks the
  // collaboration store through the access-policy infrastructure surface.
  // CIMD metadata fetch uses the shared hardened egress (Node 22 lookup +
  // IPv4 pin). Stock @better-auth/cimd/node throws Invalid IP address: undefined.
  // DCR admission/reclaim counters (and the Better Auth runtime Metrics port)
  // record through the telemetry leaf surface — same pattern as
  // cache/email/outbox/sync/publisher/notifications.
  auth: new Set(['identity', 'database', 'access-policy', 'egress', 'telemetry', 'reports']),
  cache: new Set(['telemetry']),
  // Connection-only config is a dependency-free leaf shared by bootstrap and
  // maintenance database CLIs; it must never grow application feature edges.
  config: new Set(),
  // Classification envelope cryptography is a Node-builtins-only leaf.
  security: new Set(),
  // Transaction-bound collaboration command composition joins adapters owned
  // by several infrastructure surfaces. Keeping it in a leaf composition
  // surface prevents database <-> identity/access-policy directory cycles.
  collaboration: new Set(['access-policy', 'collections', 'database', 'identity', 'outbox']),
  collections: new Set(['publication', 'access-policy', 'database', 'outbox', 'telemetry', 'egress', 'governance', 'security']),
  // CS-01: community PostgreSQL adapters are transaction-bound database
  // consumers (unit-of-work, receipts, audit), same shape as social.
  // CS-02: the rank-refresh durable outbox producer composes the shared
  // outbox envelope/router surface, same pattern as infrastructure:social.
  // CS-01: the bookmark eligibility predicate shares the publication
  // surface's target-access ancestor-restriction fact (same edge shape as
  // reading-progress) — a private/protected/deleted ancestor folder
  // conceals the bookmark from every community read and write.
  // Official hide_public/delist/restrict compose through the same
  // governance SQL helpers publication and social already consume.
  community: new Set(['database', 'outbox', 'publication', 'governance']),
  colp: new Set(),
  database: new Set(['collections', 'outbox', 'publisher', 'sync', 'config']),
  email: new Set(['telemetry']),
  health: new Set(),
  // T-10: public HTML shell fetch + meta injection is a leaf (node fetch +
  // string replace). Composition injects publication/identity ports.
  http: new Set(),
  identity: new Set(['database', 'egress', 'access-policy', 'governance']),
  // FIX-M-019: the shared hardened egress surface is a leaf (node builtins +
  // the OIDC endpoint policy only); consumers such as identity/jwks-client
  // pin outbound fetches through it.
  egress: new Set(),
  // T09: the outbox cache purge pipeline rotates Redis epochs through the cache
  // infrastructure surface (CacheStore + epoch key codec).
  outbox: new Set(['cache', 'collections', 'database', 'egress', 'telemetry', 'governance']),
  // ND-13B: Publisher canonical mutations may consume the optional
  // transaction-bound report-source invalidation sink.
  publisher: new Set(['access-policy', 'collections', 'database', 'telemetry', 'outbox']),
  // FIX-L-024 (PUB-R17): the metadata/directory/snapshot caches record
  // low-cardinality corruption metrics through the telemetry leaf surface
  // (same pattern as outbox/sync/publisher/notifications).
  // T-20: collections sitemap list query uses T-10 `isSearchIndexableVisibility`.
  publication: new Set(['cache', 'database', 'telemetry', 'http', 'governance']),
  // SURF-04: the report unit of work binds the anonymous curator public-profile
  // read to its own open transaction (the infrastructure:identity reader) so the
  // public projection never re-enters the business pool while the report
  // transaction holds a connection. The read stays presentation-only.
  reports: new Set(['cache', 'publication', 'database', 'outbox', 'collections', 'governance', 'identity', 'bookmark-subscriptions']),
  governance: new Set(['database']),
  // PUB-R02: reading-progress/saved-resource adapters share the publication
  // surface's target-access ancestor-restriction fact.
  'reading-progress': new Set(['database', 'publication']),
  // P4A-RL03: the rate-limit adapter is a leaf infrastructure surface (ioredis
  // only); it is fully independent from the Publication cache layer.
  'rate-limit': new Set(),
  // ND-13B: Sync canonical writes consume the infrastructure outbox's
  // optional report-source invalidation sink. The sink is type-only at the
  // Sync boundary and remains transaction-bound; this explicit edge avoids
  // an implicit cross-surface import while preserving the one-way graph.
  sync: new Set(['collections', 'database', 'telemetry', 'outbox']),
  search: new Set(['database', 'governance']),
  // Seed data-management CLI/feature runs through the database surface
  // (runtime + unit-of-work); registered with the seed feature.
  // Wave 17 rebuilds the community ranking snapshot, so the seed feature also
  // consumes the community refresh adapter — the same shape as the Canonical
  // seed phase below.
  seed: new Set(['database', 'collections', 'community', 'outbox']),
  social: new Set(['database', 'outbox', 'governance', 'bookmark-subscriptions']),
  // MAIL-01: postgres email delivery worker wraps renderers via infrastructure/email.
  notifications: new Set(['database', 'outbox', 'telemetry', 'email', 'governance']),
  // Archive adapters consume durable manifest/job/source repositories only.
  'ledger-archive': new Set(['database']),
  // P4A-I06: the R2 generation-store adapter is a leaf (AWS SDK only, no local infra).
  'object-storage': new Set(),
  telemetry: new Set(),
};
// Module dependencies are intentionally enumerated by infrastructure surface
// and exact module layer. Infrastructure adapters currently consume module
// facades only; allowing a layer category here would let a new deep import
// bypass the public contract without a graph review.
const infrastructureModuleEdges = {
  'bookmark-subscriptions': new Set(['module:bookmark-subscriptions:facade','module:commands:facade','module:collections:facade','module:reports:facade']),
  'access-policy': new Set(['module:access-policy:facade']),
  // F1 (legacy quarantine): the legacy OIDC boundary may re-export only the
  // identity module facade (OIDC login transaction + account establishment
  // use cases); deep application paths stay forbidden.
  // A2: business-account repositories/unit-of-work additionally consume the
  // auth module facade (mapping ports + stable error classes).
  auth: new Set(['module:identity:facade', 'module:auth:facade', 'module:mcp:facade']),
  cache: new Set(['module:commands:facade']),
  collaboration: new Set(['module:access-policy:facade', 'module:identity:facade']),
  collections: new Set([
    'module:collections:facade',
    'module:commands:facade',
    // Account-owned credits are a transaction-bound port, injected by bootstrap.
    'module:identity:facade',
    // Collection policy_revision lock/bump implements the access-policy port.
    'module:access-policy:facade',
    // Canonical MCP owner reads of unpublished libraries (collections/nodes).
    'module:mcp:facade',
  ]),
  colp: new Set(),
  // CS-01: community adapters implement the module's target-query and
  // vote-command ports through the public facade only.
  // CS-03: the comment-author projection sanitizes stored avatar URLs with
  // the identity facade's safe-avatar predicate — never a parallel check.
  community: new Set(['module:community:facade', 'module:identity:facade']),
  // P4A-I07: database implements the transaction-bound attachments ledger ports.
  database: new Set([
    'module:bookmark-subscriptions:facade',
    'module:attachments:facade',
    'module:commands:facade',
    'module:mcp:facade',
    'module:exposure:facade',
  ]),
  // C1 (auth email): the auth email adapter implements the modules/auth email
  // port (facade-only, same port-implementation pattern as notifications).
  // SC-04: the invite email adapter implements the access-policy invite email
  // port (facade-only) without importing notifications from access-policy.
  // COLP Server: delivery/suppression ports live in modules/email.
  email: new Set(['module:notifications:facade', 'module:auth:facade', 'module:access-policy:facade', 'module:email:facade']),
  health: new Set(),
  http: new Set(),
  identity: new Set(['module:identity:facade']),
  // P4A-I09: the attachments verification envelope/route (producer +
  // consumer) import the attachments module facade (payload type + the
  // coordinator), matching how outbox already consumes module facades.
  outbox: new Set(['module:collections:facade', 'module:mcp:facade', 'module:attachments:facade', 'module:reports:facade']),
  reports: new Set(['module:reports:facade', 'module:collections:facade']),
  governance: new Set(['module:governance:facade']),
  publisher: new Set([
    'module:collections:facade',
    'module:commands:facade',
    'module:publisher:facade',
  ]),
  publication: new Set(['module:publication:facade']),
  'reading-progress': new Set(['module:reading-progress:facade']),
  // P4A-RL03: the rate-limit adapter consumes only the RL02 contract types
  // exported by the attachments module facade (never the cache surface).
  // FIX-M-018 / FIX-L-061: the MCP and email-callback limiter adapters consume
  // only contract types from the mcp/notifications module facades (same
  // port-implementation pattern, facade-only).
  // PI-02: the publishing-insights ingest limiter consumes InsightEventType
  // from the publication facade (family isolation; same port-implementation
  // pattern as mcp/notifications).
  'rate-limit': new Set([
    'module:attachments:facade',
    'module:email:facade',
    'module:mcp:facade',
    'module:notifications:facade',
    'module:publication:facade',
  ]),
  sync: new Set(['module:collections:facade', 'module:identity:facade', 'module:sync:facade']),
  // nodes.search ports are declared by the MCP facade.
  search: new Set(['module:search:facade', 'module:mcp:facade', 'module:exposure:facade']),
  // PERIPH-P1-b: seed Canonical 阶段经现有 annotation/relation 门面写写路径历史。
  // Wave 17 的社区排行种子阶段同形：经 community 门面重建排行快照。
  seed: new Set(['module:collections:facade', 'module:community:facade']),
  social: new Set(['module:social:facade']),
  notifications: new Set(['module:notifications:facade']),
  // P4A-I06: object-storage consumes no module; composition happens in bootstrap.
  // P4A-I09: `generation-object-store-adapter` implements the attachments module's
  // `GenerationObjectStorePort` (closed outcome unions over the throwing I06 surface).
  'object-storage': new Set(['module:attachments:facade']),
  telemetry: new Set(),
};
const colpPublicEntrypoints = new Set(['schema', 'types', 'semantic', 'client', 'server', 'publisher', 'sync', 'security', 'conformance', 'mcp']);

// These are public process entrypoint exports, not a root-to-layer wildcard.
// Keep this list aligned with the direct local imports in src/index.ts.
const rootEntryTargets = new Set([
  'bootstrap/config.ts',
  'bootstrap/composition.ts',
  'bootstrap/worker.ts',
  'transport/app.ts',
  'modules/index.ts',
  'infrastructure/database/index.ts',
  'infrastructure/outbox/index.ts',
]);

// Bootstrap composes the process from these concrete public surfaces. This
// deliberately includes the module aggregate only at its actual entrypoint.
const bootstrapTargets = new Set([
  'infrastructure/bookmark-subscriptions/unit-of-work.ts',
  'bootstrap/config-ledger-archive.ts',
  'bootstrap/config-ledger-archive-reader.ts',
  'bootstrap/ledger-archive-worker-composition.ts',
  'bootstrap/ledger-archive-reader-composition.ts',
  'bootstrap/attachments-object-storage-composition.ts',
  // FO-02: the worker shares the favicon R2 store composition with the API
  // (same bucket/prefix rule set; isolated FAVICON_R2_PREFIX).
  'bootstrap/favicon-object-storage-composition.ts',
  // Shared-favicon provider template + refresh cadence is a bootstrap config
  // leaf consumed by config-social, config-types, and the worker.
  'bootstrap/config-favicon-shared.ts',
  // LP-01: link preview flag, prefix and worker budget; a bootstrap config
  // leaf consumed by config, config-types, and the link preview composition.
  'bootstrap/config-link-preview.ts',
  // LP-03: worker-only link preview loop + store composition.
  'bootstrap/link-preview-worker-composition.ts',
  // Worker-owned shared-domain warmer and provider admission scheduler.
  'infrastructure/collections/favicon-shared-cache.ts',
  'infrastructure/collections/favicon-provider-scheduler.ts',
  // P4A-P05: the worker composition owns the attachments verification route,
  // the bounded cleanup scheduler and the backlog telemetry/alerts.
  'bootstrap/attachments-worker-composition.ts',
  // P4A-P08: the owner-private delivery composition owns the download
  // admission closure + the RO-only isolated host (shared capability secret).
  'bootstrap/attachments-delivery-composition.ts',
  // P4A-RL04: the API rate-limit composition owns the distributed admission
  // store + facade lifecycle (off creates zero clients; graceful close).
  'bootstrap/attachments-rate-limit-composition.ts',
  'bootstrap/cache-composition.ts',
  'infrastructure/reports/report-cache.ts',
  'bootstrap/composition.ts',
  'bootstrap/config.ts',
  'bootstrap/config-types.ts',
  'infrastructure/config/database-connection.ts',
  'bootstrap/config-parse-helpers.ts',
  // M-09: parses the two independent public-shell flags around one shell origin.
  'bootstrap/config-public-shell.ts',
  // Shared cache/limiter Redis role parsing is a bootstrap config leaf used
  // by the top-level config and the individual cache/limiter loaders.
  'bootstrap/config-redis-roles.ts',
  'bootstrap/config-http-security.ts',
  'bootstrap/config-cache.ts',
  'bootstrap/config-rate-limit.ts',
  'bootstrap/config-mcp.ts',
  'bootstrap/config-sync.ts',
  'bootstrap/config-auth.ts',
  'bootstrap/config-account-credentials.ts',
  'bootstrap/account-credential-grant-composition.ts',
  // Report credential composition captures source fences through module facades.
  'bootstrap/report-plan-source-revisions.ts',
  'bootstrap/config-publication.ts',
  'bootstrap/config-email.ts',
  'bootstrap/config-social.ts',
  'bootstrap/config-product.ts',
  'bootstrap/config-classification.ts',
  'bootstrap/config-capacity-summary.ts',
  'bootstrap/config-reports.ts',
  'bootstrap/config-governance.ts',
  'infrastructure/governance/index.ts',
  'modules/governance/index.ts',
  'transport/mcp/moderation-mcp-adapter.ts',
  'bootstrap/api-rate-limit-composition.ts',
  'bootstrap/api-account-services.ts',
  'bootstrap/api-attachments-composition.ts',
  'bootstrap/api-auth-mailbox.ts',
  'bootstrap/api-email-composition.ts',
  'bootstrap/api-lifecycle.ts',
  'bootstrap/api-mcp-oauth-composition.ts',
  'bootstrap/api-mcp-surface-composition.ts',
  'bootstrap/api-postgres-ports.ts',
  'bootstrap/api-postgres-product-cursors.ts',
  'bootstrap/mcp-write-postgres-ports.ts',
  // Report-issue content composition joins the MCP surface with the
  // publication snapshot reader for authorized issue bodies.
  'bootstrap/mcp-report-content-composition.ts',
  // M-09: worker-only composition for Profile URL publication purges.
  'bootstrap/publication-cache-purge-composition.ts',
  'bootstrap/sync-session-runtime.ts',
  // P4A-I11: the production delivery host composes the RO object store +
  // capability secret and registers the thin delivery transport route.
  'bootstrap/delivery.ts',
  'bootstrap/mcp-write-composition.ts',
  // COLP Server: the self-hosted entry derives env (preset) and then starts
  // the API process; file-precise so other bootstrap files stay unreachable.
  'bootstrap/self-hosted-preset.ts',
  'bootstrap/api.ts',
  // MCP-CQ-08: bootstrap wraps COLP adapters into protocol-neutral ports.
  'transport/mcp/mcp-strict-application-adapter.ts',
  'bootstrap/oidc-endpoint-policy.ts',
  'bootstrap/process-lifecycle.ts',
  'bootstrap/public-profile-projection.ts',
  // FIX-M-006/M-008: trusted-ingress allowlist parser is a bootstrap config
  // surface (same leaf role as oidc-endpoint-policy.ts).
  'bootstrap/trusted-ingress.ts',
  'bootstrap/worker.ts',
  // Report worker composition is a bootstrap-owned wiring seam split out of
  // worker.ts to keep the lifecycle file below the source-size ratchet.
  'bootstrap/reports-worker-composition.ts',
  // Worker-owned Redis/report cache lifecycle split out of worker.ts.
  'bootstrap/worker-cache-composition.ts',
  // Worker-only bounded inspection helper; keep this grant file-precise so
  // bootstrap-to-bootstrap imports do not become generally permitted.
  'bootstrap/worker-inspection-tick.ts',
  'bootstrap/worker-projection-composition.ts',
  'transport/app.ts',
  // P4A-I11: bootstrap/delivery.ts registers the thin delivery transport
  // route onto its own Fastify instance (separate origin).
  'transport/delivery-route.ts',
  // P4A-RL04: startApi composes the product attachment routes (P03+ port
  // closures) with the distributed admission facade.
  'transport/product/attachment-routes.ts',
  'transport/http-security.ts',
  'transport/product-burst-rate-limit.ts',
  'infrastructure/access-policy/index.ts',
  // F2: bootstrap composes the Better Auth infrastructure surfaces (runtime
  // bridge, browser session authority, business-account unit of work) and
  // the readiness probe composition seam.
  'infrastructure/auth/better-auth-runtime.ts',
  'infrastructure/auth/better-auth-session-authority.ts',
  'infrastructure/auth/better-auth-session-token-protection.ts',
  'infrastructure/auth/business-account-unit-of-work.ts',
  'infrastructure/auth/account-credentials-postgres.ts',
  'infrastructure/auth/account-credential-grants-postgres.ts',
  // COLP Server: Connect Agent key issuance, local issuer JWKS, and the
  // single-owner instance settings are composed by bootstrap only.
  'infrastructure/auth/agent-key-postgres.ts',
  'infrastructure/auth/local-issuer-jwks.ts',
  'infrastructure/auth/colp-instance-settings.ts',
  'infrastructure/health.ts',
  // T-10: API composition builds the public-shell cache from the http leaf.
  'infrastructure/http/index.ts',
  'transport/auth/oidc-provider.ts',
  'modules/index.ts',
  'modules/attachments/index.ts',
  // F2: bootstrap composes the Better Auth runtime/authority from the auth
  // module surfaces (typed config wrapper + security-epoch bridge facade).
  'modules/auth/better-auth-config.ts',
  'modules/auth/index.ts',
  'modules/collections/index.ts',
  'modules/email/index.ts',
  'modules/exposure/index.ts',
  'modules/identity/index.ts',
  'modules/notifications/index.ts',
  'modules/mcp/index.ts',
  // Composition wires the gateway planner that stamps the Phase4b digest.
  // That planner is not part of the read facade.
  'modules/mcp/change-plan-gateway-planner.ts',
  'modules/publication/index.ts',
  'modules/publisher/index.ts',
  'modules/reading-progress/index.ts',
  'modules/search/index.ts',
  'modules/social/index.ts',
  // CS-02: worker composition consumes the community facade's refresh
  // cadence constant (same facade pattern as modules/social).
  'modules/community/index.ts',
  'modules/reports/index.ts',
  'modules/governance/index.ts',
  'infrastructure/cache/index.ts',
  'infrastructure/collaboration/index.ts',
  'infrastructure/collections/index.ts',
  // CS-01: API composition wires the community target/vote PostgreSQL ports.
  'infrastructure/community/index.ts',
  'infrastructure/database/index.ts',
  'infrastructure/database/ledger-archive-export-job-repository.ts',
  'infrastructure/database/ledger-archive-segment-repository.ts',
  'infrastructure/ledger-archive/index.ts',
  // F2: composition.ts consumes the type-only DatabaseSchema binding for the
  // Better Auth Kysely adapter (file-precise grant, same pattern as the
  // transport runtime.ts grant).
  'infrastructure/database/runtime.ts',
  'infrastructure/email/index.ts',
  'infrastructure/identity/index.ts',
  'infrastructure/notifications/index.ts',
  'infrastructure/object-storage/index.ts',
  'infrastructure/outbox/index.ts',
  'infrastructure/publication/index.ts',
  'infrastructure/publisher/index.ts',
  'infrastructure/reading-progress/index.ts',
  'infrastructure/reports/index.ts',
  'infrastructure/governance/index.ts',
  // P4A-RL04: the rate-limit adapter surface (leaf; independent of cache).
  'infrastructure/rate-limit/index.ts',
  'infrastructure/search/index.ts',
  'infrastructure/social/index.ts',
  'infrastructure/sync/index.ts',
  'infrastructure/telemetry/index.ts',
  // Sync session runtime and the worker compose the shared hardened egress
  // port (FIX-M-019) the same way they compose cache/database facades.
  'infrastructure/egress/index.ts',
  'modules/access-policy/index.ts',
  // Phase 3 claim-gate evidence validators live in modules/sync; bootstrap
  // re-exports them so scripts/tests keep their existing import paths.
  'modules/sync/phase3-server-sync-acceptance-evidence.ts',
  'modules/sync/phase3-authoritative-pull-acceptance-evidence.ts',
]);

// Transport imports only these current application and adapter surfaces. The
// layer graph remains explicit without granting every transport file access to
// every bootstrap, infrastructure, or COLP path.
const transportTargets = new Set([
  'modules/bookmark-subscriptions/index.ts',
  'transport/product/bookmark-subscription-routes.ts',
  'transport/product/subscription-exit-header.ts',
  'transport/product/report-reader-routes.ts',
  'bootstrap/config.ts',
  'transport/app.ts',
  'transport/app-dependencies.ts',
  'infrastructure/reports/report-cache.ts',
  'transport/app-error-mapping.ts',
  'transport/app-register-ready.ts',
  // Readiness response shaping is transport-internal and dependency-free.
  'transport/limiter-readiness.ts',
  'transport/app-test-oidc.ts',
  'transport/mutation-actor.ts',
  'transport/register-product-surfaces.ts',
  'transport/register-account-product-surfaces.ts',
  // Report surface registration is a transport composition seam extracted
  // from register-product-surfaces.ts to keep that hot file below the
  // source-size ratchet; it imports only allowlisted route/config ports.
  'transport/register-reports-surfaces.ts',
  'transport/register-governance-surfaces.ts',
  'transport/colp-sync/register-colp-sync.ts',
  'transport/mcp/register-mcp.ts',
  // FIX-M-008: the Sync transport security guard composes the trusted-ingress
  // allowlist matcher from the bootstrap config surface (policy-consumer
  // pattern, same as bootstrap/config.ts above).
  'bootstrap/trusted-ingress.ts',
  'modules/attachments/index.ts',
  // A3: transport session admission consumes the BrowserSessionAuthority port
  // (modules/auth facade) for the Better Auth cutover path.
  'modules/auth/index.ts',
  'modules/access-policy/index.ts',
  'modules/collections/index.ts',
  'modules/commands/index.ts',
  // CS-01: community target resolution + vote command application facade.
  'modules/community/index.ts',
  'modules/email/index.ts',
  'modules/identity/index.ts',
  'modules/mcp/index.ts',
  'modules/notifications/index.ts',
  'modules/publication/index.ts',
  'modules/sync/index.ts',
  'modules/reading-progress/index.ts',
  'modules/search/index.ts',
  'modules/social/index.ts',
  'modules/reports/index.ts',
  'modules/governance/index.ts',
  'infrastructure/database/errors.ts',
  // Type-only DatabaseSchema for read-only route DB handles (Explore etc.);
  // file-precise grant like errors.ts, never the runtime factory.
  'infrastructure/database/runtime.ts',
  'infrastructure/health.ts',
  // T-10: public HTML shell injection + internal web-origin fetch.
  'infrastructure/http/index.ts',
  // Public-shell ETag compare. File-precise so the rest of public-shell stays closed.
  'infrastructure/http/public-shell/html-validator.ts',
  // Snapshot conflict routes type the open-conflict page. Not the sync barrel.
  'infrastructure/sync/sync-snapshot-conflict-recovery.ts',
  // FIX-L-015 (PUB-R08): the publication routes classify cache aborts
  // (CacheAbortError) to distinguish client-disconnect cancellation from real
  // cache failures before replying (never fakes a 5xx). Same error-surface
  // pattern as infrastructure/database/errors.ts above.
  'infrastructure/cache/index.ts',
  'infrastructure/identity/index.ts',
  // FIX-M-001: the auth rate-limit PORT + Redis adapter live in the rate-limit
  // leaf surface (leaf = ioredis only, business-key independent); transport
  // consumes the port types and installHttpSecurity injects the shared
  // adapter. Deliberate edge: the auth limiter must NOT couple to the
  // Attachment module facade (business-key isolation).
  'infrastructure/rate-limit/index.ts',
  'infrastructure/telemetry/index.ts',
  // OIDC provider fetches JWKS through the shared hardened egress port.
  'infrastructure/egress/index.ts',
  'transport/product/annotation-routes.ts',
  // Extension annotation commands bind the browser session before the write.
  'transport/product/annotation-session-binding.ts',
  'transport/product/attachment-error.ts',
  'transport/product-burst-rate-limit.ts',
  'transport/product/credit-error.ts',
  'transport/product/credit-ledger-routes.ts',
  'transport/product/credit-ledger-time.ts',
  'transport/product/attachment-routes.ts',
  // Task A4: the single auth-route manifest + the Better Auth transport
  // contract are transport-internal surfaces (same pattern as
  // browser-auth-routes.ts / http-security.ts).
  'transport/auth/auth-route-manifest.ts',
  'transport/auth/account-credential-auth-manifest.ts',
  'transport/auth/account-credential-jwks.ts',
  'transport/auth/account-credential-parent-key-routes.ts',
  'transport/auth/account-credential-token-routes.ts',
  'transport/auth/better-auth-routes.ts',
  'infrastructure/auth/account-credentials-postgres.ts',
  'transport/product-actor.ts',
  'transport/product/account-credential-routes.ts',
  'transport/product/account-credential-grant-routes.ts',
  'transport/product/account-credential-identity-routes.ts',
  'transport/product/register-account-credential-surfaces.ts',
  // T-05 / ADR D6: issuer-inserted AS metadata well-known forward.
  'transport/auth/oauth-authorization-server-routes.ts',
  'transport/product/bookmark-favicon-routes.ts',
  'transport/product/link-preview-routes.ts',
  'transport/product/link-preview-command-routes.ts',
  // R15-13: client-event beacon registered from the product surface seam.
  'transport/product/client-event-routes.ts',
  'transport/auth/browser-auth-deps.ts',
  'transport/auth/browser-auth-handlers.ts',
  'transport/auth/browser-auth-mapping.ts',
  'transport/auth/browser-auth-oidc.ts',
  'transport/auth/browser-auth-routes.ts',
  'transport/product/collection-resource-routes.ts',
  'transport/product/collection-route-helpers.ts',
  'transport/product/collection-routes.ts',
  'transport/product/capture-routes.ts',
  'transport/product/capture-history-routes.ts',
  'transport/product/capture-learning-routes.ts',
  'transport/product/catalog-routes.ts',
  'transport/product/catalog-preferences-routes.ts',
  'transport/product/moderation-routes.ts',
  'transport/product/moderation-action-routes.ts',
  'transport/product/moderation-appeal-routes.ts',
  'transport/mcp/moderation-mcp-adapter.ts',
  'transport/mcp/moderation-mcp-appeals.ts',
  // P4A-I11: the delivery transport route is the thin wiring consumed by
  // bootstrap/delivery.ts (it imports only module facades).
  'transport/delivery-route.ts',
  'transport/product/editor-routes.ts',
  'transport/product/email-callback-routes.ts',
  'transport/product/email-ops-routes.ts',
  'transport/product/explore-routes.ts',
  // Preference filtering for the explore page stays beside the route registrar.
  'transport/product/explore-preference-page.ts',
  'transport/product/favicon-policy-routes.ts',
  // Transport-internal request-cancellation helper extracted from the favicon
  // policy routes so helper/children surfaces can share the same 503 mapping.
  'transport/product/request-timeout.ts',
  // FO-03: durable favicon job routes share the same product composition seam.
  'transport/product/favicon-job-routes.ts',
  // FO-05: the one-layer children reader is registered from the same product
  // composition seam as the favicon policy/source routes.
  'transport/product/collection-children-routes.ts',
  'transport/product/explore-directory-rate-limit.ts',
  'transport/colp-sync/extension-collection-routes.ts',
  // FO-04: the colp-sync favicon helper surface (Product-envelope helpers)
  // is registered by the same colp-sync composition seam.
  'transport/colp-sync/sync-favicon-helper-routes.ts',
  'transport/product/feed-routes.ts',
  'transport/product/follow-routes.ts',
  'transport/product/collection-follow-routes.ts',
  // CS-01: community target/vote product routes registered by
  // register-product-surfaces (transport-internal composition seam).
  'transport/product/community-routes.ts',
  // CS-03: community comment product routes registered by
  // register-community-surfaces (same transport-internal seam).
  'transport/product/community-comment-routes.ts',
  // CS-05: community notification product routes registered by
  // register-community-surfaces (same transport-internal seam).
  'transport/product/community-notification-routes.ts',
  // CS-01: community surface registration seam extracted from
  // register-product-surfaces.ts (same pattern as register-reports-surfaces).
  'transport/register-community-surfaces.ts',
  'transport/product/library-order-routes.ts',
  'transport/product/bookmark-preferences-routes.ts',
  'transport/product/link-health-routes.ts',
  'transport/product/classify-inbox-routes.ts',
  'transport/product/classification-settings-routes.ts',
  'transport/product/classification-preview-routes.ts',
  'transport/product/classification-run-routes.ts',
  'transport/product/classification-profile-routes.ts',
  'transport/product/classification-confirmation-routes.ts',
  'transport/register-classification-surfaces.ts',
  'transport/classification-extension-cors.ts',
  'transport/extension-product-origins.ts',
  'transport/product-rate-limit-assertion.ts',
  'transport/product/export-job-routes.ts',
  // COLP Server: Netscape/JSON collection export (E5).
  'transport/product/collection-export-routes.ts',
  'transport/product/organize-plan-routes.ts',
  'transport/product/collection-version-routes.ts',
  'transport/product/readable-replica-routes.ts',
  'transport/product/notification-routes.ts',
  'transport/http-command-scope.ts',
  'transport/http-security.ts',
  'transport/product/public-object-rate-limit.ts',
  'transport/product/insight-cookie.ts',
  'transport/mcp/mcp-protected-resource-routes.ts',
  'transport/mcp/mcp-read-routes.ts',
  'transport/mcp/mcp-compat-routes.ts',
  'transport/mcp/mcp-compat-handler.ts',
  'transport/mcp/mcp-compat-execution-observer.ts',
  'transport/mcp/mcp-compat-read-adapter.ts',
  'transport/mcp/mcp-compat-write-adapter.ts',
  'transport/mcp/mcp-compat-admission.ts',
  'transport/mcp/mcp-compat-authinfo.ts',
  'transport/mcp/mcp-shared-admission.ts',
  // Quota identity is the registered MCP route, not a client-supplied host.
  'transport/mcp/mcp-endpoint-audience.ts',
  'transport/mcp/mcp-strict-application-adapter.ts',
  'transport/mcp/mcp-well-known-routes.ts',
  'transport/mcp/mcp-write-approval-routes.ts',
  'transport/mcp/agent-routes.ts',
  'transport/product/node-routes.ts',
  'transport/product/owned-collection-routes.ts',
  'transport/auth/oidc-provider.ts',
  'transport/auth/origin-csrf.ts',
  'transport/product-admission.ts',
  'transport/product-command-mapping.ts',
  'transport/product-codes.ts',
  'transport/product-error.ts',
  'transport/product/relation-routes.ts',
  'transport/product/reading-progress-routes.ts',
  'transport/product/report-routes.ts',
  'transport/product/report-route-contract.ts',
  'transport/product/report-route-helpers.ts',
  'transport/product/report-private-routes.ts',
  'transport/product/report-private-primary-routes.ts',
  'transport/product/report-private-secondary-routes.ts',
  'transport/product/report-public-json-routes.ts',
  // ND-09 public report shell is composed by the report transport facade.
  'transport/product/report-public-shell-routes.ts',
  'transport/product/saved-resource-routes.ts',
  'transport/product/search-catalog-mute.ts',
  'transport/product/search-routes.ts',
  'transport/product-route-manifest.ts',
  'transport/product/publication-directory-routes.ts',
  'transport/product/publication-manifest-routes.ts',
  'transport/product/publication-metadata-routes.ts',
  'transport/public-shell-routes.ts',
  // M-09: canonical public Profile shell and legacy redirect wiring.
  'transport/public-profile-shell-routes.ts',
  // B1: origin-injected /explore discovery hub.
  'transport/public-explore-shell-routes.ts',
  // Per-Collection Open Graph card route: a public-shell sibling registered by
  // register-product-surfaces.ts. Its absence from this allowlist made
  // `check-import-boundaries` exit 1 on the whole tree.
  'transport/public-og-image-routes.ts',
  'transport/collections-sitemap-routes.ts',
  // FIX-L-015 (PUB-R08): transport-internal request-cancellation helper for
  // the publication read routes (request abort -> cache reader -> PG query).
  'transport/product/publication-request-cancel.ts',
  'transport/product/publication-read-negotiation.ts',
  'transport/product/publication-snapshot-routes.ts',
  'transport/product/product-public-collection-routes.ts',
  'transport/product/product-public-insight-routes.ts',
  'transport/product/product-public-profile-routes.ts',
  'transport/product/product-public-activity-routes.ts',
  'transport/product/public-activity-rate-limit.ts',
  'transport/product/product-publishing-insights-routes.ts',
  'transport/product/product-collaboration-routes.ts',
  'transport/product/product-sync-center-routes.ts',
  'transport/product/product-sync-trash-routes.ts',
  // The trash route registrar composes the batch/subtree restore and empty routes.
  'transport/product/product-sync-trash-batch-routes.ts',
  'transport/product/shared-collection-routes.ts',
  'transport/session-auth.ts',
  // FIX-M-008: shared Sync TLS/trusted-ingress guard consumed by every Sync route.
  'transport/colp-sync/sync-transport-security.ts',
  'transport/colp-sync/sync-colp-authorization.ts',
  'transport/colp-sync/sync-session-routes.ts',
  'transport/colp-sync/sync-conflict-routes.ts',
  'transport/colp-sync/sync-push-routes.ts',
  'transport/colp-sync/sync-pull-routes.ts',
  'transport/colp-sync/sync-effect-page-routes.ts',
  'transport/colp-sync/sync-ack-routes.ts',
  'transport/colp-sync/sync-retire-routes.ts',
  'transport/colp-sync/sync-snapshot-routes.ts',
  'transport/colp-sync/sync-snapshot-conflict-routes.ts',
  'transport/session-cookie.ts',
]);

// COLP Server operator CLI (`colp-server migrate|create-user|export|...`).
// It is a process entrypoint like bootstrap, so it reaches composition and
// a few public facades, never deep module paths.
const cliTargets = new Set([
  'bootstrap/self-hosted-preset.ts',
  'bootstrap/self-hosted.ts',
  'bootstrap/config.ts',
  'bootstrap/composition.ts',
  'bootstrap/process-lifecycle.ts',
  'infrastructure/database/index.ts',
  'infrastructure/collections/index.ts',
  'infrastructure/telemetry/index.ts',
  'infrastructure/auth/better-auth-runtime.ts',
  'infrastructure/auth/colp-instance-settings.ts',
  'modules/auth/index.ts',
  'modules/collections/index.ts',
]);

function allowed(source, target) {
  if (source.kind === 'root') return rootEntryTargets.has(target.relativePath);
  // src/version.ts is generated and import-free (package/protocol versions).
  if (target.kind === 'version' && target.relativePath === 'version.ts') return true;
  if (source.kind === 'cli') return target.kind === 'cli' || cliTargets.has(target.relativePath);
  // Promise observation is a dependency-free runtime primitive shared by the
  // composition, transport, and adapter layers. Domain modules stay isolated,
  // and infrastructure:async itself remains a leaf under the normal graph.
  if (
    target.kind === 'infrastructure'
    && target.infrastructureName === 'async'
    && ['bootstrap', 'transport', 'infrastructure'].includes(source.kind)
  ) return true;
  if (source.kind === 'bootstrap') return bootstrapTargets.has(target.relativePath);
  if (source.kind === 'transport') return transportTargets.has(target.relativePath);
  if (source.key === target.key) return true;
  if (source.kind === 'modules-root') return target.kind === 'modules-root' || (target.kind === 'module' && target.publicFacade);
  if (source.kind === 'module') {
    // FIX-M-019: MCP config validates static OAuth/JWKS URLs at startup with
    // the shared strict OIDC endpoint policy (deliberate policy-consumer
    // edge; modules/sync no longer needs a bootstrap carve-out).
    if (source.relativePath === 'modules/mcp/config.ts'
        && target.kind === 'bootstrap'
        && target.relativePath === 'bootstrap/oidc-endpoint-policy.ts') return true;
    if (target.kind === 'module') {
      if (target.moduleName === source.moduleName) {
        if (source.layer === 'domain' && target.layer !== 'domain') return false;
        return true;
      }
      return target.publicFacade && (moduleEdges[source.moduleName]?.has(target.moduleName) ?? false);
    }
    return false;
  }
  if (source.kind === 'infrastructure' || source.kind === 'colp') {
    // The migration CLI is the one intentional composition entrypoint under
    // infrastructure that loads environment config before constructing the DB.
    // Keep this exception exact so ordinary infrastructure cannot reach
    // bootstrap configuration.
    if (
      source.kind === 'infrastructure'
      && source.infrastructureName === 'database'
      && source.relativePath === 'infrastructure/database/migrate.ts'
      && target.kind === 'bootstrap'
      && target.relativePath === 'bootstrap/config.ts'
    ) return true;
    // The seed CLI is isomorphic with the migration CLI (loads environment
    // config before constructing the DB); keep the exception equally exact.
    if (
      source.kind === 'infrastructure'
      && source.infrastructureName === 'seed'
      && source.relativePath === 'infrastructure/seed/run.ts'
      && target.kind === 'bootstrap'
      && target.relativePath === 'bootstrap/config.ts'
    ) return true;
    // FIX-M-019: the shared hardened egress surface reuses the startup OIDC
    // endpoint policy (assertOidcEndpointUrl strict) on every hop; deliberate
    // policy-consumer edge, same pattern as migrate.ts -> bootstrap/config.ts.
    if (
      source.kind === 'infrastructure'
      && source.infrastructureName === 'egress'
      && source.relativePath === 'infrastructure/egress/hardened-egress.ts'
      && target.kind === 'bootstrap'
      && target.relativePath === 'bootstrap/oidc-endpoint-policy.ts'
    ) return true;
    // F1 (legacy quarantine): the legacy OIDC boundary is the single
    // controlled re-export exit for the deprecated OIDC/Logto provider
    // (transport/auth/oidc-provider.ts). Deliberate file-precise consumer edge,
    // same pattern as migrate.ts -> bootstrap/config.ts.
    if (
      source.kind === 'infrastructure'
      && source.infrastructureName === 'auth'
      && source.relativePath === 'infrastructure/auth/legacy-oidc-boundary.ts'
      && target.kind === 'transport'
      && target.relativePath === 'transport/auth/oidc-provider.ts'
    ) return true;
    // Edition public read embeds the community discovery predicate. Grant this
    // SQL helper only; do not open infrastructure:community to reports.
    if (
      source.kind === 'infrastructure'
      && source.relativePath === 'infrastructure/reports/report-edition-public-read.ts'
      && target.relativePath === 'infrastructure/community/community-target-shared-postgres.ts'
    ) return true;
    // CANON-P0-b: facts/header adapters read locator columns through the
    // collections-owned leaf. Do not grant the collections barrel (cycle).
    if (
      source.kind === 'infrastructure'
      && source.infrastructureName === 'access-policy'
      && (source.relativePath === 'infrastructure/access-policy/repositories.ts'
        || source.relativePath === 'infrastructure/access-policy/collaboration-query.ts')
      && target.kind === 'infrastructure'
      && target.infrastructureName === 'collections'
      && target.relativePath === 'infrastructure/collections/collection-header-read.ts'
    ) return true;
    if (target.kind === 'module') {
      return infrastructureModuleEdges[source.infrastructureName ?? '']?.has(target.key) ?? false;
    }
    if (target.kind === 'colp') return source.infrastructureName === 'colp';
    return infrastructureEdges[source.infrastructureName ?? '']?.has(target.infrastructureName ?? '') ?? false;
  }
  return false;
}

const violations = [];

/**
 * P4A-R06: the ONLY attachments facade symbols a consumer module may import.
 * Keep in sync with `I12_APPROVED_GATE_SYMBOLS` in
 * `scripts/evidence/phase4a-i12-architecture.ts` (pinned by
 * tests/unit/phase4a/phase4a-i12-architecture.test.ts).
 */
const I12_APPROVED_GATE_SYMBOLS = new Set([
  'assessSharedExposureEligibility',
  'assertSharedExposureIneligible',
  'assessSharedExposureScope',
  'assertSharedExposureScopeIneligible',
  'SharedExposureBlobFacts',
  'SharedExposureEligibility',
  'IneligibleSharedExposure',
  'SharedExposureFactsPort',
  'SharedExposureFactsScope',
  'SharedExposureProjectionKind',
  'SharedExposureIneligibilityReason',
  'OWNER_PRIVATE_EXPOSURE_MODE',
  'SHARED_EXPOSURE_PROJECTION_KINDS',
  'SHARED_EXPOSURE_INELIGIBILITY_REASONS',
]);

/** Consumer modules whose attachments edge is limited to the approved gate symbols. */
const CONSUMER_GATE_MODULES = new Set(['publication', 'mcp', 'search']);

/**
 * FIX-L-002: the legacy collection write surface (non-canonical create
 * bootstrap and the payload-less metadata update adapter) is removed from the
 * public facade. Transport/composition must consume only the canonical
 * bootstrap/update ports; any import of these symbols from a collections path
 * is an import-boundary violation.
 */
const LEGACY_COLLECTION_WRITE_SYMBOLS = new Set([
  'createOwnedCollection',
  'toUpdateCollectionMetadataPorts',
  'updateCollectionMetadata',
  'CreateOwnedCollectionPorts',
  'UpdateCollectionMetadataPorts',
]);

/** Named symbols a file imports/reexports from a given facade specifier. */
function facadeNamedSymbols(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `(?:import|export)\\s+(?:type\\s+)?\\{([^}]+)\\}\\s+from\\s+['\"]${escaped}['\"]`,
    'gu',
  );
  const symbols = [];
  for (const match of source.matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const bare = trimmed.split(/\s+as\s+/u)[0].trim();
      symbols.push(bare.startsWith('type ') ? bare.slice('type '.length).trim() : bare);
    }
  }
  return symbols;
}

for (const file of files) {
  const sourceLayer = layerOf(file);
  const sourceText = readFileSync(file, 'utf8');
  const imports = importSpecifiers(sourceText);
  for (const specifier of imports) {
    if (sourceLayer.kind === 'module' && /^(?:fastify|kysely|pg)(?:$|\/)/.test(specifier)) {
      violations.push(`${relative(sourceRoot, file)} imports framework/database package ${specifier}`);
    }
    // MCP-CQ-08: protocol-neutral application services must not import Fastify,
    // the official MCP SDK, or COLP MCP wire types.
    if (
      isMcpApplicationService(sourceLayer)
      && /^(?:fastify(?:$|\/)|@modelcontextprotocol\/(?:server|sdk)(?:$|\/)|@know-n\/colp\/mcp(?:$|\/))/.test(specifier)
    ) {
      violations.push(`${relative(sourceRoot, file)} application service imports wire package ${specifier}`);
    }
    // ORG-P0-a: Explore SQL left transport; transport must not value-import kysely.
    if (sourceLayer.kind === 'transport' && /^(?:kysely)(?:$|\/)/.test(specifier)) {
      violations.push(`${relative(sourceRoot, file)} imports kysely from transport`);
    }
    if (specifier === '@know-n/colp') {
      violations.push(`${relative(sourceRoot, file)} imports the metadata-only COLP package root`);
    } else if (specifier.startsWith('@know-n/colp/')) {
      if (specifier === '@know-n/colp/sync/unsafe' || specifier.includes('/sync/unsafe')) {
        violations.push(`${relative(sourceRoot, file)} imports COLP unsafe Sync coordinators (${specifier})`);
      }
      const entrypoint = specifier.slice('@know-n/colp/'.length).split('/')[0];
      if (!colpPublicEntrypoints.has(entrypoint)) {
        violations.push(`${relative(sourceRoot, file)} imports non-public COLP entrypoint ${specifier}`);
      }
    }
    const target = resolveLocalImport(file, specifier);
    if (!target) continue;
    const targetLayer = layerOf(target);
    // FIX-L-002: legacy collection write symbols must not be imported from any
    // collections path (facade or deep). Pins the removed write ports so a
    // future re-export or direct import trips the boundary for transport and
    // composition alike.
    if (targetLayer.kind === 'module' && targetLayer.moduleName === 'collections') {
      const symbols = facadeNamedSymbols(sourceText, specifier);
      const legacy = symbols.filter((symbol) => LEGACY_COLLECTION_WRITE_SYMBOLS.has(symbol));
      if (legacy.length > 0) {
        violations.push(`${relative(sourceRoot, file)} imports legacy collection write symbol(s) (${legacy.join(', ')})`);
        continue;
      }
    }
    // P4A-R06: symbol-gate the consumer attachments facade edge. A consumer
    // module may import ONLY the approved eligibility-port symbols; any other
    // attachments facade symbol (repository/body/owner surfaces) is a bypass
    // and fails the boundary even though the module-level edge exists.
    if (
      sourceLayer.kind === 'module'
      && CONSUMER_GATE_MODULES.has(sourceLayer.moduleName)
      && targetLayer.kind === 'module'
      && targetLayer.moduleName === 'attachments'
      && targetLayer.layer === 'facade'
    ) {
      const symbols = facadeNamedSymbols(sourceText, specifier);
      if (symbols.length === 0 || symbols.some((symbol) => !I12_APPROVED_GATE_SYMBOLS.has(symbol))) {
        violations.push(`${relative(sourceRoot, file)} imports non-approved attachments facade symbol(s) (${symbols.join(', ') || 'none'})`);
        continue;
      }
    }
    if (sourceLayer.kind === 'module' && targetLayer.kind === 'module' && targetLayer.moduleName !== sourceLayer.moduleName && !targetLayer.publicFacade) {
      violations.push(`${relative(sourceRoot, file)} imports non-public module path ${relative(sourceRoot, target)}`);
      continue;
    }
    if (!allowed(sourceLayer, targetLayer)) {
      violations.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)} violates dependency graph (${sourceLayer.key} -> ${targetLayer.key})`);
    }
  }
}

// A module facade is itself part of the graph: re-exporting an infrastructure
// implementation from a public index would smuggle a forbidden edge past the
// direct import check, so its own edge is checked above as well.

// FIX-L-002: pin the collections facades themselves — the legacy write symbols
// must never be re-exported, even while currently unused.
for (const facadeFile of ['modules/collections/index.ts', 'modules/collections/application/index.ts']) {
  const facadePath = resolve(sourceRoot, facadeFile);
  if (!knownFiles.has(facadePath)) continue;
  const facadeText = readFileSync(facadePath, 'utf8');
  for (const symbol of LEGACY_COLLECTION_WRITE_SYMBOLS) {
    if (new RegExp(`\\b${symbol}\\b`, 'u').test(facadeText)) {
      violations.push(`${facadeFile} re-exports or references legacy collection write symbol ${symbol}`);
    }
  }
}

if (violations.length) {
  console.error(`import boundary violations:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exit(1);
}
console.log('import boundaries: ok');
