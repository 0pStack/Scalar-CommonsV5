/**
 * HTTP surface for the faucet.
 *
 * Deliberately built on `node:http` with no framework: the faucet holds a funded
 * key, so every dependency in front of that key is attack surface worth not
 * having.
 *
 * Routes:
 *   - `GET  /`                                        → index; names `/health`
 *   - `POST /drip`            `{ "address": "5..." }` → dispenses one drip
 *   - `GET  /balance/:address`                        → live free balance
 *   - `GET  /health`                                  → chain + faucet state
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { InvalidAddressError } from './address.js';
import type { DripFailureCode, FaucetService } from './faucet.js';

export interface FaucetServerOptions {
  readonly faucet: FaucetService;
  /**
   * Trust `X-Forwarded-For` for the client IP.
   *
   * Off by default, and that default matters: when the faucet is exposed
   * directly, an attacker who can set this header can forge a fresh IP per
   * request and erase the per-IP budget entirely. Enable it **only** behind a
   * reverse proxy that overwrites the header.
   */
  readonly trustProxy?: boolean;
  /** Request body cap in bytes; a funded endpoint should not buffer unbounded input. */
  readonly maxBodyBytes?: number;
}

/** Maps a refusal to the status code that describes it. */
const STATUS_BY_CODE: Record<DripFailureCode, number> = {
  INVALID_ADDRESS: 400,
  RATE_LIMITED: 429,
  INSUFFICIENT_FAUCET_FUNDS: 503,
  TRANSFER_FAILED: 502,
};

const DEFAULT_MAX_BODY_BYTES = 4096;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/** Resolves the requester's IP — the key the per-IP budget is spent against. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    // RIGHT-most entry, not left-most. This is the security-relevant half of
    // the per-IP limit and it used to be wrong.
    //
    // X-Forwarded-For is client-supplied. Whatever the caller sends arrives
    // intact; a trusted proxy only APPENDS the peer it actually saw. So the
    // left-most entry is fully attacker-controlled — with nginx's stock
    // `$proxy_add_x_forwarded_for`, `X-Forwarded-For: 1.2.3.4` becomes
    // "1.2.3.4, <real ip>" and reading the left-most gave the attacker a fresh
    // rate-limit bucket per forged value. Four forged headers all returned 200
    // in testing. TESTNETAUDIT.md §6 I-6, issue #123.
    //
    // The right-most entry is the one OUR proxy appended, so it is the only one
    // a remote caller cannot choose. The faucet vhost additionally overwrites
    // the header with `$remote_addr`, which makes the list one entry long — but
    // this code does not depend on that, because a config change elsewhere must
    // not silently re-open a rate-limit bypass.
    const entries = raw?.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
    const last = entries?.[entries.length - 1];
    if (last) {
      return last;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Raised when the request body is unusable. */
class BadRequestError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBodyBytes) {
      throw new BadRequestError(`request body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError('request body is not valid JSON');
  }
}

/**
 * Builds the faucet HTTP server. The caller owns `listen`/`close` so tests can
 * bind an ephemeral port.
 */
export function createFaucetServer(options: FaucetServerOptions): Server {
  const { faucet } = options;
  const trustProxy = options.trustProxy ?? false;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      sendJson(res, 500, {
        ok: false,
        code: 'INTERNAL_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // The index. `https://faucet.scalarnet.io` is a URL that gets pasted to
    // people, and it used to greet them with a 404 error object because the
    // faucet only knew its three working routes. It reads no chain state and
    // never calls the faucet service: the answer is a pointer, so it must stay
    // 200 while the node is unreachable — which is exactly when someone opens
    // the bare host to check whether the faucet is up.
    if (path === '/' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: 'scalar-commons-faucet',
        health: '/health',
        drip: 'POST /drip',
        balance: '/balance/:address',
      });
      return;
    }

    if (path === '/drip') {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'use POST /drip' }, { allow: 'POST' });
        return;
      }
      await handleDrip(req, res);
      return;
    }

    if (path === '/health' && method === 'GET') {
      const status = await faucet.status();
      sendJson(res, 200, {
        ok: true,
        chain: status.chain,
        specName: status.specName,
        specVersion: status.specVersion,
        tokenSymbol: status.tokenSymbol,
        tokenDecimals: status.tokenDecimals,
        faucetAddress: status.faucetAddress,
        // Planck values cross the wire as strings: JSON numbers are doubles and
        // would round a real balance.
        faucetFreePlancks: status.faucetFreePlancks.toString(),
        dripAmountPlancks: status.dripAmountPlancks.toString(),
        reservePlancks: status.reservePlancks.toString(),
      });
      return;
    }

    if (path.startsWith('/balance/') && method === 'GET') {
      const raw = decodeURIComponent(path.slice('/balance/'.length));
      try {
        const { address, freePlancks } = await faucet.balanceOf(raw);
        sendJson(res, 200, { ok: true, address, freePlancks: freePlancks.toString() });
      } catch (error) {
        if (error instanceof InvalidAddressError) {
          sendJson(res, 400, { ok: false, code: 'INVALID_ADDRESS', error: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `no route for ${method} ${path}` });
  }

  async function handleDrip(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      if (error instanceof BadRequestError) {
        sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: error.message });
        return;
      }
      throw error;
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'body must be a JSON object' });
      return;
    }

    const address = (body as Record<string, unknown>).address;
    const result = await faucet.drip(address, clientIp(req, trustProxy));

    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        address: result.address,
        amountPlancks: result.amountPlancks.toString(),
        blockHash: result.blockHash,
        txHash: result.txHash,
      });
      return;
    }

    const headers: Record<string, string> = {};
    if (result.code === 'RATE_LIMITED' && result.retryAfterMs !== undefined) {
      // Retry-After is in whole seconds, rounded up so a client that obeys it
      // does not come back a moment early and get refused again.
      headers['retry-after'] = String(Math.ceil(result.retryAfterMs / 1000));
    }
    sendJson(
      res,
      STATUS_BY_CODE[result.code],
      {
        ok: false,
        code: result.code,
        error: result.error,
        ...(result.scope === undefined ? {} : { scope: result.scope }),
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      },
      headers,
    );
  }
}
