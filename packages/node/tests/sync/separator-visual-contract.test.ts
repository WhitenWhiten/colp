import { describe, expect, it } from 'vitest';

import {
  projectSyncSeparatorForUi,
  representSyncSeparatorForUiMode,
  type SyncSeparatorVisualPresentation,
} from '../../src/sync/index.js';
import {
  projectSyncSeparatorForUi as projectFromModule,
  representSyncSeparatorForUiMode as representModeFromModule,
} from '../../src/sync/separator-visual.js';

const evidence = '[evidence:sync.separator-visual]';

interface SeparatorRecord {
  readonly kind: 'separator';
  readonly id: string;
  readonly parentId: string;
  readonly position: string;
}

describe(`SYNC-0023 Separator visual projection via production API ${evidence}`, () => {
  const separator: SeparatorRecord = {
    kind: 'separator',
    id: 'separator-1',
    parentId: 'folder-1',
    position: 'M0',
  };

  it(`exports the same projection helpers from the Sync package surface and module ${evidence}`, () => {
    expect(typeof projectSyncSeparatorForUi).toBe('function');
    expect(projectSyncSeparatorForUi).toBe(projectFromModule);
    expect(representSyncSeparatorForUiMode).toBe(representModeFromModule);
  });

  it(`projects a visual presentation while preserving Separator identity and ordering by reference ${evidence}`, () => {
    const projected: SyncSeparatorVisualPresentation<SeparatorRecord> =
      projectSyncSeparatorForUi(separator);

    expect(projected.kind).toBe('separator');
    expect(projected.presentation).toBe('visual');
    // Presentation wrapper must retain the authoritative node, not a shallow copy.
    expect(projected.separator).toBe(separator);
    expect(projected.separator).toEqual({
      kind: 'separator',
      id: 'separator-1',
      parentId: 'folder-1',
      position: 'M0',
    });
    expect(projected.separator).not.toHaveProperty('url');
    // Envelope is presentation-only; wire node fields stay on nested separator.
    expect(projected).not.toHaveProperty('id');
    expect(projected).not.toHaveProperty('parentId');
    expect(projected).not.toHaveProperty('position');
  });

  it(`allows a client to omit visual presentation without mutating the Separator ${evidence}`, () => {
    const omitted = representSyncSeparatorForUiMode(separator, 'omitted');
    expect(omitted).toBeUndefined();
    // Authoritative record is unchanged by the omit path.
    expect(separator).toEqual({
      kind: 'separator',
      id: 'separator-1',
      parentId: 'folder-1',
      position: 'M0',
    });
    expect(separator).not.toHaveProperty('presentation');
  });

  it(`visible mode matches projectSyncSeparatorForUi ${evidence}`, () => {
    const viaMode = representSyncSeparatorForUiMode(separator, 'visible');
    const viaProject = projectSyncSeparatorForUi(separator);
    expect(viaMode).toEqual(viaProject);
    expect(viaMode?.separator).toBe(separator);
    expect(viaMode?.presentation).toBe('visual');
  });

  it(`throws when the input is not a Separator node ${evidence}`, () => {
    expect(() => projectSyncSeparatorForUi({ kind: 'bookmark', id: 'b1' } as never))
      .toThrow(/Separator/u);
    expect(() => projectSyncSeparatorForUi({ kind: 'folder', id: 'f1' } as never))
      .toThrow(/Separator/u);
    expect(() => projectSyncSeparatorForUi(null as never)).toThrow(/Separator/u);
    expect(() => projectSyncSeparatorForUi(undefined as never)).toThrow(/Separator/u);
    expect(() => projectSyncSeparatorForUi({ id: 'no-kind' } as never)).toThrow(/Separator/u);
    expect(() => representSyncSeparatorForUiMode({ kind: 'bookmark' } as never, 'omitted'))
      .toThrow(/Separator/u);
    expect(() => representSyncSeparatorForUiMode({ kind: 'bookmark' } as never, 'visible'))
      .toThrow(/Separator/u);
  });
});
