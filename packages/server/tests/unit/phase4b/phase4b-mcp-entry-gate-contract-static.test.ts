import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SDK_CORE_VERSION,
  MCP_SDK_PROTOCOL_VERSION,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_END_DATE_LABEL,
  PHASE4B_MCP_ENDPOINT_PATH,
  PHASE4B_MCP_EVIDENCE_SCHEMA_VERSION,
  PHASE4B_MCP_HARD_LIMITS,
  PHASE4B_MCP_LEGACY_REJECTION,
  PHASE4B_MCP_PROTOCOL_VERSION,
  PHASE4B_MCP_REPLAY_SCHEMA_VERSION,
  PHASE4B_MCP_RESOURCE_BODY,
  PHASE4B_MCP_RESOURCE_URI,
  PHASE4B_MCP_SDK_LOCK,
  PHASE4B_MCP_SERVER_INFO,
  buildPhase4bModernEnvelope,
  computeMcpEntryReplayDigest,
  findPhase4bLegacySessionHeader,
} from '../../../scripts/evidence/phase4b-mcp-entry-contract.js';

interface ReplayScenario {
  readonly id: string;
  readonly [field: string]: unknown;
}

interface ReplayManifest {
  readonly schemaVersion: string;
  readonly frozen: Record<string, unknown>;
  readonly fixedInputs: Record<string, unknown>;
  readonly sdkLock: Record<string, unknown>;
  readonly scenarios: readonly ReplayScenario[];
  readonly negativeControls: readonly string[];
  readonly recordedOutcomes: { readonly digestAlgorithm: string; readonly digest: string };
}

const backendRoot = resolve(import.meta.dirname, '../../..');
const replayManifestPath = resolve(backendRoot,
  'tests/fixtures/phase4b-mcp-entry/mcp-entry-gate.replay.v1.json');
const packageJsonPath = resolve(backendRoot, 'package.json');
const packageLockPath = resolve(backendRoot, 'package-lock.json');
const colpPackagePath = resolve(backendRoot, 'node_modules/@know-n/colp/package.json');
const evidenceSourceRoot = resolve(backendRoot, 'scripts/evidence');

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(path);
    return [path];
  });
}

function loadReplayManifest(): ReplayManifest {
  return JSON.parse(readFileSync(replayManifestPath, 'utf8')) as ReplayManifest;
}

