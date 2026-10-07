import { createHash } from 'node:crypto';
import type { AccessPolicyFactsPort } from '../../access-policy/index.js';
import { formatUtcDateTime, strongEntityTag, normalizeBookmarkUrl } from '../domain/index.js';

export type ReadableReplicaStatus = 'none' | 'pending' | 'ready' | 'failed' | 'unsupported';
export type ReadableReplicaStoredStatus = 'pending' | 'ready' | 'failed' | 'unsupported';
export type ReadableReplicaFailureCode =
  | 'not_html'
  | 'empty'
  | 'timeout'
  | 'denied'
  | 'too_large'
  | 'http'
  | 'dns'
  | 'invalid_url';

export type ReadableReplicaParagraph = {
  readonly id: string;
  readonly text: string;
};

export type ReadableReplicaSection = {
  readonly id: string;
  readonly heading: string;
  readonly paragraphs: readonly ReadableReplicaParagraph[];
};

export type ReadableReplicaView = {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly status: ReadableReplicaStatus;
  readonly sourceUrl: string;
  readonly title: string | null;
  readonly byline: string | null;
  readonly wordCount: number;
  readonly extractedAt: string | null;
  readonly failureCode: ReadableReplicaFailureCode | null;
  readonly sections: readonly ReadableReplicaSection[];
  readonly etag: string | null;
};

export type ReadableReplicaRow = {
  readonly status: ReadableReplicaStoredStatus;
  readonly sourceUrl: string;
  readonly title: string | null;
  readonly byline: string | null;
  readonly wordCount: number;
  readonly extractedAt: Date | null;
  readonly failureCode: ReadableReplicaFailureCode | null;
  readonly sections: readonly ReadableReplicaSection[];
  readonly etag: string;
};

export type ReadableReplicaBookmarkLoad = {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly bookmarkUrl: string;
  readonly replica: ReadableReplicaRow | null;
};

export interface ReadableReplicaReadPort {
  loadBookmarkReplica(input: {
    readonly collectionId: string;
    readonly nodeId: string;
  }): Promise<ReadableReplicaBookmarkLoad | null>;
}

export interface GetNodeReadableReplicaPorts {
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly replicas: ReadableReplicaReadPort;
}

export interface ReadableReplicaReadUnitOfWork {
  execute<Result>(
    work: (ports: GetNodeReadableReplicaPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export class ReadableReplicaNotFoundError extends Error {
  readonly code = 'resource_not_found' as const;
  constructor(message = 'The requested resource was not found.') {
    super(message);
    this.name = 'ReadableReplicaNotFoundError';
  }
}

export async function getNodeReadableReplica(
  ports: GetNodeReadableReplicaPorts,
  input: {
    readonly actor: { readonly principalId: string; readonly subjectId: string };
    readonly collectionId: string;
    readonly nodeId: string;
  },
): Promise<ReadableReplicaView> {
  const facts = await ports.accessPolicy.loadCollectionFacts({
    collectionId: input.collectionId,
    actorSubjectId: input.actor.subjectId,
  });
  if (!facts || facts.deleted) throw new ReadableReplicaNotFoundError();
  if (facts.ownerSubjectId !== input.actor.subjectId && facts.membershipRole === null) {
    throw new ReadableReplicaNotFoundError();
  }
  const loaded = await ports.replicas.loadBookmarkReplica({
    collectionId: input.collectionId,
    nodeId: input.nodeId,
  });
  if (!loaded) throw new ReadableReplicaNotFoundError();
  return projectReadableReplicaView(loaded);
}

export function freezeReadableReplicaEtag(input: {
  readonly nodeId: string;
  readonly status: ReadableReplicaStoredStatus;
  readonly sourceUrl: string;
  readonly extractedAt: Date | null;
  readonly sections: readonly ReadableReplicaSection[];
}): string {
  const extractedAt = input.extractedAt === null ? '' : formatUtcDateTime(input.extractedAt);
  const digest = createHash('sha256')
    .update(
      [input.nodeId, input.status, input.sourceUrl, extractedAt, JSON.stringify(input.sections)].join('\n'),
      'utf8',
    )
    .digest('base64url');
  return strongEntityTag(digest);
}

export function projectReadableReplicaView(loaded: ReadableReplicaBookmarkLoad): ReadableReplicaView {
  // Also protect historical sidecars created before URL invalidation existed.
  if (loaded.replica === null
    || normalizeBookmarkUrl(loaded.replica.sourceUrl) !== normalizeBookmarkUrl(loaded.bookmarkUrl)) {
    return Object.freeze({
      nodeId: loaded.nodeId,
      collectionId: loaded.collectionId,
      status: 'none',
      sourceUrl: loaded.bookmarkUrl,
      title: null,
      byline: null,
      wordCount: 0,
      extractedAt: null,
      failureCode: null,
      sections: Object.freeze([]),
      etag: null,
    });
  }
  const row = loaded.replica;
  return Object.freeze({
    nodeId: loaded.nodeId,
    collectionId: loaded.collectionId,
    status: row.status,
    sourceUrl: row.sourceUrl,
    title: row.title,
    byline: row.byline,
    wordCount: row.wordCount,
    extractedAt: row.extractedAt === null ? null : formatUtcDateTime(row.extractedAt),
    failureCode: row.failureCode,
    sections: Object.freeze(row.sections.map((section) => Object.freeze({
      id: section.id,
      heading: section.heading,
      paragraphs: Object.freeze(section.paragraphs.map((paragraph) => Object.freeze({
        id: paragraph.id,
        text: paragraph.text,
      }))),
    }))),
    etag: row.etag,
  });
}
