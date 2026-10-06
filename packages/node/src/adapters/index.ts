import {
  preserveExtensionCarrier,
  type ExtensionCarrier,
  type ExtensionRemovalAudit,
  type ExtensionSecurityPolicy,
} from '../schema/extensions.js';
import { isHttpsNamespaceUri } from '../schema/uri.js';

export {
  createRandomProfileId,
  getOrCreateRandomProfileId,
  type LocalProfileIdAllocator,
  type LocalProfileIdStore,
  type ProfileIdRandomBytes,
  type RandomProfileIdOptions,
} from '../server/profile-id.js';

export {
  validateBookmarkUrlHashSemantics,
  validateNodeCreateRequestUrlHashSemantics,
  validateNodeCreateUrlHashSemantics,
  validateNodeMergePatchUrlHashSemantics,
  validateNodeUrlHashSemantics,
} from '../semantic/bookmark-url-hash.js';

export type BrowserMountMode = 'whole-profile' | 'mounted-folder';

export interface BrowserBinding {
  readonly browserProfileId: string;
  readonly mountMode: BrowserMountMode;
  readonly mountNativeId?: string;
  readonly generation: string;
}

export interface ConversionWarning {
  readonly code: string;
  readonly nodeId?: string;
  readonly message: string;
  readonly path?: string;
  readonly lossy?: boolean;
}

export type ExtensionDegradationKind = 'value' | 'semantics';

export interface ExtensionDegradationInput {
  readonly namespace: string;
  /** JSON Pointer to the affected namespace value or a member beneath it. */
  readonly path: string;
  readonly kind: ExtensionDegradationKind;
  readonly reason: string;
}

export interface ExtensionDegradationAudit extends ExtensionDegradationInput {
  readonly surface: 'export-adapter';
}

export interface AdapterExtensionDegradationClaim {
  readonly namespace: string;
  readonly reason: string;
  /** Defaults to semantics when the target's exact loss category is not specified. */
  readonly kind?: ExtensionDegradationKind;
  /** Defaults to the affected namespace path on this carrier. */
  readonly path?: string;
}

export interface ConversionResult<Value> {
  readonly value: Value;
  readonly lossless: boolean;
  readonly warnings: readonly ConversionWarning[];
  /** Empty unless an explicit, named security policy removed extension data. */
  readonly extensionRemovals: readonly ExtensionRemovalAudit[];
  /** Empty unless an adapter explicitly declared degraded extension data or semantics. */
  readonly extensionDegradations?: readonly ExtensionDegradationAudit[];
}

export interface AdapterConversionResultInput<Value> {
  readonly value: Value;
  /** Assertion checked against all supplied lossy evidence. */
  readonly lossless: boolean;
  /** Non-extension warnings. `lossy_conversion` is reserved for generated warnings. */
  readonly warnings?: readonly ConversionWarning[];
  readonly extensionRemovals?: readonly ExtensionRemovalAudit[];
  readonly extensionDegradations?: readonly ExtensionDegradationAudit[];
}

export interface AdapterConversionOptions {
  /** Omit to preserve every unknown extension namespace and payload. */
  readonly extensionSecurityPolicy?: ExtensionSecurityPolicy;
  /** JSON Pointer to the protocol object being transformed, for removal audits. */
  readonly extensionCarrierPath?: string;
  /** Explicit declarations for retained values whose value or semantics lose fidelity. */
  readonly extensionDegradations?: readonly AdapterExtensionDegradationClaim[];
}

export interface CollectionAdapter<NativeTree = unknown, Snapshot = unknown> {
  readonly profile: string;
  import(
    nativeTree: NativeTree,
    binding: BrowserBinding,
    options?: AdapterConversionOptions,
  ): Promise<ConversionResult<Snapshot>>;
  preview(
    snapshot: Snapshot,
    binding: BrowserBinding,
    options?: AdapterConversionOptions,
  ): Promise<ConversionResult<unknown>>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim() === '') throw new TypeError(`${name} must be non-empty.`);
}

const issuedRemovalAudits = new WeakSet<object>();
const issuedDegradationAudits = new WeakSet<object>();

function freezeWarning(warning: ConversionWarning): ConversionWarning {
  assertNonEmpty(warning.code, 'Conversion warning code');
  if (typeof warning.message !== 'string') {
    throw new TypeError('Conversion warning message must be a string.');
  }
  if (warning.nodeId !== undefined) assertNonEmpty(warning.nodeId, 'Conversion warning nodeId');
  if (warning.path !== undefined && !warning.path.startsWith('/')) {
    throw new TypeError('Conversion warning path must be a JSON Pointer.');
  }
  if (warning.lossy !== undefined && typeof warning.lossy !== 'boolean') {
    throw new TypeError('Conversion warning lossy must be a boolean.');
  }
  return Object.freeze({
    code: warning.code,
    message: warning.message,
    ...(warning.nodeId === undefined ? {} : { nodeId: warning.nodeId }),
    ...(warning.path === undefined ? {} : { path: warning.path }),
    ...(warning.lossy === undefined ? {} : { lossy: warning.lossy }),
  });
}

