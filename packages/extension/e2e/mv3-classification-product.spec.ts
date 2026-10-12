import { grantBookmarks, confirmFirstRun, waitFirstRunProductQuiet, wakeEngine } from './kns-08-harness.js';
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { startRealStack } from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import { EXTENSION_ID, openExtensionOptions, signInExtension } from './extension-auth.js';
import { grantTabAccess, openPopupOver } from './popup-page.js';
import { FIXTURE_COLLECTION_ID } from './fixture-ids.js';

/** The bookmark's tags in this browser's annotation store. */
async function readLocalTags(page:Page,url:string):Promise<unknown>{
  return page.evaluate(async url=>{
    const [bookmark]=await chrome.bookmarks.search({url});if(!bookmark)return null;
    return new Promise(resolve=>{const open=indexedDB.open('known-bookmark-annotations',1);
      open.onsuccess=()=>{const db=open.result,request=db.transaction('bookmarks').objectStore('bookmarks').get(bookmark.id);
        request.onsuccess=()=>{resolve((request.result as {tags?:string[]}|undefined)?.tags??null);db.close();};};});
  },url);
}

// Capture, classification, credits and the favicon helper are Know-N backend routes.
test.skip(!knowNBackendRoot, KNOW_N_BACKEND_ONLY);

test('real Chromium Product cookies bootstrap CSRF, reject COLP/mixed carriers and survive session rotation',async()=>{
  const stack=await startRealStack({classification:true});
  const extensionPath=resolve(import.meta.dirname,'../dist/production');
  const context=await chromium.launchPersistentContext('',{headless:false,channel:'chromium',ignoreHTTPSErrors:true,
    args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`,'--no-proxy-server','--ignore-certificate-errors']});
  try{
    const {page}=await openExtensionOptions(context);
    await page.evaluate(({binding,collection})=>chrome.storage.local.set({'known.auth.binding.v1':binding,'known.sync.collection.v1':collection}),
      {binding:stack.extensionBinding,collection:FIXTURE_COLLECTION_ID});
    await signInExtension(page);
    await stack.classificationProduct!.fundClassification(FIXTURE_COLLECTION_ID);
    // The fixture runs with tags enabled, so a tags preview reaches the provider (unavailable until switched on).
    stack.classificationProduct!.setProviderAvailable();
    const bootstrap=await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.classification.session'}));
    expect(bootstrap).toEqual({ok:true,result:{authenticated:true}});
    const billing=await page.evaluate(async()=>{
      const response=await fetch('https://known.example/api/v1/me/credits?includeBillingMode=true',{credentials:'include'});
      if(!response.ok)throw new Error('credit_overview_failed');
      const overview=await response.json() as {prices:{operationType:string;priceVersion:string;unitPoints:number}[]};
      const price=overview.prices.find(item=>item.operationType==='bookmark.classify');
      if(!price)throw new Error('classification_price_missing');
      return {priceVersion:price.priceVersion,maxPoints:price.unitPoints};
    });
    const document={source:'extension',bookmark:{title:'Cookie classification',url:'https://example.org/',description:null},requested:{folder:false,tags:true},billing};
    const commandId=crypto.randomUUID();
    const message={kind:'known.classification.preview',collectionId:FIXTURE_COLLECTION_ID,commandId,userGesture:true,document};
    const result=await page.evaluate(message=>chrome.runtime.sendMessage(message),message);
    expect(result,JSON.stringify(result)).toMatchObject({ok:true,result:{folder:null,tags:{mode:'suggest',candidates:[]}}});
    expect(await page.evaluate(message=>chrome.runtime.sendMessage(message),message)).toEqual(result);
    const statuses=await page.evaluate(async({collectionId,document})=>{
      const values=await chrome.storage.session.get('known.auth.credential.v1');
      const token=(values['known.auth.credential.v1'] as {accessToken:string}).accessToken;
      const path=`https://known.example/api/v1/collections/${collectionId}/classification/preview`;
      const send=async(credentials:RequestCredentials)=>{
        const response=await fetch(path,{method:'POST',credentials,headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,
          'Known-Command-Id':crypto.randomUUID(),'X-CSRF-Token':'not-used'},body:JSON.stringify(document)});
        return response.status;
      };
      return [await send('omit'),await send('include')];
    },{collectionId:FIXTURE_COLLECTION_ID,document});
    expect(statuses).toEqual([401,400]);
    const before=(await context.cookies('https://known.example')).find(cookie=>cookie.name==='__Host-known_session')!;
    await stack.classificationProduct!.ageSessions();
    const rotated=await page.evaluate(message=>chrome.runtime.sendMessage(message),{...message,commandId:crypto.randomUUID()});
    expect(rotated).toMatchObject({ok:true});
    const after=(await context.cookies('https://known.example')).find(cookie=>cookie.name==='__Host-known_session')!;
    expect(Boolean(before.value&&after.value&&before.value!==after.value)).toBe(true);
    const observations=stack.classificationProduct!.observations();
    expect(observations.filter(row=>row.path.endsWith('/classification/preview')&&row.status===200)).toHaveLength(3);
    expect(observations.filter(row=>row.path.endsWith('/classification/preview')&&row.status===200).every(row=>row.cookie&&row.csrf&&!row.bearer&&row.origin===`chrome-extension://${EXTENSION_ID}`)).toBe(true);
    await context.clearCookies();
    expect(await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.classification.session'}))).toMatchObject({ok:false,error:'reconnect_required'});
  }finally{await context.close();await stack.close();}
});

