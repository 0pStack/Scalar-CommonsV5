//! Issue #164 reproduction — "a two-account tester captured 82 % of an era's emission
//! (90 068 CMN) for 60 CMN of self-directed escrow".
//!
//! WHY THIS IS A SEPARATE MOCK
//!
//! `tests.rs` uses convenient round numbers (`UnitVolume = 1_000`, `MinQualifyingVol = 0`)
//! that are fine for exercising the accumulator but cannot reproduce #164: at that unit
//! size a 60 CMN deal scores `log2_scaled = 0` and the agent earns nothing for reasons that
//! have nothing to do with the bug. The mock here mirrors `runtime/src/lib.rs` constant for
//! constant — `UnitVolume = 10 CMN`, `MinQualifyingVol = 50 CMN`,
//! `TargetEmissionPerAgent = 10 000 CMN`, `FloorEmissionPerEra = 100 000 CMN`, alpha/beta/
//! floor at the auto-params genesis values, `HeartbeatGracePeriod = 18 h` — so the numbers
//! it produces are the live chain's numbers and the assertions are checkable against the
//! figures in the issue.
//!
//! `CMN` is 10^6 here rather than 10^12 only so the whole 100 B supply cap stays inside the
//! `u64` this mock's Balance is. Every ratio in the weight formula is scale-invariant, so
//! the shape is identical; the one visible consequence is that `integer_sqrt(stake)` is
//! 10^3 smaller than on chain, which scales weights uniformly and cancels in every share.

use crate::pallet::*;
use frame_support::{
    assert_ok, parameter_types,
    traits::{ConstU16, ConstU32, ConstU64},
};
use sp_core::H256;
use sp_runtime::{
    traits::{BlakeTwo256, IdentityLookup},
    BuildStorage,
};

/// 1 CMN. See the module note on why this is 10^6 and not 10^12.
const CMN: u64 = 1_000_000;

type Block = frame_system::mocking::MockBlock<Test>;

/// Mirrors `pallet-auto-params`' genesis values in `runtime/src/lib.rs`
/// (`AutoInitialAlpha` 1 500, `AutoInitialBeta` 5 000, `AutoInitialFloorBps` 1 000) and the
/// spec-306 `AutoInitialEmissionVolumeAlphaBps` of 10 000 bps = 1.0x.
pub struct LiveParams;
impl pallet_auto_params::pallet::AutoParamsProvider for LiveParams {
    fn completion_fee_bps() -> u32 {
        25
    }
    fn alpha() -> u32 {
        1_500
    }
    fn beta() -> u32 {
        5_000
    }
    fn floor_bps() -> u32 {
        1_000
    }
    fn min_score_eligible() -> u32 {
        5
    }
    fn emission_volume_alpha_bps() -> u32 {
        10_000
    }
}

/// No governance credit in this mock. `record_gov_vote` is never called here and a
/// permissive verifier would be an unearned weight input in an economics reproduction.
pub struct DenyAllGovVotes;
impl pallet_agents::pallet::GovVoteVerifier<u64> for DenyAllGovVotes {
    fn has_live_vote_on(_who: &u64, _poll_index: u32) -> bool {
        false
    }
}

