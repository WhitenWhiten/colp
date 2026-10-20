import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach,beforeEach,expect,test,vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { automationDatabase } from '../src/automation/indexeddb-store.js';
import { automationOwnerKey } from '../src/automation/bundle-store.js';
import { AUTOMATION_BUNDLE_KEY, AUTOMATION_RECEIPTS_KEY } from '../src/automation/messages.js';
import { BROWSER_PLACEMENTS_KEY } from '../src/automation/browser-rule-store.js';
import { SERVER_STATUS_KEY } from '../src/automation/server-status.js';
import { AUTOMATION_BADGE_KEY } from '../src/action-badge.js';
import type { SubscriptionStore } from '../src/bookmark-subscriptions/store.js';
import type { createMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
const state=vi.hoisted(()=>({db:undefined as unknown as SubscriptionStore,maintenance:undefined as unknown as ReturnType<typeof createMaintenance>,logout:vi.fn(),clear:vi.fn(),personalCleanup:vi.fn()}));
vi.mock('../src/bookmark-subscriptions/runtime.js',()=>({prepareSubscriptionLogout:(account:string,origin:string)=>state.db.prepareCleanup(account,origin),maintenance:{cleanup:()=>state.maintenance.cleanup()},wakeSubscriptions:vi.fn()}));
vi.mock('../src/sw/runtime.js',()=>({store:{loadCredential:async()=>({subject:'account-a',serverOrigin:'https://known.test'}),loadBinding:async()=>null,clearAuthority:()=>state.clear()},sw:{},syncState:{cleanupAccount:()=>state.personalCleanup()},workCoordinator:{drain:async()=>{}},COLLECTION_BINDING:'binding',WELCOME_FLAG:'welcome'}));
vi.mock('../src/sw/scope.js',()=>({loadConfig:async()=>({environment:'test',serverOrigin:'https://known.test'}),enforceManagedPolicy:async()=>{},createRuntimeAuth:()=>({logout:()=>state.logout()}),currentSyncScope:vi.fn(),ensureSyncScope:vi.fn(),hasBoundCollection:vi.fn(),pushSessionAuthority:vi.fn(),retire:vi.fn(),scheduleSessionFreshen:vi.fn()}));
vi.mock('../src/sw/engine.js',()=>({scheduleSyncEngineWake:vi.fn()}));
vi.mock('../src/sw/personal-sync.js',()=>({suspendPersonalSyncForLogout:vi.fn()}));
vi.mock('../src/sw/library.js',()=>({verifyLibraryAvailability:vi.fn()}));
vi.mock('../src/save-context-cache.js',()=>({clearSaveContextCache:async()=>{}}));
import { handle } from '../src/sw/auth.js';
import { createMaintenance as buildMaintenance } from '../src/bookmark-subscriptions/maintenance.js';
import { createNativeExecutor } from '../src/bookmark-subscriptions/native.js';
import { database,nativeFixture,row,root,owned } from './bookmark-subscriptions-fixture.js';
let fixture:ReturnType<typeof nativeFixture>;
const ownerKey = automationOwnerKey({ accountId: 'account-a', serverOrigin: 'https://known.test' });
const otherOwner = automationOwnerKey({ accountId: 'account-b', serverOrigin: 'https://known.test' });
beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { storage: { local: new MemoryStorageArea(), session: new MemoryStorageArea() },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}) } });
  const area = automationDatabase().area();
  await area.set(AUTOMATION_BUNDLE_KEY, { ownerKey, version: 1 });
  await area.set(SERVER_STATUS_KEY, { ownerKey, version: 1 });
  await area.set(AUTOMATION_RECEIPTS_KEY, [{ ownerKey, localReceiptId: 'owned' },
    { ownerKey: otherOwner, localReceiptId: 'another-account' }]);
  await area.set(BROWSER_PLACEMENTS_KEY, [{ nativeId: 'browser-owned' }]);
  await chrome.storage.local.set({
    'known.automation.pause.v1': { ownerKey, pausedAt: '2026-10-20T00:00:00Z' },
    'known.automation.device.v1': { key: JSON.stringify([ownerKey, 'replica']), deviceId: 'device' },
    [AUTOMATION_BADGE_KEY]: { text: '1', color: '#123456', title: 'Account unread' },
  });
});
beforeEach(async()=>{state.db=database();fixture=nativeFixture();const mapping={...row(),rootNativeId:'source-root'};await state.db.put('mappings',mapping);fixture.nodes.set('source-root',{id:'source-root',parentId:'bar',title:'Source'});await state.db.put('nodes',owned(mapping,root,'source-root'));state.maintenance=buildMaintenance(state.db,createNativeExecutor(state.db,fixture.api));state.clear.mockReset();state.personalCleanup.mockReset();state.logout.mockReset();state.logout.mockImplementation(async()=>{expect(await state.db.get('mappings',mapping.id)).toMatchObject({cleanup:true,enabled:false,applyEpoch:2});return {status:'signed_out'};});});
afterEach(async()=>{await state.db.close();automationDatabase().close();vi.unstubAllGlobals();});
async function expectAccountAutomationCleared() {
  const area = automationDatabase().area();
  expect(await area.get(AUTOMATION_BUNDLE_KEY)).toBeUndefined();
  expect(await area.get(SERVER_STATUS_KEY)).toBeUndefined();
  expect(await area.get(AUTOMATION_RECEIPTS_KEY)).toEqual([{ ownerKey: otherOwner, localReceiptId: 'another-account' }]);
  expect(await area.get(BROWSER_PLACEMENTS_KEY)).toEqual([{ nativeId: 'browser-owned' }]);
  expect(await chrome.storage.local.get(['known.automation.pause.v1', 'known.automation.device.v1', AUTOMATION_BADGE_KEY])).toEqual({});
  expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
}
test('production logout cleans subscription native ownership when no personal collection binding exists',async()=>{
 const result=await handle({kind:'known.auth.logout',userGesture:true},{generation:1,signal:new AbortController().signal});
 expect(result.ok).toBe(true);expect(state.clear).toHaveBeenCalledOnce();expect(state.personalCleanup).not.toHaveBeenCalled();expect(fixture.nodes.has('source-root')).toBe(false);expect(await state.db.all('nodes')).toEqual([]);expect(await state.db.get('mappings',row().id)).toMatchObject({cleanup:false,enabled:false,state:'paused',error:'local_enable_required'});
 await expectAccountAutomationCleared();
});
test('logout survives a denied native cleanup and reopened storage resumes only the old mapping cleanup',async()=>{
 const remove=fixture.api.remove;fixture.api.remove=async()=>{throw new Error('Permission denied');};
 await handle({kind:'known.auth.logout',userGesture:true},{generation:1,signal:new AbortController().signal});expect(await state.db.get('mappings',row().id)).toMatchObject({cleanup:true,enabled:false,state:'repair_pending'});expect(await state.db.all('nodes')).toHaveLength(1);await state.db.close();
 await expectAccountAutomationCleared();
 fixture.api.remove=remove;await state.maintenance.cleanup();expect(fixture.nodes.has('source-root')).toBe(false);expect(await state.db.get('mappings',row().id)).toMatchObject({cleanup:false,enabled:false,state:'paused'});expect(state.personalCleanup).not.toHaveBeenCalled();
});
