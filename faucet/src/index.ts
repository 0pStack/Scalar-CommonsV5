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
import { SlidingWindowRateLimiter } from './rateLimiter.js';
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

  const limiter = new SlidingWindowRateLimiter({
    perAddress: config.perAddress,
    perIp: config.perIp,
  });
  const pruneTimer = setInterval(() => limiter.prune(), PRUNE_INTERVAL_MS);
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
