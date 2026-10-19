/**
 * SS58 address validation.
 *
 * The faucet takes an address from an untrusted HTTP request and hands it to a
 * balance transfer. Validating the SS58 checksum before that point is what keeps
 * a typo from sending devnet CMN to an unowned account that nobody can ever
 * spend from — the checksum exists precisely to catch single-character slips.
 */

import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

/** Raised when a requested address is not a well-formed SS58 address. */
export class InvalidAddressError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidAddressError';
  }
}

/**
 * Validates an SS58 address and re-encodes it in this chain's format.
 *
 * Normalising matters for rate limiting: the same account written with a
 * different SS58 prefix must map to the same key, or the per-address budget can
 * be bypassed just by re-encoding.
 *
 * @throws {InvalidAddressError} if the input is not a string, or fails to decode.
 */
export function normalizeAddress(address: unknown, ss58Format: number): string {
  if (typeof address !== 'string') {
    throw new InvalidAddressError(`address must be a string, got ${address === null ? 'null' : typeof address}`);
  }
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new InvalidAddressError('address must not be empty');
  }
  try {
    // decodeAddress verifies the blake2 checksum and the length.
    return encodeAddress(decodeAddress(trimmed), ss58Format);
  } catch (error) {
    throw new InvalidAddressError(
      `not a valid SS58 address: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
