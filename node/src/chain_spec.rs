//! Scalar Commons chain specification.

// ImOnline removed from M1 runtime — session keys: Babe + Grandpa + AuthorityDiscovery only
// sp_authority_discovery::AuthorityId is the correct public type (pallet_authority_discovery::AuthorityId is private)
use sc_service::{ChainType, Properties};
use sp_authority_discovery::AuthorityId as AuthorityDiscoveryId;
// ROUND4: `RuntimeGenesisConfig` was imported but never named — every builder
// below hands the runtime a `serde_json` patch and lets `GenesisBuilder` type
// it. Dropped rather than silenced.
use scalar_commons_runtime::{
    AccountId, Balance, SessionKeys, BABE_GENESIS_EPOCH_CONFIG, CMN, GENESIS_MINT,
};
use sp_consensus_babe::AuthorityId as BabeId;
use sp_consensus_grandpa::AuthorityId as GrandpaId;
use sp_core::{sr25519, Pair, Public};
use sp_runtime::traits::{IdentifyAccount, Verify};

/// Specialized `ChainSpec` for the Scalar Commons runtime.
pub type ChainSpec = sc_service::GenericChainSpec;
type AccountPublic = <scalar_commons_runtime::Signature as Verify>::Signer;

// ─── Genesis allocation constants ────────────────────────────────────────────
/// Stake each genesis validator bonds. Sets the initial NPoS weight floor.
pub const VALIDATOR_STASH_BOND: Balance = 1_000_000 * CMN;
/// Free balance given to each validator's controller account, for fees only.
pub const VALIDATOR_CONTROLLER_BALANCE: Balance = 50_000 * CMN;
/// Agent stake pre-registered for each genesis validator — the minimum that
/// enables floor emissions from era 1.
pub const GENESIS_AGENT_STAKE: Balance = 10_000 * CMN;

/// Founders' share of the 18B genesis mint.
pub const FOUNDERS_ALLOC: Balance = 7_000_000_000 * CMN;
/// Researcher multisig's share of the 18B genesis mint.
pub const RESEARCHERS_ALLOC: Balance = 3_000_000_000 * CMN;
/// Treasury's share of the 18B genesis mint.
pub const TREASURY_ALLOC: Balance = 5_000_000_000 * CMN;
/// Bootstrap multisig's share of the 18B genesis mint.
pub const BOOTSTRAP_ALLOC: Balance = 3_000_000_000 * CMN;

const _: () = assert!(
    FOUNDERS_ALLOC + RESEARCHERS_ALLOC + TREASURY_ALLOC + BOOTSTRAP_ALLOC == 18_000_000_000 * CMN,
    "Genesis allocations must sum to GENESIS_MINT (18B CMN)"
);

// ─── Key generation helpers ──────────────────────────────────────────────────

fn get_from_seed<TPublic: Public>(seed: &str) -> <TPublic::Pair as Pair>::Public {
    TPublic::Pair::from_string(&format!("//{}", seed), None)
        .expect("static values are valid; qed")
        .public()
}

fn account_id_from_seed<TPublic: Public>(seed: &str) -> AccountId
where
    AccountPublic: From<<TPublic::Pair as Pair>::Public>,
{
    AccountPublic::from(get_from_seed::<TPublic>(seed)).into_account()
}

/// Generate session keys for a validator — 5-tuple (no ImOnline, removed M1).
/// Returns: (stash, controller, grandpa, babe, authority_discovery)
fn authority_keys_from_seed(
    seed: &str,
) -> (
    AccountId,
    AccountId,
    GrandpaId,
    BabeId,
    AuthorityDiscoveryId,
) {
    (
        account_id_from_seed::<sr25519::Public>(&format!("{}//stash", seed)),
        account_id_from_seed::<sr25519::Public>(seed),
        get_from_seed::<GrandpaId>(seed),
        get_from_seed::<BabeId>(seed),
        get_from_seed::<AuthorityDiscoveryId>(seed),
    )
}

fn chain_properties() -> Properties {
    let mut p = Properties::new();
    p.insert("tokenSymbol".into(), "CMN".into());
    p.insert("tokenDecimals".into(), 12u32.into());
    p.insert("ss58Format".into(), 42u32.into()); // MAINNET BLOCKER: register unique SS58 prefix
    p
}

