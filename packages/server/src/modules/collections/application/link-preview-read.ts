/**
 * LP-04 read path: attach `previewImage` to bookmark views in one batch.
 *
 * A bookmark gets an image only when its URL's shared target is ready and
 * not a site-wide default, the owner has not vetoed it, and the view still
 * carries a URL (moderation tombstones null it). Everything else is JSON
 * null; folders may carry a custom cover. A missing port (feature off) or a
 * missing PRODUCT_ORIGIN yields null for every bookmark.
 */
import { linkPreviewTargetIdentity } from './link-preview-policy.js';
import { imageAssetUrl, type NodeCoverPreference } from './image-assets.js';

export interface LinkPreviewReadyTarget {
  readonly objectId: string;
  readonly width: number;
  readonly height: number;
}

export interface LinkPreviewReadPort {
  /** Durable per-node covers remain available when automatic OG fetching is off. */
  findCoverPreferences?(nodeIds: readonly string[]): Promise<ReadonlyMap<string, NodeCoverPreference>>;
  /** Ready, non-generic targets by url key; absent keys have no preview. */
  findReadyByUrlKeys(urlKeys: readonly string[]): Promise<ReadonlyMap<string, LinkPreviewReadyTarget>>;
  /** Node ids whose owner set the preview mode to `none`. */
  findVetoedNodeIds(nodeIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface BookmarkPreviewImageView {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

const LINK_PREVIEW_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Same-origin object URL; the only form a client ever receives. */
export function linkPreviewObjectUrl(productOrigin: string, objectId: string): string {
  if (!LINK_PREVIEW_OBJECT_ID.test(objectId)) throw new Error('link preview object id must be a lowercase uuid');
  const parsed = new URL(productOrigin);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('link preview product origin must be http(s)');
  }
  return `${parsed.origin}/api/v1/link-preview/${objectId}`;
}

type PreviewableNode = {
  readonly id: string;
  readonly kind: string;
  readonly url?: string | null;
};

export async function attachBookmarkPreviewImages<Node extends PreviewableNode>(
  port: LinkPreviewReadPort | undefined,
  productOrigin: string | undefined,
  nodes: readonly Node[],
): Promise<Node[]> {
  const keyed = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind !== 'bookmark' || typeof node.url !== 'string') continue;
    const identity = linkPreviewTargetIdentity(node.url);
    if (identity !== null) keyed.set(node.id, identity.urlKey);
  }
  const enabled = port !== undefined && productOrigin !== undefined && productOrigin.length > 0 && keyed.size > 0;
  const [ready, vetoed] = enabled
    ? await Promise.all([
      port.findReadyByUrlKeys([...new Set(keyed.values())]),
      port.findVetoedNodeIds([...keyed.keys()]),
    ])
    : [new Map<string, LinkPreviewReadyTarget>(), new Set<string>()];
  const covers = productOrigin && port?.findCoverPreferences
    ? await port.findCoverPreferences(nodes.map(node => node.id)) : undefined;
  return nodes.map((node) => {
    const preference = covers?.get(node.id);
    const settings = covers === undefined ? {} : {
      coverMode: preference?.mode ?? 'auto', coverRevision: preference?.revision ?? '0',
    };
    // Redacted bookmark views must never regain an image through an upload binding.
    if (node.kind === 'bookmark' && typeof node.url !== 'string') return { ...node, previewImage: null };
    if (preference?.mode === 'custom') {
      const image = preference.image;
      return { ...node, ...settings, previewImage: image && productOrigin
        ? { url: imageAssetUrl(productOrigin, image.objectId), width: image.width, height: image.height } : null };
    }
    if (preference?.mode === 'none') return { ...node, ...settings, previewImage: null };
    if (node.kind !== 'bookmark') return { ...node, ...settings };
    const urlKey = keyed.get(node.id);
    const target = urlKey === undefined || vetoed.has(node.id) ? undefined : ready.get(urlKey);
    const previewImage: BookmarkPreviewImageView | null = target === undefined || productOrigin === undefined
      ? null
      : { url: linkPreviewObjectUrl(productOrigin, target.objectId), width: target.width, height: target.height };
    return { ...node, ...settings, previewImage };
  });
}
