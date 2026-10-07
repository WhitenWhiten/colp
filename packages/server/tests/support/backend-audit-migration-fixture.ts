import { cp, copyFile, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Actual parent migration trees differ only in this archived shared helper and their head names. */
export async function backendAuditMigrationFixture(parent: 'audit' | 'main') {
  const root = await mkdtemp(join(tmpdir(), 'known-parent-migrations-'));
  const directory = join(root, 'migrations');
  await cp(resolve('migrations'), directory, { recursive: true });
  await symlink(resolve('src'), join(root, 'src'), 'dir');
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const last = parent === 'audit' ? '202610100700_classification_credits' : '202610101100_classification_credit_financial_locks';
  for (const name of await readdir(directory)) {
    if (name.endsWith('.ts') && name.slice(0, -3) > last) await rm(join(directory, name));
  }
  if (parent === 'audit') {
    await copyFile(resolve('tests/fixtures/backend-audit-20260919/classification-credits-schema.ts.txt'),
      join(directory, 'lib/classification-credits-schema.ts'));
    await copyFile(resolve('migrations/202610101200_digest_owner_membership_guard.ts'),
      join(directory, '202610100900_digest_owner_membership_guard.ts'));
  }
  return { directory, close: () => rm(root, { recursive: true, force: true }) };
}
