//! pallet-messages unit tests
//!
//! Gated by `#[cfg(test)] mod tests;` in `lib.rs` — no inner `#![cfg(test)]`.
//!
//! One test (or one loop) per bound and per fee term, so a regression names the rule it broke.

use crate::pallet::*;
use crate::MAX_PAYLOAD_LEN;
use frame_support::{
    assert_noop, assert_ok,
    dispatch::GetDispatchInfo,
    parameter_types,
    storage::StoragePrefixedMap,
    traits::{ConstU16, ConstU32, ConstU64, Currency},
    BoundedVec,
};
use parity_scale_codec::{Decode, Encode};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System:   frame_system,
        Balances: pallet_balances,
        Agents:   pallet_agents,
        Messages: crate,
    }
);

impl frame_system::Config for Test {
    type BaseCallFilter = frame_support::traits::Everything;
    type BlockWeights = ();
    type BlockLength = ();
    type RuntimeOrigin = RuntimeOrigin;
    type RuntimeCall = RuntimeCall;
    type RuntimeTask = ();
    type Nonce = u64;
    type Hash = H256;
    type Hashing = BlakeTwo256;
    type AccountId = u64;
    type Lookup = IdentityLookup<Self::AccountId>;
    type Block = Block;
    type RuntimeEvent = RuntimeEvent;
    type BlockHashCount = ConstU64<250>;
    // Real Rocks numbers, not `()`: with a zero DbWeight every `reads_writes(..)` in a
    // declaration is free, and the declared-weight floor test below would test nothing.
    type DbWeight = frame_support::weights::constants::RocksDbWeight;
    type Version = ();
    type PalletInfo = PalletInfo;
    type AccountData = pallet_balances::AccountData<u64>;
    type OnNewAccount = ();
    type OnKilledAccount = ();
    type SystemWeightInfo = ();
    type SS58Prefix = ConstU16<42>;
    type OnSetCode = ();
    type MaxConsumers = ConstU32<16>;
    type ExtensionsWeightInfo = ();
    type SingleBlockMigrations = ();
    type MultiBlockMigrator = ();
    type PreInherents = ();
    type PostInherents = ();
    type PostTransactions = ();
}

impl pallet_balances::Config for Test {
    type MaxLocks = ConstU32<50>;
    type MaxReserves = ConstU32<50>;
    type ReserveIdentifier = [u8; 8];
    type Balance = u64;
    type RuntimeEvent = RuntimeEvent;
    type DustRemoval = ();
    type ExistentialDeposit = ConstU64<1>;
    type AccountStore = System;
    type WeightInfo = ();
    type FreezeIdentifier = ();
    type MaxFreezes = ConstU32<0>;
    type RuntimeHoldReason = ();
    type RuntimeFreezeReason = ();
    type DoneSlashHandler = ();
}

pub struct MockGovVoteVerifier;
impl pallet_agents::pallet::GovVoteVerifier<u64> for MockGovVoteVerifier {
    fn has_live_vote_on(_: &u64, _: u32) -> bool {
        true
    }
}

parameter_types! {
    pub const MinStakeX: u64 = 1_000;
    pub const FFStakeX:  u64 = 10_000;
    pub const MaxStakeX: u64 = 1_000_000;
}

impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStakeX;
    type FullFloorStake = FFStakeX;
    type MaxStakePerAgent = MaxStakeX;
    type UnstakeCooldown = ConstU64<100>;
    type BaseRegistrationFee = ConstU64<50>;
    type MaxRegistrationsPerBlock = ConstU32<10>;
    type MaxAgents = ConstU32<100>;
    type Rank3MinCompletions = ConstU32<50>;
    type MinRank3OracleScore = ConstU32<0>;
    type Rank3SpanGate = ConstU64<0>;
    type MaxVolToStakeRatio = ConstU32<0>;
    type HeartbeatGracePeriod = ConstU64<600>;
    type HeartbeatDecayPeriod = ConstU64<14400>;
    type OnAgentRegistered = ();
    type OnAgentSlashed = ();
    type OnStakeChanged = ();
    type AgentCollective = ();
    type OracleScoreGate = ();
    type GovVoteVerifier = MockGovVoteVerifier;
    type IdentityHandler = ();
    type OrchestratorLookup = ();
    type MaxUriLen = ConstU32<128>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<32>;
    type MaxDelegationPeriod = ConstU64<100_800>;
    type SlashAppealWindow = ConstU64<10>;
    type SlashDestination = ();
    type MaxProposalsPerEra = ConstU32<20>;
}