describe('P4B-R01 decision and replay boundary are frozen on disk', () => {
  // Know-N's evidence document docs/evidence/phase4b-mcp-entry-gate-2026-08-04.md
  // is not shipped here (tests/EXTRACTION.md); the frozen constants below and
  // the replay manifest are the in-package decision record.

  test('the protocol version is a fixed constant, not a configurable option', () => {
    assert.equal(PHASE4B_MCP_PROTOCOL_VERSION, '2026-07-28');
    assert.equal(PHASE4B_MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION,
      'Known-Backend must not pick a second protocol version (COLP MCP_PROTOCOL_VERSION is authoritative)');
    assert.equal(PHASE4B_MCP_PROTOCOL_VERSION, MCP_SDK_PROTOCOL_VERSION,
      'harness protocol constant must match COLP MCP_SDK_PROTOCOL_VERSION');
    assert.equal(PHASE4B_MCP_SDK_LOCK.core, MCP_SDK_CORE_VERSION,
      'harness SDK lock must match COLP MCP_SDK_CORE_VERSION');
    assert.equal(PHASE4B_MCP_SDK_LOCK.core, '2.3.1');
  });

  test('frozen topology constants match the replay manifest', () => {
    const manifest = loadReplayManifest();
    assert.equal(manifest.schemaVersion, PHASE4B_MCP_REPLAY_SCHEMA_VERSION);
    assert.equal(manifest.frozen.endpointPath, PHASE4B_MCP_ENDPOINT_PATH);
    assert.equal(manifest.frozen.protocolVersion, PHASE4B_MCP_PROTOCOL_VERSION);
    assert.deepEqual(manifest.frozen.serverInfo, PHASE4B_MCP_SERVER_INFO);
    assert.equal(manifest.frozen.resourceUri, PHASE4B_MCP_RESOURCE_URI);
    assert.equal(manifest.frozen.resourceBody, PHASE4B_MCP_RESOURCE_BODY);
    assert.deepEqual(manifest.frozen.hardLimits, PHASE4B_MCP_HARD_LIMITS);
    assert.deepEqual(manifest.frozen.legacyRejection, PHASE4B_MCP_LEGACY_REJECTION);
    assert.deepEqual(manifest.sdkLock, PHASE4B_MCP_SDK_LOCK);
  });

  test('replay digest in the manifest is self-consistent and replayable', () => {
    const manifest = loadReplayManifest();
    assert.equal(manifest.recordedOutcomes.digestAlgorithm, 'sha-256');
    const expected = computeMcpEntryReplayDigest({
      schemaVersion: manifest.schemaVersion,
      frozen: manifest.frozen,
      scenarios: manifest.scenarios,
    });
    assert.equal(manifest.recordedOutcomes.digest, expected,
      'committed replay digest must equal the digest of the frozen expectations');
    const ids = manifest.scenarios.map((scenario) => scenario.id);
    assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');
    for (const id of ids) {
      assert.match(id, /^[a-z0-9-]+$/u, `scenario id must be machine-readable: ${id}`);
    }
  });

  test('every frozen negative control appears as a scenario and every legacy scenario is catalogued', () => {
    const manifest = loadReplayManifest();
    const ids = new Set(manifest.scenarios.map((scenario) => scenario.id));
    for (const control of manifest.negativeControls) {
      assert.ok(ids.has(control), `negative control must be exercised: ${control}`);
    }
    for (const id of ids) {
      if (id.startsWith('legacy-')) {
        assert.ok(manifest.negativeControls.includes(id),
          `legacy scenario must be catalogued as a negative control: ${id}`);
      }
    }
  });

  test('legacy catalog covers the plan negative controls without legacy support gaps', () => {
    const rejected = PHASE4B_MCP_LEGACY_REJECTION;
    for (const verb of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']) {
      assert.ok(rejected.rejectedVerbs.includes(verb), `verb must be rejected: ${verb}`);
    }
    for (const header of ['mcp-session-id', 'last-event-id']) {
      assert.ok(rejected.sessionHeaders.includes(header), `header must be rejected: ${header}`);
    }
    for (const method of ['initialize', 'notifications/initialized', 'ping', 'logging/setLevel',
      'notifications/roots/list_changed', 'resources/subscribe', 'resources/unsubscribe']) {
      assert.ok(rejected.rejectedMethods.includes(method), `method must be rejected: ${method}`);
    }
  });
});

describe('P4B-R01 SDK N/N-1 lock (client/server/core 2.3.1, legacy SDK absent)', () => {
  test('package.json pins client as a devDependency and server/node as exact dependencies', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    assert.equal(packageJson.devDependencies['@modelcontextprotocol/client'], '2.3.1');
    assert.equal(packageJson.dependencies?.['@modelcontextprotocol/server'], '2.3.1');
    assert.equal(packageJson.dependencies?.['@modelcontextprotocol/node'], '2.0.0');
    assert.equal(packageJson.devDependencies['@modelcontextprotocol/server'], undefined);
    assert.equal(packageJson.dependencies?.['@modelcontextprotocol/client'], undefined);
  });

  test('lockfile pins the SDK registry artifacts used by the installed COLP package', () => {
    const lock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
    const colp = JSON.parse(readFileSync(colpPackagePath, 'utf8'));
    for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/server', '@modelcontextprotocol/core']) {
      assert.equal(lock.packages[`node_modules/${name}`].version, MCP_SDK_CORE_VERSION);
    }
    assert.equal(colp.dependencies['@modelcontextprotocol/core'], MCP_SDK_CORE_VERSION);
    assert.equal(lock.packages['node_modules/@modelcontextprotocol/node'].version, '2.0.0');
  });

  test('legacy @modelcontextprotocol/sdk (N-1) is absent from manifests, lockfile, source and tests', () => {
    const packageJson = readFileSync(packageJsonPath, 'utf8');
    const lock = readFileSync(packageLockPath, 'utf8');
    assert.doesNotMatch(packageJson, /@modelcontextprotocol\/sdk/u);
    assert.doesNotMatch(lock, /@modelcontextprotocol\/sdk/u);
    for (const file of [...walkFiles(resolve(backendRoot, 'src')),
      ...walkFiles(resolve(backendRoot, 'tests'))]) {
      if (!/\.(?:ts|tsx|mts|mjs)$/u.test(file)) continue;
      const content = readFileSync(file, 'utf8');
      // The frozen catalog legitimately names the rejected legacy package, so
      // only a real import/require of it counts as an N-1 SDK presence.
      assert.doesNotMatch(content,
        /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@modelcontextprotocol\/sdk(?:['"]|\/)/u,
        `legacy SDK import must be absent: ${file}`);
    }
  });
});

