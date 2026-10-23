import {LOCAL_CLASSIFICATION_KEY,LOCAL_CLASSIFICATION_DRAFT,LOCAL_CLASSIFICATION_ENABLED,LOCAL_CLASSIFICATION_GRANTED_ORIGIN,localClassificationAvailable,
  clearLocalClassification,clearLocalClassificationContext,localClassificationOriginPattern,releaseStaleClassificationOrigin,storedLocalClassificationForm,type LocalClassificationCredential} from './classification-local-session.js';
import {classificationEndpointAllowed,localClassificationPreset,type LocalClassificationPreset,type LocalClassificationPresetId} from './classification-local-presets.js';
import {CLASSIFICATION_PROBE_INPUT,CLASSIFICATION_PROBE_OPTIONS} from './generated/classification/index.js';
import { t } from './i18n.js';
import { showToast, type ToastTone } from './toast.js';
import { readClassificationProbeJson } from './classification-probe-response.js';
import { bindLocalClassificationDisclosure } from './classification-local-disclosure.js';
import { releaseClassificationOrigin, sharesHostPermission } from './classification-origin-permission.js';

export interface ProbeConnectionInput {
  presetId: LocalClassificationPresetId;
  endpoint: string;
  model: string;
  secret?: string;
  gatewayId?: string;
  transport?: typeof fetch;
}

export type ProbeConnectionOutcome =
  | { ok: true; model: string }
  | { ok: false; error: string; status?: number };

export async function probeClassificationConnection(input: ProbeConnectionInput): Promise<ProbeConnectionOutcome> {

  try {
    new URL(input.endpoint);
  } catch {
    return { ok: false, error: t('classification_invalidEndpointUrl', 'Invalid endpoint URL') };
  }
  if (!classificationEndpointAllowed(input.endpoint)) {
    return { ok: false, error: t('classification_endpointUrlMustUse', 'Endpoint URL must use HTTPS, or HTTP on a local address') };
  }
  const preset = localClassificationPreset(input.presetId);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.secret) headers['Authorization'] = `Bearer ${input.secret}`;
  if (input.gatewayId) headers['cf-aig-gateway-id'] = input.gatewayId;
  // The Cloudflare preset expects the gateway's stored key under alias=default;
  // fail closed instead of silently billing Cloudflare Unified Billing credits.
  if (preset.wire === 'cloudflare_ai_run_v1') headers['cf-aig-no-wholesale'] = 'true';

  const transport = input.transport ?? globalThis.fetch;
  const signal = AbortSignal.timeout(10000);
  let response: Response;
  try {
    response = await transport(input.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(preset.wire === 'typesafe_systemone_v1'
        ? { ...CLASSIFICATION_PROBE_INPUT, model: input.model }
        : { model: input.model, input: CLASSIFICATION_PROBE_INPUT }),
      signal,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : t('common_networkError', 'Network error') };
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return { ok: false, error: '404 Not Found', status: 404 };
    if (response.status === 422) return { ok: false, error: '422 Unprocessable Entity', status: 422 };
    return { ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim(), status: response.status };
  }

  let payload: unknown;
  try {
    payload = await readClassificationProbeJson(response, signal);
  } catch {
    return { ok: false, error: 'schema_mismatch: invalid JSON' };
  }
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  // Cloudflare's universal envelope nests the System One answer under `result`.
  for (let i = 0; i < 3 && payload && !field(payload, 'answers') && field(payload, 'result'); i++) {
    payload = field(payload, 'result');
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'schema_mismatch: empty payload' };
  }
  const envelope = payload as Record<string, unknown>;
  const reportedModel = typeof envelope.model === 'string' && envelope.model.trim() ? envelope.model.trim() : null;
  if (!reportedModel) {
    return { ok: false, error: 'schema_mismatch: missing model' };
  }
  const answers = envelope.answers;
  if (!answers || typeof answers !== 'object') {
    return { ok: false, error: 'schema_mismatch: missing answers' };
  }
  const answerFields = answers as Record<string, unknown>;

  // The probe input is fixed, so every preset must answer the same bounded shape: a choice
  // inside the offered options with a normalised distribution, plus a Noul probability.
  // Weak "some object is present" acceptance would let an incompatible endpoint through.
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const folder = answerFields.folder as {choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown>} | undefined;
  const tag = answerFields.tag as {noul?: unknown} | undefined;
  const probabilities = folder?.probabilities && typeof folder.probabilities === 'object' ? folder.probabilities : null;
  const probabilityKeys = probabilities === null ? [] : Object.keys(probabilities).sort();
  const folderValid = Boolean(folder) && CLASSIFICATION_PROBE_OPTIONS.includes(String(folder!.choice))
    && finite(folder!.confidence)
    && probabilityKeys.join(',') === [...CLASSIFICATION_PROBE_OPTIONS].sort().join(',')
    && Object.values(probabilities ?? {}).every(finite)
    && Math.abs(Object.values(probabilities ?? {}).reduce<number>((sum, value) => sum + Number(value), 0) - 1) <= 1e-6;
  const tagValid = Boolean(tag) && finite(tag!.noul);
  if (!folderValid || !tagValid) {
    return { ok: false, error: preset.id === 'cloudflare'
      ? 'schema_mismatch: answers structure invalid'
      : 'schema_mismatch: endpoint does not return the bounded Choice/Noul contract' };
  }

  return { ok: true, model: reportedModel };
}

