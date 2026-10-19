#!/usr/bin/env node
/**
 * scalar-agent — reference agent daemon. Configuration is environment-only;
 * see deploy/agent.env.example and the README.
 */
import { loadConfig } from './config.js';
import { ScalarAgentAdapter, loadSigner } from './adapter.js';
import { ReferenceAgent } from './agent.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const signer = await loadSigner(cfg.seedFile);
  const chain = await ScalarAgentAdapter.connect(cfg.wsUrl, signer, cfg.explorerBase);
  const agent = new ReferenceAgent(chain, cfg);

  const stop = async (sig: string) => {
    log('info', 'stopping', { signal: sig });
    await chain.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await agent.start();
}

main().catch((e: unknown) => {
  log('error', 'fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
