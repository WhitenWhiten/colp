/** Endpoints every Manifest mount declaring the Publication Profile must expose. */
export const publicationRequiredEndpoints = Object.freeze([
  'directory',
  'collection',
  'snapshot',
] as const);
