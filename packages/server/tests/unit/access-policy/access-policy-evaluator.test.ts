/**
 * P1-03 access-policy pure evaluator + product denial mapping.
 *
 * Product Phase-1 rule (public visibility):
 * Product editor capabilities always require owner/editor/viewer membership
 * or matching ownerSubjectId. Collection visibility `public` alone does NOT
 * grant any editor capability (including read_editor) to a non-member actor.
 * Production maps public non-member → deny (403), not conceal.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'vitest';
import {
  ALL_COLLECTION_CAPABILITIES,
  authorizeCapability,
  evaluateAccess,
  resolveEffectiveRole,
  roleGrantsCapability,
  toProductDenial,
  type AccessPolicyFactsPort,
  type ActorPrincipal,
  type CollectionCapability,
  type MembershipRole,
  type PolicyDecision,
  type ProductDenial,
  type ResourcePolicyFacts,
} from '../../../src/modules/access-policy/index.js';

/** Editor may mutate content/metadata; not members or publication. */
const EDITOR_ALLOWED = new Set<CollectionCapability>([
  'read_editor',
  'update_collection_metadata',
  'create_node',
  'update_node',
  'move_node',
  'delete_node',
]);

/** Viewer is read-only on the product editor surface. */
const VIEWER_ALLOWED = new Set<CollectionCapability>(['read_editor']);

const OWNER_SUBJECT = 'subject-owner';
const ACTOR_SUBJECT = 'subject-actor';
const COLLECTION_A = 'collection-a';
const COLLECTION_B = 'collection-b';
const POLICY_REV = 'policy-rev-1';

function actor(overrides: Partial<ActorPrincipal> = {}): ActorPrincipal {
  return {
    principalId: 'principal-actor',
    subjectId: ACTOR_SUBJECT,
    kind: 'account',
    ...overrides,
  };
}

function facts(overrides: Partial<ResourcePolicyFacts> = {}): ResourcePolicyFacts {
  return {
    collectionId: COLLECTION_A,
    ownerSubjectId: OWNER_SUBJECT,
    membershipRole: 'owner',
    visibility: 'private',
    policyRevision: POLICY_REV,
    deleted: false,
    ...overrides,
  };
}

function expectedGrant(role: MembershipRole, capability: CollectionCapability): boolean {
  if (role === 'owner') return true;
  if (role === 'editor') return EDITOR_ALLOWED.has(capability);
  return VIEWER_ALLOWED.has(capability);
}

function assertProductDenial(
  decision: PolicyDecision,
  expected: ProductDenial | null,
): void {
  assert.deepEqual(toProductDenial(decision), expected);
}

function memoryFactsPort(byId: Map<string, ResourcePolicyFacts | null>): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input) {
      if (!byId.has(input.collectionId)) return null;
      return byId.get(input.collectionId) ?? null;
    },
  };
}

describe('access-policy: role capability matrix', () => {
  test('roleGrantsCapability matches owner/editor/viewer closed matrix', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      for (const capability of ALL_COLLECTION_CAPABILITIES) {
        assert.equal(
          roleGrantsCapability(role, capability),
          expectedGrant(role, capability),
          `${role} × ${capability}`,
        );
      }
    }
  });

  test('roleGrantsCapability returns false for null role', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      assert.equal(roleGrantsCapability(null, capability), false, capability);
    }
  });

  test('ALL_COLLECTION_CAPABILITIES is the closed Phase-1 set', () => {
    assert.deepEqual([...ALL_COLLECTION_CAPABILITIES].sort(), [
      'create_node',
      'delete_node',
      'manage_members',
      'manage_publication',
      'move_node',
      'read_editor',
      'update_collection_metadata',
      'update_node',
    ]);
  });

  test('evaluateAccess applies the same matrix for private live collections with membership', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      for (const capability of ALL_COLLECTION_CAPABILITIES) {
        const decision = evaluateAccess(
          facts({ membershipRole: role, ownerSubjectId: OWNER_SUBJECT }),
          actor({ subjectId: ACTOR_SUBJECT }),
          capability,
        );
        const shouldAllow = expectedGrant(role, capability);
        assert.equal(
          decision.outcome === 'allow',
          shouldAllow,
          `${role} × ${capability} outcome=${decision.outcome} reason=${decision.reasonCategory}`,
        );
        if (shouldAllow) {
          assert.equal(decision.reasonCategory, 'allowed');
          assert.equal(decision.effectiveRole, role);
          assertProductDenial(decision, null);
        } else {
          assert.equal(decision.outcome, 'deny');
          assert.equal(decision.reasonCategory, 'insufficient_role');
          assertProductDenial(decision, {
            statusCode: 403,
            code: 'insufficient_permission',
            recovery: 'user_action',
          });
        }
      }
    }
  });

  test('null membership without owner subject never allows any capability', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      const decision = evaluateAccess(
        facts({
          membershipRole: null,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'private',
        }),
        actor({ subjectId: ACTOR_SUBJECT }),
        capability,
      );
      assert.equal(decision.outcome === 'allow', false, capability);
    }
  });
});

