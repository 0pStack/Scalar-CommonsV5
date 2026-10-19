import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { AccountInfo, EventRecord } from '@polkadot/types/interfaces';
import { cryptoWaitReady, mnemonicGenerate } from '@polkadot/util-crypto';

import { createIndexerClient } from '../src/activity.js';
import { connectExplorerChain, type ExplorerChain } from '../src/chain.js';
import { createExplorerServer } from '../src/server.js';

/**
 * These tests run against the LIVE devnet RPC. Nothing here is mocked and
 * nothing is skippable: an explorer's entire job is to render what a real node
 * really returns, so a mocked chain would assert nothing about the thing that
 * can actually break — type shapes decoded from runtime metadata.
 *
 * If the node is unreachable the suite FAILS rather than skipping. An
 * unreachable node is a blocking finding, per issue #71.
 */

const RPC_ENDPOINT = process.env.EXPLORER_RPC_ENDPOINT ?? 'ws://127.0.0.1:9944';

/** Genesis-endowed devnet account used only to author one real signed extrinsic. */
const TEST_SEED = process.env.EXPLORER_TEST_SEED ?? '//Eve';

const ONE_CMN = 1_000_000_000_000n;

let api: ApiPromise;
let chain: ExplorerChain;
let server: Server;
let baseUrl: string;
let keyring: Keyring;

/** A real signed extrinsic, on a real block, authored by this suite. */
interface Fixture {
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
  extrinsicHash: string;
  sender: string;
  recipient: string;
}
let transfer: Fixture;