// Same 200:1 base-to-per-byte ratio as the runtime (0.02 CMN : 0.0001 CMN), scaled down to the
// mock's u64 balances so the arithmetic stays readable in assertions.
const BASE_FEE: u64 = 20_000;
const PER_BYTE_FEE: u64 = 100;
const MAX_PER_BLOCK: u32 = 4;

impl crate::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type BaseFee = ConstU64<BASE_FEE>;
    type PerByteFee = ConstU64<PER_BYTE_FEE>;
    type MaxPerBlock = ConstU32<MAX_PER_BLOCK>;
    type WeightInfo = crate::PlaceholderWeights;
}

const ALICE: u64 = 1; // registered agent
const BOB: u64 = 2; // registered agent
const CAROL: u64 = 3; // funded, never registered
const DAVE: u64 = 4; // registered agent with almost no free balance above its stake lock
const ERIN: u64 = 5; // registered agent, second independent sender

const FUNDED: u64 = 10_000_000;
const STAKE: u64 = 1_000;
const REG_FEE: u64 = 50;

fn new_test_ext() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![
            (ALICE, FUNDED),
            (BOB, FUNDED),
            (CAROL, FUNDED),
            // Stake + registration fee + 10 spare: enough to register, never enough to pay
            // BASE_FEE from free balance, because the stake lock covers the rest.
            (DAVE, STAKE + REG_FEE + 10),
            (ERIN, FUNDED),
        ],
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    let mut ext: sp_io::TestExternalities = storage.into();
    ext.execute_with(|| {
        System::set_block_number(1);
        for who in [ALICE, BOB, DAVE, ERIN] {
            assert_ok!(Agents::register(RuntimeOrigin::signed(who), STAKE));
        }
    });
    ext
}

fn payload(len: usize) -> Payload {
    BoundedVec::try_from(vec![0xABu8; len]).expect("len within bound")
}

fn send(from: u64, to: u64, kind: MessageKind, len: usize) -> sp_runtime::DispatchResult {
    Messages::send(
        RuntimeOrigin::signed(from),
        to,
        kind,
        None,
        None,
        payload(len),
    )
}

fn free(who: u64) -> u64 {
    Balances::free_balance(who)
}

fn issuance() -> u64 {
    <Balances as Currency<u64>>::total_issuance()
}

fn next_block() {
    System::set_block_number(System::block_number() + 1);
}

const ALL_KINDS: [MessageKind; 8] = [
    MessageKind::Offer,
    MessageKind::Bid,
    MessageKind::Accept,
    MessageKind::Reject,
    MessageKind::DeliveryNotice,
    MessageKind::DisputeNote,
    MessageKind::Announce,
    MessageKind::Ping,
];

// ─── Sender / recipient registration ───────────────────────────────────────────

#[test]
fn unregistered_sender_is_rejected_for_every_kind_and_pays_nothing() {
    new_test_ext().execute_with(|| {
        let before = free(CAROL);
        for kind in ALL_KINDS {
            assert_noop!(send(CAROL, ALICE, kind, 10), Error::<Test>::NotRegistered);
        }
        assert_eq!(free(CAROL), before);
        assert_eq!(NextNonce::<Test>::get(CAROL), 0);
    });
}

#[test]
fn unregistered_recipient_is_rejected_for_every_kind_except_announce() {
    new_test_ext().execute_with(|| {
        let before = free(ALICE);
        for kind in ALL_KINDS {
            if kind == MessageKind::Announce {
                continue;
            }
            assert_noop!(
                send(ALICE, CAROL, kind, 10),
                Error::<Test>::RecipientNotRegistered
            );
        }
        assert_eq!(free(ALICE), before, "a rejected send must burn nothing");
        assert_eq!(NextNonce::<Test>::get(ALICE), 0);
    });
}

#[test]
fn announce_to_unregistered_recipient_is_accepted() {
    new_test_ext().execute_with(|| {
        assert_ok!(send(ALICE, CAROL, MessageKind::Announce, 10));
        assert_eq!(NextNonce::<Test>::get(ALICE), 1);
    });
}

#[test]
fn every_kind_is_accepted_between_registered_agents() {
    new_test_ext().execute_with(|| {
        for (i, kind) in ALL_KINDS.into_iter().enumerate() {
            // Two per block keeps us under MaxPerBlock; the rate limit has its own tests.
            if i % 2 == 0 {
                next_block();
            }
            assert_ok!(send(ALICE, BOB, kind, 1));
        }
        assert_eq!(NextNonce::<Test>::get(ALICE), ALL_KINDS.len() as u64);
    });
}

