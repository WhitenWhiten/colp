import {compareClassificationMode,enableFixtureByok,comparisonDocument} from './classification-mode-comparison.js';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {test,expect,chromium,type BrowserContext,type Page} from '@playwright/test';
import {startRealStack} from './real-stack.js';
import { KNOW_N_BACKEND_ONLY, knowNBackendRoot } from './cloud-product-fixtures.js';
import {openExtensionOptions,signInExtension} from './extension-auth.js';
import {grantTabAccess,openPopupOver} from './popup-page.js';
import {grantBookmarks,confirmFirstRun,waitFirstRunProductQuiet} from './kns-08-harness.js';
import {grantOptionalBookmarks} from './bookmark-permission.js';
import {FIXTURE_COLLECTION_ID} from './fixture-ids.js';
async function openHttpTab(context:BrowserContext,url:string):Promise<Page>{
  const tab=await context.newPage();
  await tab.route('**/*',(route)=>route.fulfill({status:200,contentType:'text/html',body:`<title>${url}</title>`}));
  await tab.goto(url,{waitUntil:'domcontentloaded'});return tab;
}
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

test('local preset permission, browser-folder suggestions, session-only key and a local AI tag',async({},testInfo)=>{
  test.setTimeout(180000);
  const stack=await startRealStack({classification:true}),profile=await mkdtemp(join(tmpdir(),'known-local-classification-'));
  const extensionPath=resolve(import.meta.dirname,'../dist/production');
  const launch=()=>chromium.launchPersistentContext(profile,{headless:false,channel:'chromium',ignoreHTTPSErrors:true,
    args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,`--host-resolver-rules=${stack.browserHostResolverRules}`,'--no-proxy-server','--ignore-certificate-errors']});
  let context=await launch();context.setDefaultTimeout(20000);
  try{
    const {page}=await openExtensionOptions(context);await signInExtension(page);await grantBookmarks(page);
    const root=await page.evaluate(()=>chrome.bookmarks.create({title:'Local classification mount'}));
    await confirmFirstRun(page,[root.title]);
    const binding=await page.evaluate(async()=>(await chrome.storage.local.get('known.auth.binding.v1'))['known.auth.binding.v1']) as typeof stack.extensionBinding;
    await waitFirstRunProductQuiet(page,stack,binding);
    await page.evaluate(parentId=>chrome.bookmarks.create({parentId,title:'Vocabulary seed',url:'https://example.org/local-seed'}),root.id);
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>stack.classificationProduct!.readTags('https://example.org/local-seed'),{timeout:30000}).toEqual([{tags:[]}]);
    await stack.classificationProduct!.seedTags(FIXTURE_COLLECTION_ID);
    // The first compared mode is a hosted `server_managed` preview, which spends a
    // credit; without this grant the run stops at 409 insufficient_credits before
    // any preset behaviour is exercised (the sibling product spec funds the same way).
    await stack.classificationProduct!.fundClassification(FIXTURE_COLLECTION_ID);
    stack.classificationProduct!.setProviderAvailable();
    const modes=[await compareClassificationMode(page,stack,'server_managed')];
    const web=await context.newPage();await enableFixtureByok(web);await web.close();
    modes.push(await compareClassificationMode(page,stack,'server_byok'));
    await page.locator('#nav-ai').click();
    await page.locator('#classification-source-own').check();
    await expect(page.locator('#classification-local-settings')).toBeVisible();
    // Endpoint, model and the gateway fields sit under "Advanced service settings".
    await page.locator('#classification-local-advanced > summary').click();
    // Selecting a preset fills endpoint, model, candidate list and credential label; all stay editable.
    await page.locator('#classification-local-preset').selectOption('typesafe');
    await expect(page.locator('#classification-local-endpoint')).toHaveValue('https://api.typesafe.ai/v1/systemone');
    await expect(page.locator('#classification-local-model')).toHaveValue('jev-latest');
    await expect(page.locator('#classification-local-cf-fields')).toBeHidden();
    await expect(page.locator('#classification-local-secret-label')).toContainText('TypeSafe');
    await page.locator('#classification-local-preset').selectOption('vercel');
    await expect(page.locator('#classification-local-endpoint')).toHaveValue('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    await expect(page.locator('#classification-local-model')).toHaveValue('typesafe-ai/jev');
    await page.locator('#classification-local-preset').selectOption('custom');
    await expect(page.locator('#classification-local-endpoint')).toHaveValue('');
    await expect(page.locator('#classification-local-cf-fields')).toBeHidden();
    await page.locator('#classification-local-preset').selectOption('cloudflare');
    await expect(page.locator('#classification-local-cf-fields')).toBeVisible();
    await expect(page.locator('#classification-local-endpoint')).toHaveValue('https://api.cloudflare.com/client/v4/accounts/{account}/ai/run');
    await expect(page.locator('#classification-local-model')).toHaveValue('typesafe/jev');
    await page.locator('#classification-local-account').fill('a'.repeat(32));await page.locator('#classification-local-secret').fill('local-fixture-secret');
    await page.locator('#classification-local-disclosure').check();
    expect(await page.evaluate(()=>chrome.permissions.contains({origins:['https://api.cloudflare.com/*']}))).toBe(false);
    await grantOptionalBookmarks(page,'Use this AI service','Known local provider permission',{origins:['https://api.cloudflare.com/*']},async()=>{await page.locator('#classification-local-secret').fill('local-fixture-secret');});
    await expect(page.locator('#classification-local-status')).toContainText('Using your own AI service',{timeout:30000});
    await expect.poll(()=>page.evaluate(async()=>((await chrome.storage.session.get('known.classification.local-projection.v1'))['known.classification.local-projection.v1'] as {tagUsage?:{tag:string}[]}|undefined)?.tagUsage?.some(row=>row.tag==='AI')===true),{timeout:60000}).toBe(true);
    expect(modes[1]!.decision).toEqual(modes[0]!.decision);expect(modes[1]!.providerInputHashes).toEqual(modes[0]!.providerInputHashes);
    // Local-first: local mode chooses among this browser's folders (native ids), so it
    // is not compared with the collection-based server modes. It must still answer
    // with a real browser folder and never touch the Product preview route.
    const serverPreviews=stack.classificationProduct!.observations().filter(call=>call.path.endsWith('/classification/preview')).length;
    const localReply=await page.evaluate(message=>chrome.runtime.sendMessage(message),{kind:'known.classification.local-preview',commandId:crypto.randomUUID(),userGesture:true,document:comparisonDocument}) as
      {ok:boolean;result?:{folder:unknown};nativeFolder?:{nativeId:string}|null};
    expect(localReply).toMatchObject({ok:true});
    if(localReply.nativeFolder)expect(await page.evaluate(id=>chrome.bookmarks.get(id).then(nodes=>nodes[0]?.url),localReply.nativeFolder.nativeId)).toBeUndefined();
    expect(stack.classificationProduct!.observations().filter(call=>call.path.endsWith('/classification/preview'))).toHaveLength(serverPreviews);
    const report={experiment:'EXP-06B',provenance:'real Chromium and PostgreSQL; one controlled HTTP fixture, not a live provider',productionGatePassed:false,
      reason:'Live provider credentials unavailable; fixture timings and token accounting cannot establish real latency, failure rate or spend.',modes:modes.map(({decision:_decision,providerInputHashes:_hashes,...row})=>row)};
    const reportPath=testInfo.outputPath('classification-mode-comparison.json');await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    await testInfo.attach('classification-mode-comparison',{path:reportPath,contentType:'application/json'});
    const stored=await page.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
    // The key lives in its own storage.local entry only: never in session storage or any other entry.
    expect(JSON.stringify(stored.local['known.classification.local-key.v1'])).toContain('local-fixture-secret');
    expect(JSON.stringify({...stored.local,'known.classification.local-key.v1':undefined})).not.toContain('local-fixture-secret');
    expect(JSON.stringify(stored.session)).not.toContain('local-fixture-secret');
    const serverCalls=stack.classificationProduct!.observations().filter(call=>call.path.endsWith('/classification/preview')).length;
    // Settle the queue on the options page first, exactly like the sibling product
    // spec: opening the popup starts new service-worker work, which keeps the
    // first-run predicate from settling on its own.
    await waitFirstRunProductQuiet(page,stack,binding);
    await grantTabAccess(context);
    const popup=await openPopupOver(context,await openHttpTab(context,'https://example.org/local-classified'));
    // The classification block must be ready before the run button is actionable,
    // exactly as the sibling product spec waits for it.
    await expect(popup.locator('#folder-suggest')).toBeVisible({timeout:15000});
    // Wait for the classification block the way the sibling product spec does: the
    // popup re-renders once its settings (and the `?surface=` re-navigation) settle,
    // and an action issued before that never completes.
    await expect(popup.locator('#folder-suggest')).toBeVisible({timeout:15000});
    await popup.locator('#tab-title').fill('Local AI bookmark');
    await popup.locator('#tab-url-display').click();
    await popup.locator('#tab-url').fill('https://example.org/local-classified');
    await popup.locator('#folder-suggest').click();
    await expect(popup.locator('#tag-suggest [data-suggest="ai"][title="AI"]')).toBeVisible({timeout:30000});
    expect(stack.classificationProduct!.localCalls().length).toBeGreaterThan(0);
    expect(stack.classificationProduct!.localCalls().every(call=>call.host==='api.cloudflare.com'&&!call.cookie)).toBe(true);
    expect(stack.classificationProduct!.observations().filter(call=>call.path.endsWith('/classification/preview'))).toHaveLength(serverCalls);
    const localCommand=await page.evaluate(async()=>(await chrome.storage.session.get('known.classification.local-commands.v1'))['known.classification.local-commands.v1'] as {commands:string[]});
    await popup.locator('#tag-suggest [data-suggest="ai"][title="AI"]').click();
    await popup.locator('#save').click();
    await expect.poll(()=>page.evaluate(async()=> (await chrome.bookmarks.search({url:'https://example.org/local-classified'})).length),{timeout:15000}).toBe(1);
    await popup.close();
    // A chosen suggestion is the bookmark's own tag (7b2c508c1). With metadata kept local it stays in this
    // browser: the bookmark syncs without it and no tag confirmation is sent.
    await expect.poll(()=>readLocalTags(page,'https://example.org/local-classified'),{timeout:15000}).toEqual(['AI']);
    await waitFirstRunProductQuiet(page,stack,binding);
    await expect.poll(()=>stack.classificationProduct!.readTags('https://example.org/local-classified'),{timeout:60000}).toEqual([{tags:[]}]);
    expect(stack.classificationProduct!.observations().filter(call=>call.path.endsWith('/classification-confirmations'))).toHaveLength(0);
    const providerCalls=stack.classificationProduct!.localCalls().length;
    const document=comparisonDocument;
    // A local command id is spent once: replaying it never reaches the provider again.
    const same=await page.evaluate(message=>chrome.runtime.sendMessage(message),{kind:'known.classification.local-preview',commandId:localCommand.commands[0],userGesture:true,document});
    expect(same).toMatchObject({ok:false});expect(stack.classificationProduct!.localCalls()).toHaveLength(providerCalls);
    // d5c97f072 dropped the 60-second age limit: the collection context is judged by its sync cursor, not its age,
    // so an old pull still supplies tag candidates while it matches the engine's acknowledged cursor.
    await page.evaluate(async()=>{const key='known.classification.local-projection.v1';const value=(await chrome.storage.session.get(key))[key] as object;await chrome.storage.session.set({[key]:{...value,pulledAt:Date.now()-60001}});});
    const stale=await page.evaluate(message=>chrome.runtime.sendMessage(message),{kind:'known.classification.local-preview',commandId:crypto.randomUUID(),userGesture:true,document}) as {ok:boolean;result?:{tags:{mode:string;candidates:unknown[]}}};
    expect(stale).toMatchObject({ok:true});expect(stale.result!.tags.candidates).toEqual([expect.objectContaining({tag:'AI'})]);
    await context.close();context=await launch();const reopened=(await openExtensionOptions(context)).page;
    // A browser restart keeps the key: local mode keeps working without re-entering it.
    expect(JSON.stringify(await reopened.evaluate(async()=>(await chrome.storage.local.get('known.classification.local-key.v1'))['known.classification.local-key.v1']))).toContain('local-fixture-secret');
    expect(await reopened.evaluate(async()=>(await chrome.storage.local.get('known.classification.local-enabled.v1'))['known.classification.local-enabled.v1'])).toBe(true);
  }finally{await context.close();await stack.close();await rm(profile,{recursive:true,force:true});}
});
