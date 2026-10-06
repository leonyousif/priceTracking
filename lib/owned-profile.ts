import fs from 'node:fs';
import path from 'node:path';
import { assertOwnedPath } from './owned-path';

export function createOwnedProfile(root: string, prefix: string): string {
  if (process.env.TEST_RUN_ROOT) assertOwnedPath(process.env.TEST_RUN_ROOT, root);
  fs.mkdirSync(root, { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, prefix));
  assertOwnedPath(root, profile);
  return profile;
}

/** Removes only the directory created for this run, after browser closure. */
export async function removeOwnedProfile(root: string, profile: string): Promise<void> {
  assertOwnedPath(root, profile);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}
