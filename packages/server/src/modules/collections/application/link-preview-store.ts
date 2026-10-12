/** Bytes of one preview image version; the self-hosted server keeps them in its database. */
export interface LinkPreviewObjectStore {
  /** The ledger row (link_preview_objects) must exist first. */
  put(objectId: string, body: Buffer, contentType: string): Promise<void>;
  get(
    objectId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly contentType: string; readonly body: Buffer } | null>;
  delete(objectId: string): Promise<void>;
}