frame_support::construct_runtime!(
    pub enum Test {
        System:    frame_system,
        Balances:  pallet_balances,
        Agents:    pallet_agents,
        Emissions: crate,
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
    type DbWeight = ();
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
    type ExistentialDeposit = ConstU64<10_000>; // 0.01 CMN, as on chain
    type AccountStore = System;
    type WeightInfo = ();
    type FreezeIdentifier = ();
    type MaxFreezes = ConstU32<0>;
    type RuntimeHoldReason = ();
    type RuntimeFreezeReason = ();
    type DoneSlashHandler = ();
}

parameter_types! {
    // runtime/src/lib.rs: AgentsMinStake / AgentsFullFloorStake / AgentsMaxStakePerAgent
    pub const MinStakeL:      u64 = 1_000 * CMN;
    pub const FullFloorL:     u64 = 10_000 * CMN;
    pub const MaxStakeL:      u64 = 1_000_000 * CMN;
    pub const RegFeeL:        u64 = 50 * CMN;
    // AgentsHeartbeatGrace = 18 h and AgentsHeartbeatDecay = 90 d at 6 s blocks.
    pub const HbGraceL:       u64 = 10_800;
    pub const HbDecayL:       u64 = 1_296_000;
}

impl pallet_agents::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type MinStake = MinStakeL;
    type FullFloorStake = FullFloorL;
    type MaxStakePerAgent = MaxStakeL;
    type UnstakeCooldown = ConstU64<100_800>;
    type BaseRegistrationFee = RegFeeL;
    type MaxRegistrationsPerBlock = ConstU32<10>;
    type MaxAgents = ConstU32<1_000_000>;
    type Rank3MinCompletions = ConstU32<50>;
    type MinRank3OracleScore = ConstU32<0>;
    type Rank3SpanGate = ConstU64<0>;
    type MaxVolToStakeRatio = ConstU32<10>;
    type HeartbeatGracePeriod = HbGraceL;
    type HeartbeatDecayPeriod = HbDecayL;
    type OnAgentRegistered = Emissions;
    type OnAgentSlashed = Emissions;
    type OnStakeChanged = Emissions;
    type AgentCollective = ();
    type OracleScoreGate = ();
    type GovVoteVerifier = DenyAllGovVotes;
    type IdentityHandler = ();
    type OrchestratorLookup = ();
    type MaxUriLen = ConstU32<256>;
    type MaxNameLen = ConstU32<64>;
    type MaxCapabilitiesPerAgent = ConstU32<20>;
    type MaxDelegationPeriod = ConstU64<1_296_000>;
    type SlashAppealWindow = ConstU64<10>;
    type SlashDestination = ();
    type MaxProposalsPerEra = ConstU32<20>;
}

parameter_types! {
    // runtime/src/lib.rs, Emissions* block — same numbers, CMN of 10^6.
    pub const SupplyCapL:      u64 = 100_000_000_000 * CMN;
    pub const InitialPerEraL:  u64 = 1_000_000 * CMN;
    pub const TargetPerAgentL: u64 = 10_000 * CMN;
    pub const FloorPerEraL:    u64 = 100_000 * CMN;
    pub const EraDurationL:    u64 = 3_600;
    pub const UnitVolumeL:     u64 = 10 * CMN;
    pub const MinQualifyingL:  u64 = 50 * CMN;
}

impl crate::pallet::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Currency = Balances;
    type SupplyCap = SupplyCapL;
    type InitialEmissionsPerEra = InitialPerEraL;
    type TargetEmissionPerAgent = TargetPerAgentL;
    type FloorEmissionPerEra = FloorPerEraL;
    type EraDuration = EraDurationL;
    type MaxBatchClaimSize = ConstU32<100>;
    type OracleBonusBps = ConstU32<2_000>;
    type MaxProposalsPerEra = ConstU32<20>;
    type UnitVolume = UnitVolumeL;
    type VelocityBonusBps = ConstU32<3_000>;
    type MinQualifyingVol = MinQualifyingL;
    type AutoParams = LiveParams;
    type OracleScoreProvider = ();
    type OracleCounters = ();
    type MaxEmissionOverrideEras = ConstU32<10>;
    type ValidatorCountProvider = ();
    type OrchestratorEmissions = ();
    type OrchestratorEmissionMultiplier = ConstU32<5_000>;
}

/// The two accounts from the issue. Each holds exactly one faucet drip: 1 100 CMN, which
/// is what `https://faucet.scalarnet.io` dispenses and all the attack ever cost.
const DRIP: u64 = 1_100 * CMN;
const ATTACKER_PROVIDER: u64 = 1;
const ATTACKER_BUYER: u64 = 2;

fn new_test_ext() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Test> {
        balances: vec![
            (ATTACKER_PROVIDER, DRIP),
            (ATTACKER_BUYER, DRIP),
            (10, 100_000 * CMN),
            (11, 100_000 * CMN),
        ],
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    storage.into()
}

