import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { stringToU8a, u8aToHex } from '@polkadot/util';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';

import {
  HttpsTransport,
  MAX_ONCHAIN_PAYLOAD,
  MessageInbox,
  OnChainTransport,
  ScalarCommonsClient,
  createMessage,
  encodeSignedMessage,
  subscribeMessages,
  type InboundFrame,
  type SignedMessage,
} from '../src/index.js';

/**
 * Offline tests for the transport bindings. The chain is a hand-rolled mock of
 * the few polkadot-js surfaces the bindings touch; nothing connects anywhere.
 */

const GENESIS = new Uint8Array(32).fill(0x42);
let alice: KeyringPair;
let bob: KeyringPair;
let carol: KeyringPair;

beforeAll(async () => {
  await cryptoWaitReady();
  const kr = new Keyring({ type: 'sr25519' });
  alice = kr.addFromUri('//Alice');
  bob = kr.addFromUri('//Bob');
  carol = kr.addFromUri('//Charlie');
});

const message = (plaintext = stringToU8a('hello'), over: Record<string, unknown> = {}) =>
  createMessage(alice, {
    to: bob.address,
    kind: 'Offer',
    plaintext,
    nonce: 1n,
    expiresAtBlock: 100,
    genesisHash: GENESIS,
    ...over,
  });

// ─── A mock api with messages.send / agents.setMessagingKey ────────────────

function txApi() {
  const calls: { section: string; method: string; args: unknown[] }[] = [];
  const makeTx =
    (section: string, method: string) =>
    (...args: unknown[]) => {
      calls.push({ section, method, args });
      return {
        signAndSend: (_s: unknown, cb: (r: unknown) => void) => {
          cb({
            status: { isInBlock: true, asInBlock: { toHex: () => '0xblock' }, type: 'InBlock' },
            dispatchError: undefined,
            txHash: { toHex: () => '0xtx' },
          });
          return Promise.resolve(() => {});
        },
      };
    };
  const api = {
    rpc: {
      chain: {
        getHeader: async () => ({ number: { toNumber: () => 10 } }),
        getBlockHash: async (height: number) => ({
          toHex: () => `0x${height.toString(16).padStart(64, '0')}`,
        }),
        getBlock: async () => ({ block: { extrinsics: [] } }),
      },
    },
    tx: {
      messages: { send: makeTx('messages', 'send') },
      agents: {
        setMessagingKey: makeTx('agents', 'setMessagingKey'),
        clearMessagingKey: makeTx('agents', 'clearMessagingKey'),
      },
    },
    query: {
      agents: {
        messagingKey: async (who: string) =>
          who === bob.address
            ? { isSome: true, unwrap: () => ({ toU8a: () => new Uint8Array(32).fill(7) }) }
            : { isSome: false },
      },
    },
    registry: { findMetaError: () => ({ section: 'x', name: 'y', docs: [] }) },
  };
  return { client: new ScalarCommonsClient(api as never, { retryDelayMs: 0 }), calls };
}

describe('ScalarCommonsClient messaging extrinsics', () => {
  it('maps set/clear messaging key and reads the registered key', async () => {
    const { client, calls } = txApi();
    const key = new Uint8Array(32).fill(9);
    await client.setMessagingKey(alice, key);
    await client.clearMessagingKey(alice);
    expect(calls.map((c) => `${c.section}.${c.method}`)).toEqual([
      'agents.setMessagingKey',
      'agents.clearMessagingKey',
    ]);
    expect(calls[0]!.args).toEqual([u8aToHex(key)]);
    expect(u8aToHex((await client.messagingKeyOf(bob.address))!)).toBe(
      u8aToHex(new Uint8Array(32).fill(7)),
    );
    expect(await client.messagingKeyOf(carol.address)).toBeNull();
  });

  it('refuses a messaging key that is not 32 bytes before submitting', async () => {
    const { client, calls } = txApi();
    await expect(client.setMessagingKey(alice, new Uint8Array(31))).rejects.toThrow(/32 bytes/);
    expect(calls).toEqual([]);
  });
});

