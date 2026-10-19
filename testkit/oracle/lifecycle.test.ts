// Oracle lifecycles against a live node. Assertions are on events and storage,
// never on a submit's return value. Requires the dev accounts to be funded and
// able to register as agents (dev-real). Set SCALAR_WS to point elsewhere.
import { afterAll, beforeAll, expect, test } from "vitest";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import type { ApiPromise } from "@polkadot/api";
import { connect, devAccounts, send, hasEvent, waitBlocks } from "./helpers";

let api: ApiPromise;
let authoring = false;
const acc = devAccounts();
const qid = (tag: string) => u8aToHex(blake2AsU8a(`testkit:${tag}:${Date.now()}`));
const ans = (s: string) => u8aToHex(blake2AsU8a(s));

beforeAll(async () => {
  api = await connect();
  // A node that is up but not authoring blocks (stalled, or on-demand sealing
  // with a wedged pool) cannot run a lifecycle; skip rather than hang.
  const h0 = (await api.rpc.chain.getHeader()).number.toNumber();
  await new Promise((r) => setTimeout(r, 15_000));
  authoring = (await api.rpc.chain.getHeader()).number.toNumber() >= h0 + 2;
  if (!authoring) return;
  const jb = (await api.query.system.account(acc.Juror.address)) as any;
  if (jb.data.free.toBigInt() === 0n) {
    const min = (api.consts.agents.minStake as any).toBigInt();
    await send(api.tx.balances.transferKeepAlive(acc.Juror.address, min * 3n), acc.Alice);
  }
  for (const n of ["Alice", "Bob", "Charlie", "Juror"]) {
    const stake = (await api.query.agents.agentStake(acc[n].address)) as any;
    if (stake.isNone || stake.toString() === "0") {
      const min = (api.consts.agents.minStake as any).toBigInt();
      await send(api.tx.agents.register(min), acc[n]);
    }
  }
}, 120_000);
afterAll(async () => api?.disconnect());

test("E7: majority is paid, dissenter scored zero (events + storage)", async (ctx) => {
  if (!authoring) ctx.skip("node is not authoring blocks");
  const cw = (api.consts.oracle.minChallengeWindow as any).toNumber();
  // Finalise needs deadline + challenge window to elapse. On dev-real that is
  // ~600 blocks (1 h); only run where the window is compressed (dev-fast).
  if (cw > 30) ctx.skip(`MinChallengeWindow=${cw} blocks; run against dev-fast`);
  const id = qid("e7");
  const bounty = (api.consts.oracle.minOracleBounty as any).toBigInt();
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  await send(
    api.tx.oracle.createOracleRequest(id, bounty * 3n, "Factual", 3, 67, head + 6, cw, null),
    acc.Alice,
  );
  const w = ans("yes");
  await send(api.tx.oracle.submitResponse(id, w, 0), acc.Bob);
  await send(api.tx.oracle.submitResponse(id, w, 0), acc.Charlie);
  await send(api.tx.oracle.submitResponse(id, ans("no"), 0), acc.Juror);
  await waitBlocks(api, 6 + cw + 1, acc.Alice);
  const evs = await send(api.tx.oracle.finaliseRequest(id), acc.Alice);
  expect(hasEvent(evs, "oracle", "OracleRequestFinalised")).toBe(true);
  expect((await api.query.oracle.oracleResults(id)).toHex()).toBe(w);
  expect(((await api.query.oracle.oracleRequests(id)) as any).isNone).toBe(true);
  expect((await api.query.oracle.oracleScore(acc.Juror.address, 0)).toString()).toBe("0");
  expect((await api.query.oracle.oracleScore(acc.Bob.address, 0)).toString()).toBe("10000");
}, 300_000);

test("E8: expireRequest returns the bounty and clears the request", async (ctx) => {
  if (!authoring) ctx.skip("node is not authoring blocks");
  const id = qid("e8");
  const bounty = (api.consts.oracle.minOracleBounty as any).toBigInt();
  const cw = (api.consts.oracle.minChallengeWindow as any).toNumber();
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  await send(
    api.tx.oracle.createOracleRequest(id, bounty, "Factual", 3, 67, head + 2, cw, null),
    acc.Juror,
  );
  await waitBlocks(api, 3, acc.Juror);
  const evs = await send(api.tx.oracle.expireRequest(id), acc.Bob);
  expect(hasEvent(evs, "oracle", "OracleRequestExpired")).toBe(true);
  expect(((await api.query.oracle.oracleRequests(id)) as any).isNone).toBe(true);
}, 120_000);

test("E25: over-cap batch is rejected client-side/at decode, chain stays live", async (ctx) => {
  if (!authoring) ctx.skip("node is not authoring blocks");
  const cap = (api.consts.oracle.maxBatchSubmissions as any).toNumber();
  const subs = Array.from({ length: cap + 1 }, (_, i) => [ans(`q${i}`), ans("a"), 0]);
  const before = (await api.rpc.chain.getHeader()).number.toNumber();
  // The bound is a type-level cap: the runtime cannot decode the extrinsic, so the
  // node rejects it at validation (the node logs a validate_transaction trap) and
  // block production is unaffected.
  await expect(send(api.tx.oracle.batchSubmitResponse(subs), acc.Bob)).rejects.toThrow(
    /1002|Invalid Transaction|Could not decode|Unable to decode|validate_transaction|Bad input|Bad Proof|wasm trap|Cannot decode/i,
  );
  await waitBlocks(api, 1, acc.Juror);
  expect((await api.rpc.chain.getHeader()).number.toNumber()).toBeGreaterThan(before);
}, 120_000);
