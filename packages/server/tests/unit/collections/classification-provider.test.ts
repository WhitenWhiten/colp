import { test,expect,vi } from 'vitest';
import {
  createCloudflareJevClassificationProvider,
  createClassificationUpstream,
  createCloudflareUpstream,
} from '../../../src/infrastructure/collections/classification-provider-cloudflare-jev.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { buildClassificationCandidates, loadClassificationContext,type ClassificationContext,DEFAULT_CLASSIFICATION_SETTINGS } from '../../../src/modules/collections/index.js';

const config={accountId:'a'.repeat(32),gatewayId:'test',accessKey:'private-test-only',expectedModelVersion:'jev-1.13.0'};
const upstream=createCloudflareUpstream(config);
async function context():Promise<ClassificationContext>{
  return (await loadClassificationContext({ownerSubjectId:'owner',collectionId:'collection',tagsEnabled:false,
    preview:{source:'console',bookmark:{title:'React',url:'https://react.dev/',description:null},requested:{folder:true,tags:false}}},
  {loadSnapshot:async()=>({collectionId:'collection',title:'Library',summary:null,contentRevision:'r1',node:null,tagUsage:[],
    folders:[{id:'folder',parentId:null,title:'React',description:null}],settings:{...DEFAULT_CLASSIFICATION_SETTINGS,contractVersion:'1.0.0',collectionId:'collection',revision:'0',updatedAt:new Date(0).toISOString()}})}))!;
}
const execution={executionId:'opaque',deadlineAt:new Date(Date.now()+20000).toISOString(),signal:new AbortController().signal,
  calls:{run:async(_stage:unknown,_chunk:unknown,_input:unknown,send:()=>Promise<import('../../../src/modules/collections/index.js').ClassificationCallResult>)=>send()}};
import { calculateClassificationSettledMicrousd, DEFAULT_CLASSIFICATION_PRICING } from '../../../src/infrastructure/collections/classification-pricing.js';

test('an explicit retry removes later from provider choices and rejects abstaining output', async () => {
  const original = await context();
  const candidates = buildClassificationCandidates({ bookmark: original.bookmark, folders: [...original.snapshot.folders,
    { id: 'other', parentId: null, title: 'Other', description: null }], tagUsage: [], existingTags: [], requested: original.requested });
  const input = { ...original, candidates, folderSelectionMode: 'require_candidate' as const };
  let sent: { questions: { folder: { criteria: Record<string, string> } } } | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    sent = JSON.parse(String(init!.body)).input;
    return Response.json({ result: { model: 'jev-1.13.0', answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 1, f1: 0 } } } } });
  });
  const provider = createCloudflareJevClassificationProvider(upstream, transport);
  expect((await provider.classify(input, execution)).l1).toMatchObject({ folderId: candidates.l1[0]!.id });
  expect(sent!.questions.folder.criteria).toEqual({ f0: expect.any(String), f1: expect.any(String) });
  transport.mockImplementationOnce(async () => Response.json({ result: { model: 'jev-1.13.0',
    answers: { folder: { choice: 'later', confidence: 1, probabilities: { later: 1 } } } } }));
  await expect(provider.classify(input, execution)).rejects.toMatchObject({ code: 'contract_drift' });
});

test('a required single root is selected without a one-option provider request', async () => {
  const transport = vi.fn<typeof fetch>(), calls = vi.fn(execution.calls.run);
  const input = { ...await context(), folderSelectionMode: 'require_candidate' as const };
  const output = await createCloudflareJevClassificationProvider(upstream, transport).classify(input, { ...execution, calls: { run: calls } });
  expect(output.l1).toEqual({ folderId: 'folder', confidence: 1, probabilities: [{ folderId: 'folder', probability: 1 }] });
  expect(output.l2).toBeNull();
  expect(transport).not.toHaveBeenCalled();
  expect(calls).not.toHaveBeenCalled();
});

test('a required single root still classifies its descendants with their parent fallback', async () => {
  const original = await context();
  const candidates = buildClassificationCandidates({ bookmark: original.bookmark, folders: [...original.snapshot.folders,
    { id: 'child', parentId: 'folder', title: 'React APIs', description: null }], tagUsage: [], existingTags: [], requested: original.requested });
  const transport = vi.fn<typeof fetch>(async () => Response.json({ result: { model: 'jev-1.13.0',
    answers: { folder: { choice: 'f0', confidence: 1, probabilities: { f0: 1, parent_root: 0 } }, specific: { noul: 1 } } } }));
  const calls = vi.fn(execution.calls.run);
  const output = await createCloudflareJevClassificationProvider(upstream, transport).classify({ ...original, candidates, folderSelectionMode: 'require_candidate' },
    { ...execution, calls: { run: calls } });
  expect(output.l2).toMatchObject({ folderId: 'child' });
  expect(calls.mock.calls.map(([stage]) => stage)).toEqual(['l2']);
  expect(transport).toHaveBeenCalledOnce();
});

