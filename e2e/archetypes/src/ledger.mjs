/**
 * Per-archetype accounting.
 *
 * NET IS MEASURED, NOT INFERRED. Every account an archetype controls is funded
 * from a single known amount, and net is:
 *
 *     net = (free_after + claimable_after) - funded
 *
 * summed across the archetype's accounts. That definition is deliberately
 * blunt: it charges the strategy for every transaction fee, every escrow
 * completion fee, and every planck locked in stake it did not get back, and
 * credits it with every reward actually reachable. There is no model of what
 * the strategy "should" have paid — if the chain took it, the archetype paid
 * it.
 *
 * Stake is counted as a COST while it is still bonded, and that takes explicit
 * work: pallet-agents holds stake with LockableCurrency's set_lock, NOT
 * `reserve`, so `data.free` still contains it and only `data.frozen` reveals
 * it. The caller passes SPENDABLE (free - frozen), never free. An archetype
 * that ends an era with 1 000 CMN locked has not earned it back, and a ledger
 * fed `free` would report ring farming as nearly free — which is exactly what
 * the first version of this runner did.
 *
 * `reserved` — escrow's in-flight agreement amounts — is carried separately and
 * reported, not folded into either side: it is committed but not yet lost.
 */

export function newLedger(name) {
  return { name, accounts: [], fundedPlancks: 0n, extrinsics: 0, failures: [], notes: [] };
}

export function recordFunding(ledger, address, plancks) {
  ledger.accounts.push(address);
  ledger.fundedPlancks += BigInt(plancks);
  return ledger;
}

export function recordExtrinsic(ledger) {
  ledger.extrinsics += 1;
  return ledger;
}

/**
 * A failed extrinsic is DATA, not an error to swallow.
 *
 * A strategy the chain refuses is the chain's guards working, and that is a
 * result worth printing — "wash trading is unprofitable because confirm_delivery
 * was rejected" is a completely different finding from "wash trading is
 * unprofitable because the fees exceeded the reward".
 */
export function recordFailure(ledger, step, message) {
  ledger.failures.push({ step, message });
  return ledger;
}

export function note(ledger, text) {
  ledger.notes.push(text);
  return ledger;
}

/** net = (free + claimable) - funded, over every account of the archetype. */
export function settle(ledger, balances) {
  let spendable = 0n;
  let frozen = 0n;
  let reserved = 0n;
  let claimable = 0n;
  for (const b of balances) {
    spendable += BigInt(b.spendablePlancks);
    frozen += BigInt(b.frozenPlancks ?? 0n);
    reserved += BigInt(b.reservedPlancks ?? 0n);
    claimable += BigInt(b.claimablePlancks ?? 0n);
  }
  return {
    ...ledger,
    spendablePlancks: spendable,
    frozenPlancks: frozen,
    reservedPlancks: reserved,
    claimablePlancks: claimable,
    netPlancks: spendable + claimable - ledger.fundedPlancks,
  };
}
