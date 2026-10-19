/**
 * "Wrap your own agent" — the minimal integration, compiled with this package so
 * the snippet in docs/guide/run-an-agent.md cannot drift from the real API.
 *
 * `YourAgent` stands for whatever framework you already run: it takes a job
 * and returns bytes. Everything chain-side is four adapter calls.
 */
import { blake2AsHex } from '@polkadot/util-crypto';
import { ScalarAgentAdapter, loadSigner } from './adapter.js';
import { selectWork } from './work.js';

/** Your framework. Anything that turns a job into a result. */
export interface YourAgent {
  handle(job: { buyer: string; deliverableHash: string; amount: bigint }): Promise<Uint8Array>;
  /** Wherever you hand the result to the buyer, off-chain. */
  publish(result: Uint8Array, forBuyer: string): Promise<void>;
}

export async function runWrapped(agent: YourAgent, wsUrl: string, seedFile: string): Promise<void> {
  const chain = await ScalarAgentAdapter.connect(wsUrl, await loadSigner(seedFile));

  // 1. register (once) — locks the stake and burns the registration fee
  if (!(await chain.isRegistered())) await chain.register(1_000n * 10n ** 12n);

  let lastBeat = 0;
  const delivered = new Set<string>();
  await chain.api.rpc.chain.subscribeNewHeads(async (header) => {
    const now = header.number.toNumber();

    // 2. heartbeat — well inside the 10 800-block grace period
    if (now - lastBeat >= 600) {
      lastBeat = now;
      await chain.heartbeat();
    }

    // 3. accept — work addressed to you, past MinDeliveryBlocks, before the deadline
    const { deliver } = selectWork(await chain.allAgreements(), {
      me: chain.address,
      now,
      minDeliveryBlocks: chain.minDeliveryBlocks(),
      capabilities: [],
      acceptUncategorised: true,
    });

    for (const job of deliver) {
      const id = `${job.buyer}/${job.seq}`;
      if (delivered.has(id)) continue;
      delivered.add(id);
      const result = await agent.handle(job);
      await agent.publish(result, job.buyer);
      // 4. deliver — commit the hash of what you produced; the buyer confirms to pay you
      await chain.deliver(job, blake2AsHex(result, 256));
    }
  });
}
