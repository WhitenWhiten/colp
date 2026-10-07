import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CanonicalMutationInvariantError,
  type JsonObject,
  type ResourceOwnedFields,
} from '../../../src/modules/collections/domain/canonical-mutation.js';
import {
  RELATIONAL_OWNER_FIELDS,
  assertResourceFieldAuthority,
} from '../../../src/modules/collections/domain/resource-field-authority.js';

function legalFields(overrides: Partial<ResourceOwnedFields> = {}): ResourceOwnedFields {
  return {
    kindFields: { title: 'allowed kind field' },
    extensions: {},
    ...overrides,
  };
}

function assertAuthorityViolation(run: () => void, field: string): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof CanonicalMutationInvariantError)) return false;
    if (error.code !== 'resource_field_authority_violation') return false;
    return error.message.includes(`kindFields.${field}`);
  });
}

function assertPlainObjectViolation(run: () => void, path: string): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof CanonicalMutationInvariantError)) return false;
    if (error.code !== 'invalid_canonical_mutation') return false;
    return error.message.includes(`${path} must be a plain JSON object`);
  });
}

describe('resource field authority (T1)', () => {
  test('accepts legal kindFields and extensions on ordinary objects', () => {
    assert.doesNotThrow(() => assertResourceFieldAuthority(legalFields()));
  });

  test.each(RELATIONAL_OWNER_FIELDS.map((field) => [field, field] as const))(
    'rejects relational owner field %s in kindFields',
    (field) => {
      const kindFields = { title: 'ok', [field]: 'forbidden' };
      assertAuthorityViolation(
        () => assertResourceFieldAuthority({ kindFields, extensions: {} }),
        field,
      );
    },
  );

  describe('kindFields object shapes', () => {
    test('accepts null-prototype kindFields', () => {
      const kindFields = Object.assign(Object.create(null), { title: 'ok' }) as JsonObject;
      assert.doesNotThrow(() => assertResourceFieldAuthority({ kindFields, extensions: {} }));
    });

    test('rejects class-instance kindFields', () => {
      class KindFieldsCarrier {
        readonly title = 'ok';
      }
      const kindFields = new KindFieldsCarrier() as unknown as JsonObject;
      assertPlainObjectViolation(
        () => assertResourceFieldAuthority({ kindFields, extensions: {} }),
        'kindFields',
      );
    });

    test('rejects custom-prototype kindFields', () => {
      const kindFields = Object.assign(Object.create({ marker: true }), { title: 'ok' }) as JsonObject;
      assertPlainObjectViolation(
        () => assertResourceFieldAuthority({ kindFields, extensions: {} }),
        'kindFields',
      );
    });

    test('rejects array kindFields', () => {
      const kindFields = ['title'] as unknown as JsonObject;
      assertPlainObjectViolation(
        () => assertResourceFieldAuthority({ kindFields, extensions: {} }),
        'kindFields',
      );
    });

    test('rejects accessor-bearing kindFields exposing a relational owner field', () => {
      const kindFields: JsonObject = { title: 'ok' };
      Object.defineProperty(kindFields, 'parentId', {
        enumerable: true,
        get() {
          return 'forbidden-via-accessor';
        },
      });
      assertAuthorityViolation(
        () => assertResourceFieldAuthority({ kindFields, extensions: {} }),
        'parentId',
      );
    });
  });

  describe('extensions object shapes', () => {
    test('accepts null-prototype extensions', () => {
      const extensions = Object.assign(Object.create(null), { custom: true }) as JsonObject;
      assert.doesNotThrow(() => assertResourceFieldAuthority({ kindFields: { title: 'ok' }, extensions }));
    });

    test('rejects class-instance extensions', () => {
      class ExtensionsCarrier {
        readonly custom = true;
      }
      const extensions = new ExtensionsCarrier() as unknown as JsonObject;
      assertPlainObjectViolation(
        () => assertResourceFieldAuthority(legalFields({ extensions })),
        'extensions',
      );
    });

    test('rejects array extensions', () => {
      const extensions = [{ custom: true }] as unknown as JsonObject;
      assertPlainObjectViolation(
        () => assertResourceFieldAuthority(legalFields({ extensions })),
        'extensions',
      );
    });
  });
});
