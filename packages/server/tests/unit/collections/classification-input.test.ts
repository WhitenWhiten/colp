import { test, expect } from 'vitest';
import { parseClassificationPreviewInput as parse } from '../../../src/modules/collections/application/classification-input.js';

const incoming = {source: 'extension', requested: {folder: true, tags: true}, bookmark: {title: 'ＡＩ', url: 'https://example.org/', description: null}};
test('strict oneOf accepts incoming or authoritative node identity and preserves fingerprint bytes', () => {
  expect(parse(incoming)).toEqual(incoming);
  expect(parse({source: 'web', requested: {folder: true, tags: false}, nodeId: 'node'})).toMatchObject({nodeId: 'node'});
});
test('oneOf rejects mixed sources, forged snapshot, open nested DTO and no requested categories', () => {
  for (const value of [
    {...incoming, nodeId: 'node'}, {...incoming, taxonomy: []}, {...incoming, requested: {folder: false, tags: false}},
    {...incoming, bookmark: {...incoming.bookmark, tags: ['AI']}},
    {source: 'web', requested: incoming.requested, nodeId: 'node', title: 'forged'},
    {...incoming, requested: {...incoming.requested, auto: true}}, {...incoming, source: 'unknown'},
  ]) expect(() => parse(value)).toThrow('invalid_input');
});
test('opaque Node IDs enforce UTF-8 boundary and URLs use canonical admission', () => {
  expect(() => parse({source: 'web', requested: incoming.requested, nodeId: '中'.repeat(43)})).toThrow('invalid_input');
  for (const url of ['https://user:pass@example.org', 'data:text/plain,x', 'https://example.org/' + 'x'.repeat(4096)]) expect(() => parse({...incoming, bookmark: {...incoming.bookmark, url}})).toThrow('invalid_input');
});
test('suggest another carries a closed, bounded, unique list of turned-down folders', () => {
  expect(parse({...incoming, rejectedFolderIds: ['a', 'b']})).toEqual({...incoming, rejectedFolderIds: ['a', 'b']});
  expect(parse({source: 'web', requested: incoming.requested, nodeId: 'node', rejectedFolderIds: ['a']})).toMatchObject({rejectedFolderIds: ['a']});
  for (const rejectedFolderIds of [[], ['a', 'a'], [''], [7], ['中'.repeat(43)], Array.from({length: 9}, (_, i) => `f${i}`), 'a'])
    expect(() => parse({...incoming, rejectedFolderIds})).toThrow('invalid_input');
});

test('explicit folder selection is a bounded policy and requires a folder request', () => {
  for (const folderSelectionMode of ['allow_later', 'require_candidate']) {
    expect(parse({ ...incoming, folderSelectionMode })).toMatchObject({ folderSelectionMode });
  }
  for (const folderSelectionMode of ['unknown', true, null]) {
    expect(() => parse({ ...incoming, folderSelectionMode })).toThrow('invalid_input');
  }
  expect(() => parse({ ...incoming, requested: { folder: false, tags: true }, folderSelectionMode: 'require_candidate' })).toThrow('invalid_input');
});
