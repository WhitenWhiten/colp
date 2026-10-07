import {sql,type Kysely} from 'kysely';
// Internal bounded diagnostic code survives a crash between child completion and
// batch action publication. Provider text never enters this field or a receipt.
export async function up(db:Kysely<unknown>):Promise<void>{
  await sql`ALTER TABLE classification_provider_executions ADD COLUMN failure_code text
    CHECK (failure_code IS NULL OR failure_code IN ('invalid_input','invalid_taxonomy','context_limit','contract_drift','resource_not_found',
      'credentials','deadline','outcome_unknown','budget_exhausted','configuration_changed','lease_lost','disabled','unavailable'))`.execute(db);
}
export async function down(db:Kysely<unknown>):Promise<void>{
  await sql`ALTER TABLE classification_provider_executions DROP COLUMN failure_code`.execute(db);
}
