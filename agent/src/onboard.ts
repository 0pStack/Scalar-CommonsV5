/**
 * Beginner onboarding around the reference agent — driven by
 * `scripts/run-matty-agent.sh`, not meant to be typed by hand.
 *
 *   node dist/onboard.js new-key                       make a key; shows it ONCE so its owner can store it as a secret
 *   node dist/onboard.js check [--for-start] [--dry-run]
 *   node dist/onboard.js status
 *   node dist/onboard.js verify [txHash] [--address <ss58>]
 *   node dist/onboard.js wait-first --since <iso> [--timeout <s>]
 *
 * Configuration is the agent's own (`loadConfig`: AGENT_MNEMONIC, SCALAR_WS,
 * STAKE_CMN, STATE_DIR …) plus APPROVED_AGENT_ADDRESS, SCALAR_INDEXER,
 * SCALAR_FAUCET and EXPLORER_BASE. The key is never printed, except by
 * `new-key`, which refuses to run when a key is already configured.
 *
 * `check --for-start` is the gate in front of `main.ts`: see `planStart` in
 * ./onboard-core.ts for the rules. Its only side effect is at most ONE faucet
 * request, and only for the approved address; `--dry-run` skips even that.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, mnemonicGenerate, mnemonicValidate } from '@polkadot/util-crypto';
import { loadConfig, type Config } from './config.js';
import { formatCmn, latestTx, planStart, registrationNeed } from './onboard-core.js';

const url = (name: string, dflt: string) => (process.env[name]?.trim() || dflt).replace(/\/+$/, '');
const INDEXER = url('SCALAR_INDEXER', 'https://api.scalarnet.io');
const FAUCET = url('SCALAR_FAUCET', 'https://faucet.scalarnet.io');
const EXPLORER = url('EXPLORER_BASE', 'https://explorer.scalarnet.io');

const ok = (m: string) => console.log(`  ✓ ${m}`);
const info = (m: string) => console.log(`    ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Exit extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function address(cfg: Config): Promise<string> {
  await cryptoWaitReady();
  // polkadot-js turns a mistyped phrase into a DIFFERENT, valid-looking wallet
  // instead of failing. Only a checksummed BIP-39 phrase is accepted here.
  if (!mnemonicValidate(cfg.secret)) {
    throw new Exit(1, 'AGENT_MNEMONIC is not a valid 12-word key phrase — check the secret for typos, missing or extra words');
  }
  try {
    return new Keyring({ type: 'sr25519' }).addFromUri(cfg.secret).address;
  } catch {
    // Never echo the underlying message: it could quote the secret.
    throw new Exit(1, 'AGENT_MNEMONIC is not a valid key phrase — check the secret for typos or extra words');
  }
}

async function connect(ws: string): Promise<ApiPromise> {
  const provider = new WsProvider(ws, false);
  const api = new ApiPromise({ provider, noInitWarn: true });
  const timeout = setTimeout(() => void provider.disconnect(), 30_000);
  try {
    await provider.connect();
    await api.isReadyOrError;
    return api;
  } catch {
    throw new Exit(1, `cannot reach the Scalar Commons testnet at ${ws} — check the internet connection and try again`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson(u: string): Promise<{ status: number; body: any }> {
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function chainView(api: ApiPromise, who: string) {
  const q = api.query as any;
  const c = api.consts as any;
  const registered = ((await q.agents.agentStake(who)) as { isSome: boolean }).isSome;
  const free = BigInt((await q.system.account(who)).data.free.toString());
  const lastHb = BigInt((await q.agents.lastHeartbeat(who)).toString());
  return {
    chain: (await api.rpc.system.chain()).toString(),
    spec: api.runtimeVersion.specVersion.toNumber(),
    head: (await api.rpc.chain.getHeader()).number.toNumber(),
    registered,
    free,
    lastHeartbeat: lastHb === 0n ? null : lastHb,
    fee: BigInt(c.agents.baseRegistrationFee.toString()),
    ed: BigInt(c.balances.existentialDeposit.toString()),
  };
}

async function newKey(): Promise<void> {
  if (process.env.AGENT_MNEMONIC?.trim() || process.env.AGENT_URI?.trim()) {
    throw new Exit(1, 'a key is already configured (AGENT_MNEMONIC). Refusing to make another: that would switch your agent to a different wallet');
  }
  await cryptoWaitReady();
  const mnemonic = mnemonicGenerate(12);
  const addr = new Keyring({ type: 'sr25519' }).addFromUri(mnemonic).address;
  console.log(`
  Your new agent key — shown ONCE, stored nowhere. Copy both values into Replit Secrets now:

    Secret name:   AGENT_MNEMONIC
    Secret value:  ${mnemonic}

    Secret name:   APPROVED_AGENT_ADDRESS
    Secret value:  ${addr}

  AGENT_MNEMONIC is the key itself: anyone who has it controls this agent. Never share it,
  never paste it into a file or a chat. APPROVED_AGENT_ADDRESS is public; setting it is your
  approval for THIS agent to lock 1000 test CMN as stake and pay the 50 test CMN registration
  fee on the Scalar Commons testnet. Test CMN has no value.

  Then clear this screen:  clear
`);
}

async function check(cfg: Config, args: string[]): Promise<void> {
  const forStart = args.includes('--for-start');
  const dryRun = args.includes('--dry-run');
  const who = await address(cfg);
  const approved = process.env.APPROVED_AGENT_ADDRESS?.trim() ?? '';

  console.log('Scalar Commons agent check');
  const api = await connect(cfg.ws);
  try {
    let v = await chainView(api, who);
    ok(`connected to ${v.chain} (runtime ${v.spec}, block #${v.head})`);
    ok(`agent address ${who}`);
    if (approved === who) ok('this address is approved (APPROVED_AGENT_ADDRESS)');
    else if (approved === '') bad('APPROVED_AGENT_ADDRESS is not set yet');
    else bad(`APPROVED_AGENT_ADDRESS is ${approved}, not this key's address`);
    info(`balance: ${formatCmn(v.free)} test CMN`);
    info(v.registered ? `registered agent; last heartbeat at block #${v.lastHeartbeat ?? 'never'}` : 'not registered yet');
    const need = registrationNeed({ stake: cfg.stake, registrationFee: v.fee, existentialDeposit: v.ed });
    const plan = planStart({ chain: v.chain, address: who, approvedAddress: approved, registered: v.registered, free: v.free, need });

    if (!forStart) {
      if (!v.registered) {
        info(`registering locks ${formatCmn(cfg.stake)} test CMN and burns ${formatCmn(v.fee)}; needs ${formatCmn(need)} free`);
      }
      info(`start would: ${plan.action === 'faucet' ? 'ask the faucet for test CMN, then register' : plan.action === 'refuse' ? 'refuse' : plan.action === 'run' ? 'run' : 'register, then run'}`);
      if (plan.action === 'refuse') info(plan.message);
      return;
    }

    if (plan.action === 'refuse') throw new Exit(2, plan.message);
    if (plan.action === 'faucet') {
      info(plan.message);
      if (dryRun) {
        info('--dry-run: not contacting the faucet');
        throw new Exit(4, 'dry run stopped before the faucet');
      }
      const res = await fetch(`${FAUCET}/drip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: who }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (res.status === 429) {
        throw new Exit(3, `the faucet says wait: ${body?.error ?? 'rate limited'} (one drip per address and per network address per hour). Run start again later`);
      }
      if (!res.ok) throw new Exit(3, `the faucet answered ${res.status}: ${body?.error ?? body?.code ?? 'unknown error'}`);
      ok('faucet sent test CMN; waiting for it to arrive');
      for (let i = 0; i < 24 && v.free < need; i++) {
        await sleep(5_000);
        v = await chainView(api, who);
      }
      if (v.free < need) throw new Exit(3, `balance is ${formatCmn(v.free)} CMN, still below ${formatCmn(need)}; run start again in a minute`);
      ok(`balance now ${formatCmn(v.free)} test CMN — the agent will register itself`);
      return;
    }
    ok(plan.message);
  } finally {
    await api.disconnect();
  }
}

async function findIndexed(who: string, tx: string, waitSeconds: number) {
  for (let waited = 0; ; waited += 5) {
    const { status, body } = await getJson(`${INDEXER}/v1/accounts/${who}/extrinsics?limit=100`);
    if (status === 200) {
      const hit = (body?.items ?? []).find((x: { hash: string }) => x.hash.toLowerCase() === tx.toLowerCase());
      if (hit) return hit as { id: string; section: string; method: string; success: boolean; blockNumber: number };
    }
    if (waited >= waitSeconds) return null;
    await sleep(5_000);
  }
}

async function verify(cfg: Config, args: string[]): Promise<void> {
  const who = flag(args, '--address') ?? (await address(cfg));
  const logPath = join(cfg.stateDir, 'agent.jsonl');
  let tx = args[0]?.startsWith('0x') ? args[0] : undefined;
  if (tx === undefined && existsSync(logPath)) tx = latestTx(readFileSync(logPath, 'utf8'))?.tx;
  if (tx === undefined) throw new Exit(1, 'no transaction to verify yet: the agent has not sent one. Run start first');

  console.log(`Verifying transaction ${tx}`);
  const hit = await findIndexed(who, tx, 60);
  if (hit === null) throw new Exit(1, 'the public indexer does not show this transaction yet. Wait a minute and run verify again');
  const [block, index] = hit.id.split('-');
  const ev = await getJson(`${INDEXER}/v1/extrinsics/${hit.id}/events`);
  const events = (ev.body?.items ?? []).map((e: { section: string; method: string }) => `${e.section}.${e.method}`);
  (hit.success ? ok : bad)(`${hit.section}.${hit.method} is on chain in block #${block}, ${hit.success ? 'succeeded' : 'FAILED'}`);
  info(`events: ${events.join(', ')}`);
  console.log(`\n  Open this link to see it yourself:\n  ${EXPLORER}/extrinsic/${block}/${index}\n`);
  if (!hit.success) throw new Exit(1, 'the transaction is on chain but failed');
}

async function waitFirst(cfg: Config, args: string[]): Promise<void> {
  const since = flag(args, '--since') ?? new Date().toISOString();
  const timeout = Number(flag(args, '--timeout') ?? '180');
  const logPath = join(cfg.stateDir, 'agent.jsonl');
  console.log('Waiting for the agent\'s first transaction of this run …');
  for (let t = 0; t < timeout; t += 3) {
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const hit = latestTx(log, since);
    if (hit) {
      ok(`agent sent ${hit.event}`);
      return verify(cfg, [hit.tx]);
    }
    await sleep(3_000);
  }
  // Already registered and the next heartbeat is not due yet: nothing new to send.
  const prior = existsSync(logPath) ? latestTx(readFileSync(logPath, 'utf8')) : null;
  info('no new transaction was needed yet (the agent heartbeats about once an hour).');
  if (prior) return verify(cfg, [prior.tx]);
  info('run "scripts/run-matty-agent.sh status" in a few minutes.');
}

async function status(cfg: Config): Promise<void> {
  const who = await address(cfg);
  const api = await connect(cfg.ws);
  try {
    const v = await chainView(api, who);
    console.log('On chain');
    ok(`${v.chain}, block #${v.head}`);
    info(`agent ${who}`);
    info(`balance ${formatCmn(v.free)} test CMN (includes the locked stake)`);
    if (v.registered) {
      ok(`registered; last heartbeat block #${v.lastHeartbeat ?? 'never'}${v.lastHeartbeat ? ` (${v.head - Number(v.lastHeartbeat)} blocks ago)` : ''}`);
    } else bad('not registered yet');
  } finally {
    await api.disconnect();
  }
  const { status: code, body } = await getJson(`${INDEXER}/v1/agents/${who}`);
  if (code === 200) info(`public record: ${INDEXER}/v1/agents/${who} (completed jobs: ${body?.completedAgreements ?? 0})`);

  const logPath = join(cfg.stateDir, 'agent.jsonl');
  if (!existsSync(logPath)) return;
  console.log('\nRecent agent activity');
  for (const line of readFileSync(logPath, 'utf8').trim().split('\n').slice(-6)) {
    try {
      const r = JSON.parse(line) as { ts: string; event: string; step?: string; message?: string; tx?: string };
      const what = r.event === 'error' ? `problem in ${r.step}: ${r.message}` : r.event;
      info(`${r.ts.replace('T', ' ').slice(0, 19)} UTC  ${what}${r.tx ? `  (tx ${r.tx.slice(0, 12)}…)` : ''}`);
    } catch {
      /* a partial last line while the agent is writing */
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'new-key') return newKey();
  // `verify --address` checks any account's transaction and needs no key of its own.
  const env = cmd === 'verify' && flag(args, '--address') && !process.env.AGENT_MNEMONIC
    ? { ...process.env, AGENT_URI: '//unused' }
    : process.env;
  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    throw new Exit(1, e instanceof Error ? e.message : String(e));
  }
  if (cmd === 'check') return check(cfg, args);
  if (cmd === 'status') return status(cfg);
  if (cmd === 'verify') return verify(cfg, args);
  if (cmd === 'wait-first') return waitFirst(cfg, args);
  throw new Exit(2, 'commands: new-key | check [--for-start] [--dry-run] | status | verify [txHash] | wait-first');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    const code = e instanceof Exit ? e.code : 1;
    console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(code);
  },
);