// ─── Payload bound (2 KiB, enforced by the type) ───────────────────────────────

/// The bound lives in the call's type, so it is enforced where a call is *built*, not where it
/// is dispatched: a 2049-byte payload cannot become a `Payload` at all.
#[test]
fn payload_above_2048_bytes_cannot_be_constructed() {
    assert_eq!(MAX_PAYLOAD_LEN, 2048);
    assert!(Payload::try_from(vec![0u8; 2048]).is_ok());
    assert!(Payload::try_from(vec![0u8; 2049]).is_err());
}

/// ...and the same bound holds on the wire: bytes that encode a 2049-byte payload do not decode
/// into a call, so an oversized message is rejected before any fee or weight is computed.
#[test]
fn payload_above_2048_bytes_does_not_decode_as_a_call() {
    new_test_ext().execute_with(|| {
        // Hand-encode `Messages::send` as (pallet index, call index, args...). First prove the
        // hand encoding is right by round-tripping it at exactly the bound...
        let pallet_index = <Messages as frame_support::traits::PalletInfoAccess>::index() as u8;
        let raw = |len: usize| {
            (
                pallet_index,
                0u8, // call_index(0) = send
                BOB,
                MessageKind::Offer,
                None::<(u64, u32)>,
                None::<[u8; 32]>,
                vec![0xABu8; len],
            )
                .encode()
        };
        let at_bound = RuntimeCall::decode(&mut &raw(2048)[..]).expect("2048 bytes decodes");
        let built: RuntimeCall = Call::<Test>::send {
            to: BOB,
            kind: MessageKind::Offer,
            agreement: None,
            payload_hash: None,
            payload: payload(2048),
        }
        .into();
        assert_eq!(at_bound, built);
        // ...then one byte over.
        assert!(RuntimeCall::decode(&mut &raw(2049)[..]).is_err());
    });
}

#[test]
fn payload_at_exactly_2048_bytes_is_accepted() {
    new_test_ext().execute_with(|| {
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 2048));
    });
}

#[test]
fn empty_payload_is_accepted() {
    new_test_ext().execute_with(|| {
        // Hash-only messages: the content lives off chain, the chain carries the commitment.
        assert_ok!(Messages::send(
            RuntimeOrigin::signed(ALICE),
            BOB,
            MessageKind::Accept,
            Some((BOB, 0)),
            Some([7u8; 32]),
            payload(0),
        ));
    });
}

#[test]
fn dispatch_weight_scales_with_payload_length() {
    new_test_ext().execute_with(|| {
        let weight = |len: usize| {
            Call::<Test>::send {
                to: BOB,
                kind: MessageKind::Offer,
                agreement: None,
                payload_hash: None,
                payload: payload(len),
            }
            .get_dispatch_info()
            .call_weight
            .ref_time()
        };
        assert!(weight(0) > 0);
        assert_eq!(weight(2048) - weight(0), 1_000 * 2048);
    });
}

// ─── Fee: BaseFee + PerByteFee × len, withdrawn from free balance and burned ───

#[test]
fn fee_for_empty_payload_is_exactly_base_fee() {
    new_test_ext().execute_with(|| {
        let (bal, iss) = (free(ALICE), issuance());
        assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        assert_eq!(bal - free(ALICE), BASE_FEE);
        assert_eq!(iss - issuance(), BASE_FEE);
    });
}

#[test]
fn fee_for_max_payload_is_exactly_base_plus_2048_bytes() {
    new_test_ext().execute_with(|| {
        let (bal, iss) = (free(ALICE), issuance());
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 2048));
        let expected = BASE_FEE + PER_BYTE_FEE * 2048; // 20_000 + 204_800
        assert_eq!(expected, 224_800);
        assert_eq!(bal - free(ALICE), expected);
        assert_eq!(iss - issuance(), expected);
    });
}

#[test]
fn per_byte_fee_is_exact_at_every_length_boundary() {
    new_test_ext().execute_with(|| {
        for len in [0usize, 1, 2, 31, 32, 33, 255, 256, 1024, 2047, 2048] {
            next_block();
            let (bal, iss) = (free(ALICE), issuance());
            assert_ok!(send(ALICE, BOB, MessageKind::Offer, len));
            let expected = BASE_FEE + PER_BYTE_FEE * len as u64;
            assert_eq!(bal - free(ALICE), expected, "sender charge at len {len}");
            assert_eq!(iss - issuance(), expected, "burn at len {len}");
            assert_eq!(
                Messages::message_fee(len as u32),
                expected,
                "formula at len {len}"
            );
        }
    });
}

