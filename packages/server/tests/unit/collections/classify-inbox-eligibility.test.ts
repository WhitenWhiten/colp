import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isClassifyInboxEligible,
  type ClassifyInboxEligibilitySnapshot,
} from '../../../src/modules/collections/application/classify-inbox-eligibility.js';
import {
  buildClassifyInboxFixture,
  toEligibilitySnapshot,
} from '../../support/classify-inbox-fixtures.js';

function snapshot(
  overrides: Partial<ClassifyInboxEligibilitySnapshot> = {},
): ClassifyInboxEligibilitySnapshot {
  return {
    isOwner: true,
    kind: 'bookmark',
    softDeleted: false,
    url: 'https://example.com/page',
    parentKind: 'root',
    hasSidecar: false,
    ...overrides,
  };
}

test('non-owner is not eligible', () => {
  assert.equal(isClassifyInboxEligible(snapshot({ isOwner: false })), false);
});

test('non-bookmark kind is not eligible', () => {
  assert.equal(isClassifyInboxEligible(snapshot({ kind: 'folder' })), false);
  assert.equal(isClassifyInboxEligible(snapshot({ kind: 'root' })), false);
});

test('soft-deleted bookmark is not eligible', () => {
  assert.equal(isClassifyInboxEligible(snapshot({ softDeleted: true })), false);
});

test('empty or whitespace url is not eligible', () => {
  assert.equal(isClassifyInboxEligible(snapshot({ url: '' })), false);
  assert.equal(isClassifyInboxEligible(snapshot({ url: '   ' })), false);
});

test('parentKind other than root is not eligible', () => {
  assert.equal(isClassifyInboxEligible(snapshot({ parentKind: 'folder' })), false);
  assert.equal(isClassifyInboxEligible(snapshot({ parentKind: 'bookmark' })), false);
});

test('sidecar row present is not eligible', () => {
  assert.equal(
    isClassifyInboxEligible(toEligibilitySnapshot(buildClassifyInboxFixture({ hasSidecar: true }))),
    false,
  );
});

test('snapshot that satisfies all §5.1 rules is eligible', () => {
  assert.equal(isClassifyInboxEligible(toEligibilitySnapshot(buildClassifyInboxFixture())), true);
});
