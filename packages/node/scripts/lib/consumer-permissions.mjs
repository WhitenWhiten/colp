import { constants, open, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// The sandbox runs as uid 65534. npm commonly honors a restrictive host umask
// when it creates the consumer tree. Normalize inside the installer while it
// still owns the new files; an unprivileged host cannot chmod files owned by
// uid 65534. Disposable directories remain writable for host-side deletion;
// runtime/compilation probes still mount the complete tree read-only.
//
// Do not use chmod(path) here. chmod follows a final symlink, and a package
// tree is untrusted input. Opening with O_NOFOLLOW and changing the mode on the
// file descriptor makes a symlink (including one swapped in between readdir
// and chmod) harmless. O_NONBLOCK also prevents a FIFO in a malformed package
// from making this verifier hang. Shared regular files are rejected because a
// hard link can otherwise make chmod mutate an inode outside this tree.
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlocking = constants.O_NONBLOCK ?? 0;
const directory = constants.O_DIRECTORY ?? 0;
const directoryOpenFlags = constants.O_RDONLY | directory | noFollow;
const fileOpenFlags = constants.O_RDONLY | nonBlocking | noFollow;
const ignoredEntryErrors = new Set(['ELOOP', 'ENOENT', 'ENXIO', 'ENOTDIR', 'ENODEV']);
async function normalizeRegularFile(path) {
  let handle;
  try {
    handle = await open(path, fileOpenFlags);
  } catch (error) {
    // Symlinks, sockets and device nodes are not part of a readable package
    // tree. Leave them untouched; the later isolated import will fail closed
    // if a required entry is not usable.
    if (ignoredEntryErrors.has(error?.code)) return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return;
    if (info.nlink !== 1) {
      throw new Error(`Refusing to chmod shared package file: ${path}`);
    }
    if ((info.mode & 0o777) !== 0o644) await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
}

async function normalizeDirectory(handle, path, directoryMode) {
  const info = await handle.stat();
  if ((info.mode & 0o777) !== directoryMode) await handle.chmod(directoryMode);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    let childHandle;
    try {
      // O_DIRECTORY|O_NOFOLLOW means a symlink to a directory is rejected
      // instead of traversed. A path is only used after its parent was opened
      // and verified as a directory; no package-provided link is followed.
      childHandle = await open(child, directoryOpenFlags);
    } catch (error) {
      if (!ignoredEntryErrors.has(error?.code)) throw error;
      await normalizeRegularFile(child);
      continue;
    }
    try {
      await normalizeDirectory(childHandle, child, directoryMode);
    } finally {
      await childHandle.close();
    }
  }
}

export async function makeConsumerTreeReadable(root, options = {}) {
  // Docker's non-root bind mount requires a no-follow directory walk. On a
  // platform without these flags, failing closed is safer than silently
  // falling back to chmod(path), which could follow an untrusted symlink.
  if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) {
    throw new Error('Secure consumer-tree normalization requires O_NOFOLLOW and O_DIRECTORY.');
  }
  let handle;
  try {
    handle = await open(root, directoryOpenFlags);
  } catch (error) {
    throw new Error(`Consumer tree is not a real directory: ${root}`, { cause: error });
  }
  try {
    await normalizeDirectory(handle, root, options.writableDirectories === true ? 0o777 : 0o755);
  } finally {
    await handle.close();
  }
}