// ─── Development chain ────────────────────────────────────────────────────────

/// Single-machine development chain: Alice, Bob and Charlie as validators.
///
/// Note that all three are in the authority set, so `--dev` on one machine
/// authors roughly a third of slots and cannot reach GRANDPA's 2/3 finality
/// quorum on its own. See ROUND4.md "Gate B evidence".
pub fn development_config() -> ChainSpec {
    ChainSpec::builder(
        scalar_commons_runtime::WASM_BINARY.expect("WASM binary not available"),
        Default::default(),
    )
    .with_name("Scalar Commons Development")
    .with_id("scalar-dev")
    .with_chain_type(ChainType::Development)
    .with_properties(chain_properties())
    .with_genesis_config_patch(dev_genesis(
        vec![
            authority_keys_from_seed("Alice"),
            authority_keys_from_seed("Bob"),
            authority_keys_from_seed("Charlie"),
        ],
        vec![
            account_id_from_seed::<sr25519::Public>("Alice"),
            account_id_from_seed::<sr25519::Public>("Bob"),
            account_id_from_seed::<sr25519::Public>("Charlie"),
        ],
        account_id_from_seed::<sr25519::Public>("Alice"),
    ))
    .build()
}

// ─── Local testnet chain ──────────────────────────────────────────────────────

/// Local multi-node testnet: five validators, six endowed accounts.
///
/// ROUND15: the authority set was three (Alice/Bob/Charlie) through ROUND14.
/// GRANDPA finalizes on a supermajority: for `n` authorities the threshold is
/// `n - (n-1)/3` voters (integer division), so the tolerated failures are
/// `f = (n-1)/3`.
///
/// | `n` | threshold | tolerated down |
/// |-----|-----------|----------------|
/// | 3   | 3         | **0**          |
/// | 4   | 3         | 1              |
/// | 5   | 4         | 1              |
/// | 7   | 5         | 2              |
///
/// At `n = 3` the threshold was every single authority, so stopping one froze
/// finality outright while block production carried on — ROUND10.md §2.5
/// measured exactly that. Five clears the threshold with four voters, so the
/// chain keeps finalizing through one validator being down for a restart, a
/// snapshot, or a crash.
///
/// Be precise about what the fifth authority buys: **nothing for fault
/// tolerance.** Four and five both tolerate exactly one failure — 5 raises the
/// threshold to 4 in step with the set size. Seven is the next size that
/// survives two. Five is chosen for slot spread and to leave the set an odd
/// size, not because it is more fault-tolerant than four.
///
/// Dave and Eve were already endowed accounts here — this promotes them into
/// the authority set. Every downstream genesis field (session keys, stakers,
/// `validatorCount`, invulnerables, validator balances) is derived from this
/// vector by [`dev_genesis`], so no economic constant changes.
pub fn local_testnet_config() -> ChainSpec {
    ChainSpec::builder(
        scalar_commons_runtime::WASM_BINARY.expect("WASM binary not available"),
        Default::default(),
    )
    .with_name("Scalar Commons Local Testnet")
    .with_id("scalar-local")
    .with_chain_type(ChainType::Local)
    .with_properties(chain_properties())
    .with_genesis_config_patch(dev_genesis(
        vec![
            authority_keys_from_seed("Alice"),
            authority_keys_from_seed("Bob"),
            authority_keys_from_seed("Charlie"),
            authority_keys_from_seed("Dave"),
            authority_keys_from_seed("Eve"),
        ],
        vec![
            account_id_from_seed::<sr25519::Public>("Alice"),
            account_id_from_seed::<sr25519::Public>("Bob"),
            account_id_from_seed::<sr25519::Public>("Charlie"),
            account_id_from_seed::<sr25519::Public>("Dave"),
            account_id_from_seed::<sr25519::Public>("Eve"),
            account_id_from_seed::<sr25519::Public>("Ferdie"),
        ],
        account_id_from_seed::<sr25519::Public>("Alice"),
    ))
    .build()
}