describe('access-policy: owner subject without membership row', () => {
  test('ownerSubjectId match elevates actor to owner for all capabilities', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      const decision = evaluateAccess(
        facts({
          membershipRole: null,
          ownerSubjectId: ACTOR_SUBJECT,
          visibility: 'private',
        }),
        actor({ subjectId: ACTOR_SUBJECT }),
        capability,
      );
      assert.equal(decision.outcome, 'allow', capability);
      assert.equal(decision.effectiveRole, 'owner');
      assert.equal(resolveEffectiveRole(
        facts({ membershipRole: null, ownerSubjectId: ACTOR_SUBJECT }),
        actor({ subjectId: ACTOR_SUBJECT }),
      ), 'owner');
      assertProductDenial(decision, null);
    }
  });

  test('owner membership row also allows all capabilities', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      const decision = evaluateAccess(
        facts({ membershipRole: 'owner', ownerSubjectId: ACTOR_SUBJECT }),
        actor({ subjectId: ACTOR_SUBJECT }),
        capability,
      );
      assert.equal(decision.outcome, 'allow', capability);
    }
  });
});

describe('access-policy: missing and deleted collection concealment', () => {
  test('deleted collection facts conceal and map to product 404', () => {
    const decision = evaluateAccess(
      facts({ deleted: true, membershipRole: 'owner', ownerSubjectId: ACTOR_SUBJECT }),
      actor({ subjectId: ACTOR_SUBJECT }),
      'read_editor',
    );
    assert.equal(decision.outcome, 'conceal');
    assert.equal(decision.reasonCategory, 'resource_missing');
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });

  test('authorizeCapability with null facts conceals as resource_not_found', async () => {
    const ports = memoryFactsPort(new Map([[COLLECTION_A, null]]));
    const decision = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor(),
      capability: 'read_editor',
    });
    assert.equal(decision.outcome, 'conceal');
    assert.equal(decision.reasonCategory, 'resource_missing');
    assert.equal(decision.policyRevision, null);
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });

  test('authorizeCapability when port has no row for collectionId conceals', async () => {
    const ports = memoryFactsPort(new Map());
    const decision = await authorizeCapability(ports, {
      collectionId: 'missing-collection',
      actor: actor(),
      capability: 'create_node',
    });
    assert.equal(decision.outcome, 'conceal');
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });

  test('authorizeCapability with deleted facts from port conceals even for owner', async () => {
    const ports = memoryFactsPort(
      new Map([
        [
          COLLECTION_A,
          facts({
            deleted: true,
            membershipRole: 'owner',
            ownerSubjectId: ACTOR_SUBJECT,
          }),
        ],
      ]),
    );
    const decision = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor({ subjectId: ACTOR_SUBJECT }),
      capability: 'manage_members',
    });
    assert.equal(decision.outcome, 'conceal');
    assert.equal(decision.reasonCategory, 'resource_missing');
    assert.equal(decision.effectiveRole, null);
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });
});