describe('P4B-R01 harness boundary and no-legacy-gap scan', () => {
  // Know-N's host/client/probe harness files (phase4b-mcp-entry-{host,client,
  // probe}.ts) are not shipped; only the frozen catalog remains
  // (tests/EXTRACTION.md). The catalog and the production-boundary scans are
  // the parts that still protect this package.
  test('the catalog freezes every legacy wire symbol as a rejected input', () => {
    const catalog = JSON.stringify(PHASE4B_MCP_LEGACY_REJECTION);
    for (const symbol of ['Mcp-Session-Id', 'Last-Event-ID', 'initialize', 'notifications/initialized',
      'ping', 'logging/setLevel', 'notifications/roots/list_changed', 'resources/subscribe',
      'resources/unsubscribe']) {
      assert.match(catalog, new RegExp(escapeRegExp(symbol), 'iu'),
        `catalog must freeze ${symbol} as a rejected legacy input`);
    }
    const contract = readFileSync(resolve(evidenceSourceRoot, 'phase4b-mcp-entry-contract.ts'), 'utf8');
    for (const surface of ['createMcpHandler', "legacy: 'reject'", 'POST', PHASE4B_MCP_ENDPOINT_PATH]) {
      assert.ok(contract.includes(surface), `contract must freeze surface ${surface}`);
    }
  });

  test('the evidence contract is evidence infrastructure, not a second production server', () => {
    const bootstrapRoot = resolve(backendRoot, 'src/bootstrap');
    for (const file of walkFiles(bootstrapRoot)) {
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /phase4b-mcp-entry/u,
        `production bootstrap must not mount the R01 harness: ${file}`);
    }
    const transportRoot = resolve(backendRoot, 'src/transport');
    for (const file of walkFiles(transportRoot)) {
      const content = readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /phase4b-mcp-entry/u,
        `production transport must not import the R01 harness: ${file}`);
    }
    const contract = readFileSync(resolve(evidenceSourceRoot, 'phase4b-mcp-entry-contract.ts'), 'utf8');
    assert.doesNotMatch(contract, /from\s+['"](?:kysely|pg)(?:['"]|\/)/u,
      'evidence contract must not read business tables');
  });

  test('committed fixture files carry no credentials, tokens or real addresses', () => {
    const manifest = readFileSync(replayManifestPath, 'utf8');
    assert.doesNotMatch(manifest, /-----BEGIN/u);
    assert.doesNotMatch(manifest, /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu);
    assert.doesNotMatch(manifest, /postgres(?:ql)?:\/\/[^\s]+/iu);
    const emails = manifest.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
    for (const email of emails) {
      assert.match(email, /\.(?:invalid|example)$/u, `fixture address must be non-deliverable: ${email}`);
    }
    assert.doesNotMatch(manifest, /(?:secret|private|unlisted)[-_ ]?marker[-_A-Za-z0-9]*/iu);
  });

  test('modern envelope and legacy session-header policy are pure and deterministic', () => {
    const envelope = buildPhase4bModernEnvelope();
    assert.equal(envelope['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    assert.equal(typeof envelope['io.modelcontextprotocol/clientCapabilities'], 'object');
    assert.ok(typeof envelope['io.modelcontextprotocol/clientInfo'] === 'object');
    assert.equal(findPhase4bLegacySessionHeader(['mcp-session-id', 'legacy-value']), 'mcp-session-id');
    assert.equal(findPhase4bLegacySessionHeader(['last-event-id', 'x']), 'last-event-id');
    assert.equal(findPhase4bLegacySessionHeader(['content-type', 'application/json']), undefined);
    assert.equal(PHASE4B_MCP_EVIDENCE_SCHEMA_VERSION, 'known.phase4b.mcp-entry-gate.probe.v1');
    assert.equal(PHASE4B_MCP_END_DATE_LABEL, '2026-08-04');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
