import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { materializeClosedMcpToolSchema } from '../../src/mcp/schema-ref.js';
import { createValidatorRegistry, validateWireDocument } from '../../src/schema/index.js';
import { materializePublicationPublicWire } from '../../src/server/publication-public-projection.js';

describe('bounded projection and validation boundaries', () => {
  it('counts every occurrence of a shared schema before recursive expansion', () => {
    let schema: Record<string, unknown> = { description: 'x'.repeat(128) };
    for (let i = 0; i < 17; i++) schema = { anyOf: [schema, schema] };
    expect(() => materializeClosedMcpToolSchema(schema)).toThrow(/budget/);
  });

  it('rejects an oversized public output before allocating its JSON string', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(() => materializePublicationPublicWire({ text: 'x'.repeat(1024) }, { maxBytes: 100 }))
        .toThrow(/limits were exceeded/);
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });

  it('includes escaped strings and UTF-8 bytes in the wire budget', () => {
    const value = { text: '\u0000😀' };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(materializePublicationPublicWire(value, { maxBytes: bytes })).toEqual(value);
    expect(() => materializePublicationPublicWire(value, { maxBytes: bytes - 1 })).toThrow();
  });

  it('rejects accessors without invoking them', () => {
    const getter = vi.fn(() => '2026-10-08T00:00:00Z');
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const value = Object.defineProperty({}, 'createdAt', { enumerable: true, get: getter });
    expect(validateWireDocument(createValidatorRegistry(), 'node', value, semantics)).toMatchObject({ valid: false });
    expect(getter).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
  });
  it('rechecks caller aliases after an untrusted wrapper runs', () => {
    const source = JSON.parse(readFileSync(new URL('../../fixtures/protocol/examples/public-manifest.json', import.meta.url), 'utf8'));
    const delegate = createValidatorRegistry();
    const getter = vi.fn(() => 'collection-protocol');
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    let called = false;
    const wrapper = { ...delegate, validate: (name: Parameters<typeof delegate.validate>[0], value: unknown) => {
      called = true;
      Object.defineProperty(source, 'protocol', { enumerable: true, get: getter });
      return delegate.validate(name, value);
    } };
    expect(validateWireDocument(wrapper, 'manifest', source, semantics)).toMatchObject({ valid: false });
    expect(called).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(semantics).not.toHaveBeenCalled();
  });

});