fn settle() {
    let now = System::block_number();
    System::set_block_number(now + EraDurationL::get());
    // Permissionless, exactly as on chain — the keeper is an ordinary signed account.
    assert_ok!(Emissions::settle_era(RuntimeOrigin::signed(ATTACKER_BUYER)));
}

fn claim_gain(who: u64) -> u64 {
    let before = Balances::free_balance(who);
    let _ = Emissions::claim(RuntimeOrigin::signed(who));
    Balances::free_balance(who).saturating_sub(before)
}

// ─────────────────────────────────────────────────────────────────────────────

/// #164, reproduced move for move: two faucet-funded accounts, 60 CMN of escrow between
/// them and nobody else, and the question the issue asks — how much can they mint?
///
/// Before spec 306 the answer was `clamp(TargetEmissionPerAgent x agent_count, floor,
/// ceiling)` regardless of any of it: 100 000 CMN of pot with only one weighted agent to
/// share it, so ~1 667 CMN minted per CMN of escrow. On chain, with 11 registered agents,
/// that same shape paid 90 068.37 CMN.
///
/// D7's bound is that an era may not mint more than the qualifying escrow volume it
/// settled. Here the provider is ring-flagged — established, and every completion this era
/// from a single buyer — so its volume qualifies for nothing at all and the pot is zero.
/// The weaker bound the issue asks for, "<= 60 CMN", holds either way.
#[test]
fn issue_164_two_account_ring_cannot_mint_more_than_its_own_escrow() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Agents::register(
            RuntimeOrigin::signed(ATTACKER_PROVIDER),
            1_000 * CMN
        ));
        assert_ok!(Agents::register(
            RuntimeOrigin::signed(ATTACKER_BUYER),
            1_000 * CMN
        ));

        // "one 10 CMN + one 50 CMN escrow job, between my own two accounts".
        // create_agreement blocks literal self-dealing, which is exactly why the attack
        // needs two accounts and why it costs two registrations rather than one.
        assert_ok!(Agents::add_era_escrow_volume(
            &ATTACKER_PROVIDER,
            &ATTACKER_BUYER,
            10 * CMN
        ));
        assert_ok!(Agents::add_era_escrow_volume(
            &ATTACKER_PROVIDER,
            &ATTACKER_BUYER,
            50 * CMN
        ));
        let escrow_volume = 60 * CMN;
        assert_eq!(
            pallet_agents::EraEscrowVolume::<Test>::get(ATTACKER_PROVIDER),
            escrow_volume
        );

        settle();

        let earned = claim_gain(ATTACKER_PROVIDER) + claim_gain(ATTACKER_BUYER);
        assert!(
            earned <= escrow_volume,
            "two accounts recycling {} CMN of their own escrow minted {} CMN — \
             {}x the work they can point at (#164)",
            escrow_volume / CMN,
            earned / CMN,
            earned / escrow_volume.max(1),
        );
    });
}

/// The other half of the same claim: the fix must bound the ring without taxing the
/// honest case. Two agents with identical stake and five real, distinct counterparties
/// each still earn, still earn in proportion to the work they did, and the era still mints
/// exactly the qualifying volume rather than the agent-count pot.
#[test]
fn honest_agents_with_real_counterparties_earn_proportionally() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        let (busy, quiet) = (10u64, 11u64);
        assert_ok!(Agents::register(RuntimeOrigin::signed(busy), 1_000 * CMN));
        assert_ok!(Agents::register(RuntimeOrigin::signed(quiet), 1_000 * CMN));

        // Disjoint buyer sets, none of them a seller: no rings, no cycles, no lineage.
        for buyer in 100u64..105 {
            assert_ok!(Agents::add_era_escrow_volume(&busy, &buyer, 80 * CMN));
        }
        for buyer in 200u64..205 {
            assert_ok!(Agents::add_era_escrow_volume(&quiet, &buyer, 20 * CMN));
        }
        let qualifying = 400 * CMN + 100 * CMN;

        settle();

        // The pot is the measured work, not 100 000 CMN of agent-count schedule.
        assert_eq!(
            LastEraEmission::<Test>::get(),
            qualifying,
            "an era must mint alpha x qualifying volume, alpha = 1.0"
        );

        let busy_earned = claim_gain(busy);
        let quiet_earned = claim_gain(quiet);
        assert!(busy_earned > 0, "an honest provider must still earn");
        assert!(quiet_earned > 0, "a smaller honest provider must still earn");
        assert!(
            busy_earned > quiet_earned,
            "4x the volume at equal stake must earn more: busy {busy_earned} vs quiet {quiet_earned}"
        );
        assert!(
            busy_earned + quiet_earned <= qualifying,
            "total minted {} must not exceed qualifying volume {}",
            busy_earned + quiet_earned,
            qualifying
        );
    });
}

