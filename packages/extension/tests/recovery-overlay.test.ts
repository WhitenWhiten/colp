import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  extractOutstandingTarget,
  createProjectionSuppression,
  overlayNodesFromMappings,
  planRecoveryOverlay,
  projectionSuppresses,
  type NativeFact,
  type RecoveryOverlayNode,
} from '../src/recovery-overlay.js';
import type { MappingInput, QueueOperation } from '../src/sync-state-store.js';

const root: MappingInput = {
  nativeId: 'native-root', colpId: 'root', rootNativeId: 'native-root', nodeKind: 'folder',
  projection: { revision: 'r1', digest: 'sha256:root', content: { title: 'Root' } },
};
const folder: MappingInput = {
  nativeId: 'native-folder', colpId: 'folder-1', rootNativeId: 'native-root', nodeKind: 'folder',
  parentNativeId: 'native-root', parentColpId: 'root',
  projection: { revision: 'r1', digest: 'sha256:folder', content: { title: 'Folder' } },
};
const bookmark: MappingInput = {
  nativeId: 'native-bm', colpId: 'bm-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
  parentNativeId: 'native-folder', parentColpId: 'folder-1',
  projection: { revision: 'r1', digest: 'sha256:bm', content: { title: 'Doc', url: 'https://a.example' } },
};
const pendingCreate: MappingInput = {
  nativeId: 'native-pending', colpId: 'pending-op-create', rootNativeId: 'native-root', nodeKind: 'bookmark',
  parentNativeId: 'native-root', parentColpId: 'root',
  projection: { revision: 'local-op-create', digest: 'sha256:pending', content: { title: 'Draft' } },
};

function op(partial: Partial<QueueOperation> & Pick<QueueOperation, 'opId' | 'payload'>): Pick<QueueOperation, 'opId' | 'status' | 'payload'> {
  return { opId: partial.opId, status: partial.status ?? 'pending', payload: partial.payload };
}

function node(mapping: MappingInput, position: string, parentColpId: string | null): RecoveryOverlayNode {
  const content = mapping.projection.content ?? {};
  return {
    colpId: mapping.colpId, parentColpId, position, kind: mapping.nodeKind ?? 'folder',
    title: String(content.title ?? ''), ...(typeof content.url === 'string' ? { url: content.url } : {}),
    mapping,
  };
}

const natives: NativeFact[] = [
  { nativeId: 'native-root', title: 'Root', index: 0, folder: true },
  { nativeId: 'native-folder', title: 'Folder', parentNativeId: 'native-root', index: 0, folder: true },
  { nativeId: 'native-bm', title: 'Doc', url: 'https://a.example', parentNativeId: 'native-folder', index: 0, folder: false },
  { nativeId: 'native-pending', title: 'Draft', parentNativeId: 'native-root', index: 1, folder: false },
  { nativeId: 'native-extra', title: 'Gone', parentNativeId: 'native-root', index: 2, folder: false },
];

test('Snapshot recovery keeps an issue-protected native projection instead of replacing its content', () => {
  const incoming = { ...bookmark, projection: { ...bookmark.projection, content: { title: 'Remote replacement' } } };
  const plan = planRecoveryOverlay({ snapshot: [node(root, 'a', null), node(folder, 'a', 'root'), node(incoming, 'a', 'folder-1')],
    mappings: [root, folder, bookmark], outstanding: [], nativeFacts: natives,
    selectedRootNativeId: 'native-root', issueProtectedIds: new Set(['bm-1']) });
  assert.deepEqual(plan.targetMappings.find(row => row.colpId === 'bm-1'), bookmark);
  assert.equal(plan.intents.some(row => row.colpId === 'bm-1'), false);
});

