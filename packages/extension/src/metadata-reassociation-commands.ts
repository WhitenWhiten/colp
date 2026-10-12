export type MetadataReassociationCommand =
  | { readonly kind: 'known.metadataRestore.preview'; readonly base64: string }
  | { readonly kind: 'known.metadataRestore.confirm'; readonly token: string; readonly userGesture: true };
export function validMetadataReassociationCommand(value: unknown): value is MetadataReassociationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.kind === 'known.metadataRestore.preview') return Object.keys(row).length === 2 && typeof row.base64 === 'string'
    && row.base64.length <= Math.ceil(32 * 1024 * 1024 / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(row.base64);
  return row.kind === 'known.metadataRestore.confirm' && Object.keys(row).length === 3
    && row.userGesture === true && typeof row.token === 'string' && /^[0-9a-f-]{36}$/u.test(row.token);
}
