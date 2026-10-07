import type { Annotation } from '@know-n/colp/types';
import type {
  PublicationAnnotationRecord,
  PublicationCollectionRecord,
  PublicationNodeRecord,
} from '../../../src/modules/publication/index.js';

export const publicationAnnotationInstant = '2026-07-25T00:00:00.000Z';

export function publicationCollection(
  overrides: Partial<PublicationCollectionRecord> = {},
): PublicationCollectionRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'subject-owner', kind: 'knowledge_collection',
    title: 'Published annotations', summary: null, visibility: 'public', publicationSlug: 'annotations',
    rootNodeId: 'root-1', contentRevision: 'content-1', policyRevision: 'policy-1',
    createdAt: publicationAnnotationInstant, updatedAt: publicationAnnotationInstant, deletedAt: null,
    ...overrides,
  };
}

export function publicationNode(
  id: string,
  overrides: Partial<PublicationNodeRecord> = {},
): PublicationNodeRecord {
  return {
    id, collectionId: 'collection-1', parentId: 'root-1', kind: 'bookmark', isRoot: false,
    title: id, url: `https://example.test/${id}`, description: null, tags: [], visibility: 'inherit',
    ancestorRestricted: false, position: id.toUpperCase(), publicationPosition: id.toUpperCase(),
    resourceRevision: `revision-${id}`, createdAt: publicationAnnotationInstant,
    updatedAt: publicationAnnotationInstant, ...overrides,
  };
}

export const publicationRoot = publicationNode('root-1', {
  parentId: null, kind: 'folder', isRoot: true, title: 'Root', url: null,
  position: null, publicationPosition: null,
});

export function publicationAnnotation(
  id: string,
  overrides: Partial<PublicationAnnotationRecord> = {},
): PublicationAnnotationRecord {
  const subjectType = overrides.subjectType ?? 'node';
  const subjectId = overrides.subjectId ?? 'node-1';
  const visibility = overrides.visibility ?? 'public';
  const creatorPrincipalId = overrides.creatorPrincipalId ?? 'account-creator';
  const payload: Annotation = {
    id, collectionId: 'collection-1', subject: { type: subjectType, id: subjectId },
    type: 'note', format: 'plain', value: `value-${id}`, visibility,
    creator: { id: 'https://known.example/profiles/creator', name: 'Public Creator' },
    revision: `revision-${id}`, createdAt: publicationAnnotationInstant,
    updatedAt: publicationAnnotationInstant,
  };
  return {
    id, collectionId: 'collection-1', subjectType, subjectId, creatorPrincipalId,
    creatorUri: 'https://known.example/profiles/creator', creatorDisplayName: 'Public Creator', visibility,
    subjectVisibility: subjectType === 'collection' ? 'public' : 'inherit',
    subjectAncestorRestricted: false, payload, deletedAt: null, ...overrides,
  };
}