describe('access-policy: private concealment vs insufficient role', () => {
  test('private + no membership + not owner conceals (404), not 403', () => {
    const decision = evaluateAccess(
      facts({
        membershipRole: null,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
      }),
      actor({ subjectId: ACTOR_SUBJECT }),
      'read_editor',
    );
    assert.equal(decision.outcome, 'conceal');
    assert.equal(decision.reasonCategory, 'not_a_member');
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });

  test('protected and unlisted non-members also conceal', () => {
    for (const visibility of ['protected', 'unlisted'] as const) {
      const decision = evaluateAccess(
        facts({ membershipRole: null, visibility }),
        actor(),
        'read_editor',
      );
      assert.equal(decision.outcome, 'conceal', visibility);
      assert.equal(decision.reasonCategory, 'not_a_member', visibility);
    }
  });

  test('viewer + create_node denies with 403 insufficient_permission', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'viewer', ownerSubjectId: OWNER_SUBJECT }),
      actor({ subjectId: ACTOR_SUBJECT }),
      'create_node',
    );
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCategory, 'insufficient_role');
    assertProductDenial(decision, {
      statusCode: 403,
      code: 'insufficient_permission',
      recovery: 'user_action',
    });
  });

  test('editor + manage_members denies with 403', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'editor' }),
      actor(),
      'manage_members',
    );
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCategory, 'insufficient_role');
    assertProductDenial(decision, {
      statusCode: 403,
      code: 'insufficient_permission',
      recovery: 'user_action',
    });
  });

  test('editor + manage_publication denies with 403', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'editor' }),
      actor(),
      'manage_publication',
    );
    assert.equal(decision.outcome, 'deny');
    assertProductDenial(decision, {
      statusCode: 403,
      code: 'insufficient_permission',
      recovery: 'user_action',
    });
  });
});

describe('access-policy: cross-collection isolation', () => {
  test('facts for collection A do not authorize access when authorize loads collection B', async () => {
    const ports = memoryFactsPort(
      new Map([
        [
          COLLECTION_A,
          facts({
            collectionId: COLLECTION_A,
            membershipRole: 'owner',
            ownerSubjectId: ACTOR_SUBJECT,
          }),
        ],
        [
          COLLECTION_B,
          facts({
            collectionId: COLLECTION_B,
            membershipRole: null,
            ownerSubjectId: OWNER_SUBJECT,
            visibility: 'private',
          }),
        ],
      ]),
    );

    const allowedOnA = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor({ subjectId: ACTOR_SUBJECT }),
      capability: 'delete_node',
    });
    assert.equal(allowedOnA.outcome, 'allow');

    const deniedOnB = await authorizeCapability(ports, {
      collectionId: COLLECTION_B,
      actor: actor({ subjectId: ACTOR_SUBJECT }),
      capability: 'delete_node',
    });
    assert.equal(deniedOnB.outcome, 'conceal');
    assert.equal(deniedOnB.reasonCategory, 'not_a_member');
  });

  test('two independent facts sets evaluate independently', () => {
    const factsA = facts({
      collectionId: COLLECTION_A,
      membershipRole: 'editor',
      ownerSubjectId: OWNER_SUBJECT,
    });
    const factsB = facts({
      collectionId: COLLECTION_B,
      membershipRole: 'viewer',
      ownerSubjectId: OWNER_SUBJECT,
    });

    assert.equal(evaluateAccess(factsA, actor(), 'create_node').outcome, 'allow');
    assert.equal(evaluateAccess(factsB, actor(), 'create_node').outcome, 'deny');
  });
});

describe('access-policy: policy revision mismatch', () => {
  test('authorizeCapability denies when expectedPolicyRevision mismatches facts', async () => {
    const ports = memoryFactsPort(
      new Map([
        [
          COLLECTION_A,
          facts({
            membershipRole: 'owner',
            ownerSubjectId: ACTOR_SUBJECT,
            policyRevision: 'rev-current',
          }),
        ],
      ]),
    );

    const decision = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor({ subjectId: ACTOR_SUBJECT }),
      capability: 'update_node',
      expectedPolicyRevision: 'rev-stale',
    });

    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCategory, 'policy_revision_mismatch');
    assert.equal(decision.policyRevision, 'rev-current');
    assert.equal(decision.effectiveRole, 'owner');
    // Generic product mapping keeps deny → 403; callers may specialize later.
    assertProductDenial(decision, {
      statusCode: 403,
      code: 'insufficient_permission',
      recovery: 'user_action',
    });
  });

  test('evaluateAccess denies when facts.expectedPolicyRevision mismatches', () => {
    const decision = evaluateAccess(
      facts({
        membershipRole: 'editor',
        policyRevision: 'rev-current',
        expectedPolicyRevision: 'rev-stale',
      }),
      actor(),
      'create_node',
    );
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCategory, 'policy_revision_mismatch');
  });

  test('matching expectedPolicyRevision allows when role grants capability', async () => {
    const ports = memoryFactsPort(
      new Map([
        [
          COLLECTION_A,
          facts({
            membershipRole: 'editor',
            policyRevision: 'rev-current',
          }),
        ],
      ]),
    );

    const decision = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor(),
      capability: 'create_node',
      expectedPolicyRevision: 'rev-current',
    });
    assert.equal(decision.outcome, 'allow');
    assertProductDenial(decision, null);
  });
});

