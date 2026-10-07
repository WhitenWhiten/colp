import { readClassificationHostnameEvidence } from './classification-evidence-postgres.js';
import { sql, type Kysely } from 'kysely';
import { ClassificationError,selectClassificationRunNodes,type ClassificationRunCreate,type ClassificationRunSnapshot } from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork,type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { readClassificationTree } from './classification-taxonomy-read.js';

export async function readClassificationRunSnapshot(db:Kysely<DatabaseSchema>,input:{ownerSubjectId:string;collectionId:string;document:ClassificationRunCreate},
  options:Pick<UnitOfWorkOptions,'signal'|'cancelBackend'>&{priorEnabled?:boolean}={}):Promise<ClassificationRunSnapshot>{
  return createUnitOfWork(db,{...options,isolationLevel:'repeatable read'}).execute(async({transaction})=>{
    await sql`SET TRANSACTION READ ONLY`.execute(transaction);
    const tree=await readClassificationTree(transaction,input);
    if(!tree)throw new ClassificationError('resource_not_found');
    const nodes=selectClassificationRunNodes(input.document,{rootId:tree.rootId,folders:tree.snapshot.folders,bookmarks:tree.bookmarks});
    if(!nodes.length)throw new ClassificationError('invalid_input');
    const evidence=options.priorEnabled?await readClassificationHostnameEvidence(transaction,{collectionId:input.collectionId,ownerSubjectId:input.ownerSubjectId,
      taxonomyRevision:tree.snapshot.contentRevision,urls:nodes.map(node=>node.url)}):undefined;
    return {taxonomy:{...tree.snapshot,...(evidence?{hostnameEvidence:evidence}:{})},nodes,requested:input.document.requested};
  });
}
