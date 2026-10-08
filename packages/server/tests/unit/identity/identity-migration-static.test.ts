import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
// Task E4: the boundary-gate engine itself is the inventory contract. Importing
// it here (no side effects — run() is gated by isMainModule) lets the static
// suite assert the zero-active-production-source invariant AND the
// delete-an-exception-fails tamper behavior (plan §11 Task E4).
import {
  classify,
  collectInventory,
  INVENTORY_ALLOWLIST,
  INVENTORY_PROBES,
} from '../../../scripts/check-auth-migration-boundaries.mjs';

/**
 * Task E4: every legacy identity asset class the plan mandates must be
 * inventoried by its own probe, and every probe must hard-fail on
 * active-production-source hits.
 */
const E4_MANDATED_PROBES = [
  'legacy-oidc-route',
  'legacy-test-authorize-route',
  'legacy-frontend-entry',
  'known-test-code',
  'create-test-oidc-provider',
  'issue-test-session',
  'phase1-real-stack-user',
  'legacy-cookie-helper',
  'legacy-session-table-mint',
  'account-identities-insert',
] as const;

/**
 * E4 declared allowlist entries whose deletion MUST flip the classification
 * into active-production-source (files with no default-group fallback). The
 * gate fails on that group, so deleting any of these entries turns the gate
 * red — the declared exception is the contract, not a comment.
 */
const E4_TAMPER_SENSITIVE_ENTRIES = [
  'Known-Backend/src/transport/session-auth.ts',
  'Known-Backend/src/transport/product-admission.ts',
  'Known-Backend/src/transport/product/search-routes.ts',
  'Known-Backend/src/transport/product/product-public-insight-routes.ts',
  'Known-Backend/src/transport/colp-sync/sync-colp-authorization.ts',
  'Known-Backend/src/modules/auth/application/browser-session-authority.ts',
  'Known-Backend/src/infrastructure/auth/better-auth-session-authority.ts',
  'Known-Backend/src/infrastructure/auth/better-auth-signup-otp.ts',
  'Known-Backend/scripts/real-stack-e2e.mjs',
  'Known-Backend/scripts/phase3-sync-ui-fixture.ts',
  'Known-Backend/scripts/phase4a-p10-recovery-evidence.ts',
  'Known-Backend/scripts/phase4a-redis-rate-limit-evidence.ts',
  'Known-Backend/scripts/mcp-w08-e2e-fixture.ts',
  'Known-Backend/scripts/phase2-publication-acceptance-adapter.ts',
  'Known-Backend/scripts/phase4a-attachment-admission-baseline.ts',
  'Known-Backend/scripts/phase4a-p03-evidence.ts',
  'Known-Backend/scripts/phase4a-p07-evidence.ts',
  'Known-Backend/scripts/phase4a-p08-evidence.ts',
  'Known-Backend/scripts/evidence/phase4a-r06-projection-control.ts',
] as const;

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const FUTURE_TABLES = [
  'publications',
  'sync_sessions',
  'sync_sequence_receipts',
  'subscriptions',
  'attachments',
  'search_documents',
  'api_keys',
];

const IDENTITY_MARKERS = [
  'profile_handles',
  'account_identities',
  'oidc_login_transactions',
  'security_epoch',
  'token_hash',
  'csrf_token_hash',
  'idle_expires_at',
  'absolute_expires_at',
];

const PHASE0_MIGRATIONS = [
  '202607220900_phase1_schema.ts',
  '202607221200_versioned_outbox_worker.ts',
  '202607221500_product_command_receipt_hardening.ts',
  '202607221600_authority_repair.ts',
] as const;

