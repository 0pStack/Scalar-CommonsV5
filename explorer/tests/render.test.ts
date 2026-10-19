import { describe, it, expect } from 'vitest';

import { renderAccount, renderBlock, renderError, renderExtrinsic, renderHome } from '../src/render.js';
import type { AccountView, BlockView, ChainInfo, ExtrinsicView, HomeView } from '../src/types.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

const CHAIN: ChainInfo = {
  chain: 'Scalar Commons Local Testnet',
  specName: 'scalar-commons',
  specVersion: 304,
  tokenSymbol: 'CMN',
  tokenDecimals: 12,
  ss58Format: 42,
  genesisHash: `0x${'ff'.repeat(32)}`,
};

const BLOCK: BlockView = {
  number: 42,
  hash: `0x${'aa'.repeat(32)}`,
  parentHash: `0x${'bb'.repeat(32)}`,
  stateRoot: `0x${'cc'.repeat(32)}`,
  extrinsicsRoot: `0x${'dd'.repeat(32)}`,
  timestampMs: 1_787_086_860_000n,
  specVersion: 304,
  extrinsics: [
    {
      index: 0,
      section: 'timestamp',
      method: 'set',
      hash: `0x${'11'.repeat(32)}`,
      isSigned: false,
      signer: null,
      outcome: { kind: 'success' },
    },
    {
      index: 1,
      section: 'balances',
      method: 'transferKeepAlive',
      hash: `0x${'22'.repeat(32)}`,
      isSigned: true,
      signer: ALICE,
      outcome: { kind: 'failed', reason: 'balances.InsufficientBalance' },
    },
  ],
};

describe('renderBlock', () => {
  const html = renderBlock(BLOCK, CHAIN);

  it('states the block identity read off chain', () => {
    expect(html).toContain('42');
    expect(html).toContain(BLOCK.hash);
    expect(html).toContain(BLOCK.stateRoot);
    expect(html).toContain('2026-08-18T21:01:00.000Z');
  });

  it('links every extrinsic in the block, which is how a block reaches its extrinsics', () => {
    expect(html).toContain('href="/extrinsic/42/0"');
    expect(html).toContain('href="/extrinsic/42/1"');
    expect(html).toContain('timestamp.set');
    expect(html).toContain('balances.transferKeepAlive');
  });

  it('links the parent block so history is walkable', () => {
    expect(html).toContain(`href="/block/${BLOCK.parentHash}"`);
  });

  it('links the signer of a signed extrinsic to its account view', () => {
    expect(html).toContain(`href="/account/${ALICE}"`);
  });

  it('shows the dispatch outcome, failure included', () => {
    expect(html).toContain('balances.InsufficientBalance');
  });

  it('says so plainly when a block carries no extrinsics', () => {
    expect(renderBlock({ ...BLOCK, extrinsics: [] }, CHAIN)).toContain('no extrinsics');
  });

  it('never calls a signed extrinsic unsigned when its address is not an AccountId', () => {
    // MultiAddress has Index, Raw and Address20 variants besides Id, and none of
    // them yields an AccountId to link to. The extrinsic is still signed, and
    // saying otherwise would be the page asserting something false about chain
    // data it did read.
    const indexed = renderBlock(
      {
        ...BLOCK,
        extrinsics: [{ ...BLOCK.extrinsics[1]!, isSigned: true, signer: null }],
      },
      CHAIN,
    );
    expect(indexed).not.toContain('unsigned');
    expect(indexed).toContain('signed');
  });
});

const EXTRINSIC: ExtrinsicView = {
  block: { number: 42, hash: `0x${'aa'.repeat(32)}` },
  index: 1,
  hash: `0x${'22'.repeat(32)}`,
  section: 'balances',
  method: 'transferKeepAlive',
  isSigned: true,
  signer: ALICE,
  nonce: 7,
  tip: 0n,
  lengthBytes: 138,
  args: [
    { name: 'dest', type: 'MultiAddress', value: BOB },
    { name: 'value', type: 'Compact<u128>', value: '1000000000000' },
  ],
  events: [
    {
      index: 3,
      section: 'balances',
      method: 'Transfer',
      fields: [
        { name: 'from', value: ALICE },
        { name: 'to', value: BOB },
        { name: 'amount', value: '1000000000000' },
      ],
    },
  ],
  outcome: { kind: 'success' },
  accounts: [ALICE, BOB],
};