async function openHttpTab(context:BrowserContext,url:string):Promise<Page>{
  const tab=await context.newPage();
  await tab.route('**/*',(route:import('@playwright/test').Route)=>route.fulfill({status:200,contentType:'text/html',body:`<title>${url}</title>`}));
  await tab.goto(url,{waitUntil:'domcontentloaded'});return tab;
}
test('popup preserves native saves on provider failure and explicitly chooses mapped suggestions',async({},testInfo)=>{
  test.setTimeout(180000);
  const stack=await startRealStack({classification:true});
  const extensionPath=resolve(import.meta.dirname,'../dist/production');
  const context=await chromium.launchPersistentContext('',{headless:false,channel:'chromium',ignoreHTTPSErrors:true,
    args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,
      `--host-resolver-rules=${stack.browserHostResolverRules}`,'--no-proxy-server','--ignore-certificate-errors']});
  try{
    const {page}=await openExtensionOptions(context);await signInExtension(page);await grantBookmarks(page);
    await stack.classificationProduct!.fundClassification(FIXTURE_COLLECTION_ID);
    /* A real popup window closes itself 1.5s after a save (popup.ts savedCloseTimer),
       so every save flow below opens a fresh popup tab instead of reusing one. */
    await grantTabAccess(context);
    const openPopup = async (url: string) => {
      const page_ = await openPopupOver(context, await openHttpTab(context, url));
      await expect(page_.locator('#folder-suggest')).toBeVisible({ timeout: 15_000 });
      return page_;
    };
    const root=await page.evaluate(()=>chrome.bookmarks.create({title:'Classification browser mount'}));
    await confirmFirstRun(page,[root.title]);
    const binding=await page.evaluate(async()=>(await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']) as typeof stack.extensionBinding;
    await waitFirstRunProductQuiet(page,stack,binding);
    let popup = await openPopup('https://example.org/classification-outage');
    await popup.locator('#tab-title').fill('Save despite model outage');
    await popup.locator('#tab-url-display').click();
    await popup.locator('#tab-url').fill('https://example.org/classification-outage');
    await expect(popup.locator('#pp-note')).toHaveText(/^Uses \d+ credits?$/u);
    expect(stack.classificationProduct!.observations().filter(row=>row.path.endsWith('/classification/preview'))).toHaveLength(0);
    await popup.locator('#folder-suggest').click();
    await expect(popup.locator('#pp-note')).toContainText('Suggestions are unavailable',{timeout:25000});
    expect(stack.classificationProduct!.observations().filter(row=>row.path.endsWith('/classification/preview')&&row.status===503)).toHaveLength(1);
    await expect(popup.locator('#save')).toBeEnabled();
    await popup.screenshot({path:testInfo.outputPath('classification-unavailable-save-enabled.png')});
    await popup.locator('#save').click();
    await expect.poll(async()=>page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-outage'})).length)).toBe(1);
    const saved=await page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-outage'}))[0]);
    expect(saved?.parentId).toBe(root.id);
    await waitFirstRunProductQuiet(page,stack,binding);
    stack.classificationProduct!.setProviderAvailable();
    // A completed save parks the lane as `Edit` (disabled) and the popup closes
    // itself 1.5s later, so the next bookmark starts from a fresh popup — the same
    // way the tag block below does. Editing while the save is still in flight does
    // not reset the lane, and the assertion used to race exactly that.
    await popup.close().catch(() => undefined);
    popup = await openPopup('https://example.org/classification-chosen');
    await popup.locator('#tab-url-display').click();
    await popup.locator('#tab-url').fill('https://example.org/classification-chosen');
    await expect(popup.locator('#save')).toHaveText('Save');
    await popup.locator('#folder-suggest').click();
    await expect(popup.locator('#folder-suggest[data-state="apply"]')).toBeVisible({timeout:25000});
    await popup.locator('#folder-suggest').click();
    await expect(popup.locator('#ai-mark')).toBeVisible();
    await popup.locator('#save').click();
    await expect.poll(async()=>page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-chosen'})).length)).toBe(1);
    expect((await page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-chosen'}))[0]))?.parentId).toBe(root.id);

    await waitFirstRunProductQuiet(page,stack,binding);
    await stack.classificationProduct!.seedTags(FIXTURE_COLLECTION_ID);
    // Vocabulary setup performs real Product edits, which invalidate the sync
    // replica. Finish that recovery before testing the next native save.
    await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.connectivity.online'}));
    await waitFirstRunProductQuiet(page,stack,binding);
    await popup.close().catch(() => undefined);
    popup = await openPopup('https://example.org/classification-chosen');
    await popup.locator('#tab-title').fill('Chosen AI tag');
    await popup.locator('#tab-url-display').click();
    await popup.locator('#tab-url').fill('https://example.org/classification-tags');
    await popup.locator('#folder-suggest').click();
    await expect(popup.locator('#tag-suggest [data-suggest="ai"][title="AI"]')).toBeVisible({timeout:25000});
    await popup.locator('#tag-suggest [data-suggest="ai"][title="AI"]').click();
    await popup.locator('#save').click();
    await expect.poll(async()=>page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-tags'})).length)).toBe(1);
    await popup.close();
    // A chosen suggestion is the bookmark's own tag (7b2c508c1). With metadata kept local it stays in this
    // browser: the bookmark syncs without it and no tag confirmation is sent.
    await expect.poll(()=>readLocalTags(page,'https://example.org/classification-tags'),{timeout:15000}).toEqual(['AI']);
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>stack.classificationProduct!.readTags('https://example.org/classification-tags'),{timeout:60000}).toEqual([{tags:[]}]);
    expect(stack.classificationProduct!.observations().filter(row=>row.path.endsWith('/classification-confirmations'))).toHaveLength(0);
    const nativeId=await page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/classification-tags'}))[0]!.id);
    const readProjection=(targetNativeId=nativeId)=>page.evaluate(async nativeId=>{
      const db=await new Promise<IDBDatabase>((resolve,reject)=>{
        const request=indexedDB.open('known-phase3-indexeddb-entry');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      try{
        return await new Promise<unknown>((resolve,reject)=>{
          const request=db.transaction('native_mappings').objectStore('native_mappings').getAll();
          request.onsuccess=()=>{const content=request.result.find(row=>row.nativeId===nativeId)?.projection.content;
            resolve(content?{tags:[],...content}:null);};
          request.onerror=()=>reject(request.error);
        });
      }finally{db.close();}
    },targetNativeId);
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(async()=>{await wakeEngine(page);return readProjection();},{timeout:60000}).toMatchObject({tags:[]});
    await stack.classificationProduct!.editBookmark('https://example.org/classification-tags',[],'Description edited by the user');
    await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.connectivity.online'}));
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>readProjection(),{timeout:60000}).toMatchObject({tags:[],description:'Description edited by the user'});
    await expect.poll(()=>stack.classificationProduct!.readTags('https://example.org/classification-tags')).toEqual([{tags:[]}]);
    // The server edit does not reach the bookmark's local tags.
    expect(await readLocalTags(page,'https://example.org/classification-tags')).toEqual(['AI']);
    await stack.classificationProduct!.enableAutoTags(FIXTURE_COLLECTION_ID);
    const autoUrl='https://example.org/classification-auto';
    const autoNative=await page.evaluate(async({parentId,url})=>chrome.bookmarks.create({parentId,url,title:'Auto tagged after sync'}),{parentId:root.id,url:autoUrl});
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>stack.classificationProduct!.readTags(autoUrl),{timeout:30000}).toEqual([{tags:[]}]);
    expect(await stack.classificationProduct!.drainAutoTags()).toBe(true);
    expect(await stack.classificationProduct!.readTags(autoUrl)).toEqual([{tags:['AI']}]);
    await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.connectivity.online'}));
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>readProjection(autoNative.id),{timeout:60000}).toMatchObject({tags:['AI']});
    await stack.classificationProduct!.editBookmark(autoUrl,[],'User removed the automatic tag');
    await page.evaluate(()=>chrome.runtime.sendMessage({kind:'known.connectivity.online'}));
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>readProjection(autoNative.id),{timeout:60000}).toMatchObject({tags:[],description:'User removed the automatic tag'});
    expect(await stack.classificationProduct!.drainAutoTags()).toBe(false);
    expect(await stack.classificationProduct!.readTags(autoUrl)).toEqual([{tags:[]}]);

  }finally{await context.close();await stack.close();}
});
