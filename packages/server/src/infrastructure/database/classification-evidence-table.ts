import type {Generated} from 'kysely';
export interface ClassificationEvidenceTable {
  evidence_id:string;collection_id:string;owner_subject_id:string;node_id:string;hostname:string;folder_id:string|null;
  source:'classify_accept'|'run_apply';command_id:string;operation_id:string|null;taxonomy_revision:string;tag_count:number;tag_digest:string|null;created_at:Generated<Date>;
  bookmark_key: Generated<string | null>; evidence_generation: Generated<number>;
}
export interface ClassificationEvidenceDatabaseSchema {collection_classification_evidence:ClassificationEvidenceTable}
