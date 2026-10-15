import type { FolderRef } from '@know-n/colp/automation';
import type { AccountAutomation, CaptureAutomation } from '../capture/contracts.js';
import { createCause, type CreateCause, type CreateEvidence } from './causation.js';
import type { PreSaveDecision, PreSaveInput } from './pre-save.js';

/**
 * Bookmarks created outside the extension: the browser's star button, or its
 * bookmark manager.
 *
 * A creation is recorded first and judged after a settle window, so the star
 * dialog's folder and title are final. A rule then applies only when all hold:
 *
 * - the bookmark sits directly in a browser root (Bookmarks bar, Other
 *   bookmarks, Mobile bookmarks);
 * - it is new local intent (see causation.ts);
 * - it is unchanged since it was observed.
 *
 * A root is only a heuristic for "no folder was chosen" (ADR-A17): any other
 * folder is the Owner's choice and is kept. The bookmark is checked again right
 * before the move, and anything the Owner did since wins.
 *
 * The rule's placement is one move. Its receipt names the canonical create and
 * that move. No model is ever asked: this path runs without the user's
 * foreground gesture.
 */
export const SETTLE_MS = 3_000;
/** Older observations (a worker that slept through its settle window) are not acted on. */
export const OBSERVATION_TTL_MS = 60_000;

export interface Observation {
  readonly nativeId: string;
  readonly url: string;
  readonly parentId: string;
  readonly dateAdded: number | null;
  readonly observedAt: number;
}
export interface NativeBookmark { readonly id: string; readonly parentId?: string; readonly title: string; readonly url?: string; readonly dateAdded?: number }
export interface ObservedPlacement {
  /** Names the write-ahead intent and, once the move happened, the receipt. */
  readonly id: string;
  readonly automation: AccountAutomation;
  readonly beforeFolder?: FolderRef;
  readonly page: { readonly title: string; readonly url: string };
  readonly native: { readonly nativeId: string; readonly destinationNativeId: string; readonly movedAt: number };
}

export interface ObservedPorts {
  now(): number;
  node(nativeId: string): Promise<NativeBookmark | null>;
  /** Bookmarks bar, Other bookmarks or Mobile bookmarks; never a managed or unknown container. */
  intakeRoot(folderNativeId: string): Promise<boolean>;
  evidence(observation: Observation): Promise<CreateEvidence>;
  decide(input: PreSaveInput): Promise<PreSaveDecision | null>;
  id(): string;
  /** Written before the move, so a crash between the move and its receipt is recovered from native evidence. */
  intend(placement: ObservedPlacement, from: { readonly parentId: string; readonly dateAdded: number | null }): Promise<void>;
  move(nativeId: string, parentNativeId: string): Promise<void>;
  /** The placement's receipt, written before anything is sent; the intent is then done. */
  record(placement: ObservedPlacement): Promise<void>;
  /** The one notice for this bookmark. */
  notify(outcome: { readonly automation: CaptureAutomation; readonly title: string; readonly nativeId: string }): Promise<void>;
}

export type ObservedOutcome =
  | { readonly kind: 'placed'; readonly automation: CaptureAutomation }
  | { readonly kind: 'stoodAside'; readonly automation: CaptureAutomation }
  | { readonly kind: 'skipped'; readonly reason: Exclude<CreateCause, 'localIntent'> | 'stale' | 'gone' | 'edited' | 'chosenFolder' | 'noRule' };

const skipped = (reason: Extract<ObservedOutcome, { kind: 'skipped' }>['reason']): ObservedOutcome => ({ kind: 'skipped', reason });

/** Judge one observation once its settle window has passed. Never repeats: the caller hands each observation over once. */
export async function settleObservedCreate(ports: ObservedPorts, observation: Observation): Promise<ObservedOutcome> {
  if (ports.now() - observation.observedAt > OBSERVATION_TTL_MS) return skipped('stale');
  const node = await ports.node(observation.nativeId);
  // A removed bookmark, or its id reused by another one.
  if (!node || node.url === undefined || (observation.dateAdded !== null && node.dateAdded !== observation.dateAdded)) return skipped('gone');
  if (node.url !== observation.url) return skipped('edited');
  // A folder picked in the star dialog, or a bookmark added in a folder: the Owner's choice.
  if (!node.parentId || !await ports.intakeRoot(node.parentId)) return skipped('chosenFolder');
  const cause = createCause(await ports.evidence(observation));
  if (cause !== 'localIntent') return skipped(cause);
  const decision = await ports.decide({ url: node.url, title: node.title, parentNativeId: node.parentId, explicit: false });
  if (!decision) return skipped('noRule');
  const { automation } = decision;
  if (automation.outcome !== 'placed' || !decision.targetNativeId) {
    await ports.notify({ automation, title: node.title, nativeId: node.id });
    return { kind: 'stoodAside', automation };
  }
  // The last word is the Owner's: anything they changed since stops the move.
  const current = await ports.node(observation.nativeId);
  if (!current || current.parentId !== node.parentId || current.url !== node.url) return skipped('edited');
  const placement: ObservedPlacement = { id: ports.id(), automation, ...(decision.parent ? { beforeFolder: decision.parent } : {}),
    page: { title: current.title, url: node.url }, native: { nativeId: node.id, destinationNativeId: decision.targetNativeId, movedAt: ports.now() } };
  await ports.intend(placement, { parentId: node.parentId, dateAdded: observation.dateAdded });
  await ports.move(node.id, decision.targetNativeId);
  await ports.record(placement);
  await ports.notify({ automation, title: current.title, nativeId: node.id });
  return { kind: 'placed', automation };
}
