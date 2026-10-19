/**
 * Operator configuration.
 *
 * Defaults point at the local devnet RPC, because that is the only node this
 * indexer is ever pointed at by hand; every deployment sets `INDEXER_RPC_URL`
 * explicitly. Nothing here has a default that silently fabricates data — the
 * indexer either reaches a node or fails.
 */

/** Raised when the environment cannot be turned into a usable configuration. */
export class ConfigError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ConfigError';
  }
}

export interface IndexerConfig {
  /** WebSocket RPC endpoint of the node to index. */
  readonly rpcUrl: string;
  /** Interface the REST API binds to. */
  readonly host: string;
  /** Port the REST API binds to; 0 lets the OS choose (used by tests). */
  readonly port: number;
  /** SQLite file for the index, or `:memory:` for an ephemeral one. */
  readonly dbPath: string;
  /**
   * How many finalized blocks to backfill at startup.
   *
   * The indexer is a follower, not an archive: it catches up over a bounded
   * window so a restart is cheap, and closes gaps in that window rather than
   * re-reading the chain from genesis.
   */
  readonly backfillDepth: number;
}

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min) {
    throw new ConfigError(`${name} must be at least ${min}, got ${value}`);
  }
  return value;
}

/** Builds the configuration, refusing anything it cannot honour. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const rpcUrl = env.INDEXER_RPC_URL ?? 'ws://127.0.0.1:9944';
  if (!/^wss?:\/\//.test(rpcUrl)) {
    throw new ConfigError(`INDEXER_RPC_URL must be a ws:// or wss:// URL, got "${rpcUrl}"`);
  }

  const port = readInteger(env, 'INDEXER_PORT', 8080, 0);
  if (port > 65_535) {
    throw new ConfigError(`INDEXER_PORT must be a valid port, got ${port}`);
  }

  return {
    rpcUrl,
    host: env.INDEXER_HOST ?? '127.0.0.1',
    port,
    dbPath: env.INDEXER_DB ?? 'indexer.sqlite',
    backfillDepth: readInteger(env, 'INDEXER_BACKFILL_DEPTH', 256, 0),
  };
}
