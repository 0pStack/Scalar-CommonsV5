/**
 * The narrow chain surface the reference agent needs.
 *
 * The agent's decision logic talks to this interface, never to polkadot-js
 * directly, so the whole register → heartbeat → accept → deliver → claim loop
 * is unit-testable without a node. `chain.ts` implements it over the SDK.
 */

/** An escrow agreement as the agent sees it (amounts in plancks). */
export interface AgreementView {
  buyer: string;
  provider: string;
  seq: number;
  amount: bigint;
  deliverableHash: string;
  deliverBy: bigint;
  createdAt: bigint;
  /** `Created` | `Delivered` | `Disputed`, as named by the runtime. */
  status: string;
}

export interface Chain {
  /** Current best block number. */
  head(): Promise<bigint>;
  /** Whether `address` is a registered agent. */
  isRegistered(address: string): Promise<boolean>;
  /** Block of the agent's last heartbeat, or `null` if it never beat. */
  lastHeartbeat(address: string): Promise<bigint | null>;
  /** Whether the runtime exposes `escrow.acceptAgreement` (spec 307+). */
  supportsAccept(): boolean;
  /** Free balance of `address`, in plancks. */
  freeBalance(address: string): Promise<bigint>;
  /** Unclaimed emissions `address` could claim right now, in plancks. */
  pendingEmissions(address: string): Promise<bigint>;
  /** Agreements in which `provider` is the provider. */
  agreementsAsProvider(provider: string): Promise<AgreementView[]>;
  /** Agreements in which `buyer` is the buyer. */
  agreementsAsBuyer(buyer: string): Promise<AgreementView[]>;
  /** Other registered agents (candidates for buyer mode). */
  registeredAgents(): Promise<string[]>;

  register(stake: bigint): Promise<string>;
  /** Name the instance via `agents.updateMetadata`; `null` if the runtime has no such call. */
  setMetadata(name: string): Promise<string | null>;
  heartbeat(): Promise<string>;
  acceptAgreement(buyer: string, seq: number): Promise<string>;
  recordDelivery(buyer: string, seq: number, deliveryHash: string): Promise<string>;
  createAgreement(
    provider: string,
    amount: bigint,
    deliverableHash: string,
    deliverBy: bigint,
  ): Promise<string>;
  confirmDelivery(provider: string, seq: number): Promise<string>;
  claim(): Promise<string>;

  /** Whether the runtime exposes `agents.setMessagingKey` and `messages.send` (spec 308+). */
  supportsMessaging(): boolean;
  /** The X25519 messaging key `address` published (`0x…`), or `null`. */
  messagingKeyOf(address: string): Promise<string | null>;
  /** Publish (or rotate to) `publicKey`, a `0x…` 32-byte X25519 key. */
  setMessagingKey(publicKey: string): Promise<string>;
}

/** One JSONL record: every agent action is one line of this shape. */
export interface LogRecord {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export type Emit = (event: string, fields?: Record<string, unknown>) => void;

export type AgentMode = 'provider' | 'buyer' | 'both';

export interface AgentConfig {
  address: string;
  mode: AgentMode;
  /** Stake locked on registration, in plancks. */
  stake: bigint;
  /** Metadata name; the sprint runbook labels operator instances. */
  name: string;
  /** Heartbeat again once this many blocks have passed since the last one. */
  heartbeatEveryBlocks: bigint;
  /** Blocks after creation before `recordDelivery` is accepted (`MinDeliveryBlocks`). */
  minDeliveryBlocks: bigint;
  /** Buyer mode: if non-empty, only open agreements with these providers. */
  buyerPeers: string[];
  /** Buyer mode: escrow amount per agreement, in plancks. */
  buyerAmount: bigint;
  /** Buyer mode: never hold more than this many unsettled agreements as buyer. */
  buyerMaxOpen: number;
  /** Buyer mode: blocks from now until `deliverBy`. */
  buyerDeliverWithin: bigint;
  /**
   * X25519 messaging public key (`0x…`) derived from the agent secret. When set
   * and the runtime supports messaging, the agent keeps it published on chain.
   */
  messagingKey?: string;
}
