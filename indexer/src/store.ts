/**
 * Persistent index of what the chain has already told us.
 *
 * The chain is the source of truth for *current* state — stakes, agreements,
 * issuance — and those are read live. What the chain cannot answer cheaply is
 * *history*: "which extrinsics did this account sign", "what happened in block
 * N". Answering those by replaying the chain on every request would put the
 * indexer's read load onto the validators, so history is captured once, as
 * blocks finalize, and served from here.
 *
 * SQLite is used through `node:sqlite` so the indexer has no native build step.
 * Every balance-shaped value is stored as TEXT: SQLite's INTEGER is 64-bit and a
 * `u128` planck amount does not fit in it, nor in a JS number.
 */

import { DatabaseSync } from 'node:sqlite';

import type { Page } from './pagination.ts';

/** A finalized block header as indexed. */
export interface BlockRow {
  number: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  /** Milliseconds since epoch, from the block's `timestamp.set` inherent. */
  timestampMs: number | null;
  extrinsicCount: number;
  eventCount: number;
}

/** One extrinsic within a block, with the outcome its events reported. */
export interface ExtrinsicRow {
  /** `<block>-<index>`. */
  id: string;
  blockNumber: number;
  index: number;
  hash: string;
  section: string;
  method: string;
  /** Null for inherents, which carry no signature. */
  signer: string | null;
  nonce: number | null;
  /** Tip in plancks, as a decimal string. */
  tipPlancks: string | null;
  /** Null when the block emitted no success/failure event for this extrinsic. */
  success: boolean | null;
  args: unknown;
}

/**
 * An extrinsic as read back out of the index.
 *
 * `isSigned` is derived from the signature rather than stored: an inherent has
 * no signer, and a stored flag could drift out of step with the signer column
 * and report a block-authored inherent as a user submission.
 */
export interface StoredExtrinsic extends ExtrinsicRow {
  isSigned: boolean;
}

/** One runtime event, linked back to the extrinsic that caused it. */
export interface EventRow {
  /** `<block>-<index>`. */
  id: string;
  blockNumber: number;
  index: number;
  section: string;
  method: string;
  /** `ApplyExtrinsic`, `Initialization` or `Finalization`. */
  phase: string;
  extrinsicId: string | null;
  data: unknown;
  /** Accounts named by the event, used to answer per-address history. */
  accounts: string[];
}

/** Everything ingested from a single block, written as one transaction. */
export interface IndexedBlock {
  block: BlockRow;
  extrinsics: ExtrinsicRow[];
  events: EventRow[];
}

/** An account the indexer has observed, with its activity counters. */
export interface AccountRow {
  address: string;
  firstSeenBlock: number;
  lastSeenBlock: number;
  /** Events naming this account. */
  eventCount: number;
  /** Extrinsics signed by this account. */
  extrinsicCount: number;
}

/** A page of results plus the size of the full result set behind it. */
export interface PageResult<T> {
  total: number;
  items: T[];
}

/** Filters accepted by {@link IndexerStore.listExtrinsics}. */
export interface ExtrinsicQuery extends Page {
  blockNumber?: number;
  signer?: string;
  section?: string;
  method?: string;
  order?: 'asc' | 'desc';
}

/** Filters accepted by {@link IndexerStore.listEvents}. */
export interface EventQuery extends Page {
  blockNumber?: number;
  extrinsicId?: string;
  section?: string;
  method?: string;
  /** Restrict to events naming this account. */
  account?: string;
  order?: 'asc' | 'desc';
}

/**
 * One `(pallet, event)` pair to match, or a whole pallet when `method` is null.
 *
 * Structurally the same as `activity.ts`'s `ActivitySource`, declared here so
 * the store stays free of any knowledge of what the feed means by "activity".
 */
export interface EventMatch {
  readonly section: string;
  readonly method: string | null;
}