describe('OnChainTransport', () => {
  it('submits messages.send(to, kind, agreement, payload_hash, SCALE(SignedMessage)) built from the envelope', async () => {
    const { client, calls } = txApi();
    const m = message(stringToU8a('hello'), { agreement: { account: alice.address, seq: 4 } });
    const res = await new OnChainTransport(client, alice).send(m);
    expect(res.txHash).toBe('0xtx');
    expect(calls).toHaveLength(1);
    const [to, kind, agreement, payloadHash, frame] = calls[0]!.args as [
      string,
      string,
      unknown,
      string,
      string,
    ];
    expect(to).toBe(bob.address);
    expect(kind).toBe('Offer');
    expect(agreement).toEqual([alice.address, 4]);
    expect(payloadHash).toBe(u8aToHex(m.envelope.payloadHash));
    expect(frame).toBe(u8aToHex(encodeSignedMessage(m)));
  });

  it('sends Body::None in hash-only mode: envelope + signature + 1 tag byte', async () => {
    const { client, calls } = txApi();
    const m = message(new Uint8Array(5_000));
    await new OnChainTransport(client, alice).send(m, { hashOnly: true });
    expect((calls[0]!.args[4] as string).length).toBe(2 + 2 * (111 + 64 + 1));
    expect(calls[0]!.args[3]).toBe(u8aToHex(m.envelope.payloadHash));
  });

  it('fits exactly 2048 bytes: 1870 plain bytes without an agreement, 1834 with one', async () => {
    const { client, calls } = txApi();
    const t = new OnChainTransport(client, alice);
    const agr = { agreement: { account: bob.address, seq: 3 } };
    // 111|147 envelope + 64 signature + 1 Body tag + 2 compact length bytes.
    expect(encodeSignedMessage(message(new Uint8Array(1870))).length).toBe(MAX_ONCHAIN_PAYLOAD);
    expect(encodeSignedMessage(message(new Uint8Array(1834), agr)).length).toBe(
      MAX_ONCHAIN_PAYLOAD,
    );
    await expect(t.send(message(new Uint8Array(1870)))).resolves.toBeTruthy();
    await expect(t.send(message(new Uint8Array(1834), agr))).resolves.toBeTruthy();
    await expect(t.send(message(new Uint8Array(1871)))).rejects.toThrow(/2048/);
    await expect(t.send(message(new Uint8Array(1835), agr))).rejects.toThrow(/hashOnly/);
    expect(calls).toHaveLength(2);
  });

  it('refuses to sign the extrinsic with an account other than the envelope sender', async () => {
    const { client, calls } = txApi();
    await expect(new OnChainTransport(client, carol).send(message())).rejects.toThrow(/sender/);
    expect(calls).toEqual([]);
  });
});

