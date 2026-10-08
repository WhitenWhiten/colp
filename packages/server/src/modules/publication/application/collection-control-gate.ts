export interface CollectionHideControlPort {
  collectionControl(collectionId: string): Promise<{ readonly hidePublic: boolean }>;
}

export async function isHiddenPublicCollection(
  controls: CollectionHideControlPort | undefined,
  collectionId: string,
  projection: 'public' | 'member',
): Promise<boolean> {
  if (projection !== 'public' || controls === undefined) return false;
  return (await controls.collectionControl(collectionId)).hidePublic;
}
