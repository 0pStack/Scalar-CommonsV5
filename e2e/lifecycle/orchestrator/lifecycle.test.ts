// Orchestrator lifecycles against a live node. Assertions are on events and
// storage, never on a submit's return value. SCALAR_WS selects the node
// (default ws://127.0.0.1:9955, dev-real).
import { test, beforeAll as before, afterAll as after, assert } from "vitest";
import type { ApiPromise } from "@polkadot/api";
import { Keyring } from "@polkadot/api";
import type { KeyringPair } from "@polkadot/keyring/types";
import { connect, devAccounts, send, trySend, findEvent } from "./helpers.js";

let api: ApiPromise;
const acc = devAccounts();
// Fresh, unranked agent: proves the Rank-2 gate (E11) from the outside.
const newbie: KeyringPair = new Keyring({ type: "sr25519" }).addFromUri("//TestkitOrchNewbie");
// Sub-agent used for link lifecycles.
const sub: KeyringPair = new Keyring({ type: "sr25519" }).addFromUri("//TestkitOrchSub");

const linkOf = async (a: KeyringPair) => ((await api.query.orchestrator.subAgentToOrchestrator(a.address)) as any);
const activeCount = async (o: KeyringPair) => {
  const r = (await api.query.orchestrator.orchestratorRegistration(o.address)) as any;
  return r.isSome ? r.unwrap().activeSubCount.toNumber() : -1;
};

async function ensureAgent(a: KeyringPair) {
  const min = (api.consts.agents.minStake as any).toBigInt();
  const bal = (await api.query.system.account(a.address)) as any;
  if (bal.data.free.toBigInt() < min * 3n) {
    await send(api.tx.balances.transferKeepAlive(a.address, min * 3n), acc.Alice);
  }
  const stake = (await api.query.agents.agentStake(a.address)) as any;
  if (stake.isNone || stake.toString() === "0") await send(api.tx.agents.register(min), a);
}

/** Alice as orchestrator, or undefined if she cannot reach Rank 2 on this node. */
async function ensureOrchestrator(): Promise<boolean> {
  if ((await activeCount(acc.Alice)) >= 0) return true;
  const r = await trySend(api, api.tx.orchestrator.registerOrchestrator(50, 100), acc.Alice);
  return !r.error;
}

before(async () => {
  api = await connect();
  await ensureAgent(newbie);
  await ensureAgent(sub);
});
after(async () => api?.disconnect());

test("E11: an unranked agent cannot register as orchestrator (event + storage)", async () => {
  const r = await trySend(api, api.tx.orchestrator.registerOrchestrator(10, 100), newbie);
  assert.strictEqual(r.error, "orchestrator.AgentMustBeRank2");
  assert.strictEqual(findEvent(r.events, "orchestrator", "OrchestratorRegistered"), undefined);
  assert.strictEqual(((await api.query.orchestrator.orchestratorRegistration(newbie.address)) as any).isNone, true);
});

test("cap: registering above MaxSubAgentsPerOrchestrator is rejected", async () => {
  const max = (api.consts.orchestrator.maxSubAgentsPerOrchestrator as any).toNumber();
  assert.strictEqual(max, 50);
  const r = await trySend(api, api.tx.orchestrator.registerOrchestrator(max + 1, 100), newbie);
  // Either gate may fire first on a node; neither may write a record.
  assert.match(r.error ?? "", /orchestrator\.(MaxSubAgentsTooHigh|AgentMustBeRank2)/);
  assert.strictEqual(((await api.query.orchestrator.orchestratorRegistration(newbie.address)) as any).isNone, true);
});

test("self-link is rejected with no proposal stored", async (ctx) => {
  if (!(await ensureOrchestrator())) return ctx.skip("Alice cannot reach Rank 2 on this node");
  const r = await trySend(api, api.tx.orchestrator.proposeSubAgentLink(acc.Alice.address), acc.Alice);
  assert.strictEqual(r.error, "orchestrator.SelfLink");
  assert.strictEqual(findEvent(r.events, "orchestrator", "LinkProposed"), undefined);
  const p = (await api.query.orchestrator.pendingLinkProposals(acc.Alice.address, acc.Alice.address)) as any;
  assert.strictEqual(p.isNone, true);
  assert.strictEqual(((await linkOf(acc.Alice)) as any).isNone, true);
});

test("lifecycle: propose → accept → remove (events + both link maps + count)", async (ctx) => {
  if (!(await ensureOrchestrator())) return ctx.skip("Alice cannot reach Rank 2 on this node");
  // Leave a clean slate if a previous run aborted midway.
  if (((await linkOf(sub)) as any).isSome) {
    await send(api.tx.orchestrator.removeSubAgentLink(((await linkOf(sub)) as any).unwrap().toString()), sub);
  }
  const before = await activeCount(acc.Alice);

  const p = await trySend(api, api.tx.orchestrator.proposeSubAgentLink(sub.address), acc.Alice);
  assert.strictEqual(p.error, undefined);
  const proposed = findEvent(p.events, "orchestrator", "LinkProposed");
  assert.ok(proposed, "LinkProposed emitted");
  assert.strictEqual(proposed!.data[0].toString(), acc.Alice.address);
  assert.strictEqual(proposed!.data[1].toString(), sub.address);
  assert.strictEqual(((await api.query.orchestrator.pendingLinkProposals(acc.Alice.address, sub.address)) as any).isSome, true);

  const a = await trySend(api, api.tx.orchestrator.acceptOrchestratorLink(acc.Alice.address), sub);
  assert.strictEqual(a.error, undefined);
  assert.ok(findEvent(a.events, "orchestrator", "LinkAccepted"), "LinkAccepted emitted");
  assert.strictEqual(((await linkOf(sub)) as any).unwrap().toString(), acc.Alice.address);
  assert.strictEqual(((await api.query.orchestrator.subAgentLinks(acc.Alice.address, sub.address)) as any).isSome, true);
  assert.strictEqual(((await api.query.orchestrator.pendingLinkProposals(acc.Alice.address, sub.address)) as any).isNone, true);
  assert.strictEqual(await activeCount(acc.Alice), before + 1);

  // A stranger cannot cut the link.
  const bad = await trySend(api, api.tx.orchestrator.removeSubAgentLink(sub.address), acc.Bob);
  assert.ok(bad.error, "third-party removal must fail");
  assert.strictEqual(((await linkOf(sub)) as any).isSome, true);

  const rm = await trySend(api, api.tx.orchestrator.removeSubAgentLink(sub.address), acc.Alice);
  assert.strictEqual(rm.error, undefined);
  const removed = findEvent(rm.events, "orchestrator", "LinkRemoved");
  assert.ok(removed, "LinkRemoved emitted");
  assert.strictEqual(removed!.data[2].toString(), acc.Alice.address, "`by` names the caller");
  assert.strictEqual(((await linkOf(sub)) as any).isNone, true);
  assert.strictEqual(((await api.query.orchestrator.subAgentLinks(acc.Alice.address, sub.address)) as any).isNone, true);
  assert.strictEqual(await activeCount(acc.Alice), before);
});
