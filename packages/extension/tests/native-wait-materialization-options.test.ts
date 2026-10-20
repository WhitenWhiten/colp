// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { subscriptionStore } from '../src/bookmark-subscriptions/store.js';
import { bindNativeWaitSettings } from '../src/native-wait-ui.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { handleNativeWaitRequest } from '../src/sw/native-wait.js';
import type { NativeWaitRequest, NativeWaitResponse } from '../src/types.js';
import { materializationWait } from './pull-materialize-wait-fixture.js';

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  document.body.replaceChildren(); await subscriptionStore.close();
});

async function mount(observed = true) {
  const f = await materializationWait(observed), replies: NativeWaitResponse[] = [];
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const send = vi.fn(async (message: NativeWaitRequest) => {
    const reply = await handleNativeWaitRequest(message, f.deps, await f.effects(createChromePullBookmarkApi()));
    if (message.kind === 'known.nativeWait.confirm') replies.push(reply);
    return reply;
  });
  vi.stubGlobal('chrome', { bookmarks: f.native, runtime: { sendMessage: send } });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  bindNativeWaitSettings();
  await vi.waitFor(() => expect(document.querySelector('.native-wait-item')).not.toBeNull());
  const row = document.querySelector<HTMLElement>('.native-wait-item')!;
  return { f, replies, send, row };
}

test('actual list projects the observed candidate and Options explicit selection reaches runtime confirmation', async () => {
  const { f, row, replies, send } = await mount();
  try {
    const select = row.querySelector<HTMLSelectElement>('.native-wait-candidate');
    expect(select).not.toBeNull(); // RED before projection used nativeEventEvidence.
    expect(Array.from(select!.options).map(option => option.value)).toEqual([f.orphan.id]);
    expect(send.mock.calls.filter(([message]) => message.kind === 'known.nativeWait.confirm')).toHaveLength(0);
    expect(f.raw).toHaveBeenCalledTimes(1);
    const bind = row.querySelector<HTMLButtonElement>('[data-native-wait-action="bind"]')!;
    expect(bind.hidden).toBe(false);
    select!.value = f.orphan.id; bind.click();
    await vi.waitFor(() => expect(replies).toEqual([{ ok: true, result: 'bound', nativeId: f.orphan.id }]));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.nativeWait.confirm',
      userGesture: true, action: 'bind', nativeId: f.orphan.id, waitRef: f.wait.waitRef }));
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResultConfirmation)
      .toEqual({ kind: 'candidate_event', nativeId: f.orphan.id });
    f.restart(); await (await f.applier()).resume();
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(f.raw).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('a same-shaped manual candidate injected into the DOM cannot satisfy the runtime evidence check', async () => {
  const { f, row, replies } = await mount();
  try {
    const select = row.querySelector<HTMLSelectElement>('.native-wait-candidate');
    expect(select).not.toBeNull();
    const manual = await f.native.create({ parentId: '4', title: f.orphan.title });
    const option = document.createElement('option'); option.value = manual.id; select!.append(option);
    select!.value = manual.id;
    row.querySelector<HTMLButtonElement>('[data-native-wait-action="bind"]')!.click();
    await vi.waitFor(() => expect(replies).toEqual([{ ok: false, code: 'request_invalid' }]));
    expect((await f.store.getApplyIntent(f.scope, f.wait.intentId))?.nativeResult).toBe('result_unknown');
    expect(await f.store.getMappingByNativeId(f.scope, manual.id)).toBeNull();
    expect((await f.store.getMappingByColpId(f.scope, 'target'))?.nativeId).toBe('2');
  } finally { f.close(); }
});

test('no correlated event means no Bind control; the real Keep both exit remains usable', async () => {
  const { f, row, replies, send } = await mount(false);
  try {
    expect(row.querySelector('.native-wait-candidate')).toBeNull();
    const bind = row.querySelector<HTMLButtonElement>('[data-native-wait-action="bind"]')!;
    expect(bind.hidden).toBe(true); bind.click();
    expect(send.mock.calls.filter(([message]) => message.kind === 'known.nativeWait.confirm')).toHaveLength(0);
    row.querySelector<HTMLButtonElement>('[data-native-wait-action="keep_local_and_create"]')!.click();
    await vi.waitFor(() => expect(replies).toEqual([expect.objectContaining({ ok: true, result: 'kept_local' })]));
    f.restart(); await (await f.applier()).resume();
    expect((await f.store.getCursor(f.scope))?.cursor).toBe('next');
    expect(await f.native.getChildren('4')).toHaveLength(2);
  } finally { f.close(); }
});
