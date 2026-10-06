import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColpClient } from '../../src/client/index.js';
import type { Snapshot } from '../../src/types/index.js';

afterEach(() => vi.restoreAllMocks());

function snapshot(id: string): Snapshot {
  const source = readFileSync(new URL('../../fixtures/protocol/examples/collection-snapshot.json', import.meta.url), 'utf8');
  const original = JSON.parse(source) as Snapshot;
  return JSON.parse(source.replaceAll(original.collection.id, id)) as Snapshot;
}

describe('snapshot Collection identity [evidence:semantic.snapshot.assembly]', () => {
  it('returns a superseded refresh its own Collection instead of the other one', async () => {
    const a = snapshot('collection-a');
    const b = snapshot('collection-b');
    const client = new ColpClient({ manifestUrl: 'https://example.com/manifest' });
    let resolve!: (value: Snapshot) => void;
    const pending = new Promise<Snapshot>(done => { resolve = done; });
    vi.spyOn(client, 'getSnapshot').mockImplementation(async id => id === a.collection.id ? pending : b);
    const earlier = client.refreshSnapshot(a.collection.id);
    expect((await client.refreshSnapshot(b.collection.id)).collection.id).toBe(b.collection.id);
    resolve(a);
    expect((await earlier).collection.id).toBe(a.collection.id);
    expect(client.currentSnapshot?.collection.id).toBe(b.collection.id);
  });

  it('lets two Collections refresh concurrently on one client', async () => {
    const client = new ColpClient({ manifestUrl: 'https://example.com/manifest' });
    vi.spyOn(client, 'getSnapshot').mockImplementation(async id => snapshot(id));
    const [a, b] = await Promise.all([
      client.refreshSnapshot('collection-a'),
      client.refreshSnapshot('collection-b'),
    ]);
    expect(a.collection.id).toBe('collection-a');
    expect(b.collection.id).toBe('collection-b');
    expect(client.currentSnapshot?.collection.id).toBe('collection-b');
  });

  it('allows serial Collection switches without reusing the previous Snapshot', async () => {
    const client = new ColpClient({ manifestUrl: 'https://example.com/manifest' });
    vi.spyOn(client, 'getSnapshot').mockImplementation(async id => snapshot(id));
    for (const id of ['collection-a', 'collection-b', 'collection-a']) {
      expect((await client.refreshSnapshot(id)).collection.id).toBe(id);
      expect(client.currentSnapshot?.collection.id).toBe(id);
    }
  });
});
