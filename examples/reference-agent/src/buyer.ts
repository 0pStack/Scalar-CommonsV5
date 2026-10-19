#!/usr/bin/env node
/**
 * scalar-buyer — the other side of the trade, for testing an agent end to end.
 *
 *   scalar-buyer register                               register + heartbeat (both sides must be agents)
 *   scalar-buyer hire <provider> <cmn> [blocks] [cap]   escrow.createAgreement; prints the seq
 *   scalar-buyer wait <provider> <seq> [maxBlocks]      wait until the provider records delivery
 *   scalar-buyer confirm <provider> <seq>               escrow.confirmDelivery; releases the funds
 *
 * Same environment as the daemon: SCALAR_WS, SCALAR_SEED_FILE, AGENT_STAKE_CMN.
 * `hire` commits to blake2_256 of BRIEF (env, default "reference-agent test job").
 */
import { blake2AsHex } from '@polkadot/util-crypto';
import { loadConfig, parseCmn } from './config.js';
import { ScalarAgentAdapter, loadSigner } from './adapter.js';
import { log } from './log.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig(process.env);
  const chain = await ScalarAgentAdapter.connect(cfg.wsUrl, await loadSigner(cfg.seedFile), cfg.explorerBase);
  const agreement = async (provider: string, seq: number) =>
    (await chain.allAgreements()).find((a) => a.buyer === chain.address && a.provider === provider && a.seq === seq);

  try {
    if (cmd === 'register') {
      if (!(await chain.isRegistered())) log('info', 'extrinsic register', { ...(await chain.register(cfg.stakePlancks)) });
      log('info', 'extrinsic heartbeat', { ...(await chain.heartbeat()) });
    } else if (cmd === 'hire') {
      const [provider, cmn, within = '200', cap] = args;
      if (!provider || !cmn) throw new Error('usage: hire <provider> <cmn> [blocks] [capability]');
      const amount = parseCmn('amount', cmn);
      const brief = process.env.BRIEF ?? 'reference-agent test job';
      const deliverableHash = blake2AsHex(brief, 256);
      const deliverBy = (await chain.head()) + Number(within);
      const seqQuery = chain.api.query.escrow!.nextSeq!;
      const seq = Number((await seqQuery(chain.address, provider)).toString());
      const tx = await chain.hire(provider, amount, deliverableHash, deliverBy, cap === undefined ? null : Number(cap));
      log('info', 'extrinsic createAgreement', { ...tx, provider, seq, amount, deliverableHash, deliverBy, brief });
    } else if (cmd === 'wait') {
      const [provider, seqS, maxS = '300'] = args;
      if (!provider || seqS === undefined) throw new Error('usage: wait <provider> <seq> [maxBlocks]');
      const seq = Number(seqS);
      const until = (await chain.head()) + Number(maxS);
      for (;;) {
        const a = await agreement(provider, seq);
        const head = await chain.head();
        if (a?.status === 'Delivered') {
          log('info', 'delivered', { provider, seq, deliveryProof: a.deliveryProof, atHead: head });
          break;
        }
        if (head > until) throw new Error(`not delivered by #${until} (status ${a?.status ?? 'missing'})`);
        await new Promise((r) => setTimeout(r, 6000));
      }
    } else if (cmd === 'confirm') {
      const [provider, seqS] = args;
      if (!provider || seqS === undefined) throw new Error('usage: confirm <provider> <seq>');
      const a = await agreement(provider, Number(seqS));
      if (!a) throw new Error(`no agreement ${chain.address}/${provider}/${seqS}`);
      if (a.status !== 'Delivered') throw new Error(`agreement is ${a.status}, not Delivered — confirming would fail and still pay a fee`);
      log('info', 'extrinsic confirmDelivery', { ...(await chain.confirm(a)), provider, seq: a.seq, deliveryProof: a.deliveryProof });
    } else {
      throw new Error('commands: register | hire | wait | confirm');
    }
  } finally {
    await chain.disconnect();
  }
}

main().catch((e: unknown) => {
  log('error', 'fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
