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
  return materializePublicationPublicWire(projectPublicationAuthorizedValue(
    input,
    resolvePublicationPublicProjectionOptions(options),
  ));
}
