import type {
  ApiKeyCreateResult,
  ApiKeyMetadata,
  ColpContracts,
} from '../../src/types/generated.js';

export type ApiKeyRotateResult = ColpContracts['apiKeyRotateResult'];

export function canonicalApiKeyMetadataFixture(
  overrides: Partial<ApiKeyMetadata> = {},
): ApiKeyMetadata {
  const merged = {
    id: 'key-canonical-fixture',
    name: 'Canonical fixture key',
    type: 'read_key' as const,
    scopes: ['collections:read'] as ApiKeyMetadata['scopes'],
    collections: ['collection-canonical-fixture'],
    createdAt: '2026-07-16T07:00:00Z',
    expiresAt: '2026-10-16T00:00:00Z',
    lastUsedAt: '2026-07-20T09:30:00Z',
    lastUsedIp: '192.0.2.44',
    status: 'active' as const,
    ...overrides,
  } satisfies ApiKeyMetadata;

  return Object.freeze({
    ...merged,
    scopes: [...merged.scopes] as ApiKeyMetadata['scopes'],
    collections: [...merged.collections],
  });
}

export function canonicalApiKeyCreateResultFixture(
  key: ApiKeyMetadata = canonicalApiKeyMetadataFixture(),
  secret = 'colp_live_create_fixture_secret',
): ApiKeyCreateResult & Readonly<Record<string, unknown>> {
  return Object.freeze({
    key: canonicalApiKeyMetadataFixture(key),
    secret,
  } satisfies ApiKeyCreateResult);
}

export function canonicalApiKeyRotateResultFixture(
  key: ApiKeyMetadata = canonicalApiKeyMetadataFixture({
    id: 'key-canonical-rotate-fixture',
    status: 'rotating',
  }),
  secret = 'colp_live_rotate_fixture_secret',
): ApiKeyRotateResult & Readonly<Record<string, unknown>> {
  return Object.freeze({
    key: canonicalApiKeyMetadataFixture(key),
    secret,
  } satisfies ApiKeyRotateResult);
}