function extensionNamespacePath(namespace: string): string {
  return `/extensions/${namespace.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function assertJsonPointer(path: string, name: string): void {
  if (!path.startsWith('/') || /~(?:[^01]|$)/u.test(path)) {
    throw new TypeError(`${name} must be a valid JSON Pointer.`);
  }
}

function extensionAuditLocation(namespace: string, path: string): string {
  if (!isHttpsNamespaceUri(namespace)) {
    throw new TypeError('Extension audit namespace must be an absolute HTTPS URI.');
  }
  assertJsonPointer(path, 'Extension audit path');
  const namespacePath = extensionNamespacePath(namespace);
  const namespaceOffset = path.indexOf(namespacePath);
  const namespaceEnd = namespaceOffset + namespacePath.length;
  if (
    namespaceOffset < 0
    || (namespaceEnd !== path.length && path[namespaceEnd] !== '/')
  ) {
    throw new TypeError('Extension audit path must identify its namespace using a JSON Pointer.');
  }
  return path.slice(0, namespaceEnd);
}

function assertExtensionAuditLocation(namespace: string, path: string): void {
  extensionAuditLocation(namespace, path);
}

/** Creates an immutable, validated claim that an adapter degraded extension data. */
export function declareExtensionDegradation(
  input: ExtensionDegradationInput,
): ExtensionDegradationAudit {
  assertExtensionAuditLocation(input.namespace, input.path);
  if (input.kind !== 'value' && input.kind !== 'semantics') {
    throw new TypeError('Extension degradation kind must be value or semantics.');
  }
  assertNonEmpty(input.reason, 'Extension degradation reason');
  const audit = Object.freeze({
    namespace: input.namespace,
    path: input.path,
    kind: input.kind,
    reason: input.reason,
    surface: 'export-adapter',
  });
  issuedDegradationAudits.add(audit);
  return audit;
}

function copyRemoval(removal: ExtensionRemovalAudit): ExtensionRemovalAudit {
  if (typeof removal !== 'object' || removal === null || !issuedRemovalAudits.has(removal)) {
    throw new TypeError('Adapter conversion removals must be issued by the export transformation boundary.');
  }
  assertExtensionAuditLocation(removal.namespace, removal.path);
  if (removal.surface !== 'export-adapter') {
    throw new TypeError('Adapter conversion removals must originate from export-adapter.');
  }
  assertNonEmpty(removal.policyId, 'Extension removal policyId');
  assertNonEmpty(removal.reason, 'Extension removal reason');
  const audit = Object.freeze({
    namespace: removal.namespace,
    path: removal.path,
    surface: removal.surface,
    policyId: removal.policyId,
    reason: removal.reason,
  });
  issuedRemovalAudits.add(audit);
  return audit;
}

function compareExtensionAudit(
  left: { readonly path: string; readonly namespace: string; readonly reason: string },
  right: { readonly path: string; readonly namespace: string; readonly reason: string },
): number {
  return compareText(left.path, right.path)
    || compareText(left.namespace, right.namespace)
    || compareText(left.reason, right.reason);
}

/**
 * Completes an adapter conversion and binds extension loss audits to warnings.
 * The supplied `lossless` flag is an assertion: unsupported or contradictory
 * claims reject instead of allowing an adapter to silently lose information.
 */
export function createAdapterConversionResult<Value>(
  input: AdapterConversionResultInput<Value>,
): ConversionResult<Value> {
  if (typeof input.lossless !== 'boolean') {
    throw new TypeError('Conversion result lossless assertion must be a boolean.');
  }
  const warnings = (input.warnings ?? []).map(freezeWarning);
  if (warnings.some(({ code }) => code === 'lossy_conversion')) {
    throw new TypeError('lossy_conversion warnings are generated only from extension loss audits.');
  }
  if (warnings.some(({ path }) => path !== undefined && path.includes('/extensions/'))) {
    throw new TypeError('Extension loss warnings are generated only from extension loss audits.');
  }

  const removals = (input.extensionRemovals ?? []).map(copyRemoval).sort(compareExtensionAudit);
  const degradations = (input.extensionDegradations ?? [])
    .map((degradation) => {
      if (
        typeof degradation !== 'object'
        || degradation === null
        || !issuedDegradationAudits.has(degradation)
      ) {
        throw new TypeError('Adapter conversion degradations must be issued by declareExtensionDegradation.');
      }
      if (degradation.surface !== 'export-adapter') {
        throw new TypeError('Adapter conversion degradations must originate from export-adapter.');
      }
      return declareExtensionDegradation(degradation);
    })
    .sort((left, right) => compareExtensionAudit(left, right) || compareText(left.kind, right.kind));

  const removalKeys = new Set<string>();
  for (const removal of removals) {
    const key = `${removal.namespace}\u0000${removal.path}`;
    if (removalKeys.has(key)) throw new TypeError('Duplicate extension removal audits are not allowed.');
    removalKeys.add(key);
  }
  const degradationKeys = new Set<string>();
  for (const degradation of degradations) {
    const key = `${degradation.namespace}\u0000${degradation.path}\u0000${degradation.kind}`;
    if (degradationKeys.has(key)) {
      throw new TypeError('Duplicate extension degradation audits are not allowed.');
    }
    if (removals.some((removal) => (
      extensionAuditLocation(removal.namespace, removal.path)
      === extensionAuditLocation(degradation.namespace, degradation.path)
    ))) {
      throw new TypeError('An extension namespace cannot be both removed and degraded.');
    }
    degradationKeys.add(key);
  }

  const extensionWarnings: ConversionWarning[] = [
    ...removals.map((removal) => Object.freeze({
      code: 'lossy_conversion',
      message: `Extension ${removal.namespace} was removed by policy ${removal.policyId}: ${removal.reason}`,
      path: removal.path,
      lossy: true,
    })),
    ...degradations.map((degradation) => Object.freeze({
      code: 'lossy_conversion',
      message: `Extension ${degradation.namespace} ${degradation.kind} was degraded: ${degradation.reason}`,
      path: degradation.path,
      lossy: true,
    })),
  ].sort((left, right) => compareText(left.path ?? '', right.path ?? '') || compareText(left.message, right.message));

  const hasLoss = extensionWarnings.length > 0 || warnings.some(({ lossy }) => lossy === true);
  if (input.lossless === hasLoss) {
    throw new TypeError(
      hasLoss
        ? 'A conversion with lossy evidence must assert lossless: false.'
        : 'A conversion asserting lossless: false must include auditable lossy evidence.',
    );
  }

  return Object.freeze({
    value: input.value,
    lossless: input.lossless,
    warnings: Object.freeze([...warnings, ...extensionWarnings]),
    extensionRemovals: Object.freeze(removals),
    extensionDegradations: Object.freeze(degradations),
  });
}

/** Applies the mandatory preservation contract before an adapter exports a value. */
export function transformExportExtensionCarrier<
  Source extends object,
  Target extends object,
>(
  source: Source & ExtensionCarrier,
  target: Target,
  options: AdapterConversionOptions = {},
): ConversionResult<Target & ExtensionCarrier> {
  const result = preserveExtensionCarrier(source, target, {
    surface: 'export-adapter',
    ...(options.extensionCarrierPath === undefined ? {} : { path: options.extensionCarrierPath }),
    ...(options.extensionSecurityPolicy === undefined
      ? {}
      : { securityPolicy: options.extensionSecurityPolicy }),
  });
  for (const removal of result.removals) issuedRemovalAudits.add(removal);
  const ownerPath = options.extensionCarrierPath ?? '';
  const seenDegradations = new Set<string>();
  const degradations = (options.extensionDegradations ?? []).map((claim) => {
    if (source.extensions === undefined || !Object.hasOwn(source.extensions, claim.namespace)) {
      throw new TypeError('Extension degradation namespace must exist on the source carrier.');
    }
    if (result.value.extensions === undefined || !Object.hasOwn(result.value.extensions, claim.namespace)) {
      throw new TypeError('An extension namespace cannot be both removed and degraded.');
    }
    const path = claim.path ?? `${ownerPath}${extensionNamespacePath(claim.namespace)}`;
    const kind = claim.kind ?? 'semantics';
    const identity = `${claim.namespace}\u0000${path}\u0000${kind}\u0000${claim.reason}`;
    if (seenDegradations.has(identity)) {
      throw new TypeError('Duplicate extension degradation claims are not allowed.');
    }
    seenDegradations.add(identity);
    return declareExtensionDegradation({
      namespace: claim.namespace,
      path,
      kind,
      reason: claim.reason,
    });
  });

  const lossless = result.removals.length === 0 && degradations.length === 0;
  return createAdapterConversionResult({
    value: result.value,
    lossless,
    extensionRemovals: result.removals,
    extensionDegradations: degradations,
  });
}
