export interface AccountCredentialTable {
  id: string;
  kind: 'parent' | 'child';
  parent_id: string | null;
  account_id: string;
  subject_id: string;
  manager_account_id: string;
  label: string;
  prefix: string;
  secret_hash: string;
  state: 'active' | 'revoked';
  revision: bigint;
  epoch: bigint;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  mcp_client_id: string;
}