describe('access-policy: revoked membership', () => {
  test('revoked membership (null role) on private collection conceals', () => {
    const decision = evaluateAccess(
      facts({
        membershipRole: null,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
        deleted: false,
      }),
      actor({ subjectId: ACTOR_SUBJECT }),
      'read_editor',
    );
    assert.equal(decision.outcome, 'conceal');
    assert.equal(decision.reasonCategory, 'not_a_member');
    assertProductDenial(decision, {
      statusCode: 404,
      code: 'resource_not_found',
      recovery: 'none',
    });
  });

  test('revoked membership no longer grants capabilities even when visibility is public', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      const decision = evaluateAccess(
        facts({
          membershipRole: null,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'public',
          deleted: false,
        }),
        actor({ subjectId: ACTOR_SUBJECT }),
        capability,
      );
      assert.equal(decision.outcome === 'allow', false, capability);
      assert.equal(decision.outcome, 'deny', `public non-member → deny for ${capability}`);
      assert.equal(decision.reasonCategory, 'not_a_member');
    }
  });
});

describe('access-policy: public visibility without membership', () => {
  /**
   * Assumed / production rule (P1-03 Product editor surface):
   * - Actor always carries a subjectId (session principal).
   * - `visibility: public` does not grant product editor capabilities.
   * - Membership (owner|editor|viewer) or ownerSubjectId match is required.
   * - Public non-member → deny (403), not conceal (existence may be known).
   */
  test('public non-member is denied every product editor capability', () => {
    for (const capability of ALL_COLLECTION_CAPABILITIES) {
      const decision = evaluateAccess(
        facts({
          membershipRole: null,
          ownerSubjectId: OWNER_SUBJECT,
          visibility: 'public',
        }),
        actor({ subjectId: ACTOR_SUBJECT }),
        capability,
      );
      assert.equal(decision.outcome, 'deny', capability);
      assert.equal(decision.reasonCategory, 'not_a_member');
      assertProductDenial(decision, {
        statusCode: 403,
        code: 'insufficient_permission',
        recovery: 'user_action',
      });
    }
  });

  test('public + viewer membership still allows only viewer matrix', () => {
    assert.equal(
      evaluateAccess(
        facts({ membershipRole: 'viewer', visibility: 'public' }),
        actor(),
        'read_editor',
      ).outcome,
      'allow',
    );
    assert.equal(
      evaluateAccess(
        facts({ membershipRole: 'viewer', visibility: 'public' }),
        actor(),
        'update_node',
      ).outcome,
      'deny',
    );
  });
});

describe('access-policy: toProductDenial mapping', () => {
  test('allow maps to null', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'owner', ownerSubjectId: ACTOR_SUBJECT }),
      actor({ subjectId: ACTOR_SUBJECT }),
      'manage_members',
    );
    assert.equal(decision.outcome, 'allow');
    assert.equal(toProductDenial(decision), null);
  });

  test('deny maps to 403 insufficient_permission', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'viewer' }),
      actor(),
      'delete_node',
    );
    assert.equal(decision.outcome, 'deny');
    assertProductDenial(decision, {
      statusCode: 403,
      code: 'insufficient_permission',
      recovery: 'user_action',
    });
  });

  test('conceal outcomes never return 403', () => {
    const concealedCases: PolicyDecision[] = [
      evaluateAccess(
        facts({ deleted: true, membershipRole: 'owner', ownerSubjectId: ACTOR_SUBJECT }),
        actor({ subjectId: ACTOR_SUBJECT }),
        'read_editor',
      ),
      evaluateAccess(
        facts({ membershipRole: null, visibility: 'private', ownerSubjectId: OWNER_SUBJECT }),
        actor({ subjectId: ACTOR_SUBJECT }),
        'read_editor',
      ),
    ];

    for (const decision of concealedCases) {
      assert.equal(decision.outcome, 'conceal');
      const denial = toProductDenial(decision);
      assert.ok(denial !== null);
      assert.equal(denial.statusCode, 404);
      assert.notEqual(denial.statusCode, 403);
      assert.equal(denial.code, 'resource_not_found');
      assert.notEqual(denial.code, 'insufficient_permission');
      assert.equal(denial.recovery, 'none');
    }
  });

  test('decision echoes policyRevision from facts when present', () => {
    const decision = evaluateAccess(
      facts({ membershipRole: 'editor', policyRevision: 'echo-rev' }),
      actor(),
      'read_editor',
    );
    assert.equal(decision.policyRevision, 'echo-rev');
  });
});

