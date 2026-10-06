import { describe, expect, it } from 'vitest';

import * as rootApi from '../../src/adapters/index.js';
import {
  createAdapterConversionResult,
  declareExtensionDegradation,
  transformExportExtensionCarrier,
  type AdapterConversionOptions,
  type ConversionResult,
  type ExtensionDegradationAudit,
} from '../../src/adapters/index.js';
import {
  preserveExtensionCarrier,
  type ExtensionCarrier,
} from '../../src/schema/index.js';

const evidence = '[evidence:core.adapter-lossy-conversion-warning]';
const retainedNamespace = 'https://vendor.example/extensions/retained/v1';
const removedNamespace = 'https://vendor.example/extensions/removed/v1';
const degradedNamespace = 'https://vendor.example/extensions/degraded/v1';

function pointer(namespace: string, owner = '/nodes/node-1'): string {
  return `${owner}/extensions/${namespace.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function removeNamespaces(...namespaces: readonly string[]): AdapterConversionOptions {
  const selected = new Set(namespaces);
  return {
    extensionCarrierPath: '/nodes/node-1',
    extensionSecurityPolicy: {
      id: 'target-capability-policy-v1',
      decide: ({ namespace }) => selected.has(namespace)
        ? { action: 'remove', reason: `target cannot represent ${namespace}` }
        : { action: 'preserve' },
    },
  };
}

function degradation(
  namespace = degradedNamespace,
  reason = 'native target stores plain text only',
): ExtensionDegradationAudit {
  return declareExtensionDegradation({
    namespace,
    path: pointer(namespace),
    kind: 'value',
    reason,
  });
}

function sourceWith(payloads: Readonly<Record<string, unknown>>) {
  return { id: 'node-1', extensions: payloads };
}

function finish<Value extends object>(
  transformed: Pick<ConversionResult<Value & ExtensionCarrier>, 'value' | 'extensionRemovals'>,
  degradations: readonly ExtensionDegradationAudit[] = [],
) {
  const hasLoss = transformed.extensionRemovals.length > 0 || degradations.length > 0;
  return createAdapterConversionResult({
    value: transformed.value,
    lossless: !hasLoss,
    extensionRemovals: transformed.extensionRemovals,
    extensionDegradations: degradations,
  });
}

describe(`CORE-0034 adapter lossy conversion warning contract ${evidence}`, () => {
  it('emits one lossy_conversion warning and marks the conversion lossy for an explicitly removed Extension', () => {
    const source = sourceWith({
      [removedNamespace]: { private: true },
      [retainedNamespace]: { retained: true },
    });
    const transformed = transformExportExtensionCarrier(
      source,
      { id: source.id },
      removeNamespaces(removedNamespace),
    );

    const result = finish(transformed);

    expect(result.value.extensions).toEqual({ [retainedNamespace]: { retained: true } });
    expect(result.lossless).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'lossy_conversion',
        path: pointer(removedNamespace),
        lossy: true,
        message: expect.stringContaining(removedNamespace),
      }),
    ]);
    expect(result.extensionRemovals).toHaveLength(1);
  });

  it('emits a lossy_conversion warning for an explicit Extension degradation while retaining its canonical sidecar', () => {
    const source = sourceWith({
      [degradedNamespace]: { richText: [{ text: 'heading', level: 2 }] },
    });
    const transformed = transformExportExtensionCarrier(source, { id: source.id });

    const result = finish(transformed, [degradation()]);

    expect(result.value).toEqual(source);
    expect(result.extensionRemovals).toEqual([]);
    expect(result.extensionDegradations).toEqual([
      expect.objectContaining({ namespace: degradedNamespace, kind: 'value' }),
    ]);
    expect(result.lossless).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'lossy_conversion',
        path: pointer(degradedNamespace),
        lossy: true,
        message: expect.stringMatching(/plain text|degrad/i),
      }),
    ]);
  });

  it('rejects silent, caller-fabricated, wrong-code, or lossless claims for Extension loss', () => {
    const transformed = transformExportExtensionCarrier(
      sourceWith({ [removedNamespace]: false }),
      { id: 'node-1' },
      removeNamespaces(removedNamespace),
    );

    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: true,
      extensionRemovals: transformed.extensionRemovals,
    })).toThrow(TypeError);
    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: false,
      extensionRemovals: [{
        namespace: removedNamespace,
        path: pointer(removedNamespace),
        surface: 'export-adapter',
        policyId: 'fabricated-policy',
        reason: 'fabricated audit',
      }],
    })).toThrow(TypeError);
    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: false,
      extensionDegradations: [{
        namespace: degradedNamespace,
        path: pointer(degradedNamespace),
        surface: 'export-adapter',
        kind: 'value',
        reason: 'fabricated audit',
      }],
    })).toThrow(TypeError);
    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: false,
      warnings: [{ code: 'lossy_conversion', message: 'caller fabricated' }],
    })).toThrow(TypeError);
    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: false,
      warnings: [{ code: 'extension_removed', message: 'wrong code and no auditable loss' }],
    })).toThrow(TypeError);
    expect(() => createAdapterConversionResult({
      value: transformed.value,
      lossless: false,
      warnings: [{
        code: 'extension_removed',
        message: 'wrong code disguised as lossy evidence',
        path: pointer(removedNamespace),
        lossy: true,
      }],
    })).toThrow(TypeError);
  });

  it.each([
    ['missing', { id: 'node-1' }],
    ['empty', { id: 'node-1', extensions: {} }],
  ] as const)('treats %s extensions as lossless without inventing a warning', (_label, source) => {
    const result = finish(transformExportExtensionCarrier(source, { id: source.id }));

    expect(result.value).toEqual(source);
    expect('extensions' in result.value).toBe('extensions' in source);
    expect(result.lossless).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.extensionRemovals).toEqual([]);
    expect(result.extensionDegradations).toEqual([]);
  });

  it.each([null, false, 0, ''] as const)(
    'does not truthiness-filter the falsey Extension payload %j and warns if it is explicitly removed',
    (payload) => {
      const source = sourceWith({ [removedNamespace]: payload, [retainedNamespace]: payload });
      const transformed = transformExportExtensionCarrier(
        source,
        { id: source.id },
        removeNamespaces(removedNamespace),
      );
      const result = finish(transformed);

      expect(result.value.extensions).toEqual({ [retainedNamespace]: payload });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe('lossy_conversion');
      expect(result.lossless).toBe(false);
    },
  );

  it('retains nested arbitrary JSON exactly while warning for a separately degraded namespace', () => {
    const nested = {
      values: [null, false, 0, '', { deeper: [{ flag: true }, ['opaque']] }],
    };
    const source = sourceWith({
      [retainedNamespace]: nested,
      [degradedNamespace]: { formatting: ['bold', 'underline'] },
    });

    const result = finish(
      transformExportExtensionCarrier(source, { id: source.id }),
      [degradation(degradedNamespace, 'underline formatting is unavailable')],
    );

    expect(result.value.extensions?.[retainedNamespace]).toEqual(nested);
    expect(result.value.extensions?.[degradedNamespace]).toEqual(source.extensions[degradedNamespace]);
    expect(result.warnings).toHaveLength(1);
  });

  it('emits exactly one deterministic warning per removal and degradation in canonical path order', () => {
    const removedSecond = 'https://vendor.example/extensions/removed-second/v1';
    const degradedSecond = 'https://vendor.example/extensions/degraded-second/v1';
    const source = sourceWith({
      [removedSecond]: 1,
      [degradedSecond]: 2,
      [removedNamespace]: 3,
      [degradedNamespace]: 4,
    });
    const transformed = transformExportExtensionCarrier(
      source,
      { id: source.id },
      removeNamespaces(removedNamespace, removedSecond),
    );
    const degradations = [
      degradation(degradedNamespace, 'first capability reduction'),
      degradation(degradedSecond, 'second capability reduction'),
    ];

    const first = finish(transformed, degradations);
    const second = finish(transformed, [...degradations].reverse());

    expect(first.warnings).toEqual(second.warnings);
    expect(first.warnings).toHaveLength(4);
    expect(first.warnings.every(({ code, lossy }) => code === 'lossy_conversion' && lossy === true)).toBe(true);
    expect(first.warnings.map(({ path }) => path)).toEqual(
      [...first.warnings.map(({ path }) => path)].sort(),
    );
    for (const namespace of [removedNamespace, degradedNamespace, removedSecond, degradedSecond]) {
      expect(first.warnings.some(({ message }) => message.includes(namespace))).toBe(true);
    }
  });

  it('returns detached immutable audits, warnings, and Extension data without mutating either input', () => {
    const payload = { nested: [{ value: 'original' }] };
    const source = sourceWith({ [degradedNamespace]: payload });
    const target = { id: source.id, native: { untouched: true } };
    const before = structuredClone({ source, target });
    const result = finish(
      transformExportExtensionCarrier(source, target),
      [degradation(degradedNamespace, 'target drops nested presentation metadata')],
    );

    expect({ source, target }).toEqual(before);
    expect(result.value.extensions).not.toBe(source.extensions);
    expect(result.value.extensions?.[degradedNamespace]).not.toBe(payload);
    expect(Object.isFrozen(result.value.extensions)).toBe(true);
    expect(Object.isFrozen(result.value.extensions?.[degradedNamespace])).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.warnings[0])).toBe(true);
    expect(Object.isFrozen(result.extensionDegradations)).toBe(true);
    expect(() => { (result.warnings as unknown[]).push({}); }).toThrow(TypeError);
  });

  it('preserves all Extensions with no false warning when no removal or degradation occurs', () => {
    const source = sourceWith({
      [retainedNamespace]: { nested: [null, false, 0, ''] },
      [degradedNamespace]: ['still', 'fully', 'represented'],
    });

    const result = finish(transformExportExtensionCarrier(source, { id: source.id }));

    expect(result.value).toEqual(source);
    expect(result.lossless).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.extensionRemovals).toEqual([]);
    expect(result.extensionDegradations).toEqual([]);
  });

  it.each([
    ['non-HTTPS namespace', { namespace: 'urn:vendor:extension', path: '/extensions/urn:vendor:extension', kind: 'value', reason: 'unsupported' }],
    ['mismatched path', { namespace: degradedNamespace, path: pointer(retainedNamespace), kind: 'value', reason: 'unsupported' }],
    ['path prefix collision', { namespace: degradedNamespace, path: `${pointer(degradedNamespace)}-other`, kind: 'value', reason: 'unsupported' }],
    ['malformed pointer escape', { namespace: degradedNamespace, path: `/bad~2${pointer(degradedNamespace)}`, kind: 'value', reason: 'unsupported' }],
    ['invalid kind', { namespace: degradedNamespace, path: pointer(degradedNamespace), kind: 'partial', reason: 'unsupported' }],
    ['blank reason', { namespace: degradedNamespace, path: pointer(degradedNamespace), kind: 'value', reason: '   ' }],
  ] as const)('rejects the hostile or malformed degradation claim: %s', (_label, claim) => {
    expect(() => declareExtensionDegradation(claim as Parameters<typeof declareExtensionDegradation>[0]))
      .toThrow(TypeError);
  });

  it('rejects absent, duplicate, and removal-contradicting degradation claims', () => {
    const source = sourceWith({ [degradedNamespace]: { rich: true } });
    const duplicate = {
      namespace: degradedNamespace,
      kind: 'value' as const,
      reason: 'same unsupported representation',
    };

    expect(() => transformExportExtensionCarrier(source, { id: source.id }, {
      extensionDegradations: [{ namespace: retainedNamespace, reason: 'not present' }],
    })).toThrow(TypeError);
    expect(() => transformExportExtensionCarrier(source, { id: source.id }, {
      extensionDegradations: [duplicate, duplicate],
    })).toThrow(TypeError);
    expect(() => transformExportExtensionCarrier(source, { id: source.id }, {
      ...removeNamespaces(degradedNamespace),
      extensionDegradations: [duplicate],
    })).toThrow(TypeError);

    const removedAtFirstCarrier = transformExportExtensionCarrier(
      source,
      { id: source.id },
      removeNamespaces(degradedNamespace),
    );
    const degradedAtSecondCarrier = declareExtensionDegradation({
      namespace: degradedNamespace,
      path: pointer(degradedNamespace, '/nodes/node-2'),
      kind: 'value',
      reason: 'another carrier retains a reduced representation',
    });
    expect(createAdapterConversionResult({
      value: {},
      lossless: false,
      extensionRemovals: removedAtFirstCarrier.extensionRemovals,
      extensionDegradations: [degradedAtSecondCarrier],
    }).warnings).toHaveLength(2);
  });

  it('keeps the existing preservation helper behavior and exposes conversion APIs from the adapters surface', () => {
    const source = sourceWith({ [retainedNamespace]: { nested: [false, 0, ''] } });
    const preserved = preserveExtensionCarrier(source, { id: source.id }, { surface: 'export-adapter' });

    expect(rootApi.transformExportExtensionCarrier).toBe(transformExportExtensionCarrier);
    expect(rootApi.createAdapterConversionResult).toBe(createAdapterConversionResult);
    expect(rootApi.declareExtensionDegradation).toBe(declareExtensionDegradation);
    expect(preserved.value).toEqual(source);
    expect(preserved.removals).toEqual([]);
    expect(finish(transformExportExtensionCarrier(source, { id: source.id }))).toMatchObject({
      value: preserved.value,
      lossless: true,
      warnings: [],
      extensionRemovals: [],
      extensionDegradations: [],
    });
  });
});
