import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Kns00LiveNode = {
  readonly id: string;
  readonly parentId: string | null;
  readonly revision: string;
  readonly kind?: string;
  readonly folderRole?: string;
  readonly url?: string;
};

export type Kns00Tombstone = {
  readonly targetId: string;
  readonly deleteCursor?: string;
  readonly deleteRevision?: string;
};

export type Kns00Operation = {
  readonly opId: string;
  readonly type: string;
  readonly targetId?: string;
  readonly replicaId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
};

export type Kns00Receipt = {
  readonly opId: string;
  readonly status: string;
  readonly nodeId?: string;
  readonly code?: string;
  readonly conflictId?: string;
};

export type Kns00Fixture = {
  readonly fixtureId: string;
  readonly scenario: string;
  readonly bootstrapMode?: 'download' | 'upload' | 'merge' | 'mirror';
  readonly operations: readonly Kns00Operation[];
  readonly receipts?: readonly Kns00Receipt[];
  readonly effects?: readonly Readonly<Record<string, unknown>>[];
  readonly input?: Readonly<Record<string, unknown>>;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly terminal: {
    readonly liveNodes: readonly Kns00LiveNode[];
    readonly tombstones: readonly Kns00Tombstone[];
    readonly conflicts?: readonly Readonly<Record<string, unknown>>[];
    readonly problemCode?: string;
    readonly localDiagnostics?: readonly { readonly code: string }[];
    readonly localMatchReport?: {
      readonly candidates: readonly {
        readonly kind: string;
        readonly url?: string;
        readonly nodeIds: readonly string[];
      }[];
    };
  };
  readonly expectedOperationKinds: readonly string[];
  readonly expectedIdentities: readonly string[];
  readonly invariants?: readonly string[];
};

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/kns-00-contract');

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesRoot, name), 'utf8')) as T;
}

export function loadKns00GoldenFixtures(): readonly Kns00Fixture[] {
  return readJson<readonly Kns00Fixture[]>('golden-scenarios.json');
}

export function loadKns00FailClosedFixtures(): readonly Kns00Fixture[] {
  return readJson<readonly Kns00Fixture[]>('fail-closed.json');
}

export function loadKns00Index(): {
  readonly contract: string;
  readonly files: readonly string[];
  readonly sessionBinding?: {
    readonly browserProfileId: string;
    readonly mountMode: string;
    readonly mountNativeId: string | null;
    readonly generation: string;
  };
} {
  return readJson('index.json');
}

export function fixtureIdentities(fixture: Kns00Fixture): readonly string[] {
  const live = fixture.terminal.liveNodes.map((node) => node.id);
  const tombstones = fixture.terminal.tombstones.map((row) => row.targetId);
  const targets = fixture.operations
    .map((operation) => operation.targetId)
    .filter((id): id is string => typeof id === 'string');
  return [...new Set([...live, ...tombstones, ...targets])];
}

export function liveAndTombstoneOverlap(fixture: Kns00Fixture): readonly string[] {
  const live = new Set(fixture.terminal.liveNodes.map((node) => node.id));
  return fixture.terminal.tombstones.map((row) => row.targetId).filter((id) => live.has(id));
}
