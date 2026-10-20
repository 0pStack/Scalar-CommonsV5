/**
 * Faucet entrypoint: wires config → live node → rate limiter → HTTP server.
 *
 * Startup is fail-fast. If the node is unreachable or the funding account is
 * already below its reserve, the process exits rather than listening — a faucet
 * that accepts requests it cannot honour is worse than one that is plainly down.
 */

import { formatPlancksAsCmn } from './amount.js';
import { connectChain } from './chain.js';
import { configFromEnv } from './config.js';
import { FaucetService } from './faucet.js';
import { JsonFileStore, SlidingWindowRateLimiter } from './rateLimiter.js';
import { createFaucetServer } from './server.js';

/** How often expired rate-limit buckets are reclaimed. */
const PRUNE_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = configFromEnv();
  const chain = await connectChain({
    rpcEndpoint: config.rpcEndpoint,
    faucetSeed: config.faucetSeed,
    ss58Format: config.ss58Format,
  });

  const info = chain.chainInfo();
  const free = await chain.freeBalance(chain.faucetAddress);
  console.log(
    `[faucet] ${info.chain} (${info.specName} spec ${info.specVersion}) via ${config.rpcEndpoint}`,
  );
  console.log(
    `[faucet] funding account ${chain.faucetAddress} holds ${formatPlancksAsCmn(free)} ${info.tokenSymbol}`,
  );
  console.log(
    `[faucet] drip ${formatPlancksAsCmn(config.dripAmountPlancks)} ${info.tokenSymbol}, ` +
      `reserve ${formatPlancksAsCmn(config.reservePlancks)} ${info.tokenSymbol}`,
  );
  if (free < config.reservePlancks) {
    throw new Error(
      `funding account holds ${formatPlancksAsCmn(free)} ${info.tokenSymbol}, below its reserve of ` +
        `${formatPlancksAsCmn(config.reservePlancks)} ${info.tokenSymbol}; top it up before starting`,
    );
  }
  // F11 (#20): a hot wallet only needs the reserve plus one day's budget. Anything
  // more is lost with the key and should sit in cold storage.
  const [hourly, daily] = config.global;
  const hotWalletCeiling = config.reservePlancks + config.dripAmountPlancks * BigInt(daily.maxRequests);
  if (free > hotWalletCeiling) {
    console.warn(
      `[faucet] WARNING funding account holds more than the reserve plus one day's budget ` +
        `(${formatPlancksAsCmn(hotWalletCeiling)} ${info.tokenSymbol}); move the excess to cold storage`,
    );
  }

  // Prove the state file can be read and written before taking requests: a path
  // that cannot be created (permissions, read-only disk) would otherwise only
  // show up as every drip being refused.
  const store = new JsonFileStore(config.stateFile);
  store.save(store.load());
  const limiter = new SlidingWindowRateLimiter({
    perAddress: config.perAddress,
    perIp: config.perIp,
    global: config.global,
    store,
  });
  console.log(
    `[faucet] total budget ${hourly.maxRequests} per hour, ${daily.maxRequests} per day; ` +
      `limits kept in ${config.stateFile}`,
  );
  const pruneTimer = setInterval(() => {
    try {
      limiter.prune();
    } catch (error) {
      console.error(`[faucet] could not prune rate limits: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const faucet = new FaucetService({
    chain,
    limiter,
    dripAmountPlancks: config.dripAmountPlancks,
    reservePlancks: config.reservePlancks,
  });

  const server = createFaucetServer({ faucet, trustProxy: config.trustProxy });
  server.listen(config.port, config.host, () => {
    console.log(`[faucet] listening on http://${config.host}:${config.port}`);
  });

  const shutdown = () => {
    clearInterval(pruneTimer);
    server.close(() => {
      void chain.disconnect().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(`[faucet] startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