/**
 * Resolves something the connected runtime is expected to expose.
 *
 * What a runtime has is only known from its metadata, so polkadot-js types
 * every pallet lookup as possibly-undefined. Resolving through this turns
 * "the devnet is not the runtime these tests are written against" into one
 * specific failure rather than a `TypeError` inside a callback.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`the connected runtime exposes no ${what}`);
  }
  return value;
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.text() };
}

/** Signs and submits one transfer, then locates it in the block it landed in. */
async function submitTransfer(sender: KeyringPair, recipient: string): Promise<Fixture> {
  const transferKeepAlive = required(api.tx.balances?.transferKeepAlive, 'balances.transferKeepAlive call');
  const tx = transferKeepAlive(recipient, ONE_CMN);
  const blockHash = await new Promise<string>((resolve, reject) => {
    tx.signAndSend(sender, { nonce: -1 }, (result) => {
      if (result.isError) {
        reject(new Error(`transfer submission failed: ${result.status.type}`));
      } else if (result.status.isInBlock) {
        resolve(result.status.asInBlock.toHex());
      }
    }).catch(reject);
  });

  const signedBlock = await api.rpc.chain.getBlock(blockHash);
  const index = signedBlock.block.extrinsics.findIndex((ex) => ex.hash.toHex() === tx.hash.toHex());
  if (index < 0) {
    throw new Error(`submitted extrinsic ${tx.hash.toHex()} is not in block ${blockHash}`);
  }

  return {
    blockNumber: signedBlock.block.header.number.toNumber(),
    blockHash,
    extrinsicIndex: index,
    extrinsicHash: tx.hash.toHex(),
    sender: sender.address,
    recipient,
  };
}

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });

  api = await ApiPromise.create({
    provider: new WsProvider(RPC_ENDPOINT),
    noInitWarn: true,
    throwOnConnect: true,
  });

  chain = await connectExplorerChain({ rpcEndpoint: RPC_ENDPOINT });
  server = createExplorerServer({
    chain,
    // Only /activity reads it; this suite exercises the node-backed views.
    activity: createIndexerClient({ baseUrl: process.env.EXPLORER_INDEXER_URL ?? 'http://127.0.0.1:8080' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  transfer = await submitTransfer(keyring.addFromUri(TEST_SEED), keyring.addFromMnemonic(mnemonicGenerate()).address);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await chain?.disconnect();
  await api?.disconnect();
});

describe('connection', () => {
  it('reports the runtime it is connected to, read from live metadata', async () => {
    const info = chain.chainInfo();
    expect(info.chain).toBe((await api.rpc.system.chain()).toString());
    expect(info.specName).toBe(api.runtimeVersion.specName.toString());
    expect(info.specVersion).toBe(api.runtimeVersion.specVersion.toNumber());
    expect(info.tokenSymbol).toBe(api.registry.chainTokens[0]);
    expect(info.tokenDecimals).toBe(api.registry.chainDecimals[0]);
    expect(info.genesisHash).toBe(api.genesisHash.toHex());
  });

  it('fails loudly when the endpoint is unreachable rather than serving empty pages', async () => {
    await expect(
      connectExplorerChain({ rpcEndpoint: 'ws://127.0.0.1:1', connectTimeoutMs: 5_000 }),
    ).rejects.toThrow(/cannot reach the node/i);
  });
});

describe('home view', () => {
  it('shows the live chain identity and links the head block', async () => {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body).toContain((await api.rpc.system.chain()).toString());
    expect(body).toContain(api.runtimeVersion.specVersion.toString());
    // "head" moves, so the page may already be one block ahead of this read.
    const linked = /href="\/block\/(\d+)"/.exec(body);
    expect(linked).not.toBeNull();
    expect(Number(linked?.[1])).toBeGreaterThanOrEqual(head);
  });
});

describe('block view', () => {
  it('renders the head block with the hash the node reports', async () => {
    const header = await api.rpc.chain.getHeader();
    const headNumber = header.number.toNumber();
    const { status, body } = await get(`/block/${headNumber}`);
    expect(status).toBe(200);
    expect(body).toContain(`<h1>Block ${headNumber}</h1>`);
    expect(body).toContain(header.hash.toHex());
  });

  it('resolves a block by number and by hash to the same block', async () => {
    const byNumber = await get(`/block/${transfer.blockNumber}`);
    const byHash = await get(`/block/${transfer.blockHash}`);
    expect(byNumber.status).toBe(200);
    expect(byHash.status).toBe(200);
    expect(byNumber.body).toContain(transfer.blockHash);
    expect(byHash.body).toContain(`Block ${transfer.blockNumber}`);
  });

  it('lists exactly the extrinsics the node put in the block, each linked', async () => {
    const signedBlock = await api.rpc.chain.getBlock(transfer.blockHash);
    const { body } = await get(`/block/${transfer.blockNumber}`);
    for (const [index, ex] of signedBlock.block.extrinsics.entries()) {
      expect(body).toContain(`href="/extrinsic/${transfer.blockNumber}/${index}"`);
      expect(body).toContain(`${ex.method.section}.${ex.method.method}`);
    }
    expect(body).toContain('balances.transferKeepAlive');
    expect(body).toContain(`href="/block/${signedBlock.block.header.parentHash.toHex()}"`);
  });

  it('404s a block the chain has not produced', async () => {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    const { status, body } = await get(`/block/${head + 10_000_000}`);
    expect(status).toBe(404);
    expect(body).toContain('not found');
  });
});

describe('extrinsic view', () => {
  it('decodes the signed transfer from runtime metadata: signer, args, outcome, events', async () => {
    const { status, body } = await get(`/extrinsic/${transfer.blockNumber}/${transfer.extrinsicIndex}`);
    expect(status).toBe(200);
    expect(body).toContain('balances.transferKeepAlive');
    expect(body).toContain(transfer.extrinsicHash);
    expect(body).toContain(transfer.sender);
    expect(body).toContain(transfer.recipient);
    expect(body).toContain('balances.Transfer');
    expect(body).toContain('success');
    expect(body).toContain(`href="/block/${transfer.blockNumber}"`);
  });

  it('numbers each event by its position in the block, as the node recorded it', async () => {
    const apiAt = await api.at(transfer.blockHash);
    const systemEvents = required(apiAt.query.system?.events, 'system.events storage');
    const records = (await systemEvents()) as unknown as EventRecord[];
    const positions = [...records.entries()]
      .filter(
        ([, record]) =>
          record.phase.isApplyExtrinsic &&
          record.phase.asApplyExtrinsic.toNumber() === transfer.extrinsicIndex,
      )
      .map(([position]) => position);
    expect(positions.length).toBeGreaterThan(0);

    const { body } = await get(`/extrinsic/${transfer.blockNumber}/${transfer.extrinsicIndex}`);
    const shown = [...body.matchAll(/<tr><td>(\d+)<\/td><td>[a-zA-Z]+\.[a-zA-Z]+<\/td>/g)].map((match) =>
      Number(match[1]),
    );
    expect(shown).toEqual(positions);
  });

  it('links the accounts the extrinsic touched — sender and recipient both', async () => {
    const { body } = await get(`/extrinsic/${transfer.blockNumber}/${transfer.extrinsicIndex}`);
    expect(body).toContain(`href="/account/${transfer.sender}"`);
    expect(body).toContain(`href="/account/${transfer.recipient}"`);
  });

  it('renders the timestamp inherent of the same block as unsigned', async () => {
    const signedBlock = await api.rpc.chain.getBlock(transfer.blockHash);
    const inherentIndex = signedBlock.block.extrinsics.findIndex(
      (ex) => !ex.isSigned && ex.method.section === 'timestamp',
    );
    expect(inherentIndex).toBeGreaterThanOrEqual(0);
    const { status, body } = await get(`/extrinsic/${transfer.blockNumber}/${inherentIndex}`);
    expect(status).toBe(200);
    expect(body).toContain('timestamp.set');
    expect(body).toContain('unsigned');
  });

  it('404s an extrinsic index the block does not have', async () => {
    const signedBlock = await api.rpc.chain.getBlock(transfer.blockHash);
    const { status } = await get(
      `/extrinsic/${transfer.blockNumber}/${signedBlock.block.extrinsics.length + 5}`,
    );
    expect(status).toBe(404);
  });
});

describe('account view', () => {
  it('shows balances that match a direct storage read', async () => {
    const { status, body } = await get(`/account/${transfer.recipient}`);
    expect(status).toBe(200);
    const systemAccount = required(api.query.system?.account, 'system.account storage');
    const onChain = (await systemAccount(transfer.recipient)) as unknown as AccountInfo;
    // The recipient was created by this suite's transfer, so its free balance is
    // exactly the drip — a value the page must print, not approximate.
    expect(onChain.data.free.toBigInt()).toBe(ONE_CMN);
    expect(body).toContain('1 CMN');
    expect(body).toContain(transfer.recipient);
  });

  it('400s an address that is not valid SS58', async () => {
    const { status, body } = await get('/account/not-an-address');
    expect(status).toBe(400);
    expect(body).toContain('SS58');
  });
});

describe('http surface', () => {
  it('answers HEAD without a body, so a health check costs nothing to read', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('404s a path that names no view', async () => {
    const { status, body } = await get('/not-a-view');
    expect(status).toBe(404);
    expect(body).toContain('no such page');
  });

  it('400s a malformed URL rather than blaming the node for it', async () => {
    // 502 means "the node did not answer". A lone "%" never reaches the node,
    // and neither does a block number no u32 can hold.
    expect((await get('/block/%')).status).toBe(400);
    expect((await get('/block/9007199254740991')).status).toBe(400);
  });
});