test('exhausted folder candidates return later without dispatching a provider call', async () => {
  const input = await context();
  const candidates = buildClassificationCandidates({ bookmark: input.bookmark, folders: input.snapshot.folders,
    tagUsage: [], existingTags: [], requested: input.requested, rejectedFolderIds: ['folder'] });
  const transport = vi.fn<typeof fetch>();
  const calls = vi.fn(execution.calls.run);
  const output = await createCloudflareJevClassificationProvider(upstream, transport).classify({ ...input, candidates, folderSelectionMode: 'require_candidate' },
    { ...execution, calls: { run: calls } });
  expect(output.l1).toEqual({ folderId: null, confidence: 1, probabilities: [{ folderId: null, probability: 1 }] });
  expect(output.l2).toBeNull();
  expect(output.candidateCoverage.l1Included).toBe(0);
  expect(calls).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

test('exhausted folders do not suppress an independently requested tag suggestion', async () => {
  const input = await context(), requested = { folder: true, tags: true };
  const candidates = buildClassificationCandidates({ bookmark: input.bookmark, folders: input.snapshot.folders,
    tagUsage: [{ tag: 'React', count: 1 }], existingTags: [], requested, rejectedFolderIds: ['folder'] });
  const transport = vi.fn<typeof fetch>(async () => Response.json({ result: { model: 'jev-1.13.0', answers: { t0: { noul: 0.95 } } } }));
  const calls = vi.fn(execution.calls.run);
  const output = await createCloudflareJevClassificationProvider(upstream, transport).classify({ ...input, requested, candidates },
    { ...execution, calls: { run: calls } });
  expect(output.l1).toMatchObject({ folderId: null });
  expect(output.tags).toEqual([{ tag: 'React', noul: 0.95 }]);
  expect(calls.mock.calls.map(([stage]) => stage)).toEqual(['tags']);
  expect(transport).toHaveBeenCalledOnce();
});

test('wire failure classes are stable and uncertain failures never retry; 429 retries once respecting retry-after', async () => {
  for (const [status, code] of [[400, 'contract_drift'], [401, 'credentials'], [403, 'credentials'], [500, 'outcome_unknown']] as const) {
    let calls = 0;
    const provider = createCloudflareJevClassificationProvider(upstream, async () => { calls++; return new Response('private upstream error', { status }); });
    await expect(provider.classify(await context(), execution)).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  }

  // 429 -> retry 429 -> terminal rate_limited failure (calls = 2)
  let rateLimitCalls = 0;
  const rateLimitedProvider = createCloudflareJevClassificationProvider(upstream, async () => {
    rateLimitCalls++;
    return new Response('too many requests', { status: 429, headers: { 'retry-after': '0' } });
  });
  await expect(rateLimitedProvider.classify(await context(), execution)).rejects.toMatchObject({ code: 'rate_limited', attempts: 2 });
  expect(rateLimitCalls).toBe(2);

  // 429 -> retry succeeds (calls = 2)
  let retrySuccessCalls = 0;
  const retrySuccessProvider = createCloudflareJevClassificationProvider(upstream, async () => {
    retrySuccessCalls++;
    if (retrySuccessCalls === 1) {
      return new Response('too many requests', { status: 429, headers: { 'retry-after': '0' } });
    }
    return Response.json({
      result: {
        model: 'jev-1.13.0',
        answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 0.9, later: 0.1 } } },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
  });
  const successOutput = await retrySuccessProvider.classify(await context(), execution);
  expect(retrySuccessCalls).toBe(2);
  expect(successOutput.modelVersion).toBe('jev-1.13.0');

  // The transport reports the dispatch count so the persisted attempt row can record the retry.
  const { createCloudflareJevTransport } = await import('../../../src/infrastructure/collections/classification-provider-cloudflare-transport.js');
  let dispatchCount = 0;
  const transportResult = await createCloudflareJevTransport(upstream, async () => {
    dispatchCount++;
    if (dispatchCount === 1) return new Response('too many requests', { status: 529, headers: { 'retry-after': '0' } });
    return Response.json({ result: { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 1 } } }, { status: 200 });
  })({ state: { subject: 'alpha' }, questions: { q: { type: 'noul', instructions: 'Is the subject alpha?' } } }, new AbortController().signal);
  expect(dispatchCount).toBe(2);
  expect(transportResult.usage.attemptNumber).toBe(2);

  // 5xx -> outcome_unknown and does NOT retry (calls = 1)
  let serverErrorCalls = 0;
  const serverErrorProvider = createCloudflareJevClassificationProvider(upstream, async () => {
    serverErrorCalls++;
    return new Response('internal server error', { status: 503 });
  });
  await expect(serverErrorProvider.classify(await context(), execution)).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(serverErrorCalls).toBe(1);

  // Every failure raised after a retry carries the real dispatch count, so the
  // persisted attempt row can record two dispatches (429 -> 5xx here).
  let mixedCalls = 0;
  const mixedProvider = createCloudflareJevClassificationProvider(upstream, async () => {
    mixedCalls++;
    return mixedCalls === 1
      ? new Response('too many requests', { status: 429, headers: { 'retry-after': '0' } })
      : new Response('internal server error', { status: 500 });
  });
  await expect(mixedProvider.classify(await context(), execution)).rejects.toMatchObject({ code: 'outcome_unknown', attempts: 2 });
  expect(mixedCalls).toBe(2);
});

test('retry-after delays the retry, tolerates date headers and never dispatches after an abort', async () => {
  vi.useFakeTimers();
  try {
    const ready = await context();
    const success = () => Response.json({ result: { model: 'jev-1.13.0',
      answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 0.9, later: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } } });

    // Numeric seconds are honoured: no second dispatch before the delay elapses.
    let numericCalls = 0;
    const numeric = createCloudflareJevClassificationProvider(upstream, async () => {
      numericCalls++;
      return numericCalls === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : success();
    });
    const pending = numeric.classify(ready, execution);
    await vi.advanceTimersByTimeAsync(1900);
    expect(numericCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ modelVersion: 'jev-1.13.0' });
    expect(numericCalls).toBe(2);

    // An HTTP date in the past means "already elapsed": retry immediately.
    let dateCalls = 0;
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    const dated = createCloudflareJevClassificationProvider(upstream, async () => {
      dateCalls++;
      return dateCalls === 1 ? new Response('slow down', { status: 529, headers: { 'retry-after': pastDate } }) : success();
    });
    await expect(dated.classify(ready, execution)).resolves.toMatchObject({ modelVersion: 'jev-1.13.0' });
    expect(dateCalls).toBe(2);

    // A malformed value falls back to a bounded default wait instead of hammering the upstream.
    let brokenCalls = 0;
    const broken = createCloudflareJevClassificationProvider(upstream, async () => {
      brokenCalls++;
      return brokenCalls === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': 'soon' } }) : success();
    });
    const brokenPending = broken.classify(ready, execution);
    await vi.advanceTimersByTimeAsync(500);
    expect(brokenCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    await expect(brokenPending).resolves.toMatchObject({ modelVersion: 'jev-1.13.0' });
    expect(brokenCalls).toBe(2);

    // Aborting during the backoff ends the call as a deadline and never dispatches again.
    const controller = new AbortController();
    let abortedCalls = 0;
    const aborting = createCloudflareJevClassificationProvider(upstream, async () => {
      abortedCalls++; return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } });
    });
    const abortPending = aborting.classify(ready, { ...execution, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await expect(abortPending).rejects.toMatchObject({ code: 'deadline' });
    expect(abortedCalls).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('pricing policy drops 5% surcharge and calculates settled micro-USD', () => {
  expect(calculateClassificationSettledMicrousd(1000)).toBe(42);
  expect(calculateClassificationSettledMicrousd(100)).toBe(5);
  expect(calculateClassificationSettledMicrousd(null)).toBe(2000);
  expect(DEFAULT_CLASSIFICATION_PRICING.reservationMicrousd).toBe(2000n);
  expect(DEFAULT_CLASSIFICATION_PRICING.tokenRateMicrousd).toBe(0.042);
});
test('unknown option/model drift fail closed; private headers never become classification output',async()=>{
  for(const choice of ['unknown','f0']){
    const provider=createCloudflareJevClassificationProvider(upstream,async()=>Response.json({result:{model:choice==='f0'?'new-unverified-model':'jev-1.13.0',answers:{folder:{choice,confidence:0.9,probabilities:{f0:0.9,later:0.1}}}}}));
    await expect(provider.classify(await context(),execution)).rejects.toMatchObject({code:'contract_drift'});
  }
  const provider=createCloudflareJevClassificationProvider(upstream,async(_url,init)=>{
    expect(init?.redirect).toBe('error');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-test-only');
    return Response.json({result:{model:'jev-1.13.0',answers:{folder:{choice:'f0',confidence:0.9,probabilities:{f0:0.9,later:0.1}}},usage:{input_tokens:10,output_tokens:2}}});
  });
  expect(JSON.stringify(await provider.classify(await context(),execution))).not.toContain(upstream.credential.accessKey);
});
test('missing deployment credentials and transport loss fail without exposing causes',async()=>{
  expect(()=>createCloudflareJevClassificationProvider(createCloudflareUpstream({...config,capability:{...upstream.capability,l1Options:5}}))).toThrow('Unverified');
  await expect(createBookmarkClassificationProvider(null).classify(await context(),execution)).rejects.toMatchObject({code:'disabled'});
  const provider=createCloudflareJevClassificationProvider(upstream,async()=>{throw new Error('secret transport details');});
  await expect(provider.classify(await context(),execution)).rejects.toMatchObject({message:'outcome_unknown'});
});
test('descriptor validation never depends on a well-known id', () => {
  const invalid = [
    { id: 'custom_provider', endpoint: 'not-a-url' },
    { id: 'custom_provider', endpoint: 'ftp://gateway.example.com/run' },
    { id: 'custom_provider', endpoint: 'https://user:pass@gateway.example.com/run' },
    { id: 'custom_provider', model: '   ' },
    { id: 'custom_provider', accessKey: '' },
    { id: 'custom_provider', gatewayId: 'bad gateway' },
  ];
  for (const patch of invalid) {
    expect(() => createCloudflareJevClassificationProvider(createCloudflareUpstream({ ...config, ...patch })))
      .toThrow('Invalid classification provider configuration');
  }
  // The default deployment descriptor always requires its credential, whatever its id.
  expect(() => createCloudflareJevClassificationProvider(createCloudflareUpstream({ ...config, id: 'renamed_deployment', accessKey: '' })))
    .toThrow('Invalid classification provider configuration');
  // A user-supplied anonymous endpoint is allowed only when it declares that fact.
  expect(() => createCloudflareJevClassificationProvider(createCloudflareUpstream({ ...config, id: 'custom_provider', accessKey: '', credentialRequired: false })))
    .not.toThrow();
});

test('the TypeSafe wire sends state/questions at the top level and no gateway header', async () => {
  let body: Record<string, unknown> = {};
  let headers = new Headers();
  const nativeUpstream = createClassificationUpstream({
    wire: 'typesafe_systemone_v1', id: 'typesafe_official', endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest', accessKey: 'typesafe-key',
  });
  const provider = createCloudflareJevClassificationProvider(nativeUpstream, async (_url, init) => {
    body = JSON.parse(String(init?.body)); headers = new Headers(init?.headers);
    return Response.json({ model: 'jev-1.13.0',
      answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 0.9, later: 0.1 } } },
      usage: { input_tokens: 5, output_tokens: 1 } });
  });
  const output = await provider.classify(await context(), execution);
  expect(body.model).toBe('jev-latest');
  expect(body.state).toBeDefined();
  expect(body.questions).toBeDefined();
  expect(body.input).toBeUndefined();
  expect(headers.get('cf-aig-gateway-id')).toBeNull();
  expect(headers.get('authorization')).toBe('Bearer typesafe-key');
  expect(output.modelVersion).toBe('jev-1.13.0');
});

