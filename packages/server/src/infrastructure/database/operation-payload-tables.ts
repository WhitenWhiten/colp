export type OperationPayloadSourceKind = 'hot' | 'archive';

export interface OperationPayloadTable {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  payload_bucket: Date;
  payload_schema_version: 1;
  payload_json: Record<string, unknown>;
  sync_wire_json: Record<string, unknown> | null;
  canonical_digest_sha256: string;
  canonical_bytes: bigint;
  created_at: Date;
}

export interface OperationLookupFactTable {
  operation_id: string;
  collection_id: string;
  commit_ordinal: bigint;
  operation_type: 'attachment.finalized' | 'attachment.retired';
  command_id: string | null;
  attachment_id: string;
  blob_id: string;
}

export interface OperationPayloadFacts {
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly source: OperationPayloadSourceKind;
  readonly locator: string;
  readonly digestSha256: string;
  readonly byteCount: bigint;
  readonly schemaVersion: 1;
  readonly bucket: string;
  readonly syncWirePresent: boolean;
}

export interface OperationPayloadDocument {
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly syncWireJson: Readonly<Record<string, unknown>> | null;
  readonly digestSha256: string;
  readonly byteCount: bigint;
  readonly schemaVersion: 1;
}

/** Archive implementations must return the exact canonical payload bound by the facts. */
export interface OperationPayloadSource {
  read(facts: OperationPayloadFacts, signal?: AbortSignal): Promise<OperationPayloadDocument | null>;
}

export type HistoricalOperationPayloadPurpose = 'command' | 'audit' | 'diagnostic';

/** Named historical-payload port. Ordinary Pull must not accept this type. */
export interface HistoricalOperationPayloadPort extends OperationPayloadSource {
  readonly purpose: HistoricalOperationPayloadPurpose;
}
