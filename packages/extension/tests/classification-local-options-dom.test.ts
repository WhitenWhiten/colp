// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindLocalClassificationOptions } from '../src/classification-local-options.js';
import {
  LOCAL_CLASSIFICATION_ENABLED, LOCAL_CLASSIFICATION_GRANTED_ORIGIN, LOCAL_CLASSIFICATION_KEY,
  localClassificationCredential, type LocalClassificationCredential,
} from '../src/classification-local-session.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import type { SyncScope } from '../src/sync-state-store.js';

const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'browser', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const accountId = 'a'.repeat(32);
const cfEndpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
const cfOrigin = 'https://api.cloudflare.com/*';
const customOrigin = 'https://custom.example.org/*';

const FIELD_IDS: readonly (readonly [string, 'div' | 'input' | 'select' | 'button' | 'datalist'])[] = [
  ['classification-local-settings', 'div'],
  ['classification-local-status', 'div'],
  ['classification-local-preset', 'select'],
  ['classification-local-cf-fields', 'div'],
  ['classification-local-account-field', 'div'],
  ['classification-local-account', 'input'],
  ['classification-local-gateway', 'input'],
  ['classification-local-endpoint', 'input'],
  ['classification-local-model', 'input'],
  ['classification-local-model-candidates', 'datalist'],
  ['classification-local-secret', 'input'],
  ['classification-local-secret-label', 'div'],
  ['classification-local-http-warning', 'div'],
  ['classification-local-disclosure', 'input'],
  ['classification-local-disclosure-option', 'div'],
  ['classification-local-enable', 'button'],
  ['classification-local-test', 'button'],
  ['classification-local-disable', 'button'],
];

function mountOptionsDom() {
  document.body.replaceChildren();
  for (const [id, tag] of FIELD_IDS) {
    const node = document.createElement(tag);
    node.id = id;
    if (id === 'classification-local-preset') {
      for (const preset of ['cloudflare', 'typesafe', 'vercel', 'custom']) {
        const option = document.createElement('option');
        option.value = preset; option.textContent = preset; node.append(option);
      }
    }
    if (id === 'classification-local-gateway') (node as HTMLInputElement).value = 'default';
    if (id === 'classification-local-endpoint') (node as HTMLInputElement).value = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run';
    document.body.append(node);
  }
}

function memoryStorage(values: Record<string, unknown>) {
  return {
    get: async (key: string) => ({ [key]: values[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(values, value); },
    remove: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) delete values[key]; },
    setAccessLevel: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test('the connection test never revokes the origin the active credential depends on', async () => {
  mountOptionsDom();
  const localValues: Record<string, unknown> = {
    [LOCAL_CLASSIFICATION_ENABLED]: true,
    [LOCAL_CLASSIFICATION_GRANTED_ORIGIN]: cfOrigin,
  };
  const sessionValues: Record<string, unknown> = {};
  const credential: LocalClassificationCredential = {
    version: 3, generation: 'credential-1', presetId: 'cloudflare',
    endpoint: cfEndpoint, model: 'typesafe/jev', accountId, gatewayId: 'default', secret: 'fixture-secret', disclosed: true,
  };
  localValues[LOCAL_CLASSIFICATION_KEY] = credential;

  const granted = new Set<string>([cfOrigin]);
  const removals: string[] = [];
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: {
      local: memoryStorage(localValues), session: memoryStorage(sessionValues), sync: memoryStorage({}),
    },
    permissions: {
      contains: vi.fn(async (input: { origins: string[] }) => input.origins.every(origin => granted.has(origin))),
      request: vi.fn(async (input: { origins: string[] }) => { for (const origin of input.origins) granted.add(origin); return true; }),
      remove: vi.fn(async (input: { origins: string[] }) => {
        for (const origin of input.origins) { removals.push(origin); granted.delete(origin); }
        return true;
      }),
    },
  });
  // The probe must reach a valid bounded answer so the handler completes cleanly.
  vi.stubGlobal('fetch', async () => Response.json({
    model: 'typesafe/jev',
    answers: { folder: { choice: 'alpha', confidence: 1, probabilities: { alpha: 1, beta: 0 } }, tag: { noul: 1 } },
  }));

  const testButton = document.getElementById('classification-local-test') as HTMLButtonElement;
  let click: ((event: { isTrusted: boolean }) => Promise<void>) | undefined;
  const realAdd = testButton.addEventListener.bind(testButton);
  vi.spyOn(testButton, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'click') { click = listener as unknown as (event: { isTrusted: boolean }) => Promise<void>; return; }
    realAdd(type, listener);
  }) as typeof testButton.addEventListener);

  bindLocalClassificationOptions();

  // Local mode is already enabled on the Cloudflare origin; the user tests a
  // different endpoint, which is exactly what used to revoke Cloudflare.
  (document.getElementById('classification-local-endpoint') as HTMLInputElement).value = 'https://custom.example.org/classify';
  (document.getElementById('classification-local-secret') as HTMLInputElement).value = 'fixture-secret';

  await click!({ isTrusted: true });

  // The active credential is intact: its origin stayed granted and its key survived.
  expect(granted.has(cfOrigin)).toBe(true);
  expect(removals).not.toContain(cfOrigin);
  expect(removals).toContain(customOrigin);
  expect(localValues[LOCAL_CLASSIFICATION_GRANTED_ORIGIN]).toBe(cfOrigin);
  expect(await localClassificationCredential()).toEqual(credential);
  expect(localValues[LOCAL_CLASSIFICATION_KEY]).toEqual(credential);
  expect(document.querySelector('.toast:not(.is-closing) .toast-message')?.textContent).toContain('Connection test succeeded');
});