#[test]
fn fee_is_burned_not_transferred() {
    new_test_ext().execute_with(|| {
        let recipient_before = free(BOB);
        let iss = issuance();
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 100));
        assert_eq!(free(BOB), recipient_before, "recipient receives nothing");
        assert_eq!(iss - issuance(), BASE_FEE + PER_BYTE_FEE * 100);
    });
}

#[test]
fn fee_cannot_be_paid_from_locked_stake() {
    new_test_ext().execute_with(|| {
        // DAVE's only free-and-unlocked funds are 10 units; the rest is the stake lock.
        assert!(free(DAVE) < STAKE + BASE_FEE);
        let (bal, iss) = (free(DAVE), issuance());
        assert!(send(DAVE, ALICE, MessageKind::Offer, 0).is_err());
        assert_eq!(free(DAVE), bal);
        assert_eq!(issuance(), iss);
        assert_eq!(
            NextNonce::<Test>::get(DAVE),
            0,
            "failed send advances no nonce"
        );
        assert_eq!(
            SentInBlock::<Test>::get(DAVE),
            None,
            "failed send uses no rate slot"
        );
    });
}

#[test]
fn fee_can_spend_exactly_the_unlocked_balance_and_no_more() {
    new_test_ext().execute_with(|| {
        // A fresh agent whose unlocked funds are exactly one empty-payload fee.
        let who = 42u64;
        let _ = Balances::deposit_creating(&who, STAKE + REG_FEE + BASE_FEE);
        assert_ok!(Agents::register(RuntimeOrigin::signed(who), STAKE));
        assert_ok!(send(who, ALICE, MessageKind::Ping, 0));
        assert_eq!(free(who), STAKE, "only the locked stake is left");
        // One more planck of fee than it has unlocked: refused, nothing moves.
        assert!(send(who, ALICE, MessageKind::Ping, 0).is_err());
        assert_eq!(free(who), STAKE);
        assert_eq!(NextNonce::<Test>::get(who), 1);
    });
}

// ─── Nonce ──────────────────────────────────────────────────────────────────────

#[test]
fn nonce_increments_by_one_per_sender_and_independently() {
    new_test_ext().execute_with(|| {
        assert_eq!(NextNonce::<Test>::get(ALICE), 0);
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 0));
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 0));
        assert_ok!(send(ERIN, BOB, MessageKind::Offer, 0));
        assert_eq!(NextNonce::<Test>::get(ALICE), 2);
        assert_eq!(NextNonce::<Test>::get(ERIN), 1);
        assert_eq!(
            NextNonce::<Test>::get(BOB),
            0,
            "receiving does not touch a nonce"
        );
        next_block();
        assert_ok!(send(ALICE, ERIN, MessageKind::Offer, 0));
        assert_eq!(
            NextNonce::<Test>::get(ALICE),
            3,
            "nonce is per sender, not per pair"
        );
    });
}

#[test]
fn nonce_overflow_is_refused_not_wrapped() {
    new_test_ext().execute_with(|| {
        NextNonce::<Test>::insert(ALICE, u64::MAX);
        let bal = free(ALICE);
        assert_noop!(
            send(ALICE, BOB, MessageKind::Offer, 0),
            Error::<Test>::NonceOverflow
        );
        assert_eq!(free(ALICE), bal);
    });
}

// ─── Rate limit: MaxPerBlock = 4 per sender per block ──────────────────────────

#[test]
fn rate_limit_trips_on_the_fifth_message_in_a_block() {
    new_test_ext().execute_with(|| {
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        }
        let bal = free(ALICE);
        assert_noop!(
            send(ALICE, BOB, MessageKind::Ping, 0),
            Error::<Test>::RateLimited
        );
        assert_eq!(free(ALICE), bal, "a rate-limited send burns nothing");
        assert_eq!(NextNonce::<Test>::get(ALICE), MAX_PER_BLOCK as u64);
    });
}

#[test]
fn rate_limit_applies_to_announce_too() {
    new_test_ext().execute_with(|| {
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, CAROL, MessageKind::Announce, 0));
        }
        assert_noop!(
            send(ALICE, CAROL, MessageKind::Announce, 0),
            Error::<Test>::RateLimited
        );
    });
}

