/**
 * The explorer's read-only view of a live node.
 *
 * Every shape on these pages is decoded against the runtime metadata the node
 * serves at connect time: call arguments come from `method.meta.args`, event
 * fields from `event.meta.fields`, failures from `registry.findMetaError`. None
 * of it is hand-written, because a hand-written shape is a lie the moment the
 * runtime upgrades — and this chain upgrades its economic pallets deliberately.
 *
 * The client is read-only by construction: it exposes no signing key and no
 * `tx` surface at all. An explorer that could submit is an explorer that can be
 * abused.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { Codec } from '@polkadot/types-codec/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { SS58_PREFIX } from '@scalar-commons/sdk';

import { BLOCK_CACHE_SIZE, createBlockCache } from './cache.js';
import { type DecodedExtrinsic, decodeExtrinsics, resolveBlock, toBigInt } from './decode.js';
import type { BlockRef } from './routes.js';
import type {
  AccountView,
  BlockView,
  ChainInfo,
  ExtrinsicSummary,
  ExtrinsicView,
  HomeView,
} from './types.js';

export { BlockNotFoundError } from './decode.js';

/** Asked for an extrinsic index the block does not contain. */
export class ExtrinsicNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtrinsicNotFoundError';
  }
}

/** The address in the URL is not SS58 at all. */
export class InvalidAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAddressError';
  }
}

export interface ConnectOptions {
  readonly rpcEndpoint: string;
  /** How long to wait for the first connection before giving up. */
  readonly connectTimeoutMs?: number;
}

