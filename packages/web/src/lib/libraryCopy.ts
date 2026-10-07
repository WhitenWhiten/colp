/** Feature-off empty states. The title already says "<Thing> is not
    available yet"; this is the line under it, with no deployment, server
    or flag words (R14 W-20). */
export function libraryFeatureUnavailable(_feature: string): string {
  return 'It will appear here when it is ready. Nothing you saved is affected.'
}