test('Snapshot recovery retains quarantined records without scheduling native mutations', () => {
  const quarantined: MappingInput = { ...bookmark,
    quarantine: { code: 'record_too_large', snapshotId: 'snapshot-1', payloadDigest: 'sha256:quarantined' } };
  const plan = planRecoveryOverlay({ snapshot: [node(root, 'a', null), node(folder, 'a', 'root'), node(quarantined, 'a', 'folder-1')],
    mappings: [root, folder, bookmark], outstanding: [], nativeFacts: natives, selectedRootNativeId: 'native-root' });
  assert.deepEqual(plan.targetMappings.find(row => row.colpId === 'bm-1'), quarantined);
  assert.equal(plan.intents.some(row => row.colpId === 'bm-1'), false);
});

test('extracts typed create identity without reading payload.targetId', () => {
  const create = extractOutstandingTarget(op({
    opId: 'op-create', payload: { type: 'create_node', payload: { parentId: 'root', node: { title: 'Draft' } } },
  }));
  assert.deepEqual(create, {
    opId: 'op-create', type: 'create_node', colpIds: ['pending-op-create'],
    provisionalColpId: 'pending-op-create', parentColpId: 'root',
  });
  assert.equal(extractOutstandingTarget(op({
    opId: 'op-other', payload: { type: 'unknown_op', payload: { targetId: 'spoofed' } },
  })), null);
});

test('keeps pending create out of snapshot and deletes only unprotected extras', () => {
  const extra: MappingInput = {
    nativeId: 'native-extra', colpId: 'extra-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-root', parentColpId: 'root',
    projection: { revision: 'r1', digest: 'sha256:extra', content: { title: 'Gone' } },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null), node(folder, 'a', 'root'), node({
      ...bookmark, projection: { ...bookmark.projection, content: { title: 'Renamed', url: 'https://b.example' } },
    }, 'a', 'folder-1')],
    mappings: [root, folder, bookmark, pendingCreate, extra],
    outstanding: [op({
      opId: 'op-create', payload: { type: 'create_node', payload: { parentId: 'root' } },
    })],
    nativeFacts: natives, selectedRootNativeId: 'native-root',
  });
  assert.ok(plan.protectedColpIds.includes('pending-op-create'));
  assert.ok(plan.targetMappings.some((mapping) => mapping.colpId === 'pending-op-create'));
  assert.equal(plan.intents.some((intent) => intent.kind === 'delete' && intent.colpId === 'pending-op-create'), false);
  assert.ok(plan.intents.some((intent) => intent.kind === 'update' && intent.colpId === 'bm-1'));
  assert.ok(plan.intents.some((intent) => intent.kind === 'delete' && intent.colpId === 'extra-1'));
});

test('keeps the selected native mount label while adopting canonical Root authority', () => {
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null)],
    mappings: [root],
    outstanding: [],
    nativeFacts: [{ ...natives[0]!, title: 'Know-N' }],
    selectedRootNativeId: 'native-root',
  });

  assert.equal(plan.targetMappings[0]?.colpId, 'root');
  assert.equal(plan.intents.some((intent) => intent.kind === 'update' && intent.colpId === 'root'), false);
});

test('rebuilds a pending create whose provisional native bookmark disappeared', () => {
  const missingPending: MappingInput = {
    ...pendingCreate,
    nativeId: 'native-missing',
    projection: {
      ...pendingCreate.projection,
      content: { title: 'Draft', url: 'https://draft.example', position: 'b' },
    },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null)],
    mappings: [root, missingPending],
    outstanding: [op({
      opId: 'op-create',
      payload: { type: 'create_node', payload: { parentId: 'root' } },
    })],
    nativeFacts: [natives[0]!],
    selectedRootNativeId: 'native-root',
  });

  assert.deepEqual(plan.targetMappings.find((mapping) => mapping.colpId === missingPending.colpId), {
    ...missingPending,
    nativeId: 'recovery:pending-op-create',
  });
  assert.deepEqual(plan.intents, [{
    intentId: 'create:pending-op-create',
    kind: 'create',
    colpId: 'pending-op-create',
    order: 1,
    suppression: createProjectionSuppression('native-root', 'Draft', 'https://draft.example'),
    parentColpId: 'root',
    parentNativeId: 'native-root',
    title: 'Draft',
    url: 'https://draft.example',
    index: 0,
    folder: false,
  }]);
});