describe('access-policy: authorizeCapability happy path', () => {
  test('loads facts and allows editor create_node', async () => {
    const ports = memoryFactsPort(
      new Map([
        [
          COLLECTION_A,
          facts({ membershipRole: 'editor', policyRevision: POLICY_REV }),
        ],
      ]),
    );
    const decision = await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor(),
      capability: 'create_node',
    });
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.policyRevision, POLICY_REV);
    assert.equal(decision.effectiveRole, 'editor');
    assert.equal(toProductDenial(decision), null);
  });

  test('passes actorSubjectId into the facts port', async () => {
    let seenSubject: string | undefined;
    const ports: AccessPolicyFactsPort = {
      async loadCollectionFacts(input) {
        seenSubject = input.actorSubjectId;
        return facts({
          collectionId: input.collectionId,
          membershipRole: 'viewer',
        });
      },
    };
    await authorizeCapability(ports, {
      collectionId: COLLECTION_A,
      actor: actor({ subjectId: 'subject-seen' }),
      capability: 'read_editor',
    });
    assert.equal(seenSubject, 'subject-seen');
  });
});

describe('access-policy: import boundary smoke', () => {
  test('domain sources do not import kysely, fastify, or pg', () => {
    const modulePath = fileURLToPath(new URL('../../../src/modules/access-policy/', import.meta.url));
    const domainPath = join(modulePath, 'domain');
    assert.ok(statSync(domainPath).isDirectory(), `expected access-policy domain at ${domainPath}`);

    const forbidden = /from\s+['"](?:fastify|kysely|pg)(?:['"]|\/)|require\s*\(\s*['"](?:fastify|kysely|pg)/;

    const walk = (dir: string): string[] => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walk(path));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(path);
        }
      }
      return files;
    };

    const domainSources = walk(domainPath);
    assert.ok(domainSources.length > 0, 'expected at least one access-policy domain source file');
    for (const file of domainSources) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbidden, `import boundary violated in ${file}`);
    }
  });

  test('application sources do not import kysely, fastify, or pg', () => {
    const modulePath = fileURLToPath(new URL('../../../src/modules/access-policy/', import.meta.url));
    const applicationPath = join(modulePath, 'application');
    assert.ok(statSync(applicationPath).isDirectory(), `expected access-policy application at ${applicationPath}`);

    const forbidden = /from\s+['"](?:fastify|kysely|pg)(?:['"]|\/)|require\s*\(\s*['"](?:fastify|kysely|pg)/;

    const walk = (dir: string): string[] => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walk(path));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(path);
        }
      }
      return files;
    };

    const applicationSources = walk(applicationPath);
    assert.ok(applicationSources.length > 0, 'expected at least one access-policy application source file');
    for (const file of applicationSources) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbidden, `import boundary violated in ${file}`);
    }
  });

  test('access-policy sources do not import notifications', () => {
    const modulePath = fileURLToPath(new URL('../../../src/modules/access-policy/', import.meta.url));
    const forbidden = /from\s+['"][^'"]*notifications(?:['"]|\/)|from\s+['"]\.\.\/notifications/;
    const walk = (dir: string): string[] => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walk(path));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(path);
        }
      }
      return files;
    };
    const sources = walk(modulePath);
    assert.ok(sources.length > 0, 'expected access-policy sources');
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, forbidden, `notifications import boundary violated in ${file}`);
    }
  });
});
