export interface AccountCredentialGrantTable {
  id: string;
  credential_id: string;
  owner_account_id: string;
  resource_kind: 'collection' | 'report';
  resource_id: string;
  actions_json: unknown;
  state: 'active' | 'revoked';
  revision: bigint;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface AccountCredentialPlanAuthorizationTable {
  plan_kind: 'collection' | 'report';
  plan_id: string;
  grant_id: string;
  grant_revision: bigint;
  credential_id: string;
  plan_digest: string;
  authorized_at: Date;
}

export interface McpReportPlanTable {
  plan_id: string;
  principal_id: string;
  client_id: string;
  operations_digest: string;
  status: string;
  approval_status: string;
  expires_at: Date;
  plan_json: unknown;
  created_at: Date;
  updated_at: Date;
}
