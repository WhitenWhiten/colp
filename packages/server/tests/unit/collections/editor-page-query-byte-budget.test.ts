/**
 * P1-06 editor page query — 4 MiB serialized byte budget and cursor length preview.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EDITOR_PAGE_MAX_BYTES,
  EDITOR_PAGE_MAX_LIMIT,
  PRODUCT_EDITOR_COMPARATOR_VERSION,
  PRODUCT_EDITOR_CURSOR_PURPOSE,
  PRODUCT_EDITOR_CURSOR_TTL_MS,
  PRODUCT_EDITOR_CURSOR_VERSION,
  createProductEditorCursorSigner,
  formatUtcDateTime,
  getCollectionEditorPage,
  type EditorPage,
  type GetCollectionEditorPagePorts,
  type ProductEditorCursorAfter,
  type ProductEditorCursorPayload,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_ID,
  CONTENT_REV,
  CURSOR_KEY,
  NOW,
  POLICY_REV,
  PRINCIPAL_OWNER,
  ROOT_ID,
  addBookmark,
  createMemoryPorts,
  createState,
  expectedEditableNode,
  ownerInput,
  query,
  seedOwnedCollection,
  sortedNodes,
} from './editor-page-query-helpers.js';

// ---------------------------------------------------------------------------
// 4 MiB byte budget
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: 4 MiB byte budget', () => {
  test('with large descriptions, hasMore true before all nodes when budget exceeded', async () => {
    const state = createState();
    seedOwnedCollection(state);

    // description max 20_000; ~220 nodes * ~20 KiB exceeds 4 MiB body budget.
    const fatDescription = 'D'.repeat(20_000);
    const total = 220;
    for (let i = 0; i < total; i += 1) {
      addBookmark(state, {
        id: `fat-${String(i).padStart(4, '0')}`,
        parentId: ROOT_ID,
        positionToken: String(i).padStart(5, '0'),
        title: `Fat ${i}`,
        description: fatDescription,
      });
    }

    const page = await query(state, ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }));

    assert.ok(page.nodes.length < total, 'must stop before all nodes when byte budget hits');
    assert.equal(page.page.hasMore, true);
    assert.ok(page.page.nextCursor);
    assert.equal(page.page.returnedCount, page.nodes.length);
    assert.ok(page.nodes.length >= 1, 'single legal node must fit an empty page');

    const serialized = Buffer.byteLength(JSON.stringify(page), 'utf8');
    assert.ok(
      serialized <= EDITOR_PAGE_MAX_BYTES,
      `serialized page ${serialized} exceeds budget ${EDITOR_PAGE_MAX_BYTES}`,
    );
  });

  test.each([
    ['ASCII', 'plain-ascii'],
    ['multibyte UTF-8', '汉字🙂'],
    ['JSON escapes', '"\\\n\t'],
  ])('%s payload honors the exact boundary and excludes boundary + 1', async (_label, prefix) => {
    const state = createState();
    seedOwnedCollection(state);
    const fullNodeCount = 190;
    const paddingNodeCount = 30;
    for (let index = 0; index < fullNodeCount; index += 1) {
      addBookmark(state, {
        id: `boundary-full-${String(index).padStart(3, '0')}`,
        parentId: ROOT_ID,
        positionToken: String(index).padStart(5, '0'),
        description: 'f'.repeat(20_000),
      });
    }
    for (let index = 0; index < paddingNodeCount; index += 1) {
      const isLast = index === paddingNodeCount - 1;
      addBookmark(state, {
        id: isLast ? 'boundary-last' : `boundary-padding-${String(index).padStart(2, '0')}`,
        parentId: ROOT_ID,
        positionToken: String(fullNodeCount + index).padStart(5, '0'),
        description: isLast ? `${prefix}${'z'.repeat(1_024)}` : `${prefix}-${index}`,
      });
    }

    const baseline = await query(state, ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }));
    const total = fullNodeCount + paddingNodeCount;
    assert.equal(baseline.nodes.length, total);
    assert.equal(baseline.page.hasMore, false);
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline), 'utf8');
    let remaining = EDITOR_PAGE_MAX_BYTES - baselineBytes;
    assert.ok(remaining > 0);

    // Spread the exact-byte padding across legal descriptions. Keep the final
    // node above cursor overhead so boundary+1 excludes exactly that node.
    for (let index = fullNodeCount; index < state.nodes.length - 1 && remaining > 0; index += 1) {
      const node = state.nodes[index]!;
      const description = node.description ?? '';
      const addition = Math.min(20_000 - description.length, remaining);
      node.description = `${description}${'a'.repeat(addition)}`;
      remaining -= addition;
    }
    assert.equal(remaining, 0, 'multi-node fixture has enough legal padding capacity');
    assert.ok(state.nodes.at(-1)!.description!.length + 1 <= 20_000);

    const exact = await query(state, ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }));
    assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), EDITOR_PAGE_MAX_BYTES);
    assert.equal(exact.nodes.length, total);
    assert.equal(exact.nodes.at(-1)?.id, 'boundary-last');
    assert.equal(exact.page.hasMore, false);
    assert.equal(exact.page.nextCursor, null);

    state.nodes[state.nodes.length - 1]!.description += 'a';
    const boundaryPlusOne = await query(
      state,
      ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }),
    );
    assert.equal(boundaryPlusOne.nodes.length, total - 1);
    assert.equal(boundaryPlusOne.nodes.at(-1)?.id, 'boundary-padding-28');
    assert.equal(boundaryPlusOne.page.hasMore, true);
    assert.ok(boundaryPlusOne.page.nextCursor);
    assert.ok(
      Buffer.byteLength(JSON.stringify(boundaryPlusOne), 'utf8') <= EDITOR_PAGE_MAX_BYTES,
    );
  });

  test('500-item mixed payload serializes each node once and matches final encoded bytes', async () => {
    const state = createState();
    seedOwnedCollection(state);
    const total = EDITOR_PAGE_MAX_LIMIT + 1;
    for (let index = 0; index < total; index += 1) {
      const variant = index % 3;
      const descriptions = [
        `ascii-${index}`,
        `汉字🙂-${index}`,
        `escaped-"\\\n-${index}`,
      ];
      addBookmark(state, {
        id: `linear-${String(index).padStart(4, '0')}`,
        parentId: ROOT_ID,
        positionToken: String(index).padStart(5, '0'),
        description: descriptions[variant],
      });
    }

    const originalStringify = JSON.stringify;
    let shellCalls = 0;
    let shellBytes = 0;
    let nodeCalls = 0;
    let nodeBytes = 0;
    let largestSerializedNodeArray = 0;
    const basePorts = createMemoryPorts(state);
    const signer = basePorts.cursorSigner;
    let signCalls = 0;
    const ports: GetCollectionEditorPagePorts = {
      ...basePorts,
      cursorSigner: {
        encodedLength: (payload) => signer.encodedLength(payload),
        sign: (payload) => {
          signCalls += 1;
          return signer.sign(payload);
        },
        verify: (token, now) => signer.verify(token, now),
      },
    };
    JSON.stringify = ((...args: unknown[]) => {
      const value = args[0];
      const encoded = Reflect.apply(originalStringify, JSON, args) as string | undefined;
      if (encoded === undefined || typeof value !== 'object' || value === null) {
        return encoded;
      }
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.nodes) && typeof record.page === 'object') {
        shellCalls += 1;
        shellBytes += Buffer.byteLength(encoded, 'utf8');
        largestSerializedNodeArray = Math.max(largestSerializedNodeArray, record.nodes.length);
      }
      if (typeof record.id === 'string' && record.id.startsWith('linear-')) {
        nodeCalls += 1;
        nodeBytes += Buffer.byteLength(encoded, 'utf8');
      }
      return encoded;
    }) as typeof JSON.stringify;

    let page: EditorPage;
    try {
      page = await getCollectionEditorPage(
        ports,
        ownerInput({ limit: EDITOR_PAGE_MAX_LIMIT }),
      );
    } finally {
      JSON.stringify = originalStringify;
    }

    assert.equal(page.nodes.length, EDITOR_PAGE_MAX_LIMIT);
    assert.equal(page.page.hasMore, true);
    assert.equal(signCalls, 1);
    assert.equal(shellCalls, 1);
    assert.equal(largestSerializedNodeArray, 0);
    assert.equal(nodeCalls, EDITOR_PAGE_MAX_LIMIT);

    const finalBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    const returnedCountGrowth = Buffer.byteLength(String(page.nodes.length), 'utf8') - 1;
    const incrementalBytes = shellBytes
      + nodeBytes
      + (EDITOR_PAGE_MAX_LIMIT - 1) // commas between encoded nodes
      + returnedCountGrowth
      - 1 // `hasMore:false` -> `true`
      + Buffer.byteLength(JSON.stringify(page.page.nextCursor), 'utf8') - 4;
    assert.equal(incrementalBytes, finalBytes);
    assert.ok(finalBytes <= EDITOR_PAGE_MAX_BYTES);
  });

  test.each([
    [0, 500, 0],
    [1, 500, 0],
    [2, 1, 1],
  ])('page with %i candidates and limit %i signs %i cursor', async (
    candidateCount,
    limit,
    expectedSignCalls,
  ) => {
    const state = createState();
    seedOwnedCollection(state);
    for (let index = 0; index < candidateCount; index += 1) {
      addBookmark(state, {
        id: `sign-count-${index}`,
        parentId: ROOT_ID,
        positionToken: String(index),
      });
    }
    const basePorts = createMemoryPorts(state);
    const signer = basePorts.cursorSigner;
    let signCalls = 0;
    const ports: GetCollectionEditorPagePorts = {
      ...basePorts,
      cursorSigner: {
        encodedLength: (payload) => signer.encodedLength(payload),
        sign: (payload) => {
          signCalls += 1;
          return signer.sign(payload);
        },
        verify: (token, at) => signer.verify(token, at),
      },
    };

    const page = await getCollectionEditorPage(ports, ownerInput({ limit }));
    assert.equal(signCalls, expectedSignCalls);
    assert.equal(page.page.nextCursor === null, expectedSignCalls === 0);
  });

  test('cursor length preview matches signed tokens across variable tuple lengths', () => {
    const signer = createProductEditorCursorSigner({ current: { id: 'test-v1', key: CURSOR_KEY } });
    const base: ProductEditorCursorPayload = {
      v: PRODUCT_EDITOR_CURSOR_VERSION,
      purpose: PRODUCT_EDITOR_CURSOR_PURPOSE,
      principalId: PRINCIPAL_OWNER,
      collectionId: COLLECTION_ID,
      limit: 500,
      comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
      after: { parentKey: ROOT_ID, positionKey: '1', nodeId: 'node-1' },
      contentRevision: CONTENT_REV,
      policyRevision: POLICY_REV,
      snapshotId: 'snapshot-length-test',
      issuedAt: formatUtcDateTime(NOW),
      expiresAt: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
    };
    const afterCases: ProductEditorCursorAfter[] = [
      { parentKey: '', positionKey: '', nodeId: 'n' },
      { parentKey: ROOT_ID, positionKey: '0000000000000001', nodeId: 'node-medium' },
      { parentKey: '父节点', positionKey: 'A'.repeat(128), nodeId: '节点-🙂-escaped-"\\' },
    ];

    for (const after of afterCases) {
      const payload = { ...base, after };
      const token = signer.sign(payload);
      assert.equal(signer.encodedLength(payload), Buffer.byteLength(token, 'utf8'));
    }
  });

  test.each([-1, 1])(
    'fails closed when cursor length preview differs from signed token by %i byte',
    async (previewDelta) => {
      const state = createState();
      seedOwnedCollection(state);
      addBookmark(state, { id: 'preview-0', parentId: ROOT_ID, positionToken: '0' });
      addBookmark(state, { id: 'preview-1', parentId: ROOT_ID, positionToken: '1' });
      const basePorts = createMemoryPorts(state);
      const realSigner = basePorts.cursorSigner;
      const ports: GetCollectionEditorPagePorts = {
        ...basePorts,
        cursorSigner: {
          encodedLength: (payload) => realSigner.encodedLength(payload) + previewDelta,
          sign: (payload) => realSigner.sign(payload),
          verify: (token, at) => realSigner.verify(token, at),
        },
      };

      await assert.rejects(
        () => getCollectionEditorPage(ports, ownerInput({ limit: 1 })),
        /cursor signer returned an unexpected token length/,
      );
    },
  );

  test('generated legal Unicode/escape/null payloads preserve prefix and final byte budget', async () => {
    let randomState = 0x5eed_28;
    const nextRandom = (): number => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState;
    };
    const generatedDescription = (variant: number): string | null => {
      if (variant === 0) return null;
      if (variant === 1) return 'a'.repeat(nextRandom() % 20_001);
      if (variant === 2) return '汉🙂'.repeat(nextRandom() % 6_001);
      return '"\\\n\t'.repeat(nextRandom() % 4_001);
    };

    const limits = [1, 500, 1, 17, 31, 50, 64, 23] as const;
    for (let scenario = 0; scenario < limits.length; scenario += 1) {
      const state = createState();
      seedOwnedCollection(state);
      const total = scenario === 0 ? 0 : scenario === 1 ? 1 : 36 + (nextRandom() % 29);
      const limit = limits[scenario]!;
      for (let index = 0; index < total; index += 1) {
        addBookmark(state, {
          id: `property-${scenario}-${String(index).padStart(4, '0')}`,
          parentId: ROOT_ID,
          positionToken: String(index).padStart(5, '0'),
          title: index % 3 === 0 ? `标题 "${index}"` : `Title ${index}`,
          description: generatedDescription((scenario + index) % 4),
          url: index % 2 === 0
            ? `https://example.com/path/${index}?q=%22escaped%22`
            : `https://例子.example/${index}`,
          tags: index % 3 === 0 ? ['ascii', '标签', '"quoted"'] : [],
        });
      }

      const page = await query(state, ownerInput({ limit }));
      const candidates = sortedNodes(state, COLLECTION_ID)
        .slice(0, Math.min(limit, total))
        .map(expectedEditableNode);
      const signer = createProductEditorCursorSigner({ current: { id: 'test-v1', key: CURSOR_KEY } });
      let expectedPage: EditorPage | null = null;

      for (let count = 0; count <= candidates.length; count += 1) {
        const nodes = candidates.slice(0, count);
        const hasMore = count < total;
        const last = nodes.at(-1);
        const nextCursor = hasMore && last !== undefined
          ? signer.sign({
            v: PRODUCT_EDITOR_CURSOR_VERSION,
            purpose: PRODUCT_EDITOR_CURSOR_PURPOSE,
            principalId: PRINCIPAL_OWNER,
            collectionId: COLLECTION_ID,
            limit,
            comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
            after: {
              parentKey: last.parentId,
              positionKey: last.position,
              nodeId: last.id,
            },
            contentRevision: CONTENT_REV,
            policyRevision: POLICY_REV,
            snapshotId: page.page.snapshotId,
            issuedAt: formatUtcDateTime(NOW),
            expiresAt: page.page.expiresAt,
          })
          : null;
        const oraclePage: EditorPage = {
          collection: page.collection,
          root: page.root,
          nodes,
          capabilities: page.capabilities,
          page: {
            snapshotId: page.page.snapshotId,
            contentRevision: CONTENT_REV,
            policyRevision: POLICY_REV,
            comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
            expiresAt: page.page.expiresAt,
            returnedCount: count,
            hasMore,
            nextCursor,
          },
        };
        const bytes = Buffer.byteLength(JSON.stringify(oraclePage), 'utf8');
        if (bytes <= EDITOR_PAGE_MAX_BYTES && (!hasMore || last !== undefined)) {
          expectedPage = oraclePage;
        }
      }

      assert.ok(expectedPage, 'empty page or one legal node must fit the byte budget');
      assert.deepEqual(page, expectedPage);
    }
  });
});