test('pin mode enforces exact model version while alias mode records reported version', async () => {
  const pinUpstream = createCloudflareUpstream({
    ...config,
    expectedModelVersion: 'jev-1.13.0',
  });
  const driftProvider = createCloudflareJevClassificationProvider(pinUpstream, async () => {
    return Response.json({
      result: {
        model: 'jev-2.0.0-drift',
        answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 0.9, later: 0.1 } } },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
  });
  await expect(driftProvider.classify(await context(), execution)).rejects.toMatchObject({ code: 'contract_drift' });

  const aliasUpstream = createCloudflareUpstream({
    ...config,
    expectedModelVersion: null,
  });
  const aliasProvider = createCloudflareJevClassificationProvider(aliasUpstream, async () => {
    return Response.json({
      result: {
        model: 'jev-2.0.0-drift',
        answers: { folder: { choice: 'f0', confidence: 0.9, probabilities: { f0: 0.9, later: 0.1 } } },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
  });
  const output = await aliasProvider.classify(await context(), execution);
  expect(output.modelVersion).toBe('jev-2.0.0-drift');
});
test('upstream descriptor injects endpoint and model into outbound requests without vendor literals',async()=>{
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const customUpstream = createCloudflareUpstream({
    ...config,
    endpoint: 'https://custom-gateway.internal/v1/ai/run',
    model: 'custom/jev-variant',
  });
  const provider = createCloudflareJevClassificationProvider(customUpstream, async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return Response.json({
      result: {
        model: 'jev-1.13.0',
        answers: { folder: { choice: 'f0', confidence: 0.95, probabilities: { f0: 0.95, later: 0.05 } } },
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    });
  });
  await provider.classify(await context(), execution);
  expect(capturedUrl).toBe('https://custom-gateway.internal/v1/ai/run');
  const body = JSON.parse(String(capturedInit?.body));
  expect(body.model).toBe('custom/jev-variant');
  expect(new Headers(capturedInit?.headers).get('authorization')).toBe(`Bearer ${config.accessKey}`);
  expect(new Headers(capturedInit?.headers).get('cf-aig-gateway-id')).toBe(config.gatewayId);
});

test('a rate-limit retry that cannot fit the stage deadline is terminal and refundable', async () => {
  let calls = 0;
  const provider = createCloudflareJevClassificationProvider(upstream, async () => {
    calls++;
    return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
  });
  const tightDeadline = { ...execution, deadlineAt: new Date(Date.now() + 3_000).toISOString() };
  // 30 s backoff + a 10 s attempt cannot fit 3 s, so it must not wait; `rate_limited`
  // is provably not executed and releases the reservation.
  await expect(provider.classify(await context(), tightDeadline)).rejects.toMatchObject({ code: 'rate_limited', attempts: 1 });
  expect(calls).toBe(1);
});

test('the Cloudflare wire refuses Unified Billing fallback while other wires do not',async()=>{
  let seen: Headers | undefined;
  const succeed=async(_url:RequestInfo|URL,init?:RequestInit)=>{
    seen=new Headers(init?.headers);
    return Response.json({result:{model:'jev-1.13.0',answers:{folder:{choice:'f0',confidence:0.9,probabilities:{f0:0.9,later:0.1}}},usage:{input_tokens:1,output_tokens:1}}});
  };
  const cloudflare=createCloudflareJevClassificationProvider(createCloudflareUpstream(config),succeed);
  await cloudflare.classify(await context(),execution);
  expect(seen?.get('cf-aig-no-wholesale')).toBe('true');

  // The native TypeSafe/Vercel wire has no Cloudflare gateway in front of it.
  const nativeUpstream=createClassificationUpstream({...config,wire:'typesafe_systemone_v1',endpoint:'https://api.typesafe.ai/v1/systemone',expectedModelVersion:null});
  const native=createCloudflareJevClassificationProvider(nativeUpstream,succeed);
  await native.classify(await context(),execution);
  expect(seen?.get('cf-aig-no-wholesale')).toBeNull();
  expect(createClassificationUpstream({...config,wire:'typesafe_systemone_v1',endpoint:'https://api.typesafe.ai/v1/systemone'}).byokOnly).toBe(false);
  expect(createCloudflareUpstream(config).byokOnly).toBe(true);
});

test('the per-attempt request timeout is descriptor-driven and validated',async()=>{
  // Default headroom is deliberately above the ~4.9 s worst successful live call.
  expect(createCloudflareUpstream(config).requestTimeoutMs).toBe(10_000);
  expect(createClassificationUpstream({...config,requestTimeoutMs:2_500}).requestTimeoutMs).toBe(2_500);
  for(const requestTimeoutMs of [0,999,30_001,1.5,Number.NaN]){
    expect(()=>createCloudflareJevClassificationProvider({...createCloudflareUpstream(config),requestTimeoutMs}))
      .toThrow('Invalid classification provider configuration');
  }

  const timeout=vi.spyOn(AbortSignal,'timeout');
  try{
    const provider=createCloudflareJevClassificationProvider(createCloudflareUpstream({...config,requestTimeoutMs:12_345}),
      async()=>Response.json({model:'jev-1.13.0',answers:{folder:{choice:'f0',confidence:0.9,probabilities:{f0:0.9,later:0.1}}},usage:{input_tokens:3,output_tokens:1}}));
    await provider.classify(await context(),execution);
    expect(timeout).toHaveBeenCalledWith(12_345);
  }finally{timeout.mockRestore();}
});
