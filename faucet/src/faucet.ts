/**
 * Faucet service — the drip decision and its guards.
 *
 * Guard order is load-bearing and mirrors the chain-side convention: **every
 * check fires before any funds move.** In order — address validity, rate-limit
 * reservation, then solvency against the reserve floor — and only then is a
 * transfer submitted. A guard that ran after submission would be decoration.
 *
 * Funds come from a pre-funded devnet account. There is no mint path here and
 * there must never be one: minting is the emissions pallet's exclusive job.
 */

import { InvalidAddressError, normalizeAddress } from './address.js';
import { TransferFailedError, type ChainClient } from './chain.js';
import type { RateLimitScope, SlidingWindowRateLimiter } from './rateLimiter.js';

export interface FaucetServiceOptions {
  readonly chain: ChainClient;
  readonly limiter: SlidingWindowRateLimiter;
  /** Amount handed out per successful request, in plancks. */
  readonly dripAmountPlancks: bigint;
  /**
   * Balance the faucet refuses to spend below, in plancks.
   *
   * The last line of drain protection: even if rate limiting is misconfigured,
   * the faucet stops dispensing while it still holds this much, so the account
   * stays alive and the failure is visible instead of silent.
   */
  readonly reservePlancks?: bigint;
}

export type DripFailureCode =
  | 'INVALID_ADDRESS'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_FAUCET_FUNDS'
  | 'TRANSFER_FAILED';

export type DripResult =
  | {
      readonly ok: true;
      readonly address: string;
      readonly amountPlancks: bigint;
      readonly blockHash: string;
      readonly txHash: string;
    }
  | {
      readonly ok: false;
      readonly code: DripFailureCode;
      readonly error: string;
      readonly scope?: RateLimitScope;
      readonly retryAfterMs?: number;
    };

/** Operator-facing snapshot of faucet and chain state. */
export interface FaucetStatus {
  readonly chain: string;
  readonly specName: string;
  readonly specVersion: number;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  readonly faucetAddress: string;
  readonly faucetFreePlancks: bigint;
  readonly dripAmountPlancks: bigint;
  readonly reservePlancks: bigint;
}

export class FaucetService {
  private readonly chain: ChainClient;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly dripAmountPlancks: bigint;
  private readonly reservePlancks: bigint;

  constructor(options: FaucetServiceOptions) {
    if (options.dripAmountPlancks <= 0n) {
      throw new Error(`dripAmountPlancks must be positive, got ${options.dripAmountPlancks}`);
    }
    const existentialDeposit = options.chain.existentialDeposit();
    if (options.dripAmountPlancks < existentialDeposit) {
      // A drip below the existential deposit cannot create a new account, so the
      // transfer would fail for every first-time user of the faucet.
      throw new Error(
        `dripAmountPlancks ${options.dripAmountPlancks} is below the existential deposit ${existentialDeposit}`,
      );
    }
    const reserve = options.reservePlancks ?? 0n;
    if (reserve < 0n) {
      throw new Error(`reservePlancks must be non-negative, got ${reserve}`);
    }
    this.chain = options.chain;
    this.limiter = options.limiter;
    this.dripAmountPlancks = options.dripAmountPlancks;
    this.reservePlancks = reserve;
  }

  /** Free balance of any account, straight from the node. */
  async balanceOf(rawAddress: unknown): Promise<{ address: string; freePlancks: bigint }> {
    const address = normalizeAddress(rawAddress, this.chain.chainInfo().ss58Format);
    return { address, freePlancks: await this.chain.freeBalance(address) };
  }

  async status(): Promise<FaucetStatus> {
    const info = this.chain.chainInfo();
    return {
      chain: info.chain,
      specName: info.specName,
      specVersion: info.specVersion,
      tokenSymbol: info.tokenSymbol,
      tokenDecimals: info.tokenDecimals,
      faucetAddress: this.chain.faucetAddress,
      faucetFreePlancks: await this.chain.freeBalance(this.chain.faucetAddress),
      dripAmountPlancks: this.dripAmountPlancks,
      reservePlancks: this.reservePlancks,
    };
  }

  /**
   * Dispenses one drip to `rawAddress` on behalf of `ip`.
   *
   * Never throws for an expected refusal — those come back as a typed failure so
   * the HTTP layer can map them to a status code.
   */
  async drip(rawAddress: unknown, ip: string): Promise<DripResult> {
    // ─ Guard 1: the address must be real before anything else happens. ─
    let address: string;
    try {
      address = normalizeAddress(rawAddress, this.chain.chainInfo().ss58Format);
    } catch (error) {
      if (error instanceof InvalidAddressError) {
        return { ok: false, code: 'INVALID_ADDRESS', error: error.message };
      }
      throw error;
    }

    // ─ Guard 2: rate limits. Reserved synchronously, so two concurrent
    //   requests cannot both pass the same budget check. ─
    const decision = this.limiter.tryAcquire(address, ip);
    if (!decision.allowed) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        error: `rate limit reached for this ${decision.scope}`,
        ...(decision.scope === undefined ? {} : { scope: decision.scope }),
        ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
      };
    }

    // From here on the slot is held, so every exit path must either complete the
    // drip or hand the slot back.
    try {
      // ─ Guard 3: solvency. The faucet must stay above its reserve and above
      //   the existential deposit after paying out. ─
      const free = await this.chain.freeBalance(this.chain.faucetAddress);
      const floor = this.reservePlancks + this.chain.existentialDeposit();
      if (free < this.dripAmountPlancks || free - this.dripAmountPlancks < floor) {
        this.limiter.release(address, ip);
        return {
          ok: false,
          code: 'INSUFFICIENT_FAUCET_FUNDS',
          error: `faucet balance ${free} cannot fund a drip of ${this.dripAmountPlancks} while holding a reserve of ${this.reservePlancks}`,
        };
      }

      // ─ Guards passed: now funds move. ─
      const receipt = await this.chain.transfer(address, this.dripAmountPlancks);
      return {
        ok: true,
        address,
        amountPlancks: this.dripAmountPlancks,
        blockHash: receipt.blockHash,
        txHash: receipt.txHash,
      };
    } catch (error) {
      // The transfer did not land, so the requester keeps their allowance.
      this.limiter.release(address, ip);
      if (error instanceof TransferFailedError) {
        return { ok: false, code: 'TRANSFER_FAILED', error: error.message };
      }
      return {
        ok: false,
        code: 'TRANSFER_FAILED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