// ─── Staging testnet chain ────────────────────────────────────────────────────

/// Staging testnet: seven validators and ten endowed user accounts, live chain
/// type. Keys are still derived from well-known seeds — not for value.
pub fn staging_testnet_config() -> ChainSpec {
    ChainSpec::builder(
        scalar_commons_runtime::WASM_BINARY.expect("WASM binary not available"),
        Default::default(),
    )
    .with_name("Scalar Commons Staging")
    .with_id("scalar-staging")
    .with_chain_type(ChainType::Live)
    .with_properties(chain_properties())
    .with_genesis_config_patch(dev_genesis(
        vec![
            authority_keys_from_seed("Validator1"),
            authority_keys_from_seed("Validator2"),
            authority_keys_from_seed("Validator3"),
            authority_keys_from_seed("Validator4"),
            authority_keys_from_seed("Validator5"),
            authority_keys_from_seed("Validator6"),
            authority_keys_from_seed("Validator7"),
        ],
        (1..=10)
            .map(|i| account_id_from_seed::<sr25519::Public>(&format!("User{i}")))
            .collect(),
        account_id_from_seed::<sr25519::Public>("SudoKey"),
    ))
    .build()
}

// ─── sc-e1 fast-era testnet (P0-2 / protocol §8.2, HL-3) ─────────────

/// λ (lambda) — the uniform fast-era time-compression factor for the `sc-e1`
/// preset. Every block-denominated runtime constant is conceptually divided by
/// λ to shorten eras for integration testing, so that *time-dependent results
/// stay proportional* (HL-3: one unscaled block-denominated constant invalidates
/// all time-dependent results).
///
/// OD-3: the production λ value is owned by Keith — this is a **parameterized
/// placeholder**, not a ratified constant. It is defined in exactly ONE place so
/// it can be changed without touching any preset body, and
/// `scripts/check_lambda_scaling.py` is the CI gate that asserts every
/// block-denominated constant divides cleanly by this λ (i.e. scaling is
/// uniform, never lossy).
pub const FAST_ERA_LAMBDA: u32 = 10;

/// `sc-e1` fast-era testnet preset.
///
/// Genesis is identical to [`development_config`] (Alice/Bob/Charlie validators,
/// same allocations) EXCEPT it is tagged as a distinct chain (`scalar-sc-e1`)
/// carrying λ in its name, so integration harnesses can select it without
/// colliding with the dev chain's on-disk state.
///
/// NOTE: block-denominated timing (era length, epoch duration, bonding, dispute
/// windows, …) are **compile-time runtime constants** (`runtime/src/lib.rs`,
/// `runtime/src/governance/tracks.rs`), *not* genesis-overridable fields — so
/// this preset does not (and cannot) rewrite them from the chain-spec. It pairs
/// with a λ-scaled runtime build; `scripts/check_lambda_scaling.py` enumerates
/// every block-denominated constant and asserts uniform scaling by
/// [`FAST_ERA_LAMBDA`]. Existing mainnet / testnet presets are left untouched.
pub fn sc_e1_fast_era_config() -> Result<ChainSpec, String> {
    let lambda = FAST_ERA_LAMBDA;
    Ok(ChainSpec::builder(
        scalar_commons_runtime::WASM_BINARY.ok_or("WASM binary not available")?,
        Default::default(),
    )
    .with_name(&format!("Scalar Commons sc-e1 Fast-Era (lambda={lambda})"))
    .with_id("scalar-sc-e1")
    .with_chain_type(ChainType::Development)
    .with_properties(chain_properties())
    .with_genesis_config_patch(dev_genesis(
        vec![
            authority_keys_from_seed("Alice"),
            authority_keys_from_seed("Bob"),
            authority_keys_from_seed("Charlie"),
        ],
        vec![
            account_id_from_seed::<sr25519::Public>("Alice"),
            account_id_from_seed::<sr25519::Public>("Bob"),
            account_id_from_seed::<sr25519::Public>("Charlie"),
        ],
        account_id_from_seed::<sr25519::Public>("Alice"),
    ))
    .build())
}

// ─── Genesis config builder ───────────────────────────────────────────────────

