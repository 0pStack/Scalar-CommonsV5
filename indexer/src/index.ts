/**
 * Indexer entry point.
 *
 * Connect to the node, catch up on finalized blocks, then serve `/v1`. The
 * order matters: the API is only bound after the backfill has completed, so a
 * client that gets a response never gets one from an index that is still
 * visibly missing recent history.
 */

import { cryptoWaitReady } from '@polkadot/util-crypto';

import { createApiServer, ROUTES } from './api.ts';
import { connectChain } from './chain.ts';
import { loadConfig } from './config.ts';
import { ChainIndexer } from './indexer.ts';
import { IndexerStore } from './store.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  // SS58 encode/decode is used on every address the API accepts or emits.
  await cryptoWaitReady();

  const chain = await connectChain(config.rpcUrl);
  console.log(
    `indexer: connected to ${config.rpcUrl} (${chain.api.runtimeVersion.specName} spec ${chain.api.runtimeVersion.specVersion})`,
  );

  const store = IndexerStore.open(config.dbPath);
  const indexer = new ChainIndexer(chain.api, store, { backfillDepth: config.backfillDepth });
  await indexer.start();

  const server = createApiServer({ store, api: chain.api, chain, indexer, config });
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`indexer: serving ${ROUTES.length} v1 endpoints on http://${config.host}:${config.port}`);

  const shutdown = async () => {
    console.log('indexer: shutting down');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await indexer.stop();
    store.close();
    await chain.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  // A dead node or an unusable config must stop the process, not leave an API
  // up that answers from nothing.
  console.error(`indexer: fatal: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