describe('identity lifecycle migration static contract', () => {
  test('includes an expand migration that evolves identity tables with explicit up/down', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    assert.ok(names.length >= 5, 'expected a new identity expand migration beyond Phase 0');

    for (const phase0 of PHASE0_MIGRATIONS) {
      assert.ok(names.includes(phase0), `missing committed migration ${phase0}`);
    }

    const expandCandidates = names.filter((name) => !(PHASE0_MIGRATIONS as readonly string[]).includes(name));
    assert.ok(expandCandidates.length >= 1, 'missing identity expand migration file');

    let matchedSource: string | undefined;
    let matchedName: string | undefined;
    for (const name of expandCandidates) {
      const source = await readFile(new URL(name, MIGRATIONS_DIR), 'utf8');
      const hits = IDENTITY_MARKERS.filter((marker) => source.includes(marker));
      if (hits.length >= 5) {
        matchedSource = source;
        matchedName = name;
        break;
      }
    }

    assert.ok(matchedSource && matchedName, 'no migration covers identity lifecycle markers');
    assert.match(matchedSource, /export async function up/);
    assert.match(matchedSource, /export async function down/);
    assert.match(matchedSource, /export const migration/);

    // Expand-only: do not rewrite the committed Phase 0 baseline migration.
    const baseline = await readFile(new URL('202607220900_phase1_schema.ts', MIGRATIONS_DIR), 'utf8');
    assert.doesNotMatch(baseline, /profile_handles|account_identities|oidc_login_transactions/);

    for (const table of FUTURE_TABLES) {
      assert.doesNotMatch(
        matchedSource,
        new RegExp(`CREATE TABLE\\s+${table}\\b`, 'i'),
        `${matchedName} must not create future-phase table ${table}`,
      );
    }

    for (const marker of [
      'profile_handles',
      'account_identities',
      'oidc_login_transactions',
      'security_epoch',
      'token_hash',
      'csrf_token_hash',
    ]) {
      assert.match(matchedSource, new RegExp(marker));
    }
  });

  test('migration filenames remain sortable timestamps', async () => {
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    for (const name of names) {
      assert.match(name, /^\d{12,14}_[a-z0-9_]+\.ts$/i);
    }
    assert.deepEqual([...names].sort(), names);
  });
});

describe('Task E4 legacy identity boundary inventory', () => {
  test('every mandated legacy identity asset class has its own hard-fail probe', () => {
    const ids = new Set(INVENTORY_PROBES.map((probe) => probe.id));
    for (const mandated of E4_MANDATED_PROBES) {
      assert.ok(ids.has(mandated), `missing E4 inventory probe: ${mandated}`);
    }
    for (const probe of INVENTORY_PROBES) {
      assert.ok(
        probe.mustBeZeroGroups.includes('active-production-source'),
        `probe ${probe.id} must hard-fail on active-production-source hits`,
      );
    }
  });

  test('the full static inventory has zero active-production-source hits', () => {
    const inventory = collectInventory();
    const active = inventory.filter((hit) => hit.group === 'active-production-source');
    assert.deepEqual(
      active.map((hit) => `${hit.file} [${hit.probe}]`),
      [],
      'a legacy identity reference reached active production source without a declared exception — add it to scripts/check-auth-migration-boundaries.mjs INVENTORY_ALLOWLIST with a reason, never silence the gate',
    );
  });

  test('deleting a declared allowlist exception turns the gate red (classification is the contract)', () => {
    for (const file of E4_TAMPER_SENSITIVE_ENTRIES) {
      const entry = INVENTORY_ALLOWLIST.get(file);
      assert.ok(entry, `tamper fixture lost its allowlist entry: ${file}`);
      const declaredGroup = entry.group;
      assert.notEqual(declaredGroup, 'active-production-source', `entry ${file} is declared as a failure group`);
      assert.equal(classify(file).group, declaredGroup, `entry ${file} no longer classifies as declared`);
      // Remove the exception (tamper): the file must fall back to the hard-fail
      // group, proving the declared exception is what keeps the gate green.
      INVENTORY_ALLOWLIST.delete(file);
      try {
        assert.equal(
          classify(file).group,
          'active-production-source',
          `removing the allowlist entry for ${file} must fail the gate (no default-group fallback)`,
        );
      } finally {
        INVENTORY_ALLOWLIST.set(file, entry);
      }
    }
  });

  test('declared reuse entries stay a small, documented set', () => {
    const reuse = collectInventory().filter((hit) => hit.group === 'active-production-reuse');
    const files = new Set(reuse.map((hit) => hit.file));
    assert.deepEqual(
      [...files].sort(),
      [
        'Known-Backend/src/infrastructure/auth/better-auth-session-authority.ts',
        'Known-Backend/src/infrastructure/auth/better-auth-signup-otp.ts',
        'Known-Backend/src/modules/auth/application/browser-session-authority.ts',
        'Known-Backend/src/transport/colp-sync/sync-colp-authorization.ts',
        'Known-Backend/src/transport/product-admission.ts',
        'Known-Backend/src/transport/product/product-public-insight-routes.ts',
        'Known-Backend/src/transport/product/search-routes.ts',
      ],
      'active-production-reuse is a declared-reuse contract — new reuse needs an explicit allowlist entry and reason',
    );
  });
});