fn dev_genesis(
    initial_authorities: Vec<(
        AccountId,
        AccountId,
        GrandpaId,
        BabeId,
        AuthorityDiscoveryId,
    )>,
    endowed_accounts: Vec<AccountId>,
    root_key: AccountId,
) -> serde_json::Value {
    let endowment: Balance = 1_000_000_000 * CMN;

    // V4: Genesis agents — 3 validators, each pre-registered with 10,000 CMN stake.
    // The onboarding_boost (10,000 bps for first 10 completions) is a runtime parameter,
    // not a genesis field — it activates automatically for any agent's first 10 completions.
    let genesis_agents: Vec<(AccountId, Balance, bool)> = endowed_accounts
        .iter()
        .take(3)
        .map(|a| (a.clone(), GENESIS_AGENT_STAKE, true))
        .collect();

    // ROUND4: the `rankedCollective` seeding that used to be built here is gone.
    // `pallet_ranked_collective` declares no `#[pallet::genesis_config]` at
    // polkadot-stable2503, so `RuntimeGenesisConfig` has no such field and the
    // key was rejected outright:
    //
    //     Invalid JSON blob: unknown field `rankedCollective`, expected one of
    //     `system`, `balances`, `authorityDiscovery`, ...
    //
    // The collective is still non-empty at block 1, by a different route: the
    // `agents` genesis above inducts each genesis agent and, because
    // GENESIS_AGENT_STAKE (10,000 CMN) equals AgentsFullFloorStake, promotes it
    // twice — so those accounts land at rank 2, not rank 1. What is genuinely
    // lost is seeding the *stash* accounts; the inducted members are the
    // controllers. See ROUND4.md "chain_spec adaptations".

    let stakers: Vec<(
        AccountId,
        AccountId,
        Balance,
        pallet_staking::StakerStatus<AccountId>,
    )> = initial_authorities
        .iter()
        .map(|(stash, ctrl, ..)| {
            (
                stash.clone(),
                ctrl.clone(),
                VALIDATOR_STASH_BOND,
                pallet_staking::StakerStatus::Validator,
            )
        })
        .collect();

    let mut balances: Vec<(AccountId, Balance)> = initial_authorities
        .iter()
        .flat_map(|(stash, ctrl, ..)| {
            [
                (stash.clone(), VALIDATOR_STASH_BOND * 2),
                (ctrl.clone(), VALIDATOR_CONTROLLER_BALANCE),
            ]
        })
        .chain(endowed_accounts.iter().map(|a| (a.clone(), endowment)))
        .collect();

    balances.sort_by_key(|(a, _)| a.clone());
    balances.dedup_by(|(a1, b1), (a2, b2)| {
        if a1 == a2 {
            *b2 = b2.saturating_add(*b1);
            true
        } else {
            false
        }
    });

    let session_keys: Vec<_> = initial_authorities
        .iter()
        .map(|(stash, _ctrl, gp, ba, ad)| {
            (
                stash.clone(),
                stash.clone(),
                SessionKeys {
                    grandpa: gp.clone(),
                    babe: ba.clone(),
                    authority_discovery: ad.clone(),
                },
            )
        })
        .collect();

    serde_json::json!({
        "balances": { "balances": balances },
        "session":  { "keys": session_keys },
        "staking": {
            "validatorCount":        initial_authorities.len() as u32,
            "minimumValidatorCount": 1u32,
            "stakers":               stakers,
            "invulnerables":         initial_authorities.iter().map(|(s, ..)| s.clone()).collect::<Vec<_>>(),
            "slashRewardFraction":   0u32,
        },
        "babe":   { "authorities": [], "epochConfig": BABE_GENESIS_EPOCH_CONFIG },
        "grandpa": { "authorities": [] },
        // V4: the dev/local preset mints sudo to a genesis dev account, which is why
        // a freshly built chain starts with root on a published seed. THE LIVE DEVNET
        // NO LONGER DOES: root was rotated off //Alice on 2026-09-09 via sudo.set_key
        // (see scripts/sudo-set-key.mjs and issue #119), and is now held by the
        // operator. Sudo is NOT removed and nothing in this tree schedules its
        // removal — that is planned for mainnet, and until it happens no comment or
        // doc here may describe it as done.
        "sudo": { "key": Some(root_key) },
        // V4: Agents pre-registered at genesis with 10,000 CMN stake each.
        "agents": { "agents": genesis_agents },
        // V4: auto-params active from block 1 — run_era_rules fires every settle_era.
        "autoParams": {},
        // ROUND4: `rankedCollective`, `referenda`, `convictionVoting`,
        // `whitelist` and `constitution` were listed here as empty patches.
        // None of those five pallets declares a genesis config, so none has a
        // field in `RuntimeGenesisConfig`, and every one of them was rejected
        // as an unknown field before the node could build genesis at all.
        // Dropping them changes no on-chain state: a pallet with no genesis
        // config has nothing to initialise, and all five are wired in
        // `construct_runtime` and active from block 1 regardless. Only
        // `rankedCollective` carried a payload — see the note above.
        "safeMode":  {},
        "txPause":   {},
        // V4: Treasury active — receives slash 50% + completion fees each era.
        "treasury": {},
        // V4: Nomination pools active — any agent with ≥100 CMN can pool-stake.
        "nominationPools": {
            "minJoinBond":   100u128 * 1_000_000_000_000u128,    // 100 CMN
            "minCreateBond": 5_000u128 * 1_000_000_000_000u128,  // 5,000 CMN
            "maxPools":      Some(1_000u32),
            "maxMembersPerPool": Some(1_000u32),
        },
    })
}