describe('HttpsTransport', () => {
  it('POSTs the frame as application/octet-stream to the resolved URI', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    const m = message();
    const t = new HttpsTransport(async (to) => `https://agent.example/${to}/inbox`, { fetch });
    await t.send(m);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://agent.example/${bob.address}/inbox`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(u8aToHex(init.body as Uint8Array)).toBe(u8aToHex(encodeSignedMessage(m)));
  });

  it('aborts a peer that does not answer within the configured timeout', async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      new HttpsTransport(() => 'https://agent.example/inbox', { fetch, timeoutMs: 10 }).send(
        message(),
      ),
    ).rejects.toThrow(/timeout|aborted/i);
  });

  it.each([
    'https://localhost/inbox',
    'https://127.2.3.4/inbox',
    'https://10.0.0.1/inbox',
    'https://172.16.0.1/inbox',
    'https://192.168.1.1/inbox',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/inbox',
    'https://[fc00::1]/inbox',
    'https://[fe80::1]/inbox',
  ])('refuses private destination %s before sending', async (uri) => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(new HttpsTransport(() => uri, { fetch }).send(message())).rejects.toThrow(
      /private|local/i,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails loudly on a non-2xx answer', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 409 }));
    await expect(
      new HttpsTransport(() => 'https://a.example/inbox', { fetch }).send(message()),
    ).rejects.toThrow(/409/);
  });

  it('refuses plain http and requires an explicit development override for loopback', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      new HttpsTransport(() => 'http://agent.example/inbox', { fetch }).send(message()),
    ).rejects.toThrow(/https/);
    await expect(
      new HttpsTransport(() => 'http://127.0.0.1:8080/inbox', { fetch }).send(message()),
    ).rejects.toThrow(/private|local/i);
    await expect(
      new HttpsTransport(() => 'http://127.0.0.1:8080/inbox', {
        fetch,
        allowPrivateHosts: true,
      }).send(message()),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ─── subscribeMessages over a mock finalized chain ─────────────────────────

interface MockExtrinsic {
  section: string;
  method: string;
  signer: string;
  /** The signed message the call carries; its envelope supplies the other call args. */
  message?: SignedMessage;
  /** Raw payload override (for junk payloads). */
  payload?: Uint8Array;
}
interface MockBlock {
  extrinsics: MockExtrinsic[];
  /** [extrinsicIndex, section, method, data] */
  events: [number, string, string, unknown[]][];
}

function chainApi(
  blocks: Map<number, MockBlock>,
  failure: { block: number; times: number } | null = null,
) {
  let onHead: ((h: unknown) => void) | undefined;
  let failedReads = 0;
  const hash = (n: number) => ({ toHex: () => `0x${n.toString(16).padStart(64, '0')}`, n });
  const leaf = (v: unknown) => ({ toString: () => String(v), toJSON: () => v });
  // The polkadot-js JSON shapes of send's arguments.
  const argsOf = (x: MockExtrinsic) => {
    const e = x.message?.envelope;
    const payload = x.payload ?? (x.message ? encodeSignedMessage(x.message) : new Uint8Array());
    return [
      leaf(e ? encodeAddress(e.to, 42) : bob.address),
      leaf(e?.kind ?? 'Offer'),
      leaf(e?.agreement ? [encodeAddress(e.agreement.account, 42), e.agreement.seq] : null),
      leaf(e ? u8aToHex(e.payloadHash) : null),
      {
        ...leaf(null),
        toU8a: (bare?: boolean) => (bare ? payload : new Uint8Array([0, ...payload])),
      },
    ];
  };
  const api = {
    rpc: {
      chain: {
        subscribeFinalizedHeads: async (cb: (h: unknown) => void) => {
          onHead = cb;
          return () => {
            onHead = undefined;
          };
        },
        getBlockHash: async (n: number) => hash(n),
        getBlock: async (h: { n: number }) => {
          if (failure && h.n === failure.block && failedReads < failure.times) {
            failedReads += 1;
            throw new Error(`block ${h.n} pruned`);
          }
          return {
            block: {
              extrinsics: (blocks.get(h.n)?.extrinsics ?? []).map((x) => ({
                method: { section: x.section, method: x.method, args: argsOf(x) },
                signer: leaf(x.signer),
              })),
            },
          };
        },
      },
    },
    at: async (h: { n: number }) => ({
      query: {
        system: {
          events: async () =>
            (blocks.get(h.n)?.events ?? []).map(([idx, section, method, data]) => ({
              phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => idx } },
              event: { section, method, data: data.map(leaf) },
            })),
        },
      },
    }),
  };
  const finalize = (n: number) => onHead?.({ number: { toNumber: () => n }, hash: hash(n) });
  return {
    api: api as never,
    finalize,
    failedReads: () => failedReads,
    subscribed: () => onHead !== undefined,
  };
}

const sentEvent = (from: string, to: string, idx: number): [number, string, string, unknown[]] => [
  idx,
  'messages',
  'MessageSent',
  [from, to, 'Offer', null, '0x', 0, 0],
];

const send = (message: SignedMessage, signer = alice.address): MockExtrinsic => ({
  section: 'messages',
  method: 'send',
  signer,
  message,
});