test('reuses an exact unassigned native fact and repairs its sibling position', () => {
  const stagedBookmark: MappingInput = {
    ...bookmark,
    nativeId: 'recovery:bm-1',
  };
  const candidate: NativeFact = {
    nativeId: 'native-candidate',
    title: 'Doc',
    url: 'https://a.example',
    parentNativeId: 'native-folder',
    index: 3,
    folder: false,
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null), node(folder, 'a', 'root'), node(stagedBookmark, 'a', 'folder-1')],
    mappings: [root, folder, stagedBookmark],
    outstanding: [],
    nativeFacts: [natives[0]!, natives[1]!, candidate],
    selectedRootNativeId: 'native-root',
    allowTitleUrlIdentityGuess: true,
  });

  assert.equal(plan.targetMappings.find((mapping) => mapping.colpId === 'bm-1')?.nativeId,
    'native-candidate');
  assert.deepEqual(plan.intents, [{
    intentId: 'move:bm-1',
    kind: 'move',
    colpId: 'bm-1',
    order: 1,
    suppression: 'recovery:move:bm-1',
    nativeId: 'native-candidate',
    parentColpId: 'folder-1',
    parentNativeId: 'native-folder',
    index: 0,
  }]);
});

test('orders folder deletes after children and creates parent-first', () => {
  const child: MappingInput = {
    nativeId: 'native-child', colpId: 'child-1', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentNativeId: 'native-folder', parentColpId: 'folder-1',
    projection: { revision: 'r1', digest: 'sha256:child', content: { title: 'Child', url: 'https://c.example' } },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null)],
    mappings: [root, folder, child],
    outstanding: [],
    nativeFacts: [
      natives[0]!, natives[1]!,
      { nativeId: 'native-child', title: 'Child', url: 'https://c.example', parentNativeId: 'native-folder', index: 0, folder: false },
    ],
    selectedRootNativeId: 'native-root',
  });
  const deletes = plan.intents.filter((intent) => intent.kind === 'delete');
  assert.deepEqual(deletes.map((intent) => intent.colpId), ['child-1', 'folder-1']);
});

test('emits parent-first create when snapshot adds a missing folder', () => {
  const created: MappingInput = {
    nativeId: 'recovery:new-folder', colpId: 'new-folder', rootNativeId: 'recovery:root', nodeKind: 'folder',
    parentColpId: 'root', projection: { revision: 'r2', digest: 'sha256:new', content: { title: 'New' } },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null), node(created, 'b', 'root')],
    mappings: [root], outstanding: [],
    nativeFacts: [natives[0]!], selectedRootNativeId: 'native-root',
  });
  assert.equal(plan.intents[0]?.kind, 'create');
  assert.equal(plan.intents[0]?.colpId, 'new-folder');
  assert.equal(plan.intents[0]?.parentNativeId, 'native-root');
});

test('orders a missing nested bookmark after its missing parent folder', () => {
  const createdFolder: MappingInput = {
    nativeId: 'recovery:new-folder', colpId: 'new-folder', rootNativeId: 'native-root', nodeKind: 'folder',
    parentColpId: 'root', projection: { revision: 'r2', digest: 'sha256:new-folder', content: { title: 'New' } },
  };
  const createdBookmark: MappingInput = {
    nativeId: 'recovery:new-bookmark', colpId: 'new-bookmark', rootNativeId: 'native-root', nodeKind: 'bookmark',
    parentColpId: 'new-folder', projection: { revision: 'r2', digest: 'sha256:new-bookmark',
      content: { title: 'Nested', url: 'https://nested.example' } },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(createdBookmark, 'a', 'new-folder'), node(root, 'a', null), node(createdFolder, 'a', 'root')],
    mappings: [root, createdFolder, createdBookmark],
    outstanding: [],
    nativeFacts: [natives[0]!],
    selectedRootNativeId: 'native-root',
  });

  assert.deepEqual(plan.intents.map((item) => [item.kind, item.colpId]), [
    ['create', 'new-folder'],
    ['create', 'new-bookmark'],
  ]);
  assert.deepEqual(plan.intents.map((item) => item.order), [1, 2]);
});

