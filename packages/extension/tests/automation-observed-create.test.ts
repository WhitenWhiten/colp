import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCause, type CreateEvidence } from '../src/automation/causation.js';
import { OBSERVATION_TTL_MS, settleObservedCreate, type NativeBookmark, type Observation, type ObservedPorts } from '../src/automation/observed-create.js';
import type { PreSaveDecision } from '../src/automation/pre-save.js';
import type { CaptureAutomation } from '../src/capture/contracts.js';

/** Star-button creations (AC-09, AC-49): judged once after the settle window, never over the Owner's choice. */
const local: CreateEvidence = { localCreate: { placement: false }, projected: false, importing: false, recentlyRemoved: false };

describe('why a bookmark appeared', () => {
  it('starts intake only for new local intent', () => {
    expect(createCause(local)).toBe('localIntent');
    expect(createCause({ ...local, localCreate: { placement: true } })).toBe('ownEcho');
    expect(createCause({ ...local, localCreate: null, projected: true })).toBe('inboundProjection');
    expect(createCause({ ...local, localCreate: null })).toBe('outsideCollection');
    expect(createCause({ ...local, importing: true })).toBe('import');
    expect(createCause({ ...local, recentlyRemoved: true })).toBe('recovery');
    // A projection pulled during an import is still not intake.
    expect(createCause({ ...local, localCreate: null, projected: true, importing: true })).toBe('import');
  });
});

const placed: CaptureAutomation = { outcome: 'placed', ruleIds: ['rule-arxiv'], bundleRevision: 'b-1', settingsRevision: 1, satisfies: ['classify.root'],
  rule: { id: 'rule-arxiv', name: 'arXiv papers', revision: '1', bindingRevision: '1', semanticDigest: 'd' },
  destination: { serverUuid: 's', collectionId: 'c', nodeId: 'academic' }, folderTitle: 'Academic', fromNativeId: '2',
  collectionId: 'c', replicaId: 'r', generation: 1 };
const root = { serverUuid: 's', collectionId: 'c', nodeId: 'other' };
const NOW = 1_000_000;

let nodes: Map<string, NativeBookmark>, evidence: CreateEvidence, decision: PreSaveDecision | null, clock: number;
const order: string[] = [];
const ports = {
  now: () => clock,
  node: vi.fn(async (id: string) => nodes.get(id) ?? null),
  intakeRoot: vi.fn(async (id: string) => ['1', '2', '3'].includes(id)),
  evidence: vi.fn(async () => evidence),
  decide: vi.fn(async () => decision),
  id: () => 'placement-1',
  intend: vi.fn(async () => { order.push('intend'); }),
  move: vi.fn(async (id: string, parentId: string) => { order.push('move'); nodes.set(id, { ...nodes.get(id)!, parentId }); }),
  record: vi.fn(async () => { order.push('record'); }),
  notify: vi.fn(async () => undefined),
} satisfies ObservedPorts;
const observation = (over: Partial<Observation> = {}): Observation =>
  ({ nativeId: 'n1', url: 'https://arxiv.org/abs/1', parentId: '2', dateAdded: 5, observedAt: NOW, ...over });

beforeEach(() => {
  clock = NOW + 3_000; evidence = local; order.length = 0;
  decision = { automation: placed, targetNativeId: '10', parent: root };
  nodes = new Map([['n1', { id: 'n1', parentId: '2', title: 'A paper', url: 'https://arxiv.org/abs/1', dateAdded: 5 }]]);
  for (const port of Object.values(ports)) if (vi.isMockFunction(port)) port.mockClear();
});

describe('settling an observed creation', () => {
  it('files a page starred into a browser root with one move, one receipt and one notice', async () => {
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'placed', automation: placed });
    expect(ports.decide).toHaveBeenCalledWith({ url: 'https://arxiv.org/abs/1', title: 'A paper', parentNativeId: '2', explicit: false });
    expect(ports.move).toHaveBeenCalledOnce();
    expect(ports.move).toHaveBeenCalledWith('n1', '10');
    const placement = { id: 'placement-1', automation: placed, beforeFolder: root, page: { title: 'A paper', url: 'https://arxiv.org/abs/1' },
      native: { nativeId: 'n1', destinationNativeId: '10', movedAt: clock } };
    // The intent is durable before the move, the receipt follows it.
    expect(ports.intend).toHaveBeenCalledWith(placement, { parentId: '2', dateAdded: 5 });
    expect(ports.record).toHaveBeenCalledWith(placement);
    expect(order).toEqual(['intend', 'move', 'record']);
    expect(ports.notify).toHaveBeenCalledOnce();
  });

  it('keeps a folder picked in the star dialog, or a bookmark added in a folder, as the Owner’s choice', async () => {
    nodes.set('n1', { ...nodes.get('n1')!, parentId: '20' });
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'chosenFolder' });
    expect(ports.decide).not.toHaveBeenCalled();
    expect(ports.move).not.toHaveBeenCalled();
    expect(ports.notify).not.toHaveBeenCalled();
  });

  it('lets an edit made before the move win', async () => {
    // The address was changed in the dialog.
    nodes.set('n1', { ...nodes.get('n1')!, url: 'https://arxiv.org/abs/2' });
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'edited' });
    // Moved by hand while the rules were being read.
    nodes.set('n1', { ...nodes.get('n1')!, url: 'https://arxiv.org/abs/1' });
    ports.decide.mockImplementationOnce(async () => { nodes.set('n1', { ...nodes.get('n1')!, parentId: '20' }); return decision; });
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'edited' });
    expect(ports.move).not.toHaveBeenCalled();
    expect(ports.record).not.toHaveBeenCalled();
  });

  it('never starts intake for the extension’s own save, a projection, an import, a restore or an unsynced folder', async () => {
    const causes: [CreateEvidence, string][] = [[{ ...local, localCreate: { placement: true } }, 'ownEcho'],
      [{ ...local, localCreate: null, projected: true }, 'inboundProjection'], [{ ...local, importing: true }, 'import'],
      [{ ...local, recentlyRemoved: true }, 'recovery'], [{ ...local, localCreate: null }, 'outsideCollection']];
    for (const [given, reason] of causes) {
      evidence = given;
      expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason });
    }
    expect(ports.decide).not.toHaveBeenCalled();
    expect(ports.move).not.toHaveBeenCalled();
  });

  it('says why a matching rule could not act, without moving anything', async () => {
    const blocked: CaptureAutomation = { ...placed, outcome: 'blocked', reason: 'bindingUnavailable', satisfies: [] };
    decision = { automation: blocked, targetNativeId: null };
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'stoodAside', automation: blocked });
    expect(ports.notify).toHaveBeenCalledWith({ automation: blocked, title: 'A paper', nativeId: 'n1' });
    expect(ports.move).not.toHaveBeenCalled();
    expect(ports.record).not.toHaveBeenCalled();
  });

  it('does nothing for a removed or reused bookmark, a stale observation or a page no rule matches', async () => {
    expect(await settleObservedCreate(ports, observation({ dateAdded: 4 }))).toEqual({ kind: 'skipped', reason: 'gone' });
    clock = NOW + OBSERVATION_TTL_MS + 1;
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'stale' });
    clock = NOW + 3_000; decision = null;
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'noRule' });
    nodes.clear();
    expect(await settleObservedCreate(ports, observation())).toEqual({ kind: 'skipped', reason: 'gone' });
    expect(ports.move).not.toHaveBeenCalled();
  });
});
