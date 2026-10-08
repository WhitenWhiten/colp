import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_PROTOCOL_VERSIONS,
  PHASE4B_MCP_CONFIG_ENDPOINT_PATH,
  PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS,
  assertMcpReadFeatureConfig,
} from '../../../src/modules/mcp/index.js';
import {
  phase4bMcpConfigBaseEnv as baseEnv,
  phase4bMcpOnEnv as onEnv,
  phase4bMcpProdEnv as prodEnv,
} from '../../support/phase4b-mcp-config-env.js';

function assertDeepFrozen(value: unknown, label: string): void {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeepFrozen(item, `${label}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${label}.${key}`);
  }
}

test('MCP compat flag defaults off and omits the nested compat section', () => {
  const closed = loadConfig(baseEnv);
  assert.equal(closed.mcp, undefined);

  const readOn = loadConfig(onEnv()).mcp!;
  assert.equal(readOn.enabled, true);
  assert.equal(readOn.compat, undefined);
  assert.equal('compat' in readOn, false);
  assert.equal(readOn.endpointPath, PHASE4B_MCP_CONFIG_ENDPOINT_PATH);
});

test('MCP compat on with read on freezes path and singleton 2025-11-25 versions', () => {
  const mcp = loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' })).mcp!;
  const compat = mcp.compat;
  assert.ok(compat, 'compat section must be present when the flag is on');
  assert.equal(compat.enabled, true);
  assert.equal(compat.endpointPath, '/collections/-/mcp-compat');
  assert.equal(compat.endpointPath, MCP_COMPAT_ENDPOINT_PATH);
  assert.deepEqual(compat.supportedProtocolVersions, ['2025-11-25']);
  assert.equal(compat.supportedProtocolVersions, MCP_COMPAT_PROTOCOL_VERSIONS);
  assert.equal(compat.supportedProtocolVersions.length, 1);
  assert.equal(
    (compat.supportedProtocolVersions as readonly string[]).includes('2025-06-18'),
    false,
  );
  assert.equal(mcp.endpointPath, '/collections/-/mcp');
  assert.equal(mcp.protocolVersion, '2026-07-28');
  assertDeepFrozen(compat, 'config.mcp.compat');
  assertDeepFrozen(mcp, 'config.mcp');
});

test('production accepts compat on without extra env beyond the read feature', () => {
  const mcp = loadConfig(prodEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' })).mcp!;
  assert.equal(mcp.compat?.endpointPath, MCP_COMPAT_ENDPOINT_PATH);
  assert.deepEqual(mcp.compat?.supportedProtocolVersions, MCP_COMPAT_PROTOCOL_VERSIONS);
  assert.equal(Object.isFrozen(mcp.compat), true);
});

test('compat on with read off or absent fails closed at loadConfig', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_COMPAT: 'true' }),
    /KNOWN_FEATURE_MCP_COMPAT requires KNOWN_FEATURE_MCP_READ=true/u,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_READ: 'false', KNOWN_FEATURE_MCP_COMPAT: 'true' }),
    /KNOWN_FEATURE_MCP_COMPAT requires KNOWN_FEATURE_MCP_READ=true/u,
  );
  assert.equal(loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_READ: 'false' }).mcp, undefined);
});

test('invalid MCP compat flag values fail closed like the read flag', () => {
  for (const value of ['yes', '1', 'on', '']) {
    assert.throws(
      () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: value })),
      /KNOWN_FEATURE_MCP_COMPAT must be true or false/u,
      `read-on + ${JSON.stringify(value)}`,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv, KNOWN_FEATURE_MCP_COMPAT: value }),
      /KNOWN_FEATURE_MCP_COMPAT must be true or false/u,
      `read-off + ${JSON.stringify(value)}`,
    );
  }
});

test('forbidden legacy env keys still fail closed when compat is on', () => {
  for (const key of PHASE4B_MCP_FORBIDDEN_LEGACY_ENV_KEYS) {
    assert.throws(
      () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true', [key]: 'anything' })),
      /legacy MCP 2025-11-25 configuration/u,
      `${key} must fail boot even with compat on`,
    );
  }
  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true', MCP_PROTOCOL_MODE: 'legacy' })),
    /MCP_PROTOCOL_MODE/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true', MCP_PROTOCOL_VERSION: '2025-11-25' })),
    /MCP_PROTOCOL_VERSION/u,
  );
  assert.throws(
    () => loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true', MCP_SESSION_STORE: 'memory' })),
    /MCP_SESSION_STORE/u,
  );
});

test('compat path and versions are code constants, not env-selected', () => {
  const mcp = loadConfig(onEnv({
    KNOWN_FEATURE_MCP_COMPAT: 'true',
    MCP_COMPAT_PATH: '/collections/-/mcp-legacy',
    MCP_COMPAT_PROTOCOL_VERSION: '2025-06-18',
    MCP_PROTOCOL_MODE: undefined,
  })).mcp!;
  assert.equal(mcp.compat?.endpointPath, '/collections/-/mcp-compat');
  assert.deepEqual(mcp.compat?.supportedProtocolVersions, ['2025-11-25']);
});

test('assertMcpReadFeatureConfig rejects drifted nested compat', () => {
  const mcp = loadConfig(onEnv({ KNOWN_FEATURE_MCP_COMPAT: 'true' })).mcp!;
  assert.doesNotThrow(() => assertMcpReadFeatureConfig(mcp));

  // Runtime tampering is deliberate; do not assert an invalid literal satisfies
  // the production type merely to pass it through the runtime validator.
  const pathDrift = structuredClone(mcp);
  Object.defineProperty(pathDrift.compat!, 'endpointPath', { value: '/collections/-/mcp' });
  assert.throws(() => assertMcpReadFeatureConfig(pathDrift), /compat endpoint path is frozen/u);

  const versionDrift = structuredClone(mcp);
  Object.defineProperty(versionDrift.compat!, 'supportedProtocolVersions', {
    value: Object.freeze(['2025-06-18']),
  });
  assert.throws(
    () => assertMcpReadFeatureConfig(versionDrift),
    /supportedProtocolVersions must be exactly \["2025-11-25"\]/u,
  );
});
