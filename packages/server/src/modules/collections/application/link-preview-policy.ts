/**
 * LP-02 link preview policy (pure): which URL a preview belongs to and which
 * decoded images are worth showing on a card.
 */
import { createHash } from 'node:crypto';
import { getDomain } from 'tldts';
import { LINK_PREVIEW_MAX_DIMENSION } from './link-preview-limits.js';

export const LINK_PREVIEW_NORMALIZED_URL_MAX_LENGTH = 4096;
export const LINK_PREVIEW_MIN_WIDTH = 200;
export const LINK_PREVIEW_MIN_SHORT_SIDE = 120;
/** Accepted aspect ratio (width / height), inclusive: 1:3 up to 4:1. */
export const LINK_PREVIEW_MIN_ASPECT = 1 / 3;
export const LINK_PREVIEW_MAX_ASPECT = 4;

export interface LinkPreviewTargetIdentity {
  /** Hex sha256 of the normalized URL; the cache primary key. */
  readonly urlKey: string;
  readonly normalizedUrl: string;
  /** Registrable domain (or the bare host for IPs and single-label hosts). */
  readonly site: string;
}

export function linkPreviewTargetIdentity(bookmarkUrl: string): LinkPreviewTargetIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(bookmarkUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  // Fragments are not sent over HTTP. Keep the path (including its trailing
  // slash) intact: this identity is also the worker's actual fetch address.
  parsed.hash = '';
  const normalizedUrl = parsed.href;
  if (normalizedUrl.length > LINK_PREVIEW_NORMALIZED_URL_MAX_LENGTH) return null;
  const hostname = parsed.hostname;
  const site = (getDomain(hostname) ?? hostname).slice(0, 253);
  return {
    urlKey: createHash('sha256').update(normalizedUrl, 'utf8').digest('hex'),
    normalizedUrl,
    site,
  };
}

export type LinkPreviewImageRejection = 'rejected_type' | 'rejected_small' | 'rejected_shape';

/** Null when a structurally decoded image is fit for a card. */
export function linkPreviewImageRejection(image: {
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}): LinkPreviewImageRejection | null {
  if (image.mime !== 'image/png' && image.mime !== 'image/jpeg' && image.mime !== 'image/webp') {
    return 'rejected_type';
  }
  const { width, height } = image;
  if (width > LINK_PREVIEW_MAX_DIMENSION || height > LINK_PREVIEW_MAX_DIMENSION) return 'rejected_shape';
  if (width < LINK_PREVIEW_MIN_WIDTH || Math.min(width, height) < LINK_PREVIEW_MIN_SHORT_SIDE) {
    return 'rejected_small';
  }
  const aspect = width / height;
  if (aspect < LINK_PREVIEW_MIN_ASPECT || aspect > LINK_PREVIEW_MAX_ASPECT) return 'rejected_shape';
  return null;
}