/** One plain sentence per kind of failure; the raw reason is kept on the button for diagnostics, never shown. */
export function connectionFailureCopy(probe:{ok:false;error:string;status?:number}):string{
  if(probe.status===401||probe.status===403)return t('classification_testFailedKey', 'Connection test failed. The service did not accept the key.');
  if(probe.status===404)return t('classification_testFailedNotFound', 'Connection test failed. The endpoint was not found. Check the address.');
  if(probe.status===422)return t('classification_testFailedModel', 'Connection test failed. The service did not accept the model. Check the model name.');
  if(probe.error.startsWith('schema_mismatch'))return t('classification_testFailedFormat', 'Connection test failed. The service replied in an unexpected format. Check that it supports the classification API.');
  return t('classification_connectionTestFailed', 'Connection test failed. Check the address, model and key, then try again.');
}

export function bindLocalClassificationOptions(){
  const section=document.getElementById('classification-local-settings');if(!section)return;
  bindLocalClassificationDisclosure(section);
  const field=(id:string)=>document.getElementById(id) as HTMLInputElement;
  // The inline alert only states which source is active; action results are toasts.
  const feedback=document.getElementById('classification-local-status')!;
  const alertBox=document.getElementById('classification-local-alert');
  const choices=document.getElementById('pref-classification-options');
  const knowNGroup=document.getElementById('pref-classification');
  const sourceRadios=Array.from(document.querySelectorAll?.<HTMLInputElement>('input[name="classification-source"]')??[]);
  const enable=document.getElementById('classification-local-enable') as HTMLButtonElement;
  const disable=document.getElementById('classification-local-disable') as HTMLButtonElement;
  let active=false;
  /**
   * "Suggestions come from" is a plain choice of what to look at. Choosing Know-N while your own service is in use
   * is the existing "Use Know-N suggestions" flow; choosing your own service reveals its settings, and nothing
   * changes until "Use this service" — so until then the alert says suggestions still come from Know-N.
   */
  const serverClassificationOff=()=>document.body.dataset.serverClassification==='off';
  const showSource=(source:'know-n'|'own')=>{
    const next=serverClassificationOff()&&source==='know-n'?'own':source;
    for(const radio of sourceRadios)radio.checked=radio.value===next;
    if(knowNGroup)knowNGroup.hidden=next==='own'||serverClassificationOff();
    section.hidden=next!=='own'||!localClassificationAvailable();
    if(alertBox){alertBox.hidden=next!=='own';alertBox.dataset.active=String(active);}
    feedback.textContent=active
      ?t('classification_usingLocal', 'Using your own AI service. The key is saved on this browser.')
      :signedIn()?t('classification_localNotActive', 'Suggestions still come from Know-N until you use this service.')
        :t('classification_localNotActiveSignedOut', 'No suggestions until you use this service.');
  };
  // Know-N suggestions need an account, so signed out the page opens on the choice that works without one.
  const signedIn=()=>document.body.dataset.state==='connected';
  let picked=false;
  const defaultSource=()=>active||!signedIn()||serverClassificationOff()?'own':'know-n';
  new MutationObserver(()=>{
    if(serverClassificationOff()){picked=false;showSource('own');return;}
    if(!picked&&!active)showSource(defaultSource());
  }).observe(document.body,{attributes:true,attributeFilter:['data-state','data-server-classification']});
  const showMode=(local:boolean)=>{active=local;feedback.dataset.active=String(local);
    const disclosure=field('classification-local-disclosure');
    disclosure.checked=local;
    const disclosureOption=document.getElementById('classification-local-disclosure-option');
    if(disclosureOption)disclosureOption.hidden=local;
    enable.textContent=local?t('classification_saveLocalChanges', 'Save changes'):t('options_enableLocalClassification', 'Use this AI service');
    disable.hidden=!local;
    showSource(local?'own':picked?(sourceRadios.find(radio=>radio.checked)?.value==='own'?'own':'know-n'):defaultSource());};
  if(choices)choices.hidden=!localClassificationAvailable();
  for(const radio of sourceRadios)radio.addEventListener('change',()=>{
    if(!radio.checked)return;
    picked=true;
    if(radio.value==='own')showSource('own');
    else if(!active)showSource('know-n');
  });
  const notify=(copy:string,tone:ToastTone)=>showToast(copy,tone,{announce:true});
  const presetSelect=document.getElementById('classification-local-preset') as HTMLSelectElement | null;
  const cfFields=document.getElementById('classification-local-cf-fields');
  const testBtn=document.getElementById('classification-local-test') as HTMLButtonElement | null;

  enable.disabled=!localClassificationAvailable();
  if(testBtn)testBtn.disabled=!localClassificationAvailable();

  const accountInput=field('classification-local-account');
  const accountField=document.getElementById('classification-local-account-field');
  const endpointInput=field('classification-local-endpoint');
  const modelInput=field('classification-local-model');
  const secretInput=field('classification-local-secret');
  const modelCandidates=document.getElementById('classification-local-model-candidates');
  const secretLabel=document.getElementById('classification-local-secret-label');
  const httpWarning=document.getElementById('classification-local-http-warning');
  const selectedPreset=()=>localClassificationPreset(presetSelect?.value??'typesafe');
  const endpointFor=(preset:LocalClassificationPreset,account:string)=>preset.endpoint.replace('{account}',account||'{account}');
  const syncHttpWarning=()=>{if(httpWarning)httpWarning.hidden=!endpointInput?.value.trim().startsWith('http://');};
  /**
   * The account id is required by the Cloudflare envelope and by any endpoint that
   * still carries the `{account}` placeholder — including a Cloudflare template
   * pasted into the custom preset. Hiding the only input that can resolve it would
   * be a dead end.
   */
  const syncAccountField=()=>{if(accountField)accountField.hidden=!(selectedPreset().accountFields||(endpointInput?.value??'').includes('{account}'));};
  const endpointHost=(value:string)=>{try{return new URL(value).host;}catch{return '';}};
  const isAccountId=(value:string)=>/^[a-f0-9]{32}$/iu.test(value);
  /** `{account}` substitution applies to custom endpoints too. */
  const resolveAccountPlaceholder=(endpoint:string,accountId:string)=>isAccountId(accountId)
    ?endpoint.replaceAll('{account}',accountId):endpoint;
  /** A masked credential stays bound to the provider host it was entered for. */
  let credentialHost=endpointHost(endpointInput?.value.trim()??'');
  /** The saved key, reused when the field is left blank for the same provider host. */
  let storedSecret:{host:string;value:string}|null=null;
  const secretFor=(endpoint:string)=>secretInput?.value
    ||(storedSecret&&storedSecret.host===endpointHost(endpoint)?storedSecret.value:'');
  function discardCredentialForNewHost(nextEndpoint:string){
    const nextHost=endpointHost(nextEndpoint);
    if(secretInput?.value&&nextHost&&nextHost!==credentialHost)secretInput.value='';
    credentialHost=nextHost;
  }

  const showStoredSecret=()=>{if(secretInput)secretInput.placeholder=storedSecret
    ?t('classification_keySavedPlaceholder', 'Saved on this browser. Leave blank to keep it.'):'';};

  function applyPreset(preset:LocalClassificationPreset,{discardCredential=false}={}){
    if(cfFields)cfFields.hidden=!preset.accountFields;
    const endpoint=endpointFor(preset,accountInput?.value.trim()??'');
    if(discardCredential)discardCredentialForNewHost(endpoint);
    if(endpointInput)endpointInput.value=endpoint;
    if(modelInput)modelInput.value=preset.defaultModel;
    if(modelCandidates)modelCandidates.innerHTML=preset.modelCandidates.map(value=>`<option value="${value}"></option>`).join('');
    if(secretLabel)secretLabel.textContent=preset.credentialLabel;
    syncHttpWarning();
    syncAccountField();
  }

  endpointInput?.addEventListener('input',()=>{
    const next=endpointInput.value.trim();
    if(secretInput?.value&&endpointHost(next)!==credentialHost)secretInput.value='';
    credentialHost=endpointHost(next);
    syncHttpWarning();
    syncAccountField();
  });

  if(accountInput&&endpointInput){
    accountInput.addEventListener('input',()=>{
      const preset=selectedPreset();
      if(preset.accountFields)endpointInput.value=endpointFor(preset,accountInput.value.trim());
    });
  }

  if(presetSelect){
    presetSelect.addEventListener('change',()=>{applyPreset(selectedPreset(),{discardCredential:true});
      const advanced=document.getElementById('classification-local-advanced') as HTMLDetailsElement|null;
      if(advanced)advanced.open=selectedPreset().id==='custom'||Boolean(selectedPreset().accountFields);});
    applyPreset(selectedPreset());
  }

  if(testBtn){
    testBtn.addEventListener('click',async event=>{
      if(!event.isTrusted)return;
      const preset=selectedPreset();
      let endpoint=endpointInput?.value.trim()??'';
      const model=modelInput?.value.trim()??'';
      const gatewayId=field('classification-local-gateway')?.value.trim()??'default';
      const accountId=accountInput?.value.trim()??'';

      endpoint=resolveAccountPlaceholder(endpoint,accountId);
      const secret=secretFor(endpoint);
      if(endpoint.includes('{account}')){
        notify(t('classification_enterCloudflareAccountId', 'Enter the Cloudflare account ID for this endpoint.'),'error');return;
      }
      if(endpointInput)endpointInput.value=endpoint;
      if(preset.accountFields&&!/^[a-z0-9_-]{1,64}$/iu.test(gatewayId)){
        notify(t('classification_enterCloudflareGatewayId', 'Enter the Cloudflare gateway ID.'),'error');return;
      }

      let url:URL;
      try{
        url=new URL(endpoint);
        if(!classificationEndpointAllowed(endpoint)||!url.host)throw new Error();
      }catch{
        notify(t('classification_enterValidHttpsEndpoint', 'Enter a valid HTTPS endpoint, or HTTP on a local address.'),'error');return;
      }
      if(!model){notify(t('classification_enterModelIdentifier', 'Enter a model identifier.'),'error');return;}
      if(preset.credential==='required'&&!secret){notify(t('classification_enterBeforeTesting', 'Enter the $1 before testing.', preset.credentialLabel),'error');return;}

      const origin=`${url.origin}/*`;
      // Never revoke the origin grant an active credential already relies on.
      const activeOrigin=(await chrome.storage.local.get(LOCAL_CLASSIFICATION_GRANTED_ORIGIN))[LOCAL_CLASSIFICATION_GRANTED_ORIGIN];
      testBtn.disabled=true;
      let granted=false;
      try{
        granted=await chrome.permissions.request({origins:[origin]});
      }catch{granted=false;}
      if(!granted){
        notify(t('classification_originPermissionNotGranted', 'Origin permission not granted for $1.', url.origin),'error');
        testBtn.disabled=false;
        return;
      }
      notify(t('common_testingConnection', 'Testing connection...'),'info');
      try{
        const probe=await probeClassificationConnection({
          presetId:preset.id,endpoint,model,
          secret:secret||undefined,
          gatewayId:preset.accountFields?gatewayId:undefined,
        });
        if(probe.ok){
          notify(t('classification_connectionTestSucceededReported', 'Connection test succeeded! Reported model: $1', probe.model),'ok');
        }else{
          testBtn.dataset.lastError=probe.error;
          notify(connectionFailureCopy(probe),'error');
        }
      }catch(err){
        testBtn.dataset.lastError=err instanceof Error?err.message:'unknown';
        notify(t('classification_connectionTestFailed', 'Connection test failed. Check the address, model and key, then try again.'),'error');
      }finally{
        // Release only the probe-only grant; never the origin the credential uses.
        if(!sharesHostPermission(origin,activeOrigin)){try{await releaseClassificationOrigin(origin);}catch{}}
        testBtn.disabled=false;
      }
    });
  }

  enable.addEventListener('click',event=>{if(event.isTrusted&&navigator.userActivation.isActive)void save();});
  async function useKnowN(){
    // Choosing Know-N is explicit, so the page stays on it even while signed out.
    picked=true;for(const radio of sourceRadios)radio.checked=radio.value==='know-n';
    // The key stays saved so switching back to local mode needs no re-entry; only the
    // mode flag, cached collection context and the host grant are dropped.
    await chrome.storage.local.remove(LOCAL_CLASSIFICATION_ENABLED);await clearLocalClassificationContext();
    const endpoint=endpointInput?.value.trim()??'';
    try{if(endpoint)await releaseClassificationOrigin(localClassificationOriginPattern(endpoint));}catch{}
    await releaseStaleClassificationOrigin('');
    showMode(false);
    notify(t('classification_serverClassificationSelectedKeyKept', 'Know-N suggestions selected. Your key stays saved for when you switch back.'),'ok');
  }
  disable.addEventListener('click',async event=>{if(event.isTrusted)await useKnowN();});
  // Choosing "Know-N" while your own service is in use is the same flow as the button.
  for(const radio of sourceRadios)radio.addEventListener('change',event=>{
    if(radio.checked&&radio.value==='know-n'&&active&&event.isTrusted)void useKnowN();
  });

  async function save(){
    if(!localClassificationAvailable())return;
    const preset=selectedPreset();
    let endpoint=endpointInput?.value.trim()??'';
    const model=modelInput?.value.trim()??'';
    const accountId=accountInput?.value.trim()??'';
    const gatewayId=field('classification-local-gateway')?.value.trim()??'default';

    endpoint=resolveAccountPlaceholder(endpoint,accountId);
    const secret=secretFor(endpoint);
    if(endpoint.includes('{account}')){
      notify(t('classification_enterCloudflareAccountId', 'Enter the Cloudflare account ID for this endpoint.'),'error');return;
    }
    if(endpointInput)endpointInput.value=endpoint;

    if(!field('classification-local-disclosure').checked){
      notify(t('classification_confirmDataDisclosureBefore', 'Confirm the data disclosure before enabling.'),'error');return;
    }

    let url:URL;
    try{
      url=new URL(endpoint);
      if(!classificationEndpointAllowed(endpoint)||!url.host)throw new Error();
    }catch{
      notify(t('classification_enterValidHttpsEndpoint', 'Enter a valid HTTPS endpoint, or HTTP on a local address.'),'error');return;
    }
    if(!model){notify(t('classification_enterModelIdentifier', 'Enter a model identifier.'),'error');return;}

    if(secret&&(new TextEncoder().encode(secret).length>4096||/[\r\n\0]/u.test(secret))){
      notify(t('classification_invalidSecretToken', 'Invalid secret token.'),'error');return;
    }
    if(preset.credential==='required'&&!secret){
      notify(t('classification_enterThe', 'Enter the $1.', preset.credentialLabel),'error');return;
    }
    if(preset.accountFields&&!/^[a-z0-9_-]{1,64}$/iu.test(gatewayId)){
      notify(t('classification_enterCloudflareGateway', 'Enter the Cloudflare gateway.'),'error');return;
    }

    // Permission is requested directly from the trusted click, before any asynchronous message.
    const origin=`${url.origin}/*`;
    const permission=chrome.permissions.request({origins:[origin]});
    enable.disabled=true;
    const secretField=field('classification-local-secret');
    try{
      if(!await permission){
        notify(t('classification_originPermissionNotGranted', 'Origin permission not granted for $1.', url.origin),'error');
        return;
      }
      await releaseStaleClassificationOrigin(origin);
      // Local-first: no account, collection or sync is needed; the key stays on this browser.
      await chrome.storage.local.set({[LOCAL_CLASSIFICATION_ENABLED]:true});
      await clearLocalClassification();
      const credential:LocalClassificationCredential={version:3,generation:crypto.randomUUID(),
        presetId:preset.id,endpoint,model,
        accountId:preset.accountFields?accountId:undefined,
        gatewayId:preset.accountFields?gatewayId:undefined,
        secret:secret||undefined,disclosed:true};
      await chrome.storage.local.set({[LOCAL_CLASSIFICATION_KEY]:credential});
      await chrome.storage.local.remove(LOCAL_CLASSIFICATION_DRAFT);
      // Only drop the typed token once the credential is stored.
      secretField.value='';
      storedSecret=secret?{host:url.host,value:secret}:null;
      showStoredSecret();
      await chrome.runtime.sendMessage({kind:'known.connectivity.online'});
      showMode(true);
      notify(t('classification_localEnabled', 'Your AI service is enabled. The key stays saved on this browser.'),'ok');
    }catch{notify(t('classification_localEnableFailed', "Couldn't enable your AI service. Try again."),'error');}
    finally{enable.disabled=false;}
  }
  const modeReady=chrome.storage.local.get(LOCAL_CLASSIFICATION_ENABLED).then(values=>{
    showMode(values[LOCAL_CLASSIFICATION_ENABLED]===true);
  });
  // Re-opening options must show the active configuration, not the default
  // preset's template: otherwise the user re-targets Cloudflare or tests an
  // origin that is not the one in use. The stored secret itself is never
  // written back into the form.
  const configurationReady=storedLocalClassificationForm().then(stored=>{
    if(!localClassificationAvailable())return;
    if(!stored||(stored.version!==undefined&&stored.version!==3)||typeof stored.endpoint!=='string'||typeof stored.model!=='string')return;
    const preset=localClassificationPreset(stored.presetId??'');
    if(presetSelect)presetSelect.value=preset.id;
    const advanced=document.getElementById('classification-local-advanced') as HTMLDetailsElement|null;
    if(advanced)advanced.open=preset.id==='custom'||preset.accountFields;
    if(cfFields)cfFields.hidden=!preset.accountFields;
    if(accountInput&&typeof stored.accountId==='string')accountInput.value=stored.accountId;
    if(field('classification-local-gateway')&&typeof stored.gatewayId==='string')field('classification-local-gateway').value=stored.gatewayId;
    if(endpointInput)endpointInput.value=stored.endpoint;
    if(modelInput)modelInput.value=stored.model;
    if(modelCandidates)modelCandidates.innerHTML=preset.modelCandidates.map(value=>`<option value="${value}"></option>`).join('');
    if(secretLabel)secretLabel.textContent=preset.credentialLabel;
    // The credential's own endpoint becomes the host a fresh credential belongs to.
    credentialHost=endpointHost(stored.endpoint);
    if(typeof stored.secret==='string'&&stored.secret){storedSecret={host:credentialHost,value:stored.secret};showStoredSecret();}
    syncHttpWarning();
    syncAccountField();
  });
  return Promise.all([modeReady,configurationReady]).then(()=>undefined);
}