test('a typed credential never survives a preset or endpoint-host change', () => {
  mountOptionsDom();
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage({}), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
  });

  bindLocalClassificationOptions();

  const secret = document.getElementById('classification-local-secret') as HTMLInputElement;
  const endpoint = document.getElementById('classification-local-endpoint') as HTMLInputElement;
  const preset = document.getElementById('classification-local-preset') as HTMLSelectElement;

  // Typed against the Cloudflare template.
  secret.value = 'cf-api-token';
  endpoint.value = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run';

  // Editing only the path on the same host keeps the credential.
  endpoint.value = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/v2';
  endpoint.dispatchEvent(new Event('input'));
  expect(secret.value).toBe('cf-api-token');

  // Switching the preset to a different provider discards it.
  preset.value = 'typesafe';
  preset.dispatchEvent(new Event('change'));
  expect(secret.value).toBe('');

  // And re-typing then changing the endpoint host discards it too.
  secret.value = 'typesafe-key';
  endpoint.value = 'https://api.typesafe.ai/v1/systemone';
  endpoint.dispatchEvent(new Event('input'));
  secret.value = 'typesafe-key';
  endpoint.value = 'https://attacker.example.org/v1/systemone';
  endpoint.dispatchEvent(new Event('input'));
  expect(secret.value).toBe('');
});

test('re-opening options hydrates the form from the active credential, never its secret', async () => {
  mountOptionsDom();
  const localValues: Record<string, unknown> = {
    [LOCAL_CLASSIFICATION_ENABLED]: true,
    [LOCAL_CLASSIFICATION_KEY]: {
      version: 3, generation: 'credential-2', presetId: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', secret: 'stored-key', disclosed: true,
    } satisfies LocalClassificationCredential,
  };
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage(localValues), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
  });

  bindLocalClassificationOptions();

  await vi.waitFor(() => {
    expect((document.getElementById('classification-local-preset') as HTMLSelectElement).value).toBe('typesafe');
  });
  expect((document.getElementById('classification-local-endpoint') as HTMLInputElement).value).toBe('https://api.typesafe.ai/v1/systemone');
  expect((document.getElementById('classification-local-model') as HTMLInputElement).value).toBe('jev-1.13.0');
  // The stored secret is never surfaced into the form; the field only says one is kept.
  const secretField = document.getElementById('classification-local-secret') as HTMLInputElement;
  expect(secretField.value).toBe('');
  expect(secretField.placeholder).toContain('Saved on this browser');
  expect(document.getElementById('classification-local-disclosure-option')!.hidden).toBe(true);
  expect((document.getElementById('classification-local-disclosure') as HTMLInputElement).checked).toBe(true);
  expect(document.getElementById('classification-local-status')!.dataset.active).toBe('true');
});