test('does not count sidecar separators in native Chrome sibling indexes', () => {
  const separator: MappingInput = {
    nativeId: 'sidecar:separator-1', colpId: 'separator-1', rootNativeId: 'native-root',
    nodeKind: 'separator', parentColpId: 'root',
    projection: { revision: 'r2', digest: 'sha256:separator', content: {} },
  };
  const created: MappingInput = {
    nativeId: 'recovery:after-separator', colpId: 'after-separator', rootNativeId: 'native-root',
    nodeKind: 'bookmark', parentColpId: 'root',
    projection: { revision: 'r2', digest: 'sha256:after', content: { title: 'After', url: 'https://after.example' } },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node(root, 'a', null), node(separator, 'a', 'root'), node(created, 'b', 'root')],
    mappings: [root], outstanding: [], nativeFacts: [natives[0]!], selectedRootNativeId: 'native-root',
  });
  const create = plan.intents.find((intent) => intent.colpId === 'after-separator');
  assert.equal(create?.kind, 'create');
  assert.equal(create?.index, 0);
});

test('suppresses bookmark listener echos for in-flight projection intents', () => {
  assert.match(createProjectionSuppression('parent', 'Draft', 'https://a.example'), /^recovery:create:v2:sha256:[a-f0-9]{64}$/);
  assert.equal(projectionSuppresses([{
    state: 'executing', kind: 'create', nativeId: undefined, observedNativeId: 'native-new',
    suppression: 'recovery:create:pending-1',
  }], { kind: 'create', nativeId: 'native-new', suppression: 'recovery:create:pending-1' }), true);
  assert.equal(projectionSuppresses([{
    state: 'executing', kind: 'create', nativeId: undefined, observedNativeId: 'native-new',
    suppression: 'recovery:create:pending-1',
  }], { kind: 'create', nativeId: 'native-new', suppression: 'recovery:create:other' }), false);
  assert.equal(projectionSuppresses([{
    state: 'terminal', kind: 'delete', nativeId: 'native-old', suppression: 'recovery:delete:old',
  }], { kind: 'remove', nativeId: 'native-old', suppression: 'recovery:delete:old' }), false);
  assert.equal(projectionSuppresses([{
    state: 'executing', kind: 'update', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
  }], { kind: 'change', nativeId: 'native-bm' }), false);
  assert.equal(projectionSuppresses([{
    state: 'executing', kind: 'update', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
    title: 'Remote title', url: 'https://remote.example',
  }], { kind: 'change', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
    changes: { title: 'Remote title' } }), true);
  assert.equal(projectionSuppresses([{
    state: 'executing', kind: 'update', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
    title: 'Remote title', url: 'https://remote.example',
  }], { kind: 'change', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
    changes: { title: 'Local title' } }), false);
});

const URL_VARIANTS: ReadonlyArray<{ readonly name: string; readonly native: string; readonly snapshot: string }> = [
  { name: 'case', native: 'https://Example.COM/docs', snapshot: 'https://example.com/docs' },
  { name: 'default port', native: 'https://example.com:443/docs', snapshot: 'https://example.com/docs' },
  { name: 'trailing slash', native: 'https://example.com/docs/', snapshot: 'https://example.com/docs' },
  { name: 'fragment', native: 'https://example.com/docs#section', snapshot: 'https://example.com/docs' },
  { name: 'tracking query', native: 'https://example.com/docs?utm_source=news', snapshot: 'https://example.com/docs' },
  { name: 'query order', native: 'https://example.com/docs?b=2&a=1', snapshot: 'https://example.com/docs?a=1&b=2' },
  { name: 'percent encoding', native: 'https://example.com/%7Euser', snapshot: 'https://example.com/~user' },
  { name: 'similar path', native: 'https://example.com/docs', snapshot: 'https://example.com/docs2' },
];

