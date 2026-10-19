/**
 * Pure decisions behind the beginner onboarding wrapper (`onboard.ts`,
 * driven by `scripts/run-matty-agent.sh`). Offline and unit-tested.
 *
 * The agent in `main.ts` registers itself on its first pass — it locks the
 * stake and burns the registration fee with no further question. This file
 * decides whether it may be started at all:
 *
 *  - only on a chain that calls itself a testnet;
 *  - only with the one wallet a human approved by address
 *    (`APPROVED_AGENT_ADDRESS`), so a wrong or unknown key never spends;
 *  - never underfunded: an unregistered agent without the full registration
 *    amount would pay a fee for a `register` that is bound to fail, on every
 *    pass. It asks the faucet first instead.
 */

const PLANCKS_PER_CMN = 10n ** 12n;

/** 1 CMN kept back for the fees of the first few calls (register, metadata, heartbeat ≈ 0.0001 CMN each). */
export const FEE_HEADROOM = PLANCKS_PER_CMN;

/** Exact decimal CMN for display. A float misprints balances above 2^53 plancks (≈ 9 007 CMN). */
export function formatCmn(plancks: bigint): string {
  const whole = plancks / PLANCKS_PER_CMN;
  const frac = (plancks % PLANCKS_PER_CMN).toString().padStart(12, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

export interface RegistrationCosts {
  /** Stake `agents.register` locks (the agent's `STAKE_CMN`). */
  stake: bigint;
  /** `agents.baseRegistrationFee`, burned. */
  registrationFee: bigint;
  /** `balances.existentialDeposit`. */
  existentialDeposit: bigint;
}

/** Free balance an unregistered agent needs before it may be started. */
export function registrationNeed(c: RegistrationCosts): bigint {
  return c.stake + c.registrationFee + c.existentialDeposit + FEE_HEADROOM;
}

/** The public network reports `system.chain` = "Scalar Commons Local Testnet". */
export function isTestnet(chain: string): boolean {
  return /testnet/i.test(chain);
}

export type StartAction = 'refuse' | 'faucet' | 'run-and-register' | 'run';

export function planStart(s: {
  chain: string;
  address: string;
  approvedAddress: string;
  registered: boolean;
  free: bigint;
  need: bigint;
}): { action: StartAction; message: string } {
  if (!isTestnet(s.chain)) {
    return { action: 'refuse', message: `connected chain "${s.chain}" is not a testnet; this onboarding runs on the testnet only` };
  }
  if (s.approvedAddress.trim() === '') {
    return {
      action: 'refuse',
      message:
        `no APPROVED_AGENT_ADDRESS secret. Add it with the value ${s.address} to approve this agent ` +
        `to lock its test-CMN stake and pay its registration fee on the testnet`,
    };
  }
  if (s.approvedAddress.trim() !== s.address) {
    return {
      action: 'refuse',
      message:
        `the key in AGENT_MNEMONIC belongs to ${s.address}, which does not match APPROVED_AGENT_ADDRESS ` +
        `(${s.approvedAddress.trim()}). Refusing to use a wallet you did not approve`,
    };
  }
  if (s.registered) return { action: 'run', message: 'agent is registered' };
  if (s.free >= s.need) {
    return { action: 'run-and-register', message: `balance ${formatCmn(s.free)} CMN covers registration; the agent will register itself` };
  }
  return {
    action: 'faucet',
    message: `balance ${formatCmn(s.free)} CMN is below the ${formatCmn(s.need)} CMN registration needs; asking the testnet faucet`,
  };
}

/** Newest line of the agent's JSONL log that carries a transaction hash (optionally at/after `sinceIso`). */
export function latestTx(log: string, sinceIso?: string): { event: string; tx: string; ts: string } | null {
  let found: { event: string; tx: string; ts: string } | null = null;
  for (const line of log.split('\n')) {
    let rec: { ts?: unknown; event?: unknown; tx?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (typeof rec.tx !== 'string' || typeof rec.event !== 'string' || typeof rec.ts !== 'string') continue;
    if (sinceIso !== undefined && rec.ts < sinceIso) continue;
    found = { event: rec.event, tx: rec.tx, ts: rec.ts };
  }
  return found;
}