export interface ExplorerChain {
  chainInfo(): ChainInfo;
  home(): Promise<HomeView>;
  block(ref: BlockRef): Promise<BlockView>;
  extrinsic(ref: BlockRef, index: number): Promise<ExtrinsicView>;
  account(address: string): Promise<AccountView>;
  /**
   * Field name → metadata type name for one event of the connected runtime, or
   * null when the runtime has no such event. Read from metadata already in
   * memory: it costs the node nothing.
   */
  eventFieldTypes(section: string, method: string): ReadonlyMap<string, string> | null;
  disconnect(): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Pulls a required item out of the runtime metadata.
 *
 * polkadot-js types every pallet lookup as possibly-undefined, because what a
 * runtime exposes is only known once its metadata is read. Resolving through
 * this guard turns "the connected runtime does not have what the explorer needs"
 * into one specific error instead of a `TypeError` half a page into rendering.
 */
function fromMetadata<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

/**
 * Reads a named field out of a decoded struct.
 *
 * Structs decode to `Map`s, so fields are looked up by the name the metadata
 * gave them rather than by a shape written here. A runtime that renames a field
 * therefore produces a loud, specific failure instead of a silently blank page.
 */
function structField(value: Codec, name: string, context: string): Codec {
  const fields = value as unknown as Map<string, Codec>;
  const field = fields instanceof Map ? fields.get(name) : undefined;
  if (field === undefined) {
    throw new Error(`${context}: decoded value has no "${name}" field`);
  }
  return field;
}

interface DecodedBlock {
  readonly number: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly stateRoot: string;
  readonly extrinsicsRoot: string;
  readonly timestampMs: bigint | null;
  readonly extrinsics: readonly DecodedExtrinsic[];
}

/**
 * Connects to a node and returns the explorer's reader.
 *
 * Rejects loudly when the endpoint is unreachable. An explorer that starts
 * anyway would serve pages that look like chain state and are not — which is
 * worse than serving nothing, because a visitor cannot tell the difference.
 */
export async function connectExplorerChain(options: ConnectOptions): Promise<ExplorerChain> {
  const provider = new WsProvider(options.rpcEndpoint);
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let api: ApiPromise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    api = await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    throw new Error(
      `cannot reach the node at ${options.rpcEndpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  const ss58Format = api.registry.chainSS58 ?? SS58_PREFIX;

  const info: ChainInfo = {
    chain: (await api.rpc.system.chain()).toString(),
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    tokenSymbol: api.registry.chainTokens[0] ?? 'UNIT',
    tokenDecimals: api.registry.chainDecimals[0] ?? 12,
    ss58Format,
    genesisHash: api.genesisHash.toHex(),
  };

  /** Normalises any accepted address form to this chain's SS58 format. */
  function normalizeAddress(address: string): string {
    try {
      return encodeAddress(decodeAddress(address), ss58Format);
    } catch (error) {
      throw new InvalidAddressError(
        `not a valid SS58 account address: ${address} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /** Decodes one block: header, timestamp, and every extrinsic with its events and outcome. */
  async function decodeBlock(hash: string): Promise<DecodedBlock> {
    const [signedBlock, apiAt] = await Promise.all([api.rpc.chain.getBlock(hash), api.at(hash)]);
    const systemEvents = fromMetadata(
      apiAt.query.system?.events,
      `runtime at block ${hash} exposes no system.events storage`,
    );
    const records = (await systemEvents()) as unknown as EventRecord[];
    const timestampMs = apiAt.query.timestamp?.now
      ? toBigInt(await apiAt.query.timestamp.now())
      : null;

    const extrinsics = decodeExtrinsics(
      api.registry,
      signedBlock.block.extrinsics,
      records,
      ss58Format,
    );

    return {
      number: signedBlock.block.header.number.toNumber(),
      hash: signedBlock.block.header.hash.toHex(),
      parentHash: signedBlock.block.header.parentHash.toHex(),
      stateRoot: signedBlock.block.header.stateRoot.toHex(),
      extrinsicsRoot: signedBlock.block.header.extrinsicsRoot.toHex(),
      timestampMs,
      extrinsics,
    };
  }

  // Both are read by hash, and what a hash names never changes, so they are
  // cached by it. See cache.ts for why numbers are never keys.
  const decodedBlocks = createBlockCache<DecodedBlock>(BLOCK_CACHE_SIZE);
  const specVersions = createBlockCache<number>(BLOCK_CACHE_SIZE);

  function cachedBlock(hash: string): Promise<DecodedBlock> {
    return decodedBlocks.get(hash, () => decodeBlock(hash));
  }

  function cachedSpecVersion(hash: string): Promise<number> {
    return specVersions.get(hash, async () =>
      (await api.rpc.state.getRuntimeVersion(hash)).specVersion.toNumber(),
    );
  }

  function summarize(decoded: DecodedExtrinsic): ExtrinsicSummary {
    return {
      index: decoded.index,
      section: decoded.section,
      method: decoded.method,
      hash: decoded.hash,
      isSigned: decoded.isSigned,
      signer: decoded.signer,
      outcome: decoded.outcome,
    };
  }

  return {
    chainInfo(): ChainInfo {
      return info;
    },

    async home(): Promise<HomeView> {
      // One header read, and no block bodies: the index page is chrome that
      // names the chain and points at its head, so it must not cost the node
      // more than the cheapest question there is to ask it.
      const header = await api.rpc.chain.getHeader();
      return {
        chain: info,
        head: { number: header.number.toNumber(), hash: header.hash.toHex() },
      };
    },

    async block(ref: BlockRef): Promise<BlockView> {
      const { hash } = await resolveBlock(api.rpc.chain, ref);
      const [decoded, specVersion] = await Promise.all([
        cachedBlock(hash),
        cachedSpecVersion(hash),
      ]);
      return {
        number: decoded.number,
        hash: decoded.hash,
        parentHash: decoded.parentHash,
        stateRoot: decoded.stateRoot,
        extrinsicsRoot: decoded.extrinsicsRoot,
        timestampMs: decoded.timestampMs,
        specVersion,
        extrinsics: decoded.extrinsics.map(summarize),
      };
    },

    async extrinsic(ref: BlockRef, index: number): Promise<ExtrinsicView> {
      const { hash } = await resolveBlock(api.rpc.chain, ref);
      const decoded = await cachedBlock(hash);
      const extrinsic = decoded.extrinsics[index];
      if (extrinsic === undefined) {
        throw new ExtrinsicNotFoundError(
          `block ${decoded.number} has no extrinsic at index ${index} (it has ${decoded.extrinsics.length})`,
        );
      }
      return {
        block: { number: decoded.number, hash: decoded.hash },
        index: extrinsic.index,
        hash: extrinsic.hash,
        section: extrinsic.section,
        method: extrinsic.method,
        isSigned: extrinsic.isSigned,
        signer: extrinsic.signer,
        nonce: extrinsic.nonce,
        tip: extrinsic.tip,
        lengthBytes: extrinsic.lengthBytes,
        args: extrinsic.args,
        events: extrinsic.events,
        outcome: extrinsic.outcome,
        accounts: extrinsic.accounts,
      };
    },

    async account(address: string): Promise<AccountView> {
      const publicKey = (() => {
        try {
          return decodeAddress(address);
        } catch (error) {
          throw new InvalidAddressError(
            `not a valid SS58 account address: ${address} (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
      })();
      const normalized = normalizeAddress(address);

      const header = await api.rpc.chain.getHeader();
      const headNumber = header.number.toNumber();
      const headHash = header.hash.toHex();

      const apiAt = await api.at(headHash);
      const systemAccount = fromMetadata(
        apiAt.query.system?.account,
        'runtime exposes no system.account storage',
      );
      const account = await systemAccount(normalized);
      const balances = structField(account, 'data', 'system.account');
      const balance = (name: string): bigint =>
        toBigInt(structField(balances, name, 'system.account.data')) ?? 0n;

      return {
        address: normalized,
        publicKey: u8aToHex(publicKey),
        free: balance('free'),
        reserved: balance('reserved'),
        frozen: balance('frozen'),
        nonce: Number(toBigInt(structField(account, 'nonce', 'system.account')) ?? 0n),
        at: { number: headNumber, hash: headHash },
      };
    },

    eventFieldTypes(section: string, method: string): ReadonlyMap<string, string> | null {
      const events = api.events as unknown as Record<
        string,
        Record<string, { meta: EventRecord['event']['meta'] } | undefined> | undefined
      >;
      const event = events[section]?.[method];
      if (event === undefined) {
        return null;
      }
      const types = new Map<string, string>();
      for (const field of event.meta.fields) {
        if (field.name.isNone) continue;
        // The declared type name (`BalanceOf<T>`, `T::AccountId`) when the
        // metadata carries one, else the resolved type from the registry.
        const typeName = field.typeName.isSome
          ? field.typeName.unwrap().toString()
          : api.registry.lookup.getTypeDef(field.type).type;
        types.set(field.name.unwrap().toString(), typeName);
      }
      return types;
    },

    async disconnect(): Promise<void> {
      await api.disconnect();
    },
  };
}
