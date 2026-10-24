import type { FolderTreeNode } from './save-folder.js';
import type { MountBinding } from './site-adapters/contracts.js';
import { sourceDigest } from './site-adapters/source-db.js';

export interface DestinationPolicy { digest: string; excluded: ReadonlySet<string>; constrained: boolean }
export interface DestinationPolicyPorts {
  mounts(): Promise<readonly MountBinding[]>;
  tree(): Promise<readonly FolderTreeNode[]>;
  deviceId(): Promise<string>;
}
/** AI eligibility is separate from personal write permission. Explicit folder picks bypass this policy. */
export function createClassificationDestinationPolicy(ports: DestinationPolicyPorts) {
  async function snapshot() {
    const mounts = await ports.mounts();
    // An ordinary cloud preview need not have native-bookmark permission when no source policy exists.
    if (!mounts.length) return { digest: sourceDigest([]), excluded: new Set<string>(), constrained: false, nodes: new Map<string, FolderTreeNode>(), unrestricted: true };
    const [tree, device] = await Promise.all([ports.tree(), ports.deviceId()]);
    if (mounts.length > 10000) throw new Error('destination_policy_capacity');
    const nodes = new Map<string, FolderTreeNode>(), ancestry: { id: string; parent: string | null; date: number | null }[] = [];
    const visit = (rows: readonly FolderTreeNode[]) => { for (const n of rows) {
      if (n.url !== undefined) continue;
      nodes.set(n.id, n); ancestry.push({ id: n.id, parent: n.parentId ?? null, date: n.dateAdded ?? null }); visit(n.children ?? []);
    } }; visit(tree);
    const excluded = new Set<string>();
    for (const m of mounts) {
      if (m.aiDestination === 'allowed') continue;
      const n = nodes.get(m.root.nativeId);
      if (m.root.deviceId !== device || !m.root.dateAdded || n?.dateAdded !== m.root.dateAdded) throw new Error('destination_policy_needs_rebind');
      excluded.add(m.root.nativeId);
    }
    const digest = sourceDigest({ mounts: [...mounts].sort((a, b) => a.id.localeCompare(b.id)), ancestry: ancestry.sort((a, b) => a.id.localeCompare(b.id)) });
    return { digest, excluded, constrained: excluded.size > 0, nodes, unrestricted: false };
  }
  return {
    snapshot,
    async assertCurrent(expected: string) { if ((await snapshot()).digest !== expected) throw new Error('destination_policy_changed'); },
    async assertAllowed(id: string, expected?: string) {
      const s = await snapshot(); if (expected && s.digest !== expected) throw new Error('destination_policy_changed');
      if (s.unrestricted) return s.digest; // Existing native write/mapping guards still apply at each caller.
      const seen = new Set<string>(); let current: string | undefined = id;
      while (current) {
        if (seen.has(current) || !s.nodes.has(current)) throw new Error('destination_policy_unresolved'); seen.add(current);
        if (s.excluded.has(current)) throw new Error('destination_policy_excluded');
        current = s.nodes.get(current)!.parentId;
      }
      return s.digest;
    },
    async assertCloudSupported() { if ((await snapshot()).constrained) throw new Error('cloud_destination_policy_unsupported'); },
  };
}