describe('subscribeMessages', () => {
  it('delivers messages addressed to self, in block order, filling finality gaps', async () => {
    const a = message(stringToU8a('a'));
    const b = message(stringToU8a('b'), { nonce: 2n, agreement: { account: bob.address, seq: 1 } });
    const blocks = new Map<number, MockBlock>([
      [
        10,
        {
          extrinsics: [
            { section: 'timestamp', method: 'set', signer: '' },
            send(a),
            send(message(stringToU8a('c'), { to: carol.address })),
          ],
          events: [
            sentEvent(alice.address, bob.address, 1),
            sentEvent(alice.address, carol.address, 2),
          ],
        },
      ],
      [12, { extrinsics: [send(b)], events: [sentEvent(alice.address, bob.address, 0)] }],
    ]);
    const { api, finalize } = chainApi(blocks);
    const got: InboundFrame[] = [];
    const done = new Promise<void>((resolve) => {
      void subscribeMessages(
        api,
        bob.address,
        (f) => {
          got.push(f);
          if (got.length === 2) resolve();
        },
        { fromBlock: 10 },
      );
    });
    await new Promise((r) => setTimeout(r, 0));
    finalize(12); // 10 and 11 were skipped by the finality notification
    await done;
    expect(got.map((g) => g.blockNumber)).toEqual([10, 12]);
    expect(got.map((g) => g.extrinsicIndex)).toEqual([1, 0]);
    expect(u8aToHex(got[0]!.frame)).toBe(u8aToHex(encodeSignedMessage(a)));
    expect(got[0]!.origin).toBe(alice.address);
    expect(got[1]!.call).toEqual({
      origin: alice.address,
      to: bob.address,
      kind: 'Offer',
      agreement: { account: bob.address, seq: 1 },
      payloadHash: b.envelope.payloadHash,
    });
  });

  it('hands MessageInbox everything it needs to verify rule 6 end to end', async () => {
    const m = message(stringToU8a('terms'), { agreement: { account: bob.address, seq: 2 } });
    const { api, finalize } = chainApi(
      new Map([[3, { extrinsics: [send(m)], events: [sentEvent(alice.address, bob.address, 0)] }]]),
    );
    const inbox = new MessageInbox({ self: bob.address, genesisHash: GENESIS });
    const received = new Promise<string>((resolve) => {
      void subscribeMessages(
        api,
        bob.address,
        ({ frame, call, blockNumber }) => {
          resolve(new TextDecoder().decode(inbox.receive(frame, blockNumber, { call }).plaintext));
        },
        { fromBlock: 3 },
      );
    });
    await new Promise((r) => setTimeout(r, 0));
    finalize(3);
    expect(await received).toBe('terms');
  });

  it('ignores an event whose extrinsic is not messages.send from the event sender', async () => {
    const blocks = new Map<number, MockBlock>([
      [
        5,
        {
          extrinsics: [send(message(), carol.address)],
          events: [sentEvent(alice.address, bob.address, 0)],
        },
      ],
    ]);
    const { api, finalize } = chainApi(blocks);
    const handler = vi.fn();
    const onError = vi.fn();
    await subscribeMessages(api, bob.address, handler, { fromBlock: 5, onError });
    finalize(5);
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription alive when the handler throws, and unsubscribes on request', async () => {
    const blocks = new Map<number, MockBlock>([
      [1, { extrinsics: [send(message())], events: [sentEvent(alice.address, bob.address, 0)] }],
    ]);
    const { api, finalize, subscribed } = chainApi(blocks);
    const onError = vi.fn();
    const unsub = await subscribeMessages(
      api,
      bob.address,
      () => {
        throw new Error('handler bug');
      },
      { onError },
    );
    finalize(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'handler bug' }));
    unsub();
    expect(subscribed()).toBe(false);
  });

  it('bounds retries, skips an unreadable block, reports it, and survives a throwing onError', async () => {
    const m = message();
    const blocks = new Map<number, MockBlock>([
      [5, { extrinsics: [], events: [] }],
      [6, { extrinsics: [send(m)], events: [sentEvent(alice.address, bob.address, 0)] }],
    ]);
    const { api, finalize, failedReads } = chainApi(blocks, { block: 5, times: 99 });
    const handler = vi.fn();
    const onError = vi.fn(() => {
      throw new Error('reporter failed');
    });
    await subscribeMessages(api, bob.address, handler, {
      maxBlockRetries: 1,
      onError,
    });

    finalize(5);
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    finalize(6);
    await new Promise((r) => setTimeout(r, 10));

    expect(failedReads()).toBe(2);
    expect(onError).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 6 }));
  });

  it('reports a skipped block through the default logger when onError is omitted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { api, finalize } = chainApi(new Map([[5, { extrinsics: [], events: [] }]]), {
      block: 5,
      times: 99,
    });
    await subscribeMessages(api, bob.address, vi.fn(), { maxBlockRetries: 0 });

    finalize(5);
    await new Promise((r) => setTimeout(r, 10));

    expect(warn).toHaveBeenCalledWith(
      '[scalar-sdk] message subscriber error',
      expect.objectContaining({ error: expect.stringContaining('skipped after 1 failed reads') }),
    );
    warn.mockRestore();
  });
});