/// D8 / #161 at the emissions layer. Two identical agents register in the same block on a
/// chain that is already 534 527 blocks old; one sends an explicit heartbeat and one does
/// not. They must settle at the same weight, because registering IS the heartbeat.
///
/// Before D8 the silent one computed its multiplier from a gap of the entire chain history
/// — the issue measured 63 — which put it under the `hb >= 90` activity gate and cost it
/// the floor share it had done nothing to forfeit.
#[test]
fn freshly_registered_agent_is_not_penalised_against_one_that_heartbeats() {
    new_test_ext().execute_with(|| {
        System::set_block_number(534_527);
        let (silent, beating) = (10u64, 11u64);
        assert_ok!(Agents::register(RuntimeOrigin::signed(silent), 1_000 * CMN));
        assert_ok!(Agents::register(
            RuntimeOrigin::signed(beating),
            1_000 * CMN
        ));
        assert_ok!(Agents::heartbeat(RuntimeOrigin::signed(beating)));

        for buyer in 100u64..105 {
            assert_ok!(Agents::add_era_escrow_volume(&silent, &buyer, 80 * CMN));
        }
        for buyer in 200u64..205 {
            assert_ok!(Agents::add_era_escrow_volume(&beating, &buyer, 80 * CMN));
        }

        assert_eq!(
            Agents::heartbeat_multiplier(&silent),
            100,
            "registering starts the heartbeat clock"
        );

        settle();

        assert_eq!(
            AgentWeightSnapshot::<Test>::get(silent),
            AgentWeightSnapshot::<Test>::get(beating),
            "a just-registered agent must not settle below one that heartbeated"
        );
        assert!(AgentWeightSnapshot::<Test>::get(silent) > 0);
    });
}

/// The alpha lever is real in both directions, and the D9 stopgap it replaces is subsumed:
/// alpha = 0 stops emission without pausing `settle_era` or `claim`, so nothing
/// economically essential comes to depend on a privileged caller (first principle #3).
#[test]
fn alpha_scales_the_bound_and_zero_stops_emission() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(10), 1_000 * CMN));
        for buyer in 100u64..105 {
            assert_ok!(Agents::add_era_escrow_volume(&10, &buyer, 80 * CMN));
        }
        settle();
        assert_eq!(LastEraEmission::<Test>::get(), 400 * CMN);
    });
}

/// A root override is bounded by the same rule. The lever can still lower emission — that
/// is what stopped the bleeding on the live chain at block #542152 — but it cannot mint
/// past the measurement. Raising the ceiling is alpha's job, on chain and visible.
#[test]
fn emission_override_is_still_bounded_by_qualifying_volume() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Agents::register(RuntimeOrigin::signed(10), 1_000 * CMN));
        // era 0 settles first, so target the era after it.
        assert_ok!(Emissions::set_era_emission_override(
            RuntimeOrigin::root(),
            1,
            500_000 * CMN,
        ));

        for buyer in 100u64..105 {
            assert_ok!(Agents::add_era_escrow_volume(&10, &buyer, 80 * CMN));
        }
        settle(); // era 0

        for buyer in 100u64..105 {
            assert_ok!(Agents::add_era_escrow_volume(&10, &buyer, 80 * CMN));
        }
        settle(); // era 1 — the overridden one

        assert_eq!(
            LastEraEmission::<Test>::get(),
            400 * CMN,
            "a 500 000 CMN root override must still be cut to the qualifying volume"
        );
    });
}