function recoveryGuess(input: {
  readonly nativeUrl: string; readonly snapshotUrl: string; readonly nativeTitle?: string;
  readonly snapshotTitle?: string; readonly nativeParent?: string;
  readonly allowTitleUrlIdentityGuess?: boolean;
}) {
  const staged: MappingInput = {
    ...bookmark,
    nativeId: 'recovery:bm-1',
    projection: { ...bookmark.projection, content: { title: input.snapshotTitle ?? 'Doc', url: input.snapshotUrl } },
  };
  return planRecoveryOverlay({
    snapshot: [node(root, 'a', null), node(folder, 'a', 'root'), node(staged, 'a', 'folder-1')],
    mappings: [root, folder, staged], outstanding: [],
    nativeFacts: [
      natives[0]!, natives[1]!,
      {
        nativeId: 'native-candidate', title: input.nativeTitle ?? 'Doc', url: input.nativeUrl,
        parentNativeId: input.nativeParent ?? 'native-folder', index: 0, folder: false,
      },
    ],
    selectedRootNativeId: 'native-root',
    ...(input.allowTitleUrlIdentityGuess === undefined ? {} : { allowTitleUrlIdentityGuess: input.allowTitleUrlIdentityGuess }),
  });
}

function assertRecoveryDidNotReuse(plan: ReturnType<typeof planRecoveryOverlay>): void {
  assert.equal(plan.targetMappings.find((mapping) => mapping.colpId === 'bm-1')?.nativeId, 'recovery:bm-1');
  assert.ok(plan.intents.some((intent) => intent.kind === 'create' && intent.colpId === 'bm-1'));
  assert.equal(plan.intents.some((intent) => intent.nativeId === 'native-candidate'), false);
}

test('recovery still reuses a unique exact raw URL under the same parent', () => {
  const plan = recoveryGuess({ nativeUrl: 'https://a.example', snapshotUrl: 'https://a.example',
    allowTitleUrlIdentityGuess: true });
  assert.equal(plan.targetMappings.find((mapping) => mapping.colpId === 'bm-1')?.nativeId, 'native-candidate');
});

test('omitted allowTitleUrlIdentityGuess does not unique-match title+URL', () => {
  assertRecoveryDidNotReuse(recoveryGuess({ nativeUrl: 'https://a.example', snapshotUrl: 'https://a.example' }));
});

for (const variant of URL_VARIANTS) {
  test(`recovery does not reuse a native fact for ${variant.name} URL spelling`, () => {
    assertRecoveryDidNotReuse(recoveryGuess({ nativeUrl: variant.native, snapshotUrl: variant.snapshot }));
  });
}

test('recovery does not reuse a native fact with the same title and a different URL', () => {
  assertRecoveryDidNotReuse(recoveryGuess({
    nativeUrl: 'https://example.com/alpha', snapshotUrl: 'https://example.com/beta',
  }));
});

test('recovery does not reuse a native fact with the same URL under a different parent', () => {
  assertRecoveryDidNotReuse(recoveryGuess({
    nativeUrl: 'https://a.example', snapshotUrl: 'https://a.example', nativeParent: 'native-root',
  }));
});

test('converts durable mappings into recovery overlay nodes without mutating them', () => {
  const sparse: MappingInput = {
    nativeId: 'sidecar:separator-1', colpId: 'separator-1', rootNativeId: 'native-root',
    projection: { revision: 'r2', digest: 'sha256:separator', content: { position: 'b' } },
  };
  const result = overlayNodesFromMappings([bookmark, sparse]);

  assert.deepEqual(result.map(({ mapping: _mapping, ...item }) => item), [{
    colpId: 'bm-1', parentColpId: 'folder-1', position: 'bm-1', kind: 'bookmark',
    title: 'Doc', url: 'https://a.example',
  }, {
    colpId: 'separator-1', parentColpId: null, position: 'b', kind: 'folder', title: '',
  }]);
  assert.equal(result[0]?.mapping, bookmark);
  assert.equal(result[1]?.mapping, sparse);
});

