/**
 * Resolve a polkadot-js package from the repository's installed workspaces.
 *
 * Root-level operator scripts are deliberately not an npm package, so Node's
 * ESM resolver cannot find workspace dependencies from `scripts/`. Keep that
 * repository-specific resolution rule here instead of copying it into every
 * operator command.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CANDIDATES = [
  new URL('../package.json', import.meta.url),
  new URL('../../indexer/package.json', import.meta.url),
];

export async function loadPolkadot(packageName) {
  let lastError;
  for (const candidate of CANDIDATES) {
    try {
      const require = createRequire(fileURLToPath(candidate));
      return await import(pathToFileURL(require.resolve(packageName)).href);
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
  throw new Error(
    `cannot resolve ${packageName} from sdk/ or indexer/ node_modules; run npm ci at the repository root${detail}`,
  );
}
