/**
 * pallet-emissions lifecycle checks against a live node (#183).
 *
 *   SCALAR_WS=ws://127.0.0.1:9955 npm test
 *
 * These run on a real-constants chain (EraDuration = 3600 blocks), so a full settle cannot
 * be reached in a test run; what CAN be asserted here is that the guards hold on the real
 * runtime and that rejected calls leave no ledger trace. The settle/claim arithmetic is
 * covered exhaustively by the Rust suite (pallets/emissions/src/tests.rs). Point SCALAR_WS at
 * a compressed-timing node to extend these to a full era.
 *
 * Every assertion reads storage or events. A call's success or failure is only ever the
 * trigger, never the evidence.
 */
import type { ApiPromise } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { big, connect, freshAccount, keyring, send } from "./helpers";

let api: ApiPromise;
let funder: KeyringPair;
let keeper: KeyringPair;

beforeAll(async () => {
  api = await connect();
  // Other lab sessions share this node and hammer //Alice's nonce, so fund from a
  // different dev account (override with SCALAR_FUNDER) and do the work from fresh ones.
  funder = (await keyring()).addFromUri(process.env.SCALAR_FUNDER ?? "//Charlie");
  keeper = await freshAccount("keeper");
  const fund = await send(
    api,
    api.tx.balances.transferKeepAlive(keeper.address, 10n ** 13n),
    funder,
  );
  expect(fund.error).toBeNull();
});
afterAll(async () => {
  await api?.disconnect();
});

async function accumulator(): Promise<bigint> {
  return big(await api.query.emissions.accRewardPerStake());
}
async function lastSettledEra(): Promise<string> {
  return (await api.query.emissions.lastSettledEra()).toString();
}
async function issuance(): Promise<bigint> {
  return big(await api.query.balances.totalIssuance());
}

describe("emissions constants on the live runtime", () => {
  it("keeps the hard supply cap at 100B CMN and the velocity bonus at or below +30%", () => {
    const cmn = 10n ** 12n;
    expect(big(api.consts.emissions.supplyCap)).toBe(100_000_000_000n * cmn);
    expect(Number(big(api.consts.emissions.velocityBonusBps))).toBeLessThanOrEqual(3000);
  });

  it("keeps the MinQualifyingVol floor gate at or above 50 CMN of era volume", () => {
    const cmn = 10n ** 12n;
    expect(big(api.consts.emissions.minQualifyingVol)).toBeGreaterThanOrEqual(50n * cmn);
  });
});

describe("settle_era guards on the live runtime", () => {
  it("rejects a premature settle with EraNotDue and writes nothing", async () => {
    const era = await lastSettledEra();
    const acc = await accumulator();
    const supply = await issuance();
    const eraStart = (await api.query.emissions.eraStartBlock()).toString();
    const number = (await api.query.agents.eraNumber()).toString();

    const out = await send(api, api.tx.emissions.settleEra(), keeper);

    // Only assert the guard if the era genuinely is not due on this node.
    const head = (await api.rpc.chain.getHeader()).number.toBigInt();
    const due = BigInt(eraStart) + big(api.consts.emissions.eraDuration);
    if (head < due) {
      expect(out.error).toBe("emissions.EraNotDue");
      expect(out.events).not.toContain("emissions.EraSettled");
      expect(await lastSettledEra()).toBe(era);
      expect(await accumulator()).toBe(acc);
      expect((await api.query.emissions.eraStartBlock()).toString()).toBe(eraStart);
      expect((await api.query.agents.eraNumber()).toString()).toBe(number);
      // Issuance only ever falls here (the fee is burned/redistributed); it never rises.
      expect(await issuance()).toBeLessThanOrEqual(supply);
    } else {
      // Due: settle_era is permissionless, so a plain signed account must succeed.
      expect(out.error).toBeNull();
      expect(out.events).toContain("emissions.EraSettled");
    }
  });
});

describe("claim on the live runtime", () => {
  it("rejects an unregistered account with NotRegistered and mints nothing", async () => {
    const stranger = await freshAccount("stranger");
    const fund = await send(
      api,
      api.tx.balances.transferKeepAlive(stranger.address, 10n ** 13n),
      funder,
    );
    expect(fund.error).toBeNull();
    const supply = await issuance();

    const out = await send(api, api.tx.emissions.claim(), stranger);

    expect(out.error).toBe("emissions.NotRegistered");
    expect(out.events).not.toContain("emissions.RewardClaimed");
    expect(await issuance()).toBeLessThanOrEqual(supply);
  });

  it("a freshly registered agent with no settled work has nothing to claim", async () => {
    const agent = await freshAccount("agent");
    const stake = big(api.consts.agents.minStake);
    const fee = big(api.consts.agents.baseRegistrationFee);
    const fund = await send(
      api,
      api.tx.balances.transferKeepAlive(agent.address, stake + fee * 4n + 10n ** 13n),
      funder,
    );
    expect(fund.error).toBeNull();
    const reg = await send(api, api.tx.agents.register(stake), agent);
    expect(reg.error).toBeNull();

    // Registration seeds reward debt at the current accumulator: no back-pay for eras
    // settled before the agent existed.
    const debt = big(await api.query.emissions.agentRewardDebt(agent.address));
    expect(debt).toBe(await accumulator());
    expect(big(await api.query.emissions.agentWeightSnapshot(agent.address))).toBe(0n);

    const out = await send(api, api.tx.emissions.claim(), agent);

    expect(out.error).toBe("emissions.NothingToClaim");
    expect(out.events).not.toContain("emissions.RewardClaimed");
    expect(big(await api.query.emissions.agentRewardDebt(agent.address))).toBe(debt);
  });
});