#[test]
fn rate_limit_resets_in_the_next_block() {
    new_test_ext().execute_with(|| {
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        }
        next_block();
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        }
        assert_eq!(
            SentInBlock::<Test>::get(ALICE),
            Some((System::block_number(), MAX_PER_BLOCK))
        );
    });
}

#[test]
fn rate_limit_is_per_sender() {
    new_test_ext().execute_with(|| {
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        }
        // ALICE is exhausted; ERIN in the same block is not.
        assert_ok!(send(ERIN, BOB, MessageKind::Ping, 0));
    });
}

#[test]
fn rejected_sends_do_not_consume_rate_limit_slots() {
    new_test_ext().execute_with(|| {
        for _ in 0..10 {
            assert!(send(ALICE, CAROL, MessageKind::Offer, 0).is_err());
        }
        for _ in 0..MAX_PER_BLOCK {
            assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0));
        }
    });
}

// ─── Event and state ───────────────────────────────────────────────────────────

#[test]
fn message_sent_event_carries_every_field() {
    new_test_ext().execute_with(|| {
        System::reset_events();
        assert_ok!(send(ALICE, BOB, MessageKind::Ping, 0)); // nonce 0
        assert_ok!(Messages::send(
            RuntimeOrigin::signed(ALICE),
            BOB,
            MessageKind::DeliveryNotice,
            Some((BOB, 7)),
            Some([9u8; 32]),
            payload(321),
        ));
        System::assert_last_event(RuntimeEvent::Messages(Event::MessageSent {
            from: ALICE,
            to: BOB,
            kind: MessageKind::DeliveryNotice,
            agreement: Some((BOB, 7)),
            payload_hash: Some([9u8; 32]),
            payload_len: 321,
            nonce: 1,
        }));
    });
}

#[test]
fn payload_is_not_written_to_state() {
    new_test_ext().execute_with(|| {
        // Snapshot every key under this pallet's storage prefix before and after a full-size
        // send. Only NextNonce and SentInBlock may appear, and neither may hold payload bytes.
        let prefix = sp_io::hashing::twox_128(b"Messages");
        let keys = || {
            let mut out = Vec::new();
            let mut next = sp_io::storage::next_key(&prefix);
            while let Some(k) = next {
                if !k.starts_with(&prefix) {
                    break;
                }
                out.push((k.clone(), sp_io::storage::get(&k).unwrap().to_vec()));
                next = sp_io::storage::next_key(&k);
            }
            out
        };
        assert!(keys().is_empty());
        assert_ok!(send(ALICE, BOB, MessageKind::Offer, 2048));
        let written = keys();
        let nonce_prefix = NextNonce::<Test>::final_prefix();
        let rate_prefix = SentInBlock::<Test>::final_prefix();
        assert_eq!(
            written.len(),
            2,
            "exactly one NextNonce and one SentInBlock entry"
        );
        for (k, v) in written {
            assert!(k.starts_with(&nonce_prefix) || k.starts_with(&rate_prefix));
            assert!(
                v.len() <= 12,
                "no stored value is large enough to hold a payload"
            );
        }
    });
}

// ─── Declared weight is a floor over the worst-case storage path ───────────────

/// Same rule as pallet-agents' #217 floors: an under-declared extrinsic is underpriced, so
/// the caller's fee buys less storage work than the chain performs.
///
/// 6 reads: sender `AgentStake`, recipient `AgentStake`, `SentInBlock`, `NextNonce`, the
///   sender's `System::Account` for the withdraw, and `TotalIssuance` for the burn.
/// 4 writes: `SentInBlock`, `NextNonce`, the sender's `System::Account`, `TotalIssuance`
///   (dropping the withdrawn `NegativeImbalance` lowers issuance — that is the burn).
#[test]
fn declared_weight_send_covers_its_storage_path() {
    let floor = <Test as frame_system::Config>::DbWeight::get().reads_writes(6, 4);
    for len in [0usize, 2048] {
        let declared = Call::<Test>::send {
            to: BOB,
            kind: MessageKind::Offer,
            agreement: None,
            payload_hash: None,
            payload: payload(len),
        }
        .get_dispatch_info()
        .call_weight;
        assert!(
            declared.all_gte(floor),
            "send({len} bytes) declares {declared:?} but its storage path needs at least \
             {floor:?}"
        );
    }
}
