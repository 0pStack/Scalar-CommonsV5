/**
 * Explorer entry point.
 *
 * Connects to a node first and only then starts listening: a process that
 * accepted requests before it had a chain behind it would answer them with
 * plausible-looking empty pages, which is the one failure an explorer must not
 * have.
 */

import { createIndexerClient } from './activity.js';
import { connectExplorerChain } from './chain.js';
import { readIntEnv } from './config.js';
import { createExplorerServer } from './server.js';

const rpcEndpoint = process.env.EXPLORER_RPC_ENDPOINT ?? 'ws://127.0.0.1:9944';
// Port 0 is meaningful (ask the OS for any free port), so the range starts there.
//
// 8081, not 8080. 8080 is the INDEXER's default port, and the activity page now
// fetches from the indexer — so with both defaults in force the explorer asked
// itself for `/v1/activity`, got its own 404, and reported 502 on every load.
// The deployed units never hit it because `deploy/products` assigns 8081
// explicitly, which is exactly what makes a default like that survive: it is
// only ever wrong for someone running it the documented way, from the README.
const port = readIntEnv('EXPLORER_PORT', process.env.EXPLORER_PORT, 8081, 0, 65_535);
const host = process.env.EXPLORER_HOST ?? '127.0.0.1';
// The agent-activity page reads history from the indexer. Only that page
// depends on it: every other view still reads the node alone.
const indexerUrl = process.env.EXPLORER_INDEXER_URL ?? 'http://127.0.0.1:8080';
if (!/^https?:\/\//.test(indexerUrl)) {
  throw new Error(`EXPLORER_INDEXER_URL must be an http:// or https:// URL, not ${JSON.stringify(indexerUrl)}`);
}

const chain = await connectExplorerChain({ rpcEndpoint });
const info = chain.chainInfo();
const server = createExplorerServer({ chain, activity: createIndexerClient({ baseUrl: indexerUrl }) });

server.listen(port, host, () => {
  console.log(
    `[explorer] serving ${info.chain} (${info.specName} spec ${info.specVersion}) from ${rpcEndpoint} (activity from ${indexerUrl}) on http://${host}:${port}`,
  );
});

/** Closes the socket and the node connection so a restart does not leak a subscription. */
async function shutdown(signal: string): Promise<void> {
  console.log(`[explorer] ${signal} received, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chain.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
