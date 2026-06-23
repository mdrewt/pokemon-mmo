// Global setup: give the two-window e2e a clean, deterministic world.
//
// Republish the server module to the local SpacetimeDB server with --delete-data, so each run
// starts from `init` (one wandering NPC, zero players). Fails fast with an actionable message if
// the local server isn't running — this is a LOCAL gate and there is no point proceeding without it.

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..'); // playwright runs from frontend/

export default function globalSetup(): void {
  // Verify the local server is reachable (lists databases on the `local` server).
  try {
    execSync('spacetime list -s local', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'SpacetimeDB local server not reachable. Start it first: `spacetime start` ' +
        '(then re-run `npm run test:e2e`).',
    );
  }

  // Fresh world: republish + clear data so player/NPC counts are deterministic.
  execSync('spacetime publish -p server-module -s local monster-tamer-mmo --delete-data --yes', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}