test('edge branches: inactive and malformed ops, bare mappings, orphan snapshot chains', () => {
  assert.equal(extractOutstandingTarget(op({
    opId: 'op-done', status: 'terminal', payload: { type: 'delete_node', targetId: 'bm-1' },
  })), null);
  assert.equal(extractOutstandingTarget(op({
    opId: 'op-no-target', payload: { type: 'delete_node', targetId: 42 },
  })), null);
  assert.deepEqual(extractOutstandingTarget(op({
    opId: 'op-bare-create', payload: { type: 'create_node', payload: ['not-an-object'] },
  })), {
    opId: 'op-bare-create', type: 'create_node', colpIds: ['pending-op-bare-create'],
    provisionalColpId: 'pending-op-bare-create',
  });

  const bare: MappingInput = {
    nativeId: 'native-bare', colpId: 'bare-1', rootNativeId: 'native-root',
    projection: { revision: 'r1', digest: 'sha256:bare' },
  };
  assert.deepEqual(overlayNodesFromMappings([bare]).map(({ mapping: _mapping, ...item }) => item), [{
    colpId: 'bare-1', parentColpId: null, position: 'bare-1', kind: 'folder', title: '',
  }]);

  const orphanPending: MappingInput = {
    ...pendingCreate, parentNativeId: 'native-dead', projection: { revision: 'r1', digest: 'sha256:p' },
  };
  const plan = planRecoveryOverlay({
    snapshot: [node({ ...root, colpId: 'root' }, 'a', null),
      { colpId: 'cycle-a', parentColpId: 'cycle-b', position: 'a', kind: 'bookmark', title: 'A', mapping: bare },
      { colpId: 'cycle-b', parentColpId: 'cycle-a', position: 'b', kind: 'bookmark', title: 'B', mapping: bare }],
    mappings: [orphanPending],
    outstanding: [op({
      opId: 'op-create', payload: { type: 'create_node', payload: { parentId: 'root' } },
    })],
    nativeFacts: [natives[0]!],
    selectedRootNativeId: 'native-root',
  });
  assert.equal(plan.targetMappings.find((mapping) => mapping.colpId === 'pending-op-create')
    ?.parentNativeId, undefined);
  assert.equal(plan.targetMappings.find((mapping) => mapping.colpId === 'root')?.nativeId, 'native-root');
  assert.equal(plan.targetMappings.some((mapping) => mapping.colpId === 'cycle-a'), false);
  const orphanCreate = plan.intents.find((intent) => intent.colpId === 'pending-op-create');
  assert.equal(orphanCreate?.kind, 'create');
  assert.equal(orphanCreate?.parentNativeId, undefined);

  const suppressed = { state: 'executing' as const, kind: 'update' as const, nativeId: 'native-other',
    observedNativeId: 'native-bm', suppression: 'recovery:update:bm-1', title: 'Remote title' };
  assert.equal(projectionSuppresses([suppressed],
    { kind: 'change', nativeId: 'native-bm', suppression: 'recovery:update:bm-1',
      changes: { title: 'Remote title' } }), true);
  assert.equal(projectionSuppresses([suppressed],
    { kind: 'change', nativeId: 'native-bm' }), false);
  assert.equal(projectionSuppresses([{ ...suppressed, kind: 'create' as const, nativeId: undefined }],
    { kind: 'create', nativeId: 'native-unrelated', suppression: 'recovery:update:bm-1' }), true);
  assert.equal(projectionSuppresses([suppressed],
    { kind: 'remove', nativeId: 'native-bm', suppression: 'recovery:update:bm-1' }), false);
});
