/**
 * A dispatch error the runtime returned for an extrinsic that *was* included in a block.
 *
 * Economic why: inclusion already charged the fee. The outcome is decided by chain
 * state and the call's arguments, so resubmitting the same call earns the same
 * error and burns another fee (#160). These errors are therefore never retried.
 */
export class DispatchFailure extends Error {
  constructor(
    /** Pallet name, e.g. `escrow` (`system` for non-module errors such as `BadOrigin`). */
    readonly section: string,
    /** Error variant, e.g. `MinDeliveryBlocksNotElapsed`, `BadOrigin`, `InsufficientBalance`. */
    readonly errorName: string,
    docs: string,
  ) {
    super(`${section}.${errorName}${docs ? `: ${docs}` : ''}`);
    this.name = 'DispatchFailure';
  }
}

/**
 * Dispatch errors that are a pure function of chain state and call arguments (#160).
 *
 * Every name here is a guard whose verdict follows from the call's own arguments and a
 * runtime constant, so attempt four fails exactly as attempt one did — three fees later:
 *
 *  - `MinDeliveryBlocksNotElapsed`, `BadOrigin` — the original #160 pair.
 *  - `SpanTooLong` — `deliver_by` beyond `MaxAgreementSpan`. Reachable since E21 (#198)
 *    replaced spec 306's silent clamp with an error; see the release note for #219.
 *  - `DeadlineTooEarly` — `deliver_by` inside `MinDeliveryBlocks`, the same comparison
 *    from the other side.
 *  - `SelfDeal` — buyer equals provider: the signer against an argument, no state at all.
 *  - `AmountTooLow` — `amount` below `MinAgreementAmount`.
 *
 * Deliberately *not* here, though the guards look similar (#225 audit):
 *  - `BuyerNotAgent`, `ProviderNotAgent`, `ProviderLacksCapability`, `NotRegistered` —
 *    a registration or a capability can land while the retry loop is still running.
 *  - `SeqOverflow`, `DeadlinePassed`, `DeadlineWouldExceedMaxSpan` — decided against
 *    stored state (a counter, the head block, an agreement's `created_at`), not constants.
 *  - `StakeTooLow`, `InvalidSlashBps` — each pallet raises these from a second,
 *    state-dependent guard as well, and this match is by name, not by `section`.
 */
const DETERMINISTIC_NAMES = new Set([
  'MinDeliveryBlocksNotElapsed',
  'BadOrigin',
  'SpanTooLong',
  'DeadlineTooEarly',
  'SelfDeal',
  'AmountTooLow',
]);

/**
 * True when retrying `err` cannot change the outcome: a {@link DispatchFailure}
 * whose name is in {@link DETERMINISTIC_NAMES} or starts with `Insufficient`
 * (#160, extended by #225).
 *
 * The list stays deliberately explicit rather than "every dispatch error": other
 * module errors (e.g. `NotRegistered`) can clear between attempts, and classifying
 * one of those would convert a recoverable failure into a hard one — strictly worse
 * than the duplicate fee it saves. A name is admitted only when its guard compares
 * call arguments against a runtime constant, and only for calls this SDK submits.
 * Transport failures and pool statuses (`Dropped`, `Invalid`, `Usurped`) never
 * reached dispatch and stay retryable.
 */
export function isDeterministicFailure(err: unknown): boolean {
  if (!(err instanceof DispatchFailure)) return false;
  return DETERMINISTIC_NAMES.has(err.errorName) || err.errorName.startsWith('Insufficient');
}
