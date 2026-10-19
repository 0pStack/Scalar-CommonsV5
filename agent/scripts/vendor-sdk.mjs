// Replace the `file:../sdk` symlink in node_modules with a real copy of the built SDK.
// Why: a symlinked SDK resolves its @polkadot imports from ../sdk/node_modules, so two copies
// of @polkadot/util load and polkadot-js warns "multiple versions". The copy resolves them from
// the agent's node_modules instead. Run after `npm ci` and after the SDK is built.
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';

const dest = 'node_modules/@scalar-commons/sdk';
if (!existsSync('../sdk/dist')) throw new Error('../sdk/dist missing: build the SDK first (npm run setup:sdk)');
if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync('../sdk/dist', `${dest}/dist`, { recursive: true });
cpSync('../sdk/package.json', `${dest}/package.json`);
console.log(`vendored ../sdk/dist -> ${dest}`);
