import { expect, it, vi } from 'vitest';
import { ColpClient } from '../../src/client/index.js';

it('default Node transport fails closed when builtin DNS pinning is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')!;
  let client: ColpClient;
  try {
    Object.defineProperty(process, 'getBuiltinModule', { ...descriptor, value: undefined });
    client = new ColpClient({ manifestUrl: 'https://example.test/manifest' });
  } finally { Object.defineProperty(process, 'getBuiltinModule', descriptor); }
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(client.discover()).rejects.toThrow(/DNS pinning capability is unavailable/);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
