import {
  materializePublicationPublicWire,
  projectPublicationAuthorizedValue,
  resolvePublicationPublicProjectionOptions,
  type PublicationPublicWireOptions,
  type PublicationPublicValue,
} from './publication-public-projection.js';

/** Safe Publication projection for an already authorized caller. */
export function projectPublicationAuthorizedWire(
  input: unknown,
  options?: PublicationPublicWireOptions,
): PublicationPublicValue {
  const resolved = resolvePublicationPublicProjectionOptions(options);
  return materializePublicationPublicWire(
    projectPublicationAuthorizedValue(input, resolved),
    resolved.limits,
  );
}
