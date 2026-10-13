// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindServerOriginField } from '../src/server-origin-field.js';
import { RUNTIME_ORIGIN_KEY } from '../src/config.js';
import { MemoryStorageArea } from '../src/credential-store.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

async function setup(grant: Promise<boolean> = Promise.resolve(true), managed = {}) {
  void grant.catch(() => undefined);
  document.body.innerHTML = '<input id="server-origin" type="url">';
  const storage = new MemoryStorageArea();
  await storage.set({ [RUNTIME_ORIGIN_KEY]: 'https://old.test' });
  const request = vi.fn(() => grant);
  vi.stubGlobal('chrome', { storage: { local: storage, managed: { get: async () => managed } }, permissions: { request } });
  const ports = { validate: vi.fn(async () => undefined), disconnect: vi.fn(async () => { await storage.remove(RUNTIME_ORIGIN_KEY); }), refresh: vi.fn(async () => undefined) };
  const controller = await bindServerOriginField(ports);
  const input = document.getElementById('server-origin') as HTMLInputElement;
  function change(value: string) {
    input.value = value;
    const event = new Event('change'); Object.defineProperty(event, 'isTrusted', { value: true });
    input.dispatchEvent(event);
  }
  return { storage, request, ports, controller, input, change };
}

test('waits for permission and validation before disconnecting and saving a new server', async () => {
  let allow!: (granted: boolean) => void;
  const fixture = await setup(new Promise(resolve => { allow = resolve; }));
  fixture.change('https://new.test/');
  expect(fixture.request).toHaveBeenCalledWith({ origins: ['https://new.test/*'] });
  expect(fixture.input.disabled).toBe(true);
  expect(fixture.ports.disconnect).not.toHaveBeenCalled();
  expect((await fixture.storage.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY]).toBe('https://old.test');
  allow(true); await fixture.controller.ready();
  expect(fixture.ports.validate).toHaveBeenCalledWith('https://new.test');
  expect(fixture.ports.validate.mock.invocationCallOrder[0]).toBeLessThan(fixture.ports.disconnect.mock.invocationCallOrder[0]!);
  expect((await fixture.storage.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY]).toBe('https://new.test');
  expect(fixture.ports.refresh).toHaveBeenCalledOnce();
  expect(fixture.input.disabled).toBe(false);
});

test.each([false, 'rejected'])('permission %s leaves the existing connection untouched and blocks login', async result => {
  const fixture = await setup(result === false ? Promise.resolve(false) : Promise.reject(new Error('permission request failed')));
  fixture.change('https://new.test');
  await expect(fixture.controller.ready()).rejects.toThrow('server_configuration_failed');
  expect(fixture.ports.validate).not.toHaveBeenCalled();
  expect(fixture.ports.disconnect).not.toHaveBeenCalled();
  expect((await fixture.storage.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY]).toBe('https://old.test');
  expect(fixture.input.getAttribute('aria-invalid')).toBe('true');
});

test('a non-COLP server does not replace the existing connection', async () => {
  const fixture = await setup();
  fixture.ports.validate.mockRejectedValueOnce(new Error('manifest_invalid'));
  fixture.change('https://new.test');
  await expect(fixture.controller.ready()).rejects.toThrow('server_configuration_failed');
  expect(fixture.ports.disconnect).not.toHaveBeenCalled();
  expect((await fixture.storage.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY]).toBe('https://old.test');
});

test('clearing an override disconnects before returning to the build default', async () => {
  const fixture = await setup(); fixture.change(''); await fixture.controller.ready();
  expect(fixture.request).not.toHaveBeenCalled();
  expect(fixture.ports.disconnect).toHaveBeenCalledOnce();
  expect(await fixture.storage.get(RUNTIME_ORIGIN_KEY)).toEqual({});
  expect(fixture.ports.refresh).toHaveBeenCalledOnce();
});

test('saving the same server can restore a revoked permission without signing out', async () => {
  const fixture = await setup(); fixture.change('https://old.test/'); await fixture.controller.ready();
  expect(fixture.request).toHaveBeenCalledWith({ origins: ['https://old.test/*'] });
  expect(fixture.ports.disconnect).not.toHaveBeenCalled();
  expect(fixture.ports.refresh).toHaveBeenCalledOnce(); expect(fixture.input.value).toBe('https://old.test');
});

test('LAN HTTP and malformed origins cannot reach the permission or save steps', async () => {
  const fixture = await setup();
  for (const origin of ['http://192.168.1.20', 'https://new.test/path', 'https://user:pass@new.test']) {
    fixture.change(origin); await expect(fixture.controller.ready()).rejects.toThrow();
  }
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.ports.disconnect).not.toHaveBeenCalled();
});

test('declining loopback HTTP confirmation keeps the previous address', async () => {
  const fixture = await setup(); vi.stubGlobal('confirm', vi.fn(() => false));
  fixture.change('http://127.0.0.1:8080'); await fixture.controller.ready();
  expect(fixture.input.value).toBe('https://old.test');
  expect(fixture.request).not.toHaveBeenCalled(); expect(fixture.ports.disconnect).not.toHaveBeenCalled();
});

test('managed origins lock the field without changing the personal override', async () => {
  const fixture = await setup(Promise.resolve(true), { serverOrigin: 'https://managed.test' });
  expect(fixture.input.disabled).toBe(true); expect(fixture.input.value).toBe('https://managed.test');
  expect((await fixture.storage.get(RUNTIME_ORIGIN_KEY))[RUNTIME_ORIGIN_KEY]).toBe('https://old.test');
});
