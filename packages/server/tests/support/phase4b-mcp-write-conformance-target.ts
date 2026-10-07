import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DeploymentConformanceCommand,
  DeploymentConformanceTarget,
} from '@know-n/colp/conformance';

/**
 * Test-only synthetic deployment target for MCP-W10 claim/runner unit tests.
 * It deliberately mirrors the COLP reference fixture in `colp/tests` so the
 * same package-owned official probes can be exercised without a PostgreSQL
 * harness. It is never used as deployment evidence outside unit tests.
 */
export function createPhase4bMcpWriteSyntheticTarget(): DeploymentConformanceTarget {
  const ledger = new Map<string, string>();
  const reservedIds = new Set<string>();
  const extensions = new Map<string, unknown>();
  const objects = new Map<string, unknown>();
  const parents = new Map<string, string | null>();
  const managedFolders = new Set<string>();
  const titles = new Map<string, string>();
  const randomProfileIds = new Map<string, string>();
  const keys = new Map<string, string>();

  async function execute(command: DeploymentConformanceCommand): Promise<unknown> {
    switch (command.kind) {
      case 'id-ledger.reserve': {
        const existing = ledger.get(command.logicalKey);
        if (existing !== undefined) return { status: 'reserved', id: existing };
        if (reservedIds.has(command.requestedId)) return { status: 'conflict' };
        ledger.set(command.logicalKey, command.requestedId);
        reservedIds.add(command.requestedId);
        return { status: 'reserved', id: command.requestedId };
      }
      case 'id-ledger.delete-resource':
        ledger.delete(command.logicalKey);
        return { status: 'deleted' };
      case 'sync-extension.replace':
        extensions.set(command.resourceId, structuredClone(command.value));
        return { status: 'stored' };
      case 'sync-extension.load':
        return extensions.has(command.resourceId)
          ? { status: 'found', value: structuredClone(extensions.get(command.resourceId)) }
          : { status: 'missing' };
      case 'pre-write.write': {
        const candidate = command.candidate as Record<string, unknown>;
        if (typeof candidate.url !== 'string') return { status: 'rejected' };
        if (typeof candidate.urlHash === 'string') {
          const expected = `sha-256=:${createHash('sha256').update(candidate.url).digest('base64')}:`;
          if (candidate.urlHash !== expected) return { status: 'rejected' };
        }
        objects.set(command.objectId, structuredClone(command.candidate));
        return { status: 'stored' };
      }
      case 'pre-write.load':
        return objects.has(command.objectId)
          ? { status: 'found', value: structuredClone(objects.get(command.objectId)) }
          : { status: 'missing' };
      case 'parent-cycle.seed':
      case 'node-subtree.seed':
        for (const node of command.nodes) parents.set(node.id, node.parentId);
        return { status: 'stored' };
      case 'parent-cycle.move': {
        let current: string | null | undefined = command.parentId;
        const visited = new Set<string>();
        while (current !== null && current !== undefined && !visited.has(current)) {
          if (current === command.nodeId) return { status: 'rejected' };
          visited.add(current);
          current = parents.get(current);
        }
        parents.set(command.nodeId, command.parentId);
        return { status: 'stored' };
      }
      case 'parent-cycle.parent':
        return parents.has(command.nodeId)
          ? { status: 'found', parentId: parents.get(command.nodeId) }
          : { status: 'missing' };
      case 'node-subtree.delete': {
        if (!parents.has(command.nodeId)) return { status: 'missing' };
        const deleted = new Set([command.nodeId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [nodeId, parentId] of parents) {
            if (!deleted.has(nodeId) && parentId !== null && deleted.has(parentId)) {
              deleted.add(nodeId);
              changed = true;
            }
          }
        }
        for (const nodeId of deleted) parents.delete(nodeId);
        return { status: 'deleted', affectedCount: deleted.size };
      }
      case 'node-subtree.read':
        return parents.has(command.nodeId) ? { status: 'found' } : { status: 'missing' };
      case 'managed-bookmarks.seed':
        managedFolders.add(command.folderId);
        parents.set(command.folderId, null);
        parents.set(command.childId, command.folderId);
        titles.set(command.childId, 'original');
        return { status: 'stored' };
      case 'managed-bookmarks.mutate': {
        let current = parents.get(command.nodeId);
        if (managedFolders.has(command.nodeId)) return { status: 'rejected' };
        while (current !== null && current !== undefined) {
          if (managedFolders.has(current)) return { status: 'rejected' };
          current = parents.get(current);
        }
        titles.set(command.nodeId, command.marker);
        return { status: 'stored' };
      }
      case 'managed-bookmarks.read':
        return titles.has(command.nodeId)
          ? { status: 'found', title: titles.get(command.nodeId) }
          : { status: 'missing' };
      case 'ai-provenance.create':
        if (command.trustedOrigin === 'human'
          && (command.callerProvenance as { kind?: unknown } | undefined)?.kind === 'ai') {
          return { status: 'rejected' };
        }
        objects.set(command.objectId, {
          provenance: command.trustedOrigin === 'ai'
            ? { kind: 'ai', generatedAt: '2026-01-01T00:00:00Z', provider: 'trusted-runtime' }
            : command.callerProvenance,
        });
        return { status: 'stored' };
      case 'ai-provenance.edit-human': {
        const existing = objects.get(command.objectId) as
          { provenance?: Record<string, unknown> } | undefined;
        if (existing === undefined) return { status: 'missing' };
        objects.set(command.objectId, {
          ...existing,
          provenance: { ...existing.provenance, editedByHuman: true },
        });
        return { status: 'stored' };
      }
      case 'ai-provenance.load': {
        const existing = objects.get(command.objectId) as { provenance?: unknown } | undefined;
        return existing === undefined
          ? { status: 'missing' }
          : { status: 'found', provenance: structuredClone(existing.provenance) };
      }
      case 'random-profile-id.get-or-create': {
        let id = randomProfileIds.get(command.profileKey);
        if (id === undefined) {
          id = `prf.r1.${randomBytes(32).toString('base64url')}`;
          randomProfileIds.set(command.profileKey, id);
        }
        return { status: 'found', id };
      }
      case 'profile-id.configure-key':
        keys.set(command.version, command.secret);
        return { status: 'configured' };
      case 'profile-id.activate-key':
        return keys.has(command.version) ? { status: 'activated' } : { status: 'missing' };
      case 'profile-id.derive': {
        const secret = keys.get(command.version);
        if (secret === undefined) return { status: 'missing' };
        return {
          status: 'derived',
          id: createHash('sha256').update(`${command.version}\0${secret}\0${command.profileKey}`).digest('hex'),
        };
      }
      case 'publication.http-contract':
        return {
          challenge: command.challenge,
          initialStatus: 200,
          conditionalStatus: 304,
          etag: '"deployment"',
          validated: true,
        };
      case 'feed.delivery-contract':
        return { challenge: command.challenge, releaseFirst: true, skipRejected: true };
      case 'publisher.transaction-contract':
      case 'sync.transaction-contract':
        return {
          challenge: command.challenge,
          committed: true,
          replayed: true,
          rollbackObserved: true,
          ...(command.kind === 'sync.transaction-contract' ? { casObserved: true } : {}),
        };
      case 'mcp-2026-07-28.transport-header-contract': {
        const methodValues = command.headers
          .filter((header) => header.name === 'Mcp-Method')
          .map((header) => header.value);
        if (new Set(methodValues).size > 1) {
          return { challenge: command.challenge, accepted: false, codec: null, decoded: null, unique: false };
        }
        const nameHeader = command.headers.find((header) => header.name === 'Mcp-Name');
        const match = /^=\?base64\?([A-Za-z0-9+/]+=*)\?=$/u.exec(nameHeader?.value ?? '');
        const decoded = match === null ? null : Buffer.from(match[1]!, 'base64').toString('utf8');
        return {
          challenge: command.challenge,
          accepted: decoded === 'sentinel',
          codec: decoded === 'sentinel' ? 'base64' : null,
          decoded,
          unique: true,
        };
      }
      case 'mcp-2026-07-28.discovery-contract':
        return {
          challenge: command.challenge,
          discovered: true,
          protocolVersion: '2026-07-28',
          serverInfo: { name: 'known-mcp-write-synthetic', version: '0.0.0' },
          capabilitiesDeclared: true,
          extensionsBounded: true,
        };
      case 'mcp-2026-07-28.subscription-contract': {
        const routed = command.notification.subscriptionId === command.subscriptionId;
        return {
          challenge: command.challenge,
          subscriptionId: command.subscriptionId,
          acknowledged: true,
          notificationRouted: routed,
          requestScoped: true,
          bodyCarried: false,
        };
      }
      case 'mcp-2026-07-28.read-schema-contract': {
        const serialized = JSON.stringify(command.schema);
        const accepted = !Array.isArray(command.schema)
          && Buffer.byteLength(serialized, 'utf8') <= command.budget.maxBytes;
        return {
          challenge: command.challenge,
          accepted,
          refsResolved: accepted,
        };
      }
      case 'mcp-2026-07-28.write-mrtr-contract':
        return command.mode === 'complete'
          ? {
              challenge: command.challenge,
              resultType: 'complete',
              requestState: null,
              serverInitiated: false,
            }
          : {
              challenge: command.challenge,
              resultType: 'input_required',
              requestState: `state-${randomUUID()}`,
              retryResumed: true,
              serverInitiated: false,
            };
      case 'mcp-2026-07-28.oauth-client-contract':
        return {
          challenge: command.challenge,
          issuerValidated: command.expectedIssuer === command.issuer,
          dcrApplicationType: command.applicationType,
          credentialIssuerKeyed: true,
          refreshStateIsolated: true,
        };
    }
  }

  return {
    execute,
    async restart(): Promise<void> {},
    async readDiagnostics(): Promise<unknown> {
      return { keyVersions: [...keys.keys()], secretValues: '[REDACTED]' };
    },
  };
}