/** Filters accepted by {@link IndexerStore.listActivity}. */
export interface ActivityQuery extends Page {
  /** Events to include. An empty list matches nothing. */
  sources: readonly EventMatch[];
  /** Restrict to events naming this account. */
  account?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  number           INTEGER PRIMARY KEY,
  hash             TEXT NOT NULL UNIQUE,
  parent_hash      TEXT NOT NULL,
  state_root       TEXT NOT NULL,
  extrinsics_root  TEXT NOT NULL,
  timestamp_ms     INTEGER,
  extrinsic_count  INTEGER NOT NULL,
  event_count      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS extrinsics (
  id            TEXT PRIMARY KEY,
  block_number  INTEGER NOT NULL,
  idx           INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  section       TEXT NOT NULL,
  method        TEXT NOT NULL,
  signer        TEXT,
  nonce         INTEGER,
  tip_plancks   TEXT,
  success       INTEGER,
  args_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS extrinsics_block ON extrinsics (block_number, idx);
CREATE INDEX IF NOT EXISTS extrinsics_signer ON extrinsics (signer);
CREATE INDEX IF NOT EXISTS extrinsics_call ON extrinsics (section, method);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  block_number  INTEGER NOT NULL,
  idx           INTEGER NOT NULL,
  section       TEXT NOT NULL,
  method        TEXT NOT NULL,
  phase         TEXT NOT NULL,
  extrinsic_id  TEXT,
  data_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_block ON events (block_number, idx);
CREATE INDEX IF NOT EXISTS events_call ON events (section, method);
CREATE INDEX IF NOT EXISTS events_extrinsic ON events (extrinsic_id);

CREATE TABLE IF NOT EXISTS event_accounts (
  event_id  TEXT NOT NULL,
  address   TEXT NOT NULL,
  PRIMARY KEY (event_id, address)
);
CREATE INDEX IF NOT EXISTS event_accounts_address ON event_accounts (address);

CREATE TABLE IF NOT EXISTS accounts (
  address           TEXT PRIMARY KEY,
  first_seen_block  INTEGER NOT NULL,
  last_seen_block   INTEGER NOT NULL
);
`;

/** Reads a column that SQLite may hand back as number or bigint. */
function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asBlock(row: Record<string, unknown>): BlockRow {
  return {
    number: asNumber(row.number),
    hash: row.hash as string,
    parentHash: row.parent_hash as string,
    stateRoot: row.state_root as string,
    extrinsicsRoot: row.extrinsics_root as string,
    timestampMs: asNullableNumber(row.timestamp_ms),
    extrinsicCount: asNumber(row.extrinsic_count),
    eventCount: asNumber(row.event_count),
  };
}

function asExtrinsic(row: Record<string, unknown>): StoredExtrinsic {
  const success = row.success;
  const signer = (row.signer as string | null) ?? null;
  return {
    isSigned: signer !== null,
    id: row.id as string,
    blockNumber: asNumber(row.block_number),
    index: asNumber(row.idx),
    hash: row.hash as string,
    section: row.section as string,
    method: row.method as string,
    signer,
    nonce: asNullableNumber(row.nonce),
    tipPlancks: (row.tip_plancks as string | null) ?? null,
    success: success === null || success === undefined ? null : asNumber(success) === 1,
    args: JSON.parse(row.args_json as string),
  };
}

/** Matches an all-digits block number; anything else is treated as a hash. */
const BLOCK_NUMBER_RE = /^\d+$/;

export class IndexerStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (and migrates) the index. Pass `:memory:` for an ephemeral index. */
  static open(path: string): IndexerStore {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    return new IndexerStore(db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Writes one block and everything in it, atomically and idempotently.
   *
   * Re-indexing a block is normal, not exceptional: startup backfill and the
   * finalized-head subscription overlap by design, so the same block arrives
   * twice on almost every run. Rows for the block are cleared first so a repeat
   * write replaces rather than accumulates.
   */
  saveBlock(indexed: IndexedBlock): void {
    const { block, extrinsics, events } = indexed;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM event_accounts WHERE event_id IN (SELECT id FROM events WHERE block_number = ?)').run(block.number);
      this.db.prepare('DELETE FROM events WHERE block_number = ?').run(block.number);
      this.db.prepare('DELETE FROM extrinsics WHERE block_number = ?').run(block.number);

      this.db
        .prepare(
          `INSERT INTO blocks (number, hash, parent_hash, state_root, extrinsics_root, timestamp_ms, extrinsic_count, event_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(number) DO UPDATE SET
             hash = excluded.hash,
             parent_hash = excluded.parent_hash,
             state_root = excluded.state_root,
             extrinsics_root = excluded.extrinsics_root,
             timestamp_ms = excluded.timestamp_ms,
             extrinsic_count = excluded.extrinsic_count,
             event_count = excluded.event_count`,
        )
        .run(
          block.number,
          block.hash,
          block.parentHash,
          block.stateRoot,
          block.extrinsicsRoot,
          block.timestampMs,
          block.extrinsicCount,
          block.eventCount,
        );

      const insertExtrinsic = this.db.prepare(
        `INSERT INTO extrinsics (id, block_number, idx, hash, section, method, signer, nonce, tip_plancks, success, args_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const extrinsic of extrinsics) {
        insertExtrinsic.run(
          extrinsic.id,
          extrinsic.blockNumber,
          extrinsic.index,
          extrinsic.hash,
          extrinsic.section,
          extrinsic.method,
          extrinsic.signer,
          extrinsic.nonce,
          extrinsic.tipPlancks,
          extrinsic.success === null ? null : extrinsic.success ? 1 : 0,
          JSON.stringify(extrinsic.args ?? null),
        );
        if (extrinsic.signer !== null) {
          this.touchAccount(extrinsic.signer, extrinsic.blockNumber);
        }
      }

      const insertEvent = this.db.prepare(
        `INSERT INTO events (id, block_number, idx, section, method, phase, extrinsic_id, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertEventAccount = this.db.prepare(
        'INSERT OR IGNORE INTO event_accounts (event_id, address) VALUES (?, ?)',
      );
      for (const event of events) {
        insertEvent.run(
          event.id,
          event.blockNumber,
          event.index,
          event.section,
          event.method,
          event.phase,
          event.extrinsicId,
          JSON.stringify(event.data ?? null),
        );
        for (const address of event.accounts) {
          insertEventAccount.run(event.id, address);
          this.touchAccount(address, event.blockNumber);
        }
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records that an address was active in a block, widening its seen range. */
  private touchAccount(address: string, blockNumber: number): void {
    this.db
      .prepare(
        `INSERT INTO accounts (address, first_seen_block, last_seen_block) VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           first_seen_block = MIN(first_seen_block, excluded.first_seen_block),
           last_seen_block = MAX(last_seen_block, excluded.last_seen_block)`,
      )
      .run(address, blockNumber, blockNumber);
  }

  /** Highest block number held, or null when the index is empty. */
  latestBlockNumber(): number | null {
    const row = this.db.prepare('SELECT MAX(number) AS n FROM blocks').get() as
      | Record<string, unknown>
      | undefined;
    const value = row?.n;
    return value === null || value === undefined ? null : asNumber(value);
  }

  /**
   * Lowest block number held, or null when the index is empty.
   *
   * This is how far back the index can honestly answer. The startup backfill
   * window is not the same figure: the follower keeps accumulating for as long
   * as it runs, so real history reaches further back than the window it began
   * with, and an endpoint that quotes the window understates its own coverage.
   */
  earliestBlockNumber(): number | null {
    const row = this.db.prepare('SELECT MIN(number) AS n FROM blocks').get() as
      | Record<string, unknown>
      | undefined;
    const value = row?.n;
    return value === null || value === undefined ? null : asNumber(value);
  }

  /** Number of blocks held. */
  blockCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM blocks').get() as Record<string, unknown>;
    return asNumber(row.c);
  }

  hasBlock(number: number): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM blocks WHERE number = ?').get(number);
    return row !== undefined;
  }

  /**
   * Block numbers in `[from, to]` that are not indexed.
   *
   * Backfill uses this to close gaps left by a restart, so the API never reports
   * a hole in history as "nothing happened".
   */
  missingBlocks(from: number, to: number): number[] {
    const rows = this.db
      .prepare('SELECT number FROM blocks WHERE number BETWEEN ? AND ?')
      .all(from, to) as Record<string, unknown>[];
    const present = new Set(rows.map((row) => asNumber(row.number)));
    const missing: number[] = [];
    for (let n = from; n <= to; n += 1) {
      if (!present.has(n)) missing.push(n);
    }
    return missing;
  }

  listBlocks(page: Page): PageResult<BlockRow> {
    const total = asNumber(
      (this.db.prepare('SELECT COUNT(*) AS c FROM blocks').get() as Record<string, unknown>).c,
    );
    const rows = this.db
      .prepare('SELECT * FROM blocks ORDER BY number DESC LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as Record<string, unknown>[];
    return { total, items: rows.map(asBlock) };
  }

  /** Looks a block up by decimal number or by `0x`-prefixed hash. */
  getBlock(numberOrHash: string): BlockRow | null {
    const row = BLOCK_NUMBER_RE.test(numberOrHash)
      ? this.db.prepare('SELECT * FROM blocks WHERE number = ?').get(Number(numberOrHash))
      : this.db.prepare('SELECT * FROM blocks WHERE hash = ?').get(numberOrHash.toLowerCase());
    return row === undefined ? null : asBlock(row as Record<string, unknown>);
  }

  listExtrinsics(query: ExtrinsicQuery): PageResult<StoredExtrinsic> {
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (query.blockNumber !== undefined) {
      filters.push('block_number = ?');
      params.push(query.blockNumber);
    }
    if (query.signer !== undefined) {
      filters.push('signer = ?');
      params.push(query.signer);
    }
    if (query.section !== undefined) {
      filters.push('section = ?');
      params.push(query.section);
    }
    if (query.method !== undefined) {
      filters.push('method = ?');
      params.push(query.method);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    const total = asNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS c FROM extrinsics ${where}`).get(...params) as Record<
          string,
          unknown
        >
      ).c,
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM extrinsics ${where} ORDER BY block_number ${direction}, idx ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as Record<string, unknown>[];
    return { total, items: rows.map(asExtrinsic) };
  }

