import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  classifyDurablePullCursorWrite,
  classifyPullAck,
  classifyPullMappingAuthority,
  pullCursorOrder,
} from '../src/pull-ack-boundary.js';
import { PULL_DEPENDENCY_KINDS } from '../src/scope-transition.js';

const HASH = 'A'.repeat(43);
const MAC = 'B'.repeat(22);
/** `spc2.<tag>.<expiresAt base36>.<commitOrdinal base36>.<o|c>.<stableIdHash>.<mac>`. */
function spc2(ordinal: string | number, options: { stream?: 'o' | 'c'; expires?: string; hash?: string } = {}) {
  const ordinalText = typeof ordinal === 'number' ? ordinal.toString(36) : ordinal;
  return `spc2.knowntag001.${options.expires ?? '1z'}.${ordinalText}.${options.stream ?? 'o'}.${options.hash ?? HASH}.${MAC}`;
}

describe('C-03 page is the Ack boundary', () => {
  test('refuses an event-cursor Ack and an incomplete page', () => {
    assert.equal(classifyPullAck({
      cursorKind: 'event', pageComplete: true, backendPageEvidence: true,
      publishedCursor: spc2(1), nextCursor: spc2(2),
    }), 'refuse_event_cursor');
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: false, backendPageEvidence: true,
      publishedCursor: spc2(1), nextCursor: spc2(2),
    }), 'refuse_incomplete_page');
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: false,
      publishedCursor: spc2(1), nextCursor: spc2(2),
    }), 'refuse_missing_evidence');
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
      publishedCursor: spc2(2), nextCursor: spc2(1),
    }), 'refuse_rewind');
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
      publishedCursor: spc2(1), nextCursor: spc2(2),
    }), 'allow');
  });

  test('orders spc2 cursors by the packed commit ordinal, not by byte order', () => {
    // Byte order puts '10' before '9'; canonically ordinal 9 precedes 36.
    assert.equal(pullCursorOrder(spc2(9), spc2(36)), 'before');
    assert.equal(pullCursorOrder(spc2(36), spc2(9)), 'after');
    // A re-issued cursor with a longer base36 expiry must not invert the order.
    assert.equal(pullCursorOrder(spc2('5', { expires: 'z' }), spc2('6', { expires: '10' })), 'before');
    assert.equal(pullCursorOrder(spc2(7), spc2(7)), 'equal');
    // The operation stream precedes the conflict stream at the same ordinal.
    assert.equal(pullCursorOrder(spc2(4, { stream: 'o' }), spc2(4, { stream: 'c' })), 'before');
    assert.equal(pullCursorOrder(spc2(4, { stream: 'c' }), spc2(4, { stream: 'o' })), 'after');
    // A truncated stable-id hash is not order preserving.
    assert.equal(pullCursorOrder(spc2(4, { hash: 'A'.repeat(43) }), spc2(4, { hash: 'C'.repeat(43) })), 'incomparable');
    assert.equal(pullCursorOrder('cursor-old', 'cursor-next'), 'incomparable');
  });

  test('classifies a byte-order-forward cursor that is canonically a rewind', () => {
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
      publishedCursor: spc2(36), nextCursor: spc2(9),
    }), 'refuse_rewind');
    // Unparseable opaque cursors are never ordered lexicographically.
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
      publishedCursor: 'c2', nextCursor: 'c1',
    }), 'refuse_unordered');
    assert.equal(classifyPullAck({
      cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
      publishedCursor: spc2(3, { expires: 'z' }), nextCursor: spc2(4, { expires: '10' }),
    }), 'allow');
  });

  test('only publishes a durable cursor that provably continues the page chain', () => {
    // The chain attaches: the staged page starts exactly at the durable cursor.
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: 'cursor-old', previousCursor: 'cursor-old', nextCursor: 'cursor-next',
    }), 'allow');
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: null, previousCursor: 'cursor-old', nextCursor: 'cursor-next',
    }), 'allow');
    // A rebased authority cursor ahead of the page tail: refuse the rewind.
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: spc2(36), previousCursor: spc2(5), nextCursor: spc2(9),
    }), 'refuse_rewind');
    // A detached chain whose order cannot be proven is refused, never guessed.
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: 'cursor-rebased', previousCursor: 'cursor-old', nextCursor: 'cursor-next',
    }), 'refuse_stale_chain');
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: spc2(4, { hash: 'A'.repeat(43) }), previousCursor: spc2(1),
      nextCursor: spc2(4, { hash: 'C'.repeat(43) }),
    }), 'refuse_stale_chain');
    // A detached chain that still moves the authority cursor forward is a valid page.
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: spc2(3), previousCursor: spc2(5), nextCursor: spc2(9),
    }), 'allow');
    assert.equal(classifyDurablePullCursorWrite({
      publishedCursor: spc2(9), previousCursor: spc2(5), nextCursor: spc2(9),
    }), 'allow');
  });

  test('page-local mapping facts are unpublished shadow, not Ack authority', () => {
    assert.equal(classifyPullMappingAuthority({
      fromCommittedPageEvents: true, pageComplete: false, cursorPublished: false,
    }), 'applied_locally_unpublished');
    assert.equal(classifyPullMappingAuthority({
      fromCommittedPageEvents: false, pageComplete: true, cursorPublished: true,
    }), 'published');
  });

  test('extends page preflight kinds without forking PULL_DEPENDENCY_KINDS', () => {
    for (const kind of [
      'parent_child', 'same_node', 'placement_anchor', 'parent_children_revision',
      'create_order', 'range_boundary', 'known_pending', 'local_pending_edits',
    ]) {
      assert.ok((PULL_DEPENDENCY_KINDS as readonly string[]).includes(kind), kind);
    }
  });
});