describe('renderExtrinsic', () => {
  const html = renderExtrinsic(EXTRINSIC, CHAIN);

  it('names the call and its arguments', () => {
    expect(html).toContain('balances.transferKeepAlive');
    expect(html).toContain('dest');
    expect(html).toContain('1000000000000');
  });

  it('links back to the block that contains it', () => {
    expect(html).toContain('href="/block/42"');
  });

  it('links every account the extrinsic touched — the extrinsic-to-account hop', () => {
    expect(html).toContain(`href="/account/${ALICE}"`);
    expect(html).toContain(`href="/account/${BOB}"`);
  });

  it('lists the events the extrinsic emitted', () => {
    expect(html).toContain('balances.Transfer');
  });

  it('escapes chain-supplied values instead of trusting them', () => {
    const hostile = renderExtrinsic(
      {
        ...EXTRINSIC,
        args: [{ name: 'remark', type: 'Bytes', value: '<img src=x onerror=alert(1)>' }],
      },
      CHAIN,
    );
    expect(hostile).not.toContain('<img src=x');
    expect(hostile).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders an unsigned extrinsic without inventing a signer', () => {
    const inherent = renderExtrinsic(
      { ...EXTRINSIC, isSigned: false, signer: null, nonce: null, tip: null, accounts: [] },
      CHAIN,
    );
    expect(inherent).toContain('unsigned');
    expect(inherent).not.toContain('href="/account/');
  });

  it('never calls a signed extrinsic unsigned when its address is not an AccountId', () => {
    const indexed = renderExtrinsic({ ...EXTRINSIC, isSigned: true, signer: null }, CHAIN);
    expect(indexed).not.toContain('unsigned');
    expect(indexed).toContain('signed');
    expect(indexed).toContain('not an AccountId');
  });
});

const ACCOUNT: AccountView = {
  address: ALICE,
  publicKey: `0x${'ee'.repeat(32)}`,
  free: 1_000_050_000_000_000_000_000n,
  reserved: 0n,
  frozen: 10_000_000_000_000_000n,
  nonce: 7,
  at: { number: 42, hash: `0x${'aa'.repeat(32)}` },
};

describe('renderAccount', () => {
  const html = renderAccount(ACCOUNT, CHAIN);

  it('shows the address and its balances in CMN', () => {
    expect(html).toContain(ALICE);
    expect(html).toContain('1,000,050,000 CMN');
    expect(html).toContain('10,000 CMN');
  });

  it('says which block the state was read at, so a balance is never undated', () => {
    expect(html).toContain('href="/block/42"');
    expect(html).toContain(ACCOUNT.at.hash);
  });
});

describe('renderHome', () => {
  const home: HomeView = {
    chain: CHAIN,
    head: { number: 42, hash: BLOCK.hash },
  };
  const html = renderHome(home);

  it('identifies the chain it is connected to', () => {
    expect(html).toContain('Scalar Commons Local Testnet');
    expect(html).toContain('304');
    expect(html).toContain('CMN');
  });

  it('links the head block, which is the way in to every other view', () => {
    expect(html).toContain('href="/block/42"');
    expect(html).toContain(`href="/block/${BLOCK.hash}"`);
  });
});

describe('renderError', () => {
  it('renders the status and reason and escapes the reason', () => {
    const html = renderError(404, 'block 99 not found <b>', CHAIN);
    expect(html).toContain('404');
    expect(html).toContain('block 99 not found &lt;b&gt;');
    expect(html).not.toContain('<b>');
  });
});
