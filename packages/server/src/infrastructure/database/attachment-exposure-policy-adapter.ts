/**
 * FIX-L-033 (SYNC-R17): composition adapter for the Sync domain's minimal
 * `AttachmentExposurePolicyPort`.
 *
 * Maps the attachments exposure-eligibility gate onto the port WITHOUT copying
 * any policy logic. Sync bootstrap has no attachment output candidates while
 * no content-safety capability exists. The shared gate therefore returns an
 * empty verdict list without loading the collection's attachment history.
 *
 * The ineligible assertion remains the output boundary. Adding attachment
 * output requires passing its explicit blob candidates through this gate;
 * a future eligible verdict must be an intentional capability change.
 *
 * The return type is declared structurally and never imports the Sync module,
 * so this adapter stays composable for any consumer speaking the same
 * "assert attachments denied" language without widening module edges.
 */
import {
  assessSharedExposureScope,
  assertSharedExposureScopeIneligible,
  type SharedExposureFactsPort,
} from '../../modules/exposure/deny-by-default.js';

/** The structural shape of the Sync `AttachmentExposurePolicyPort`. */
export interface AttachmentExposurePolicyAdapter {
  assertAttachmentsDenied(input: { readonly collectionId: string }): Promise<void>;
}

export function createAttachmentExposurePolicyAdapter(
  factsPort: SharedExposureFactsPort,
): AttachmentExposurePolicyAdapter {
  return Object.freeze({
    async assertAttachmentsDenied(input: { readonly collectionId: string }): Promise<void> {
      const exposure = await assessSharedExposureScope(factsPort, { collectionId: input.collectionId, blobIds: [] });
      assertSharedExposureScopeIneligible(exposure);
    },
  });
}