test('{account} is substituted for any preset that references it, never sent literally', async () => {
  mountOptionsDom();
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage({}), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
  });
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL) => {
    fetched.push(String(url));
    return Response.json({ model: 'typesafe/jev', answers: { folder: { choice: 'alpha', confidence: 1, probabilities: { alpha: 1, beta: 0 } }, tag: { noul: 1 } } });
  });

  const testButton = document.getElementById('classification-local-test') as HTMLButtonElement;
  let click: ((event: { isTrusted: boolean }) => Promise<void>) | undefined;
  const realAdd = testButton.addEventListener.bind(testButton);
  vi.spyOn(testButton, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'click') { click = listener as unknown as (event: { isTrusted: boolean }) => Promise<void>; return; }
    realAdd(type, listener);
  }) as typeof testButton.addEventListener);

  bindLocalClassificationOptions();
  const preset = document.getElementById('classification-local-preset') as HTMLSelectElement;
  const accountField = document.getElementById('classification-local-account-field')!;
  preset.value = 'custom';
  preset.dispatchEvent(new Event('change'));
  const endpoint = document.getElementById('classification-local-endpoint') as HTMLInputElement;
  endpoint.value = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run';
  endpoint.dispatchEvent(new Event('input'));
  (document.getElementById('classification-local-model') as HTMLInputElement).value = 'typesafe/jev';
  (document.getElementById('classification-local-secret') as HTMLInputElement).value = 'tok';
  const account = document.getElementById('classification-local-account') as HTMLInputElement;

  // The custom preset has no gateway, but the endpoint still needs the account id,
  // so the only input that can resolve `{account}` must stay reachable.
  expect((document.getElementById('classification-local-cf-fields') as HTMLElement).hidden).toBe(true);
  expect(accountField.hidden).toBe(false);

  // Without an account id the placeholder is refused instead of dispatched.
  await click!({ isTrusted: true });
  expect(fetched).toEqual([]);

  account.value = 'b'.repeat(32);
  await click!({ isTrusted: true });
  expect(fetched).toHaveLength(1);
  expect(fetched[0]).not.toContain('{account}');
  expect(fetched[0]).toContain('b'.repeat(32));

  // Dropping the placeholder from a non-Cloudflare endpoint hides it again.
  endpoint.value = 'https://custom.example.org/v1/systemone';
  endpoint.dispatchEvent(new Event('input'));
  expect(accountField.hidden).toBe(true);

  // A Cloudflare preset always shows the account id.
  preset.value = 'cloudflare';
  preset.dispatchEvent(new Event('change'));
  expect(accountField.hidden).toBe(false);
});

test('enabling local mode keeps the key on this browser only, never in session or sync storage', async () => {
  mountOptionsDom();
  const localValues: Record<string, unknown> = {};
  const sessionValues: Record<string, unknown> = {};
  const syncValues: Record<string, unknown> = {};
  const granted = new Set<string>();
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage(localValues), session: memoryStorage(sessionValues), sync: memoryStorage(syncValues) },
    permissions: {
      contains: vi.fn(async (input: { origins: string[] }) => input.origins.every(origin => granted.has(origin))),
      request: vi.fn(async (input: { origins: string[] }) => { for (const origin of input.origins) granted.add(origin); return true; }),
      remove: vi.fn(async (input: { origins: string[] }) => { for (const origin of input.origins) granted.delete(origin); return true; }),
    },
    // Signed out with no synced collection: local-first enabling must not depend on either.
    runtime: { sendMessage: vi.fn(async () => ({ ok: false, error: 'reconnect_required' })) },
  });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });

  const secret = 'fixture-secret-value';
  const enable = document.getElementById('classification-local-enable') as HTMLButtonElement;
  let click: ((event: { isTrusted: boolean }) => void) | undefined;
  const realAdd = enable.addEventListener.bind(enable);
  vi.spyOn(enable, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'click') { click = listener as unknown as (event: { isTrusted: boolean }) => void; return; }
    realAdd(type, listener);
  }) as typeof enable.addEventListener);

  bindLocalClassificationOptions();
  (document.getElementById('classification-local-account') as HTMLInputElement).value = 'a'.repeat(32);
  (document.getElementById('classification-local-secret') as HTMLInputElement).value = secret;
  (document.getElementById('classification-local-disclosure') as HTMLInputElement).checked = true;

  click!({ isTrusted: true });
  await vi.waitFor(() => { expect(localValues[LOCAL_CLASSIFICATION_KEY]).toBeTruthy(); });

  // The credential survives a browser restart in its own storage.local slot; nothing syncs it.
  expect(JSON.stringify(localValues[LOCAL_CLASSIFICATION_KEY])).toContain(secret);
  expect(JSON.stringify({ ...localValues, [LOCAL_CLASSIFICATION_KEY]: undefined })).not.toContain(secret);
  expect(JSON.stringify(sessionValues)).not.toContain(secret);
  expect(JSON.stringify(syncValues)).not.toContain(secret);
  expect(Object.keys(syncValues)).toEqual([]);
});

