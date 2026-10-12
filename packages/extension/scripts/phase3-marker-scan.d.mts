export function domainSeparatedPhase3MetadataDigest(label: string, value: string): string;
export function markerVariants(markers: readonly string[]): string[];
export function containsPhase3Marker(markers: readonly string[], text: string): boolean;
export function redactPhase3MarkerBytes(markers: readonly string[], input: Uint8Array): Buffer;
