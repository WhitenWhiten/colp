import { describe, expect, it } from 'vitest';
import { scanMcp20260728XMcpHeaderDeclarations as scan } from '../../src/mcp/2026-07-28/request-context.js';

describe('public MCP header scanner resource boundary', () => {
  it('rejects cycles without overflowing the stack', () => {
    const schema: Record<string, unknown> = { type: 'object' };
    schema.properties = { self: schema };
    expect(scan(schema)).toEqual({ valid: false, reason: 'Tool inputSchema exceeds the schema budget or is not JSON data.' });
  });

  it('rejects excessive depth and width before declaration traversal', () => {
    let deep: unknown = { type: 'string' };
    for (let depth = 0; depth < 2000; depth += 1) deep = { properties: { child: deep } };
    expect(scan(deep).valid).toBe(false);
    const properties = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`p${i}`, { type: 'string' }]));
    expect(scan({ properties }).valid).toBe(false);
  });

  it('bounds ignored schema text and references, not just declared headers', () => {
    expect(scan({ description: 'x'.repeat(1_048_577) }).valid).toBe(false);
    expect(scan({ allOf: Array.from({ length: 1001 }, () => ({ $ref: '#/$defs/item' })) }).valid).toBe(false);
  });

  it('does not execute getters or Proxy traps during admission', () => {
    let invoked = false;
    const getter = { get properties() { invoked = true; return {}; } };
    const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('must not run'); } });
    expect(scan(getter).valid).toBe(false);
    expect(scan(proxy).valid).toBe(false);
    expect(invoked).toBe(false);
  });

  it('preserves valid declaration paths and primitive types', () => {
    expect(scan({ type: 'object', properties: {
      outer: { type: 'object', properties: {
        id: { type: 'string', 'x-mcp-header': 'X-Item' },
        enabled: { type: 'boolean', 'x-mcp-header': 'X-Enabled' },
      } },
    } })).toEqual({ valid: true, declarations: [
      { path: ['outer', 'id'], headerName: 'X-Item', type: 'string' },
      { path: ['outer', 'enabled'], headerName: 'X-Enabled', type: 'boolean' },
    ] });
    expect(scan(true)).toEqual({ valid: true, declarations: [] });
    expect(scan(false)).toEqual({ valid: true, declarations: [] });
  });

  it('preserves duplicate-name and unreachable-declaration denials', () => {
    const duplicate = scan({ properties: {
      a: { type: 'string', 'x-mcp-header': 'X-Item' },
      b: { type: 'string', 'x-mcp-header': 'x-item' },
    } });
    expect(duplicate.valid).toBe(false);
    if (!duplicate.valid) expect(duplicate.reason).toMatch(/unique/);
    const unreachable = scan({ allOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'X-Item' } } }] });
    expect(unreachable.valid).toBe(false);
    if (!unreachable.valid) expect(unreachable.reason).toMatch(/statically reachable/);
  });
});