test('re-saving with the key left blank keeps the stored key, but only for the same provider host', async () => {
  mountOptionsDom();
  const stored: LocalClassificationCredential = { version: 3, generation: 'credential-3', presetId: 'typesafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', secret: 'stored-key', disclosed: true };
  const localValues: Record<string, unknown> = { [LOCAL_CLASSIFICATION_ENABLED]: true, [LOCAL_CLASSIFICATION_KEY]: stored };
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage(localValues), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const enable = document.getElementById('classification-local-enable') as HTMLButtonElement;
  let click: ((event: { isTrusted: boolean }) => void) | undefined;
  const realAdd = enable.addEventListener.bind(enable);
  vi.spyOn(enable, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === 'click') { click = listener as unknown as (event: { isTrusted: boolean }) => void; return; }
    realAdd(type, listener);
  }) as typeof enable.addEventListener);

  bindLocalClassificationOptions();
  const endpoint = document.getElementById('classification-local-endpoint') as HTMLInputElement;
  await vi.waitFor(() => { expect(endpoint.value).toBe(stored.endpoint); });
  (document.getElementById('classification-local-disclosure') as HTMLInputElement).checked = true;

  click!({ isTrusted: true });
  await vi.waitFor(() => { expect((localValues[LOCAL_CLASSIFICATION_KEY] as LocalClassificationCredential).generation).not.toBe('credential-3'); });
  expect((localValues[LOCAL_CLASSIFICATION_KEY] as LocalClassificationCredential).secret).toBe('stored-key');

  const before = localValues[LOCAL_CLASSIFICATION_KEY];
  endpoint.value = 'https://other.example.org/v1/systemone';
  endpoint.dispatchEvent(new Event('input'));
  click!({ isTrusted: true });
  await vi.waitFor(() => { expect(document.querySelector('.toast:not(.is-closing) .toast-message')?.textContent).toContain('Enter the'); });
  expect(localValues[LOCAL_CLASSIFICATION_KEY]).toBe(before);
});

test('switching to server classification keeps the saved key, and switching back reuses it', async () => {
  mountOptionsDom();
  const stored: LocalClassificationCredential = { version: 3, generation: 'credential-4', presetId: 'typesafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', secret: 'kept-key', disclosed: true };
  const localValues: Record<string, unknown> = { [LOCAL_CLASSIFICATION_ENABLED]: true, [LOCAL_CLASSIFICATION_KEY]: stored };
  const granted = new Set<string>(['https://api.typesafe.ai/*']);
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage(localValues), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: {
      contains: vi.fn(async (input: { origins: string[] }) => input.origins.every(origin => granted.has(origin))),
      request: vi.fn(async (input: { origins: string[] }) => { for (const origin of input.origins) granted.add(origin); return true; }),
      remove: vi.fn(async (input: { origins: string[] }) => { for (const origin of input.origins) granted.delete(origin); return true; }),
    },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  });
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const clicks = new Map<string, (event: { isTrusted: boolean }) => unknown>();
  for (const id of ['classification-local-enable', 'classification-local-disable']) {
    const button = document.getElementById(id) as HTMLButtonElement, realAdd = button.addEventListener.bind(button);
    vi.spyOn(button, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'click') { clicks.set(id, listener as unknown as (event: { isTrusted: boolean }) => unknown); return; }
      realAdd(type, listener);
    }) as typeof button.addEventListener);
  }

  bindLocalClassificationOptions();
  const endpoint = document.getElementById('classification-local-endpoint') as HTMLInputElement;
  await vi.waitFor(() => { expect(endpoint.value).toBe(stored.endpoint); });

  await clicks.get('classification-local-disable')!({ isTrusted: true });
  expect(localValues[LOCAL_CLASSIFICATION_ENABLED]).toBeUndefined();
  expect(localValues[LOCAL_CLASSIFICATION_KEY]).toEqual(stored);
  expect(granted.has('https://api.typesafe.ai/*')).toBe(false);
  expect((document.getElementById('classification-local-secret') as HTMLInputElement).placeholder).toContain('Saved on this browser');

  (document.getElementById('classification-local-disclosure') as HTMLInputElement).checked = true;
  clicks.get('classification-local-enable')!({ isTrusted: true });
  await vi.waitFor(() => { expect(localValues[LOCAL_CLASSIFICATION_ENABLED]).toBe(true); });
  await vi.waitFor(() => { expect((localValues[LOCAL_CLASSIFICATION_KEY] as LocalClassificationCredential).generation).not.toBe('credential-4'); });
  expect((localValues[LOCAL_CLASSIFICATION_KEY] as LocalClassificationCredential).secret).toBe('kept-key');
  expect(await localClassificationCredential()).toMatchObject({ secret: 'kept-key' });
});

test('signed out, the source choice opens on your own AI service; signing in moves it to Know-N', async () => {
  mountOptionsDom();
  for (const value of ['know-n', 'own']) {
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'classification-source'; radio.value = value;
    document.body.append(radio);
  }
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', {
    storage: { local: memoryStorage({}), session: memoryStorage({}), sync: memoryStorage({}) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) },
  });
  const checked = () => document.querySelector<HTMLInputElement>('input[name="classification-source"]:checked')?.value;
  bindLocalClassificationOptions();
  await vi.waitFor(() => expect(checked()).toBe('own'));
  expect(document.getElementById('classification-local-status')!.textContent).toBe('No suggestions until you use this service.');
  document.body.dataset.state = 'connected';
  await vi.waitFor(() => expect(checked()).toBe('know-n'));
  delete document.body.dataset.state;
});