// ─── Mainnet genesis ──────────────────────────────────────────────────────────

/// Mainnet genesis.
///
/// Deliberately not reachable from a `--chain` id: every argument below is a
/// real-world key or allocation that must be supplied by whoever builds the
/// launch spec, and none of them has a defensible default. Call this from a
/// spec-building tool, then ship the resulting JSON.
pub fn mainnet_genesis_config(
    initial_authorities: Vec<(
        AccountId,
        AccountId,
        GrandpaId,
        BabeId,
        AuthorityDiscoveryId,
    )>,
    founder_accounts: Vec<(AccountId, Balance)>,
    researcher_multisig: AccountId,
    bootstrap_multisig: AccountId,
    // V4: root_key is a 3-of-5 multisig account, held by the operators.
    // Removal via sudo.set_key(None) is SCHEDULED FOR MAINNET and is not implemented
    // here: nothing in this crate or in runtime/ schedules it, so it will not happen
    // on its own. Stated as a plan, not as a fact — an earlier version of this comment
    // asserted it as done and the published docs repeated the claim.
    root_key: AccountId,
) -> ChainSpec {
    let founder_total: Balance = founder_accounts.iter().map(|(_, b)| b).sum();
    assert_eq!(
        founder_total + RESEARCHERS_ALLOC + TREASURY_ALLOC + BOOTSTRAP_ALLOC,
        GENESIS_MINT,
        "Mainnet genesis allocations must equal GENESIS_MINT"
    );

    let mut properties = Properties::new();
    properties.insert("tokenSymbol".into(), "CMN".into());
    properties.insert("tokenDecimals".into(), 12u32.into());
    // MAINNET BLOCKER: register a unique SS58 prefix before launch via PR to
    // https://github.com/paritytech/ss58-registry — replace 42 with the registered value.
    properties.insert("ss58Format".into(), 42u32.into());

    let stakers: Vec<(
        AccountId,
        AccountId,
        Balance,
        pallet_staking::StakerStatus<AccountId>,
    )> = initial_authorities
        .iter()
        .map(|(stash, ctrl, ..)| {
            (
                stash.clone(),
                ctrl.clone(),
                VALIDATOR_STASH_BOND,
                pallet_staking::StakerStatus::Validator,
            )
        })
        .collect();

    let session_keys: Vec<_> = initial_authorities
        .iter()
        .map(|(stash, _ctrl, gp, ba, ad)| {
            (
                stash.clone(),
                stash.clone(),
                SessionKeys {
                    grandpa: gp.clone(),
                    babe: ba.clone(),
                    authority_discovery: ad.clone(),
                },
            )
        })
        .collect();

    // ROUND4: the founding-TC seeding built here is removed for the same
    // reason as in `dev_genesis` — `pallet_ranked_collective` has no genesis
    // config at polkadot-stable2503, so the key was rejected before genesis
    // could be built. The `agents` genesis below still inducts and promotes
    // the initial validators' agent accounts.

    // V4: Genesis agents — the 3 initial validators are also registered agents.
    // Each gets the minimum 10,000 CMN stake (FullFloorStake = floor emissions enabled).
    let genesis_agents: Vec<serde_json::Value> = initial_authorities
        .iter()
        .take(3)
        .map(|(stash, ..)| serde_json::json!([stash, GENESIS_AGENT_STAKE, true]))
        .collect();

    let mut balances: Vec<(AccountId, Balance)> = initial_authorities
        .iter()
        .flat_map(|(stash, ctrl, ..)| {
            [
                (stash.clone(), VALIDATOR_STASH_BOND * 2),
                (ctrl.clone(), VALIDATOR_CONTROLLER_BALANCE),
            ]
        })
        .chain(founder_accounts.iter().map(|(a, b)| (a.clone(), *b)))
        .chain([
            (researcher_multisig.clone(), RESEARCHERS_ALLOC),
            (bootstrap_multisig.clone(), BOOTSTRAP_ALLOC),
            // V4: Treasury pre-funded at genesis — 5B CMN for early governance operations.
            // Intended to be accessed only via Track 1 spend proposals once sudo is
            // removed at mainnet. Until then root can still reach it.
            (
                scalar_commons_runtime::treasury_account_id(),
                TREASURY_ALLOC,
            ),
        ])
        .collect();

    balances.sort_by_key(|(a, _)| a.clone());
    balances.dedup_by(|(a1, b1), (a2, b2)| {
        if a1 == a2 {
            *b2 = b2.saturating_add(*b1);
            true
        } else {
            false
        }
    });

    ChainSpec::builder(
        scalar_commons_runtime::WASM_BINARY.expect("WASM binary not available"),
        Default::default(),
    )
    .with_name("Scalar Commons")
    .with_id("scalar-commons")
    .with_chain_type(ChainType::Live)
    .with_properties(properties)
    .with_genesis_config_patch(serde_json::json!({
        "balances": { "balances": balances },
        "session":  { "keys": session_keys },
        "staking": {
            "validatorCount":        initial_authorities.len() as u32,
            "minimumValidatorCount": 3u32,
            "stakers":               stakers,
            "invulnerables":         initial_authorities.iter().map(|(s,..)| s.clone()).collect::<Vec<_>>(),
            // V4: slash reward fraction set to 10% (100_000_000 / 1_000_000_000 = 10%)
            // Slashers who report misbehavior receive 10% of the slash as incentive.
            "slashRewardFraction":   100_000_000u32,
        },
        "babe":   { "authorities": [], "epochConfig": BABE_GENESIS_EPOCH_CONFIG },
        "grandpa": { "authorities": [] },
        // V4: sudo is a 3-of-5 bootstrap multisig, held by the operators.
        // Removal is scheduled for mainnet and is not yet implemented anywhere.
        "sudo": { "key": Some(root_key) },
        // V4: agents pre-registered — 3 genesis validators are also founding agents.
        "agents": { "agents": genesis_agents },
        // V4: auto-params runs every era from era 1 — F-02 fixed in genesis.
        "autoParams": {},
        // ROUND4: `rankedCollective`, `referenda`, `convictionVoting`,
        // `whitelist` and `constitution` removed — none declares a genesis
        // config, so none is a field of `RuntimeGenesisConfig`. All five stay
        // wired in `construct_runtime` and active from block 1.
        "safeMode":  {},
        "txPause":   {},
        // V4: Treasury active from block 1.
        "treasury": {},
        // V4: Nomination pools — any agent with ≥100 CMN can pool-stake immediately.
        "nominationPools": {
            "minJoinBond":       100u128 * 1_000_000_000_000u128,
            "minCreateBond":     5_000u128 * 1_000_000_000_000u128,
            "maxPools":          Some(1_000u32),
            "maxMembersPerPool": Some(1_000u32),
        },
    }))
    .build()
}
