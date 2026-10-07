import { describe, expect, it, vi } from 'vitest';

import { defaultClientHostResolver, defaultPinnedNodeFetch } from '../../src/client/host-resolution.js';

function resolverFor(module: object | undefined) {
  const builtin = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(module);
  try {
    return defaultClientHostResolver();
  } finally {
    builtin.mockRestore();
  }
}

describe('Default Node client host resolution', () => {
  it('resolves a bracketed public IPv6 URL hostname as an address literal', async () => {
    const lookup = vi.fn(async () => [{ address: '2606:4700:4700::1111' }]);
    const resolver = resolverFor({ lookup })!;
    await expect(resolver('[2606:4700:4700::1111]')).resolves.toEqual(['2606:4700:4700::1111']);
    expect(lookup).toHaveBeenCalledWith('2606:4700:4700::1111', { all: true, verbatim: true });
  });

  it('returns all DNS answers for a domain name', async () => {
    const lookup = vi.fn(async () => [{ address: '198.51.100.7' }, { address: '10.0.0.7' }]);
    await expect(resolverFor({ lookup })!('public.example')).resolves.toEqual(['198.51.100.7', '10.0.0.7']);
    expect(lookup).toHaveBeenCalledWith('public.example', { all: true, verbatim: true });
  });

  it.each([undefined, {}, { lookup: undefined }])('supports a runtime without a DNS module: %s', module => {
    expect(resolverFor(module)).toBeUndefined();
  });

  it.each([null, {}, [null], [{ address: 1 }], [{ address: '' }]])('rejects malformed DNS data: %s', async result => {
    await expect(resolverFor({ lookup: async () => result })!('public.example')).rejects.toThrow(TypeError);
  });

  it('propagates DNS failures', async () => {
    const error = new Error('DNS unavailable');
    await expect(resolverFor({ lookup: async () => { throw error; } })!('public.example')).rejects.toBe(error);
  });

  it('bounds a hanging lookup with the invocation signal', async () => {
    const controller = new AbortController();
    const resolver = resolverFor({ lookup: () => new Promise(() => {}) })!;
    const pending = resolver('public.example', controller.signal);
    controller.abort(new Error('request expired'));
    await expect(pending).rejects.toThrow('request expired');
  });

  it.each([{}, { versions: {} }, { versions: { node: '22' } }])('supports non-Node or older runtimes: %s', runtime => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
    let resolver;
    let transport;
    try {
      Object.defineProperty(globalThis, 'process', {
        configurable: descriptor.configurable ?? true, enumerable: descriptor.enumerable ?? true, writable: true, value: runtime,
      });
      resolver = defaultClientHostResolver();
      transport = defaultPinnedNodeFetch();
    } finally {
      Object.defineProperty(globalThis, 'process', descriptor);
    }
    expect(resolver).toBeUndefined();
    expect(transport).toBeUndefined();
  });
});
