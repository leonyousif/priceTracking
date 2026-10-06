import fs from 'node:fs';
import path from 'node:path';

/** Resolve existing ancestors too, so a missing child cannot escape through a symlink. */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const canonical = fs.existsSync(resolved)
    ? fs.realpathSync.native(resolved)
    : path.join(canonicalPath(path.dirname(resolved)), path.basename(resolved));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Cleanup may remove descendants, never the ownership root itself or a sibling. */
export function assertOwnedPath(root: string, target: string): void {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the owned root: ${target}`);
  }
}
