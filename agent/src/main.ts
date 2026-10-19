import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keyring } from '@polkadot/keyring';
import { u8aToHex } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { ScalarCommonsClient, deriveMessagingKey, type Logger } from '@scalar-commons/sdk';
import { Agent, type AgentState } from './agent.js';
import { SdkChain } from './chain.js';
import { loadConfig } from './config.js';
import type { Emit } from './types.js';

/** SDK diagnostics go to stderr so stdout stays pure JSONL. */
const stderrLogger: Logger = {
  debug: () => {},
  info: (m: string) => console.error(`[sdk] ${m}`),
  warn: (m: string) => console.error(`[sdk] ${m}`),
  error: (m: string) => console.error(`[sdk] ${m}`),
} as unknown as Logger;

function loadState(path: string): AgentState {
  if (!existsSync(path)) return { accepted: [], delivered: [], confirmed: [] };
  return { accepted: [], delivered: [], confirmed: [], ...JSON.parse(readFileSync(path, 'utf8')) };
}

/** Atomic write, so a kill mid-save cannot leave a truncated state file. */
function saveState(path: string, state: AgentState): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  mkdirSync(cfg.stateDir, { recursive: true });
  const logPath = join(cfg.stateDir, 'agent.jsonl');
  const statePath = join(cfg.stateDir, 'state.json');

  const emit: Emit = (event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };

  await cryptoWaitReady();
  const pair = new Keyring({ type: 'sr25519' }).addFromUri(cfg.secret);
  emit('start', { ...cfg.redacted(), address: pair.address });

  const client = await ScalarCommonsClient.connect(cfg.ws, { logger: stderrLogger });
  const chain = new SdkChain(client, pair);
  const state = loadState(statePath);
  // The X25519 messaging key is derived from the same secret: nothing new to
  // back up.
  //
  // Derivation is allowed to FAIL without stopping the agent. `deriveMessagingKey`
  // accepts a mnemonic, a 32-byte hex seed or a dev `//URI`; the keyring that
  // built `pair` two lines above accepts more than that — a short raw string, for
  // instance, which it pads. So an agent whose secret has always worked would
  // otherwise start crashing at launch the moment this feature was added, on
  // every runtime including the ones with no messaging pallet at all.
  //
  // `Agent.ensureMessagingKey` already treats `undefined` as "this agent does not
  // publish a messaging key" and skips, exactly as it skips on a pre-309 runtime.
  // Routing the failure into that existing path keeps the feature optional, which
  // is what it was designed to be.
  let messagingKey: string | undefined;
  try {
    messagingKey = u8aToHex(deriveMessagingKey(cfg.secret).publicKey);
  } catch (err) {
    // Emitted, never swallowed: an agent silently not publishing a key is a
    // support question nobody can answer from the logs.
    emit('messaging-key-unavailable', {
      reason: err instanceof Error ? err.message : String(err),
      effect: 'this agent will not publish a messaging key; everything else runs normally',
    });
  }
  const agent = new Agent(chain, { ...cfg, address: pair.address, messagingKey }, emit, state);

  let stopping = false;
  const stop = (sig: string) => {
    emit('stop', { signal: sig });
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      await agent.tick();
      saveState(statePath, state);
    } catch (err) {
      emit('error', { step: 'tick', message: err instanceof Error ? err.message : String(err) });
    }
    for (let i = 0; i < cfg.pollSeconds * 10 && !stopping; i++) await new Promise((r) => setTimeout(r, 100));
  }
  await client.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
