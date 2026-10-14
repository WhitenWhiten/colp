// Page-side chrome.* stub for scripts/options-shots.mjs.
//
// `installStub` is serialised by Playwright (page.addInitScript), so it must stay self-contained: no imports and
// no references to module scope. It answers the background messages that options.html, popup.html and
// capture-tabs.html send, with realistic data, so the real UI renders every state.
//
// States come from `?shot=a,b,c` on the page URL (comma separated flags):
//   signedout   signed-out account (also `signin` for the popup's sign-in card)
//   firstrun    the first-run welcome instead of the normal options page
//   own         the user's own AI provider key is configured
//   error       every background call fails (options pages) and the credits endpoints return 500
//   conflict    the saving preferences have a local/remote conflict
//   manual      manual capture mode (popup and Saving page)
//   Library pages (Bookmarks, History, Subscriptions, Sync, Save tabs):
//     empty       no bookmarks / no captures / no subscriptions      long      long titles, paths and names everywhere
//     noperm      bookmark access is not granted                      importing, importattn   a local-import run is in progress / needs attention
//     warn        the local-import preview carries a warning          paused    saving is paused
//     waiting     a capture is waiting for a suggestion               herr      the capture history fails to load
//     nocollection  no collection is chosen yet
//     ps-paused, ps-disconnected, ps-unavailable   personal sync state of the chosen collection (default enabled)
//     subempty, suberr, subout, subnoperm, subwait, sublong, subdirs   subscription states
//     rperm, rtree, rfail, rnested, rshift, rmanaged, rprivate         Sync › Folders states
//     frnew, frattn  a first sync is waiting to start / has items that need a decision
//     nwait, nwerr   items wait for a decision (nwerr: the decision is refused)   rdel, rdkeep, rconf   cloud deletions pending / confirm policy / a conflict
//     attn, rrej     sync stopped for good / one operation was rejected
//     imp-active, imp-paused, imp-attn, imp-done                        an import is running / paused / needs attention / complete
//     ingress     bookmarks are listed as not included in sync
//     tabs-notabs, tabs-dupe, tabs-confirmed, tabs-long, tabs-many      Save tabs states (see the TABS block below)
//   Automations page: auto-paused, auto-expired, auto-none, auto-off (server has no automations), auto-rejected,
//     auto-missing (a rule's folder is not mapped here), auto-empty (signed in, active, no rules)
//   Popup only: existing, suggest, suggesting, retrying, local, longtitle, longfolder, nofavicon, perm, attention, stuck,
//   autoline, autonoline, autoboot, autolocal, autoattention, autowaiting, autoexisting (auto* = automatic card).
export function installStub(messages) {
  const now = Date.now();
  const params = new URL(location.href).searchParams;
  const flags = (params.get('shot') ?? '').split(',').filter(Boolean);
  const has = (...names) => names.some((name) => flags.includes(name));
  const isPopup = location.pathname.endsWith('/popup.html');
  const signedOut = has('signedout', 'signin', 'firstrun');
  const errored = has('error'), conflict = has('conflict'), manual = has('manual');
  const longPath = has('longfolder');
  const iso = (ms) => new Date(ms).toISOString();
  const uuid = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  // ---- storage -----------------------------------------------------------------------------------------------
  const localStore = {
    'known.onboarding.installed.v1': has('firstrun') ? 'installed' : 'seen',
    'known.auth.authority-generation.v1': { generation: 4 },
    'known.sync.collection.v1': (isPopup && signedOut) || has('nocollection') ? undefined : 'col-reading',
    'known.auth.snapshot.v1': signedOut ? { status: 'signed_out', serverOrigin: 'https://known.example', updatedAt: now }
      : { status: 'connected', serverOrigin: 'https://known.example', accountLabel: 'ada@example.com', updatedAt: now },
    ...(has('own') ? { 'known.classification.local-enabled.v1': true, 'known.classification.local-key.v1': { version: 3, generation: 'g1', presetId: 'typesafe',
      endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', secret: 'sk-secret', disclosed: true } } : {}),
    ...(isPopup ? {
      'known.classification.manual-auto-suggest.v1': false,
      'known.sync.save-context.v1': signedOut ? undefined : { collectionId: 'col-reading', parentNativeId: longPath ? 'f-long2' : 'f-seo' },
      'known.sync.folder.v1': signedOut ? { collectionId: 'device', folderNativeId: 'f-seo' } : undefined,
      'known.save.folder.recent.v1': { ids: ['f-seo', 'f-prog'] },
    } : {}),
  };
  const sessionStore = signedOut ? {} : { 'known.auth.credential.v1': { subject: 'subject-example' } };
  const pick = (store, key) => {
    if (key === null || key === undefined) return { ...store };
    if (typeof key === 'string') return { [key]: store[key] };
    if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]));
    return Object.fromEntries(Object.entries(key).map(([k, d]) => [k, store[k] === undefined ? d : store[k]]));
  };
  const bag = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const area = (store) => ({
    get: async (k) => pick(store, k),
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { for (const key of Array.isArray(k) ? k : [k]) delete store[key]; },
    clear: async () => { for (const k of Object.keys(store)) delete store[k]; },
    setAccessLevel: async () => {},
    onChanged: bag(),
  });

  // ---- bookmarks and tab ---------------------------------------------------------------------------------------
  const nodes = new Map(), kids = new Map();
  let nextNodeId = 100;
  const add = (id, parentId, title, url) => {
    nodes.set(id, { id, parentId, title, ...(url ? { url } : {}), dateAdded: Date.UTC(2026, 8, 1) + nodes.size * 3600e3 });
    if (parentId !== undefined) { if (!kids.has(parentId)) kids.set(parentId, []); kids.get(parentId).push(id); }
    if (!url) kids.set(id, kids.get(id) ?? []);
  };
  add('0', undefined, '');
  add('1', '0', 'Bookmarks bar'); add('2', '0', 'Other bookmarks');
  add('f-marketing', '1', 'Marketing'); add('f-seo', 'f-marketing', 'SEO'); add('f-prog', '1', 'Programming');
  add('f-read', '1', 'Read later'); add('f-research', '1', 'Research');
  if (longPath) { add('f-long1', '1', 'Quarterly planning notes and reference material'); add('f-long2', 'f-long1', 'Engineering design reviews for the platform migration'); }
  add('f-misc', '2', 'Misc'); add('f-personal', '2', 'Personal');
  // Pre-save rules (AW-19): an arXiv page, and the folder its rule files into.
  const ruled = has('rule', 'ruleblocked', 'autorule', 'autoruleblocked');
  if (ruled) add('f-academic', '1', 'Academic');
  if (!has('empty')) {
    for (const [id, title, url] of [
      ['b-gh', 'adeze/raindrop-mcp: Raindrop MCP Server', 'https://github.com/adeze/raindrop-mcp'],
      ['b-an', 'Building effective agents', 'https://www.anthropic.com/research/building-effective-agents'],
      ['b-md', 'Using the Fetch API - Web APIs | MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch'],
      ['b-zp', 'Instapaper Integrations | Connect Your Apps with Zapier', 'https://zapier.com/apps/instapaper/integrations']]) add(id, 'f-prog', title, url);
    if (has('long')) {
      add('b-long', 'f-prog', 'A very long title that keeps going well past the end of the line to show how a single row copes with a title that never seems to end, in the middle of a list of rows', 'https://very-long-domain-name.example.com/a/very/long/path/that/goes/on/and/on?with=query&and=more');
      for (let i = 0; i < 6; i += 1) add(`b-x${i}`, 'f-prog', `Another saved article number ${i + 1}`, `https://site${i}.example.org/post/${i}`);
    }
    add('b-seo1', 'f-seo', 'The beginner’s guide to SEO', 'https://moz.com/beginners-guide-to-seo');
    add('b-seo2', 'f-seo', 'Core Web Vitals', 'https://web.dev/vitals/');
    add('b-mk', 'f-marketing', 'Positioning for developer tools', 'https://example.com/positioning');
    add('b-rl1', 'f-read', 'The economics of attention', 'https://news.site/economics');
    add('b-bar', '1', 'Hacker News', 'https://news.ycombinator.com/');
    add('b-other', '2', 'Wikipedia', 'https://en.wikipedia.org/');
  }
  const outNode = (id) => { const n = nodes.get(id); return { ...n, index: (kids.get(n.parentId) ?? []).indexOf(id) }; };
  const subtree = (id) => { const n = outNode(id); return kids.has(id) ? { ...n, children: (kids.get(id) ?? []).map(subtree) } : n; };
  const detach = (id) => { const n = nodes.get(id); kids.get(n.parentId).splice(kids.get(n.parentId).indexOf(id), 1); };
  const tree = [subtree('0')];
  const bookmarkNode = (id) => ({ id, title: 'adeze/raindrop-mcp: Raindrop MCP Server', url: 'https://github.com/adeze/raindrop-mcp',
    parentId: has('autorule') ? 'f-academic' : has('autoruleblocked') ? 'f-seo' : longPath ? 'f-long2' : 'f-prog', dateAdded: Date.UTC(2026, 8, 28) });
  const longTitle = 'Understanding the long and winding road of browser rendering pipelines: from parsing and style recalculation through layout, paint and compositing, with notes on performance budgets';
  const paper = { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need' };
  const tabTitle = has('longtitle') ? longTitle : ruled ? paper.title : 'Instapaper Integrations | Connect Your Apps with Zapier';
  const tabUrl = has('existing', 'autoexisting') ? 'https://github.com/adeze/raindrop-mcp' : ruled ? paper.url : 'https://zapier.com/apps/instapaper/integrations';
  const capturedTitle = has('longtitle') ? longTitle : ruled ? paper.title : 'adeze/raindrop-mcp: Raindrop MCP Server';
  const automation = (outcome) => ({ outcome, ...(outcome === 'blocked' ? { reason: 'bindingUnavailable' } : {}), ruleIds: ['r1'], bundleRevision: 'b-1',
    settingsRevision: 1, satisfies: outcome === 'placed' ? ['classify.root'] : [],
    rule: { id: 'r1', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'digest' },
    ...(outcome === 'placed' ? { destination: { serverUuid: 'server', collectionId: 'col-reading', nodeId: 'academic' }, folderTitle: 'Academic' } : {}),
    fromNativeId: 'f-seo', collectionId: 'col-reading', replicaId: 'rep-1', generation: 1 });

  // ---- capture tasks -------------------------------------------------------------------------------------------
  const task = (over = {}) => ({
    version: 1, captureId: uuid(701), commandId: uuid(901), batchId: null,
    scope: { replicaId: 'rep-1', collectionId: 'col-reading', accountId: 'account-example', serverOrigin: 'https://known.example', browserProfileId: 'bp-1' },
    source: 'action-popup', tabId: 1, url: 'https://github.com/adeze/raindrop-mcp', title: capturedTitle,
    targetNativeId: 'f-prog', insertPosition: 'bottom', saveAnother: false, allowUnverifiedCloud: false,
    createdAt: now, updatedAt: now, revision: 1, reportedRevision: 1, policyVersion: 'v1', automaticIntent: true, disposition: 'new',
    save: 'local-saved', classification: 'applied', sync: has('autolocal') ? 'local-only' : 'confirmed',
    existence: null, nativeIntentId: null, nativeId: 'n-1', nodeId: null, executionId: null, decisionId: 'dec-1',
    localLocation: { nativeId: 'n-1', path: ['Bookmarks bar', 'Programming'] }, cloudLocation: null,
    appliedRevision: 'rev-1', manualFence: 0, controlGeneration: 3, reason: null,
    automatic: { decision: { tags: ['mcp', 'raindrop'], path: ['Bookmarks bar', 'Programming'] } },
    savedAt: now - 3500, classificationAppliedAt: now - 3400, ...over,
  });
  const historyTask = (id, i, over) => task({
    captureId: uuid(700 + id), commandId: uuid(900 + i), source: 'manual-popup',
    url: `https://${['example.com', 'blog.dev', 'news.site'][i % 3]}/article-${id}`,
    title: ['Attention is all you need', 'Designing data-intensive apps', 'The economics of attention'][i % 3] + ` ${id}`,
    targetNativeId: 'f-research', createdAt: now - i * 3600e3, updatedAt: now - i * 3600e3, decisionId: null, appliedRevision: null, automatic: undefined,
    nativeId: `n-${id}`, localLocation: { nativeId: 'f-research', path: ['Know-N', 'Research'] },
    classification: ['applied', 'waiting', 'failed'][i % 3], sync: ['confirmed', 'pending', 'confirmed'][i % 3], ...over,
  });
  const ruledTask = (outcome) => task({ url: paper.url, title: paper.title, source: has('rule', 'ruleblocked') ? 'manual-popup' : 'action-popup',
    automaticIntent: !has('rule', 'ruleblocked'), targetNativeId: outcome === 'placed' ? 'f-academic' : 'f-seo', classification: 'none', sync: 'pending',
    decisionId: null, appliedRevision: null, automatic: undefined, automation: automation(outcome),
    localLocation: { nativeId: 'n-1', path: ['Bookmarks bar', ...(outcome === 'placed' ? ['Academic'] : ['Marketing', 'SEO'])] } });
  const popupTask = () => has('autorule', 'rule') ? ruledTask('placed') : has('autoruleblocked', 'ruleblocked') ? ruledTask('blocked')
    : has('autoattention') ? task({ classification: 'manual', decisionId: null, appliedRevision: null, automatic: undefined, reason: 'insufficient_credits' })
    : has('autowaiting') ? task({ classification: 'running', decisionId: null, appliedRevision: null, automatic: undefined, sync: 'pending' })
      : has('autoexisting') ? task({ disposition: 'existing', save: 'unsubmitted', nativeId: null, classification: 'none', decisionId: null, appliedRevision: null, automatic: undefined,
        existence: { kind: 'local', exact: [exactOne()[0]], similar: [], coverage: { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: now, stale: false } } })
        : task();
  const exactOne = () => [{ nativeId: 'n-1', nodeId: null, collectionId: null, collectionTitle: null, path: ['Bookmarks bar', 'Programming'], writable: true, url: tabUrl }];
  const historyItems = () => has('empty') ? [] : [
    historyTask(1, 0, { classification: 'applied', appliedRevision: 'rev-1', decisionId: 'dec-1', savedAt: now - 3500e3, local: true,
      automatic: { decision: { tags: ['mcp', 'ai'], path: ['Know-N', 'Research'], automaticApplied: true, status: 'applied' } } }),
    historyTask(2, 1, { sync: 'attention' }),
    historyTask(3, 2, { save: 'failed' }),
    historyTask(4, 8, { save: 'unknown', createdAt: now - 26 * 3600e3 }),
    historyTask(5, 3, { createdAt: now - 28 * 3600e3 }),
    ...(has('waiting') ? [historyTask(6, 2, { classification: 'waiting', createdAt: now - 30 * 3600e3 })] : []),
    ...(has('long') ? [historyTask(7, 5, { title: 'A very long title that keeps going well past the end of the line to show how a single row copes with a title that never seems to end', url: 'https://very-long-domain-name.example.com/a/very/long/path',
      createdAt: now - 29 * 3600e3, save: 'failed', localLocation: { nativeId: 'f-read', path: ['Bookmarks bar', 'A folder with a rather long name', 'Another nested folder name'] } }),
      ...Array.from({ length: 8 }, (_, k) => historyTask(20 + k, k, { createdAt: now - (2 + k) * 86400e3 - 3600e3 }))] : []),
  ];
  const counters = (mult = 1) => ({ total: 12 * mult, saved: 10 * mult, failed: 1 * mult, pending: 1 * mult, unknown: 0,
    existing: 0, cancelled: 0, automaticEligible: 8 * mult, automaticApplied: 6 * mult, positive: 4 * mult, negative: 1 * mult,
    implicit: 1 * mult, unrated: 2 * mult, syncConfirmed: 9 * mult, syncPending: 1 * mult, syncAttention: 0, attention: mult });
  const statistics = { definitionVersion: 'capture-metrics.v1', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    updatedAt: now, from: now - 7 * 86400e3, to: now, counts: counters(),
    days: Array.from({ length: 7 }, (_, i) => ({ date: iso(now - (6 - i) * 86400e3).slice(0, 10), counts: counters(i % 2 ? 1 : 0) })),
    latency: { save: { samples: 11, p50: 180, p95: 620 }, classification: { samples: 6, p50: 2400, p95: 5100 } },
    saveFailures: { permission_denied: 1 }, classificationDeferrals: { offline: 2 } };
  const coverage = { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: now, stale: false };


  // ---- subscriptions (BOOKMARK_SUBSCRIPTIONS commands) -----------------------------------------------------------
  const subSource = (id, title, type, owner, extra = {}) => ({ sourceType: type, sourceId: id, title, owner: { displayName: owner, handle: null }, visibility: 'public', relations: ['followed'], sourceRole: 'viewer',
    openUrl: `https://know-n.com/${type === 'digest_series' ? 'digests' : 'c'}/${id}`, updatedAt: iso(now - 3600e3), allowedMappingModes: ['readonly'], ...extra });
  const subMapping = (id, title, type, owner, state, extra = {}, localExtra = {}) => ({
    mappingId: uuid(300 + id), subscriptionId: `sub-${id}`, profileId: 'bp-1', profileLabel: 'This browser', mode: 'readonly', generation: 'g1', revision: 'r1', status: 'active', createdAt: iso(now - id * 86400e3), detachedAt: null,
    digestMode: type === 'digest_series' ? 'latest' : null, editionLimit: type === 'digest_series' ? 1 : null, checkIntervalMinutes: 15, exitPolicy: { onUnfollow: 'inherit', onUnsubscribe: 'inherit' },
    sourceRef: { sourceType: type, sourceId: `src-${id}` }, availability: 'available', source: subSource(`src-${id}`, title, type, owner),
    local: { id: `l-${id}`, state, enabled: state !== 'paused', localAlias: title, mountPath: ['Subscriptions', title], bookmarkCount: type === 'digest_series' ? 20 : 318,
      lastCheckedAt: now - 5 * 60e3, lastUpdatedAt: now - 3600e3, nextCheckAt: now + 10 * 60e3, rootNativeId: 'f-sub', ...localExtra }, ...extra });
  const subMappings = () => has('subempty') ? [] : [
    subMapping(1, 'Frontend Weekly', 'digest_series', 'Frontend Weekly team', 'current'),
    subMapping(2, 'Ana’s AI reading list', 'collection', 'Ana Souza', 'paused', { checkIntervalMinutes: 60 }),
    subMapping(3, 'Rust Digest', 'digest_series', 'Rust community', 'retrying', {}, { lastCheckedAt: now - 3600e3 }),
    ...(has('subwait') ? [subMapping(4, 'Design Systems Weekly', 'digest_series', 'DS team', 'local_change'), subMapping(5, 'Open source maintainers', 'collection', 'OSS folks', 'applying')] : []),
    ...(has('sublong') ? [subMapping(6, 'A very long subscription title that keeps going well past the end of the line to show how a row copes with it', 'collection', 'An author with a rather long display name that also goes on', 'current', {}, { mountPath: ['Bookmarks bar', 'Subscriptions', 'Another nested folder with a long name', 'And another one'] })] : []),
  ];
  const subFollows = () => ({ items: has('subempty') ? [] : [{ subscriptionId: 'sub-9', sourceType: 'collection', sourceId: 'src-9', status: 'active', revision: 'r', createdAt: iso(now), terminatedAt: null, availability: 'available', source: subSource('src-9', 'Product design reading', 'collection', 'Mira Chen') }], nextCursor: null });
  const subs = (command) => {
    const ok = (data) => ({ ok: true, data });
    if (errored || has('suberr')) return { ok: false, error: 'subscription_runtime_unavailable' };
    if (has('subout') && command.kind === 'list') return { ok: false, error: 'sign_in_required' };
    if (has('subnoperm') && command.kind === 'list') return { ok: false, error: 'permission_required' };
    switch (command.kind) {
      case 'list': {
        const items = command.status === 'detached' ? [{ ...subMapping(8, 'Old newsletter', 'digest_series', 'Someone', 'detached', { status: 'detached', detachedAt: iso(now - 86400e3) }), local: null }] : subMappings();
        return ok({ profileId: 'bp-1', mappings: { items, nextCursor: null }, subscriptions: subFollows(), capabilities: { protocolVersion: 1, contentEnabled: true, limits: {} }, pendingDraft: null,
          pendingExits: has('subwait') ? [{ mappingId: 'map-77', generation: 'g1', result: 'kept', localAlias: 'Retired digest' }] : [] });
      }
      case 'subscriptions': return ok(subFollows());
      case 'mapping': { const found = subMappings().find((m) => m.mappingId === command.mappingId) ?? subMappings()[0]; return ok({ mapping: found, etag: '"1"', local: found.local, sourceRef: found.sourceRef }); }
      case 'source': return ok(subSource(command.sourceId, 'Frontend Weekly', command.sourceType, 'Frontend Weekly team'));
      case 'sources': return ok({ items: [subSource('s1', 'Frontend Weekly', 'digest_series', 'Frontend Weekly team'), subSource('s2', 'Ana’s AI reading list', 'collection', 'Ana Souza', { visibility: 'unlisted' }), subSource('s3', 'Rust Digest', 'digest_series', 'Rust community', { visibility: 'protected' })], nextCursor: null });
      case 'directoryDefaults': return ok({ mountParentNativeId: has('subdirs') ? 'f-sub' : null, preservationParentNativeId: null });
      case 'wizardDraft': return ok(null);
      case 'folders': return ok({ nodes: command.parentId ? [] : [{ id: '1', title: 'Bookmarks bar', disabled: false }, { id: '2', title: 'Other bookmarks', disabled: false }, { id: 'f-sub', title: 'Subscriptions', disabled: true, reason: 'readonly_subscription' }] });
      case 'sourcePreview': return ok({ descriptor: { snapshotId: 'snap', source: { sourceType: command.sourceType, sourceId: command.sourceId }, mappingId: null, generation: null, digestMode: command.digestMode, editionLimit: command.editionLimit, projectionVersion: '1', projectionRevision: 'p', projectionEtag: 'e', policyRevision: 'x', contentDigest: 'd', rootKey: 'root',
        counts: { nodes: 2, bookmarks: 20, editions: 1, skipped: 0 }, skippedByReason: [], editions: [{ editionId: 'ed1', title: 'Issue 214: Container queries in practice', publishedAt: iso(now) }], expiresAt: iso(now + 3600e3), maxPageSize: 200 },
        nodes: [{ key: 'root', parentKey: null, index: 0, kind: 'folder', role: 'root', editionId: null, title: 'Frontend Weekly' }, { key: 'a', parentKey: 'root', index: 0, kind: 'bookmark', role: 'content', editionId: 'ed1', title: 'Container queries in practice', url: 'https://example.com/a' }] });
      case 'mountPreview': return ok({ token: 'tok', expiresAt: iso(now + 3600e3), input: command, descriptor: { snapshotId: 'snap', counts: { nodes: 22, bookmarks: 20, editions: 1, skipped: 0 }, skippedByReason: [], editions: [], expiresAt: iso(now + 3600e3) }, nodes: [] });
      case 'exitPreview': return ok({ previewId: 'pv', trigger: 'unsubscribe', preferenceRevision: '1', expiresAt: iso(now + 3600e3), targets: [{ mappingId: command.mappingId, subscriptionId: 'sub-1', profileId: 'bp-1', profileLabel: 'This browser', generation: 'g1', mappingRevision: 'r1', effectiveAction: 'keep', policyOrigin: 'global' }] });
      case 'diagnostics': return ok({ items: [], nextCursor: null });
      default: return ok({});
    }
  };

  // ---- TABS: the Save tabs page (capture-tabs.html) ----------------------------------------------------------------
  //   tabs-notabs   tab access not granted (an alert with Allow)     tabs-dupe   some tabs are already saved (Save another copy)
  //   tabs-confirmed  the batch is saving in the background          tabs-long   long titles and addresses   tabs-many   40 tabs
  const tabSites = [['Attention is all you need', 'https://arxiv.org/abs/1706.03762'], ['Designing Data-Intensive Applications', 'https://dataintensive.net/'], ['The economics of attention', 'https://news.site/economics'],
    ['Core Web Vitals', 'https://web.dev/vitals/'], ['Building effective agents', 'https://www.anthropic.com/research/building-effective-agents'], ['Using the Fetch API - Web APIs | MDN', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch'],
    ['Instapaper Integrations | Connect Your Apps with Zapier', 'https://zapier.com/apps/instapaper/integrations'], ['Positioning for developer tools', 'https://example.com/positioning'], ['Hacker News', 'https://news.ycombinator.com/'], ['Wikipedia', 'https://en.wikipedia.org/'],
    ['Extensions | Chrome', 'chrome://extensions/'], ['', null]];
  const batchItems = () => {
    const sites = has('tabs-many') ? Array.from({ length: 40 }, (_, k) => [`Article number ${k + 1} about something worth reading`, `https://site${k % 7}.example/post/${k + 1}`]) : tabSites;
    return sites.map(([title, url], k) => ({ itemId: uuid(900 + k), commandId: uuid(950 + k), tabIds: [k + 1, ...(k === 3 ? [99] : [])],
      title: has('tabs-long') && k === 1 ? 'A very long tab title that keeps going well past the end of the line to show how a row in the list copes with a title that never seems to end' : title,
      url: has('tabs-long') && k === 1 ? 'https://very-long-domain-name.example.com/a/very/long/path/that/goes/on/and/on?with=query' : url,
      reason: url === null ? 'unreadable' : url.startsWith('chrome://') ? 'unsupported' : null,
      existence: has('tabs-dupe') && (k === 2 || k === 6) ? { kind: 'local', exact: [{ nativeId: 'n-1', nodeId: null, collectionId: null, collectionTitle: null, path: ['Bookmarks bar', 'Programming'], writable: true, url }], similar: [], coverage: { local: 'complete', cloud: 'not-checked', collectionIds: [], checkedAt: now, stale: false } } : null,
      captureId: has('tabs-confirmed') && k < 4 ? uuid(700 + k + 1) : null }));
  };
  const batch = () => { const items = batchItems(); return { batchId: uuid(800), scope: { replicaId: 'rep-1', collectionId: 'col-reading', accountId: 'account-example', serverOrigin: 'https://known.example', browserProfileId: 'bp-1' },
    windowId: 1, selection: 'all', tabsPermission: !has('tabs-notabs'), createdAt: now, confirmed: has('tabs-confirmed'),
    selectedIds: has('tabs-confirmed') ? items.filter((item) => item.captureId).map((item) => item.itemId) : [], saveAnotherIds: [], targetNativeId: has('tabs-confirmed') ? 'f-prog' : null, items }; };

  // ---- background messages -------------------------------------------------------------------------------------
  const respond = async (msg) => {
    if (msg && msg.type === 'BOOKMARK_SUBSCRIPTIONS') return subs(msg.command ?? {});
    const kind = msg && msg.kind;
    if (errored && !isPopup && !['known.auth.status', 'known.capture.navigation.get', 'known.capture.navigation.set'].includes(kind)) return { ok: false, error: 'unavailable' };
    switch (kind) {
      case 'known.auth.status':
        if (signedOut) return { ok: true, state: { status: 'signed_out', environment: 'development', serverOrigin: 'https://known.example' } };
        return { ok: true, state: { status: 'connected', environment: 'development', serverOrigin: 'https://known.example',
          accountLabel: 'ada@example.com', sessionExpiresAt: iso(now + 3600e3) } };
      case 'known.capture.control':
        return { ok: true, scopeKey: 'scope-1', mode: manual ? 'manual' : 'automatic', pending: false, state: manual ? 'manual' : 'automatic',
          permission: true, signedIn: !signedOut,
          control: { paused: has('paused'), generation: 3, lastCommand: null,
            consent: signedOut ? null : { collectionId: 'col-reading', priceVersion: 'price-v1', maxPoints: 10, periodPoints: 200, expiresAt: now + 20 * 3600e3 } },
          target: signedOut ? { nativeId: 'f-research', path: ['Know-N', 'Research'], inRange: false, collectionId: null, collectionTitle: null }
            : { nativeId: 'f-research', path: ['Know-N', 'Research'], inRange: true, collectionId: 'col-reading', collectionTitle: 'Reading list' },
          targetError: null, counts: { resumable: 2, suggestions: 1, checking: 0, manual: 0 } };
      case 'known.capture.control.quote': return { ok: true, quote: { priceVersion: 'price-v1', unitPoints: 4, available: 12480 } };
      case 'known.capture.history':
        return { ok: true, items: historyItems(), remoteItems: [], next: null, statistics, unreported: 0 };
      case 'known.capture.diagnostics':
        return { ok: true, diagnostic: { reason: 'ready', checkedAt: iso(now), mode: 'automatic', signedIn: true,
          permission: { bookmarks: true }, scope: 'scope-1', pending: { control: false } } };
      case 'known.capture.learning':
        return { ok: true, view: { enabled: true, priorAvailable: true, clearedAt: null, generation: 1,
          records: [{ hostname: 'example.com', beforePath: ['Know-N', 'Inbox'], afterPath: ['Know-N', 'Research'], receivedAt: now - 86400e3, available: true }] } };
      case 'known.collections.list': return { ok: true, collections: [{ id: 'col-reading', title: 'Reading list', kind: 'bookmarks', visibility: 'private' }, { id: 'col-work', title: 'Work', kind: 'bookmarks', visibility: 'private' }] };
      case 'known.capture.cloudAvailable': return { available: false };
      case 'known.capture.navigation.get': return { ok: true, hash: null, identity: 'id-1' };
      case 'known.capture.navigation.set': return { ok: true };
      case 'known.bookmark.preferences.get':
        return { ok: true, preferences: { bookmarkInsertPosition: 'bottom', foldersFirst: true, captureMode: manual ? 'manual' : 'automatic',
          resultPanelAutoDismissMs: 5000, resultPanelMs: 5000, learnFromCorrections: true, resumeClassificationWhenOnline: true,
          subscriptionOnUnfollow: 'keep', subscriptionOnUnsubscribe: 'keep', subscriptionDefaultCheckIntervalMinutes: 60,
          subscriptionDefaultDigestMode: 'recent', subscriptionDefaultEditionLimit: 5 },
        scope: 'account', source: 'server', revision: '1', etag: '"1"', pending: false, conflict,
        ...(conflict ? { conflictValues: { local: { bookmarkInsertPosition: 'bottom', foldersFirst: true }, remote: { bookmarkInsertPosition: 'top', foldersFirst: false } } } : {}) };
      case 'known.bookmark.preferences.local':
        return { ok: true, preferences: { captureMode: manual ? 'manual' : 'automatic', bookmarkInsertPosition: 'bottom',
          resultPanelAutoDismissMs: isPopup && !has('autonoline') ? 600000 : 0 } };
      case 'known.sync.engine.status': {
        const engine = { phase: has('stuck', 'syncstall') ? 'offline' : 'idle', recoveryFrozen: false, authorityRefreshRequired: false, cooldownPending: false,
          engineWakeInFlight: false, authorityRefreshInFlight: false, credentialReady: true, sessionReady: true, hasPendingWork: false, parked: false,
          attention: [], conflictPending: has('attention'), errorCode: has('stuck') ? 'server_error' : undefined };
        return { ok: true, state: engine, engine };
      }
      case 'known.capture.get': case 'known.capture.start':
        if (!isPopup) {
          const found = historyItems().find((item) => item.captureId === msg.captureId);
          return found ? { ok: true, task: { ...found, savedAt: found.save === 'local-saved' ? found.createdAt + 900 : undefined } } : { ok: false, error: 'capture_not_found' };
        }
        await sleep(has('autoboot') ? 60000 : 0);
        return { ok: true, task: popupTask() };
      case 'known.capture.edit': return { ok: true, task: popupTask() };
      case 'known.capture.remove': (window.__removeCalls ??= []).push(msg); return { ok: true, task: task({ disposition: 'cancelled' }) };
      case 'known.capture.existence':
        return { ok: true, existence: has('existing') ? { kind: 'local', exact: exactOne(), similar: [], coverage } : { kind: 'not-found', exact: [], similar: [], coverage } };
      case 'known.save.status':
        return { ok: true, status: { kind: has('attention') ? 'action-required' : 'synced', label: has('attention') ? 'Action required' : 'Synced', tone: has('attention') ? 'attention' : 'ok' },
          localOnly: false, mountNativeIds: ['1'], defaultFolderId: 'f-seo' };
      case 'known.favicon.save-context': return { ok: true, parentNativeId: 'f-seo' };
      case 'known.capture.batch.preview': case 'known.capture.batch.get': case 'known.capture.batch.resume': case 'known.capture.batch.confirm':
        return { ok: true, batch: batch(), tasks: has('tabs-confirmed') ? historyItems().slice(0, 4).map((item, k) => ({ ...item, captureId: uuid(700 + k + 1),
          // Save tabs under rules: the first tab was placed by one, the fifth matched one whose folder is missing here.
          ...(has('tabs-rule') && k === 0 ? { save: 'local-saved', disposition: 'new', automation: automation('placed'), localLocation: { nativeId: 'f-academic', path: ['Bookmarks bar', 'Academic'] } } : {}),
          ...(has('tabs-rule') && k === 3 ? { save: 'local-saved', disposition: 'new', automation: automation('blocked') } : {}) })) : [] };
      // ---- Sync ----
      case 'known.sync.ingressDiagnostics.get':
        return { ok: true, diagnostics: has('ingress') ? [
          { code: 'unselected_range', count: 41, firstAt: now - 9 * 86400e3, lastAt: now - 3600e3 },
          { code: 'private_local', count: 6, firstAt: now - 5 * 86400e3, lastAt: now - 86400e3 },
          { code: 'unsupported_url_scheme', count: 3, firstAt: now - 2 * 86400e3, lastAt: now - 7200e3 },
          { code: 'reorder_children_local_only', count: 12, firstAt: 0, lastAt: 0 }] : [] };
      case 'known.roots.boundaries': return { ok: true, boundaries: { selected: has('empty') ? [] : ['f-prog', 'f-marketing'], privateLocal: [] } };
      case 'known.localImport.status': return { ok: true, status: has('importing') ? { commandId: uuid(1), digest: 'd', targetNativeId: '1', folderTitle: 'Imported', total: 1204, next: 812, state: 'running', reason: null }
        : has('importattn') ? { commandId: uuid(1), digest: 'd', targetNativeId: '1', folderTitle: 'Imported', total: 1204, next: 812, state: 'attention', reason: 'permission_required' } : null };
      case 'known.localImport.preview': return { ok: true, preview: { digest: 'dg', creates: 1205, roots: ['Bookmarks bar', 'Other'], warnings: has('warn') ? ['Bookmark without HREF was omitted.'] : [] } };
      case 'known.batch.status': return { ok: true, status: null };
      case 'known.batch.preview': return { ok: true, preview: { operation: msg.operation, digest: 'sha256:p', basisDigest: 'b', crossBoundary: false, requiresSecondConfirm: true,
        items: (msg.nativeIds ?? []).map((id) => ({ nativeId: id, title: nodes.get(id)?.title ?? id, nodeKind: nodes.get(id)?.url ? 'bookmark' : 'folder', state: 'ready' })) } };
      case 'known.roots.get': {
        if (has('rfail')) return { ok: false, error: 'request_invalid' };
        if (has('rperm')) return { ok: true, view: { viewId: 'v1', status: 'permission_required', roots: [] } };
        if (has('rtree')) return { ok: true, view: { viewId: 'v1', status: 'tree_unavailable', roots: [] } };
        const row = (ref, kind, title, depth, selected, bookmarkCount, folderCount, extra = {}) => ({ ref, kind, title, depth, selected, privateLocal: false, managed: false, bookmarkCount, folderCount, ...extra });
        return { ok: true, view: { viewId: 'v1', status: has('rnested') ? 'nested_normalized' : 'ready', roots: [
          row('r-bar', 'bookmarks_bar', 'Bookmarks bar', 0, false, 0, 3), row('r-mkt', 'folder', 'Marketing', 1, true, 12, 1), row('r-seo', 'folder', 'SEO', 2, true, 8, 0),
          row('r-prog', 'folder', has('long') ? 'A very long folder name that keeps going well past the end of the line to see how the tree row copes with it' : 'Programming', 1, true, 24, 0),
          row('r-pers', 'folder', 'Personal', 1, false, 9, 0, { privateLocal: has('rprivate') }),
          row('r-other', 'other', 'Other bookmarks', 0, false, 41, 2), row('r-ref', 'folder', 'Reference', 1, false, 30, 0),
          ...(has('rmanaged') ? [row('r-mob', 'mobile', 'Mobile bookmarks', 0, false, 0, 0, { managed: true, exclusionReason: 'managed' })] : []) ] } };
      }
      case 'known.roots.preview': return { ok: true, preview: { previewId: 'rp1', boundaryVersion: '1', treeDigest: 'td', bookmarkCount: 44, folderCount: 3, skippedCount: 0, addedCount: 1, removedCount: 1, shiftCount: has('rshift') ? 1 : 0,
        expiresAt: now + 600e3, warnings: has('rnested') ? [{ code: 'nested_normalized' }] : [], shifts: has('rshift') ? [{ ref: 'r-mkt', title: 'Marketing', bookmarkCount: 12, folderCount: 1, affectedCount: 12 }] : [],
        removals: [{ ref: 'r-pers', title: 'Personal', bookmarkCount: 9, folderCount: 0, affectedCount: 9 }] } };
      case 'known.roots.confirm': return { ok: false, error: 'preview_stale' };
      case 'known.personalSync.status': return signedOut || has('nocollection') ? { ok: false, error: 'collection_required' }
        : { ok: true, collectionId: 'col-reading', policy: { version: 1, mode: has('ps-paused') ? 'paused' : has('ps-disconnected') ? 'disconnected'
          : has('ps-unavailable') ? 'target-unavailable' : 'enabled', collectionId: 'col-reading', revision: uuid(9), reason: 'user' } };
      case 'known.firstRun.status': return has('frnew') ? { ok: true, firstRun: 'none', phase: 'draft' } : has('frattn') ? { ok: true, firstRun: 'running', phase: 'needs_attention', attention: { reportId: 'rep', pendingCount: 3, conflictCount: 1, rejectedCount: 0 } } : { ok: true, firstRun: 'completed', phase: 'completed' };
      case 'known.firstRun.preview': return { ok: true, previewId: 'fp1', boundaryVersion: '1', treeDigest: 'td', bookmarkCount: 44, folderCount: 3, skippedCount: 0, warnings: [], ...(msg.bootstrapMode ? { report: { matched: 31, localOnly: 9, remoteOnly: 4, candidates: 2, conflicts: 0 } } : {}) };
      case 'known.firstRun.later': return { ok: true, firstRun: 'deferred', phase: 'draft' };
      case 'known.nativeWait.list': return has('nwait') ? { ok: true, waits: [
        { waitRef: 'w1', intentId: 'i1', colpId: 'c1', title: 'Designing data-intensive apps', url: 'https://dataintensive.net/', waitReason: 'native_result_unknown', candidates: [{ nativeId: 'b-gh', title: 'Designing Data-Intensive Applications', url: 'https://dataintensive.net/' }, { nativeId: 'b-an', title: 'DDIA notes', url: 'https://notes.example/ddia' }], affectedRange: { parentNativeId: 'f-read' }, generation: 1 },
        { waitRef: 'w2', intentId: 'i2', colpId: 'c2', title: 'The economics of attention', url: 'https://news.site/economics', waitReason: 'waiting_dependency', candidates: [], affectedRange: { parentNativeId: 'f-read' }, generation: 1 },
        ...(has('long') ? [{ waitRef: 'w3', intentId: 'i3', colpId: 'c3', title: 'A very long bookmark title that keeps going well past the end of the line to show how a waiting row copes with it', url: 'https://very-long-domain-name.example.com/a/very/long/path', waitReason: 'native_result_unknown', candidates: [], affectedRange: { parentNativeId: 'f-read' }, generation: 1 }] : []) ] } : { ok: true, waits: [] };
      case 'known.nativeWait.confirm': return has('nwerr') ? { ok: false, error: 'something_else' } : { ok: true, result: 'bound' };
      case 'known.remoteDelete.policy.get': case 'known.remoteDelete.pending.list': return { ok: true, policy: has('rdkeep') ? 'confirm' : 'sync', casVersion: 1, pendingCount: has('rdel') ? 2 : 0,
        pending: has('rdel') ? [{ decisionId: 'd1', title: 'Hacker News', kind: 'bookmark', state: 'pending', casVersion: 1, deleteRevision: 'x1' }, { decisionId: 'd2', title: 'Old projects', kind: 'folder', state: 'pending', casVersion: 1, deleteRevision: 'x2' }] : [],
        conflictPending: has('rconf'), conflictHref: 'https://known.example/sync' };
      case 'known.sync.progress.get': {
        if (signedOut) return { ok: true, progress: null };
        const counts = (synced, total) => ({ synced, total });
        if (has('syncprep')) return { ok: true, progress: { stage: 'preparing', firstSync: true, liveWork: false, bookmarks: counts(0, 0), folders: counts(0, 0) } };
        if (has('syncrun', 'syncstall')) return { ok: true, progress: { stage: 'syncing', firstSync: true, liveWork: true, bookmarks: counts(1240, 5312), folders: counts(38, 214) } };
        return { ok: true, progress: { stage: 'done', firstSync: false, liveWork: false, bookmarks: counts(5312, 5312), folders: counts(214, 214) } };
      }
      case 'known.sync.attention.get': return { ok: true, attention: has('attn') ? { phase: 'recovery', recoveryFrozen: true, queueProjection: 'idle', rejectedPending: false, conflictPending: false, nativeWaitPending: false, waitCount: 0, lastError: 'payload_too_large', recoveryCode: 'payload_too_large', terminal: true, terminalCode: 'payload_too_large' }
        : { phase: 'idle', recoveryFrozen: false, queueProjection: 'idle', rejectedPending: has('rrej'), conflictPending: false, nativeWaitPending: has('nwait'), waitCount: has('nwait') ? 2 : 0, terminal: false } };
      case 'known.import.previewFile': case 'known.import.previewNative': return { ok: true, preview: { digest: 'dg', sourceProfile: 'netscape-bookmarks-v1', creates: 1204,
        warnings: has('warn') ? [{ code: 'w1', message: 'Bookmark without HREF was omitted.' }, { code: 'w2', message: 'Invalid bookmark timestamp was omitted.' }] : [],
        roots: [{ sourceNodeId: 'n1', kind: 'Folder', title: 'Bookmarks bar', descendants: 640 }, { sourceNodeId: 'n2', kind: 'Folder', title: 'Other bookmarks', descendants: 563 }, { sourceNodeId: 'n3', kind: 'Folder', title: 'Imported from Safari', descendants: 0 }],
        targets: [{ nativeId: '1', colpId: 'c1', revision: 'r', title: 'Reading list' }, { nativeId: 'f-prog', colpId: 'c2', revision: 'r', title: 'Programming' }] } };
      case 'known.import.status': { const mode = flags.find((f) => f.startsWith('imp-')); if (!mode) return { ok: false, error: 'no_import' };
        const base = { planId: 'plan-1', state: 'active', progress: { total: 1204, skipped: 4, queued: 388, terminal: 808, recoverable: 0 } };
        return { ok: true, status: mode === 'imp-paused' ? { ...base, state: 'paused' } : mode === 'imp-attn' ? { ...base, state: 'attention', progress: { ...base.progress, recoverable: 6, queued: 0, terminal: 1190 } } : mode === 'imp-done' ? { ...base, state: 'complete', progress: { total: 1204, skipped: 4, queued: 0, terminal: 1200, recoverable: 0 } } : base }; }
      case 'known.import.commit': return { ok: true, status: { planId: 'plan-1', state: 'active', progress: { total: 1204, skipped: 0, queued: 1204, terminal: 0, recoverable: 0 } } };
      case 'known.classification.settings':
        return has('suggest', 'suggesting') ? { ok: true, result: { settings: { executionMode: has('local') ? 'own_service' : 'server_managed', autoTagMode: 'suggest' } } } : { ok: false, error: 'unavailable' };
      case 'known.classification.preview': {
        // "Suggest another" names the folders turned down; offer the first one that is not.
        const rejected = msg.document.rejectedFolderIds ?? [];
        if (has('suggesting') || (rejected.length && has('retrying'))) await sleep(60000);
        const id = [...(longPath ? ['f-long2'] : []), 'f-marketing', 'f-research', 'f-read'].find((folder) => !rejected.includes(folder));
        return { ok: true, nativeFolder: { folderId: id, nativeId: id, title: nodes.get(id).title },
          result: { folder: { decision: 'suggest', folderId: id }, tags: { mode: 'suggest', candidates: [{ tag: 'automation' }, { tag: 'zapier' }] },
            candidateCoverage: { l1Included: 1, l1Total: 1, descendantIncluded: 0, descendantTotal: 0 } } };
      }
      case 'known.classification.folder': return { ok: true, nativeFolder: { folderId: msg.folderId, nativeId: msg.folderId, title: nodes.get(msg.folderId)?.title ?? '' } };
      case 'known.save.native': return { ok: true, previewOpened: true };
      case 'known.capture.context': return { ok: true, actionPopup: true };
      case 'known.automation.match':
        return { ok: true, match: has('rule') ? { outcome: 'placed', ruleName: 'arXiv papers', ruleCount: 1, folderNativeId: 'f-academic', folderTitle: 'Academic' }
          : has('ruleblocked') ? { outcome: 'blocked', ruleName: 'arXiv papers', ruleCount: 1, folderNativeId: null, folderTitle: null } : null };
      case 'known.automation.state': case 'known.automation.refresh': {
        const state = has('auto-paused') ? 'paused' : has('auto-expired') ? 'expired' : has('auto-none', 'auto-off') ? 'none' : 'active';
        const rules = state !== 'active' || has('auto-empty') ? [] : [
          { id: 'r1', name: 'arXiv papers', folder: 'Academic', resolved: true },
          { id: 'r2', name: 'GitHub repositories to Programming', folder: 'Programming', resolved: true },
          { id: 'r3', name: 'Recipes from my favourite food sites', folder: null, resolved: !has('auto-missing') }];
        if (rules[2] && rules[2].resolved) rules[2].folder = 'Cooking';
        const placement = (id, title, url, ruleName, folder, ago, placementState, path = 'preSave') => ({ id, title, host: new URL(url).hostname, ruleName, folder, at: now - ago, path, state: placementState });
        const placements = has('auto-none', 'auto-off', 'auto-empty') || signedOut ? [] : [
          placement('p1', 'Attention Is All You Need', 'https://arxiv.org/abs/1706.03762', 'arXiv papers', 'Academic', 40e3, 'waitingForSync'),
          placement('p2', 'facebook/react: The library for web and native user interfaces', 'https://github.com/facebook/react', 'GitHub repositories to Programming', 'Programming', 25 * 60e3, 'confirmed', 'observed'),
          placement('p3', 'Scaling Laws for Neural Language Models', 'https://arxiv.org/abs/2001.08361', 'arXiv papers', 'Academic', 3 * 3600e3, has('auto-rejected') ? 'rejected' : 'review'),
          placement('p4', 'Lemon tart', 'https://www.bbcgoodfood.com/recipes/lemon-tart', 'Recipes from my favourite food sites', 'Cooking', 26 * 3600e3, 'confirmed')];
        return { ok: true, state: { account: signedOut ? 'signedOut' : 'signedIn', state: signedOut ? 'none' : state, rules, placements,
          pausedAt: state === 'paused' ? now - 2 * 86400e3 : null, pausedBy: state === 'paused' ? 'owner' : null,
          expiresAt: state === 'expired' ? now - 3600e3 : now + 6 * 86400e3, lastRefreshAt: state === 'none' && !has('auto-off') ? null : now - (state === 'expired' ? 8 * 86400e3 : 120e3),
          problem: has('auto-rejected') ? 'rejected' : has('auto-off') ? 'unavailable' : state === 'expired' ? 'offline' : null, webUrl: 'https://known.example/automations' } };
      }
      case 'known.capture.check': case 'known.capture.resume': case 'known.capture.edit.cancel': case 'known.capture.feedback': case 'known.capture.presented': case 'known.connectivity.online': case 'known.favicon.drain': return { ok: true };
      default: return { ok: false, error: 'unavailable' };
    }
  };

  window.chrome = {
    runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getURL: (p) => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${p}`,
      getManifest: () => ({ version: '0.1.0', name: 'Know-N' }),
      sendMessage: (m) => respond(m), onMessage: bag(), onInstalled: bag(), onStartup: bag(),
      openOptionsPage: async () => {}, lastError: null },
    storage: { local: area(localStore), session: area(sessionStore), sync: area({}), managed: area({}), onChanged: bag() },
    permissions: { contains: async () => !has('perm', 'noperm'), request: async () => true, remove: async () => true, onAdded: bag(), onRemoved: bag() },
    bookmarks: { getTree: async () => [subtree('0')], get: async (id) => (Array.isArray(id) ? id : [id]).map((i) => nodes.has(i) ? outNode(i) : bookmarkNode(i)),
      getChildren: async (id) => (kids.get(id) ?? []).map(outNode), getSubTree: async (id) => [subtree(id)],
      search: async (q) => { const needle = String(typeof q === 'string' ? q : q.query ?? q.url ?? '').toLowerCase();
        return has('existing', 'autoexisting') ? [bookmarkNode('n-1')] : [...nodes.values()].filter((n) => n.id !== '0' && `${n.title} ${n.url ?? ''}`.toLowerCase().includes(needle)).map((n) => outNode(n.id)); },
      create: async (b) => { const id = `n-${nextNodeId += 1}`; add(id, b.parentId ?? '1', b.title ?? '', b.url); return outNode(id); },
      update: async (id, change) => { Object.assign(nodes.get(id), change); return outNode(id); },
      move: async (id, dest) => { const n = nodes.get(id); detach(id); n.parentId = dest.parentId ?? n.parentId; kids.get(n.parentId).push(id); return outNode(id); },
      remove: async (id) => { detach(id); nodes.delete(id); }, removeTree: async (id) => { detach(id); nodes.delete(id); },
      onCreated: bag(), onRemoved: bag(), onChanged: bag(), onMoved: bag(), onImportBegan: bag(), onImportEnded: bag() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {}, getBadgeText: async () => '', onClicked: bag() },
    tabs: { query: async () => [{ id: 1, url: tabUrl, title: tabTitle, favIconUrl: has('nofavicon') || ruled ? undefined : 'https://zapier.com/favicon.ico' }],
      get: async () => ({}), create: async () => ({}), update: async () => ({}), remove: async () => {},
      onCreated: bag(), onRemoved: bag(), onUpdated: bag(), onActivated: bag() },
    commands: { getAll: async () => isPopup ? [] : [{ name: '_execute_action', shortcut: 'Alt+S', description: 'Save' }, { name: 'save-window-tabs', shortcut: '', description: 'Save tabs' }] },
    alarms: { create: () => {}, get: async () => undefined, clear: async () => true, onAlarm: bag() },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: bag() },
    // Chrome's lookup: the catalog's message with $1…$9 filled; '' when missing.
    i18n: { getMessage: (k, values = []) => messages[k]?.message.replace(/\$(\$|[1-9])/gu, (_, slot) => slot === '$' ? '$' : values[Number(slot) - 1] ?? '') ?? '',
      getUILanguage: () => messages.locale?.message ?? 'en' },
    identity: { getRedirectURL: () => 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/' },
    scripting: { executeScript: async () => [] },
  };

  // ---- account and credits API (the pages fetch the account origin directly) -----------------------------------
  const nativeFetch = window.fetch.bind(window);
  const balance = { available: 12480, reserved: 320, expiringPoints: 240, nextExpiryAt: iso(now + 12 * 86400e3) };
  const entry = (i, over = {}) => ({ entryId: uuid(100 + i), sequence: String(40 - i), kind: ['spend', 'grant', 'reserve', 'release', 'refund'][i % 5],
    postedAt: iso(now - i * 7200e3), effectiveAt: iso(now - i * 7200e3),
    pointsDelta: [-4, 100, 0, -1, 4][i % 5], availableDelta: [-4, 100, -4, 3, 4][i % 5], reservedDelta: [0, 0, 4, -4, 0][i % 5],
    expiredPoints: i === 3 ? 1 : 0, balanceAfter: { available: 12480 - i * 4, reserved: i === 2 ? 4 : 0 },
    operationType: 'bookmark.classify', source: ['extension', 'scheduler', 'web'][i % 3], reasonCode: ['classification_completed', 'trial_grant', 'classification_requested'][i % 3],
    grantId: i % 5 === 1 ? uuid(50) : null, chargeId: i % 5 === 0 ? uuid(60) : null, relatedEntryId: i === 3 ? uuid(101) : null,
    expiresAt: i % 5 === 1 ? iso(now + 12 * 86400e3) : null,
    task: i % 2 === 0 ? { kind: 'classification_action', collectionId: 'col-reading', nodeId: 'node-1', runId: 'run-1', actionId: 'act-1' } : null, ...over });
  const ledger = { contractVersion: '1.0.0', accountId: 'account-example',
    snapshot: { asOf: iso(now), ledgerSequence: '40', balance },
    items: Array.from({ length: 8 }, (_, i) => entry(i)), nextCursor: null };
  window.fetch = (url, init) => {
    const u = String(url);
    if (errored && u.includes('/api/v1/me/credits')) return json({}, 500);
    if (u.includes('/api/v1/me/credits/ledger/')) return json({ contractVersion: '1.0.0', entry: entry(0) });
    if (u.includes('/api/v1/me/credits/ledger')) return json(ledger);
    if (u.includes('/api/v1/me/credits')) return json({ contractVersion: '1.0.0', accountId: 'account-example', asOf: iso(now), ledgerSequence: '40', balance,
      prices: [{ operationType: 'bookmark.classify', priceVersion: 'price-v1', unit: 'bookmark', unitPoints: 4 }] });
    if (u.endsWith('/api/v1/session')) return json({ authenticated: true, csrfToken: 'csrf-token' });
    if (u.endsWith('/api/v1/auth/get-session')) return json({ user: { id: 'subject-example' } });
    if (u.endsWith('/api/v1/me')) return json({ account: { id: 'account-example' }, profile: { id: 'account-example' } });
    return nativeFetch(url, init);
  };
}