  getExtrinsic(id: string): StoredExtrinsic | null {
    const row = this.db.prepare('SELECT * FROM extrinsics WHERE id = ?').get(id);
    return row === undefined ? null : asExtrinsic(row as Record<string, unknown>);
  }

  listEvents(query: EventQuery): PageResult<EventRow> {
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (query.blockNumber !== undefined) {
      filters.push('e.block_number = ?');
      params.push(query.blockNumber);
    }
    if (query.extrinsicId !== undefined) {
      filters.push('e.extrinsic_id = ?');
      params.push(query.extrinsicId);
    }
    if (query.section !== undefined) {
      filters.push('e.section = ?');
      params.push(query.section);
    }
    if (query.method !== undefined) {
      filters.push('e.method = ?');
      params.push(query.method);
    }
    if (query.account !== undefined) {
      filters.push('EXISTS (SELECT 1 FROM event_accounts ea WHERE ea.event_id = e.id AND ea.address = ?)');
      params.push(query.account);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    const total = asNumber(
      (
        this.db.prepare(`SELECT COUNT(*) AS c FROM events e ${where}`).get(...params) as Record<
          string,
          unknown
        >
      ).c,
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM events e ${where} ORDER BY e.block_number ${direction}, e.idx ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as Record<string, unknown>[];
    return { total, items: rows.map((row) => this.asEvent(row)) };
  }

  /**
   * Events matching any of `sources`, newest first, each with its block's time.
   *
   * The ordering is the one `/v1/events` uses — block, then position in the
   * block's event record — so a feed and an event list over the same window
   * agree about what came first.
   */
  listActivity(query: ActivityQuery): PageResult<EventRow & { timestampMs: number | null }> {
    if (query.sources.length === 0) {
      return { total: 0, items: [] };
    }
    const params: (string | number)[] = [];
    const clauses = query.sources.map((source) => {
      params.push(source.section);
      if (source.method === null) return 'e.section = ?';
      params.push(source.method);
      return '(e.section = ? AND e.method = ?)';
    });
    const filters = [`(${clauses.join(' OR ')})`];
    if (query.account !== undefined) {
      filters.push('EXISTS (SELECT 1 FROM event_accounts ea WHERE ea.event_id = e.id AND ea.address = ?)');
      params.push(query.account);
    }
    const where = `WHERE ${filters.join(' AND ')}`;

    const total = asNumber(
      (this.db.prepare(`SELECT COUNT(*) AS c FROM events e ${where}`).get(...params) as Record<string, unknown>).c,
    );
    const rows = this.db
      .prepare(
        `SELECT e.*, b.timestamp_ms AS block_timestamp_ms FROM events e
         LEFT JOIN blocks b ON b.number = e.block_number
         ${where} ORDER BY e.block_number DESC, e.idx DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset) as Record<string, unknown>[];
    return {
      total,
      items: rows.map((row) => ({ ...this.asEvent(row), timestampMs: asNullableNumber(row.block_timestamp_ms) })),
    };
  }

  getEvent(id: string): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return row === undefined ? null : this.asEvent(row as Record<string, unknown>);
  }

  private asEvent(row: Record<string, unknown>): EventRow {
    const accountRows = this.db
      .prepare('SELECT address FROM event_accounts WHERE event_id = ? ORDER BY address')
      .all(row.id as string) as Record<string, unknown>[];
    return {
      id: row.id as string,
      blockNumber: asNumber(row.block_number),
      index: asNumber(row.idx),
      section: row.section as string,
      method: row.method as string,
      phase: row.phase as string,
      extrinsicId: (row.extrinsic_id as string | null) ?? null,
      data: JSON.parse(row.data_json as string),
      accounts: accountRows.map((accountRow) => accountRow.address as string),
    };
  }

  listAccounts(page: Page): PageResult<AccountRow> {
    const total = asNumber(
      (this.db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as Record<string, unknown>).c,
    );
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY last_seen_block DESC, address ASC LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as Record<string, unknown>[];
    return { total, items: rows.map((row) => this.asAccount(row)) };
  }

  getAccount(address: string): AccountRow | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE address = ?').get(address);
    return row === undefined ? null : this.asAccount(row as Record<string, unknown>);
  }

  /**
   * Activity counters are derived on read rather than incremented on write.
   *
   * That is what keeps them correct across a re-index: a counter bumped per
   * write would double on the second pass over the same block, and a wrong
   * activity count is indistinguishable from real chain activity to a caller.
   */
  private asAccount(row: Record<string, unknown>): AccountRow {
    const address = row.address as string;
    const eventCount = asNumber(
      (
        this.db
          .prepare('SELECT COUNT(*) AS c FROM event_accounts WHERE address = ?')
          .get(address) as Record<string, unknown>
      ).c,
    );
    const extrinsicCount = asNumber(
      (
        this.db.prepare('SELECT COUNT(*) AS c FROM extrinsics WHERE signer = ?').get(address) as Record<
          string,
          unknown
        >
      ).c,
    );
    return {
      address,
      firstSeenBlock: asNumber(row.first_seen_block),
      lastSeenBlock: asNumber(row.last_seen_block),
      eventCount,
      extrinsicCount,
    };
  }
}
