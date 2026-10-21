//! Executive regressions for emergency filtering and cap-safe mint admission (#60).

use crate::{
    AccountId, Address, Balance, Balances, Executive, Header, Runtime, RuntimeCall, RuntimeEvent,
    RuntimeOrigin, SafeMode, Signature, SignedExtra, Staking, System, TxPause, UncheckedExtrinsic,
    CMN, SUPPLY_CAP,
};
use frame_support::{assert_ok, traits::tokens::fungible::hold::Inspect as InspectHold};
use parity_scale_codec::Encode;
use sp_core::{sr25519, Pair};
use sp_runtime::{generic, traits::Header as HeaderT, BuildStorage, Digest, DigestItem};

fn signer(n: u8) -> sr25519::Pair {
    sr25519::Pair::from_seed(&[n; 32])
}

fn account(n: u8) -> AccountId {
    signer(n).public().into()
}

/// Real signatures, fee charging, dispatch filters and BABE timestamp handling.
fn externalities() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Runtime>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Runtime> {
        balances: (1..=4)
            .map(|n| (account(n), CMN.saturating_mul(1_000_000)))
            .collect(),
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    pallet_sudo::GenesisConfig::<Runtime> {
        key: Some(account(1)),
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    let mut ext: sp_io::TestExternalities = storage.into();
    ext.execute_with(|| {
        let digest = sp_consensus_babe::digests::PreDigest::SecondaryPlain(
            sp_consensus_babe::digests::SecondaryPlainPreDigest {
                authority_index: 0,
                slot: 1.into(),
            },
        );
        let header = Header::new(
            1,
            Default::default(),
            Default::default(),
            Default::default(),
            Digest {
                logs: vec![DigestItem::PreRuntime(
                    sp_consensus_babe::BABE_ENGINE_ID,
                    digest.encode(),
                )],
            },
        );
        Executive::initialize_block(&header);
    });
    ext
}

fn apply_ok(extrinsic: UncheckedExtrinsic) {
    assert_eq!(Executive::apply_extrinsic(extrinsic), Ok(Ok(())));
}

fn timestamp() -> UncheckedExtrinsic {
    UncheckedExtrinsic::new_bare(RuntimeCall::Timestamp(pallet_timestamp::Call::set {
        now: crate::MILLISECS_PER_BLOCK,
    }))
}

fn signed(call: RuntimeCall, n: u8, nonce: u32) -> UncheckedExtrinsic {
    let extra: SignedExtra = (
        frame_system::CheckNonZeroSender::<Runtime>::new(),
        frame_system::CheckSpecVersion::<Runtime>::new(),
        frame_system::CheckTxVersion::<Runtime>::new(),
        frame_system::CheckGenesis::<Runtime>::new(),
        frame_system::CheckEra::<Runtime>::from(generic::Era::Immortal),
        frame_system::CheckNonce::<Runtime>::from(nonce),
        frame_system::CheckWeight::<Runtime>::new(),
        pallet_transaction_payment::ChargeTransactionPayment::<Runtime>::from(0),
    );
    let payload = generic::SignedPayload::new(call.clone(), extra.clone()).unwrap();
    let signature = payload.using_encoded(|bytes| signer(n).sign(bytes));
    UncheckedExtrinsic::new_signed(
        call,
        Address::Id(account(n)),
        Signature::from(signature),
        extra,
    )
}

fn transfer() -> RuntimeCall {
    RuntimeCall::Balances(pallet_balances::Call::transfer_allow_death {
        dest: Address::Id(account(2)),
        value: CMN,
    })
}

fn transfer_name() -> pallet_tx_pause::RuntimeCallNameOf<Runtime> {
    (
        b"Balances".to_vec().try_into().unwrap(),
        b"transfer_allow_death".to_vec().try_into().unwrap(),
    )
}

#[test]
fn paused_call_is_rejected_by_executive_and_unpause_restores_it() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(TxPause::pause(RuntimeOrigin::root(), transfer_name()));
        let before = Balances::free_balance(account(2));
        assert_eq!(
            Executive::apply_extrinsic(signed(transfer(), 1, 0)),
            Ok(Err(frame_system::Error::<Runtime>::CallFiltered.into()))
        );
        assert_eq!(Balances::free_balance(account(2)), before);
        assert_ok!(TxPause::unpause(RuntimeOrigin::root(), transfer_name()));
        apply_ok(signed(transfer(), 1, 1));
        assert_eq!(
            Balances::free_balance(account(2)),
            before.saturating_add(CMN)
        );
    });
}

#[test]
fn safe_mode_is_enforced_by_executive_and_exit_restores_calls() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        assert_eq!(
            Executive::apply_extrinsic(signed(transfer(), 1, 0)),
            Ok(Err(frame_system::Error::<Runtime>::CallFiltered.into()))
        );
        assert_ok!(SafeMode::force_exit(RuntimeOrigin::root()));
        apply_ok(signed(transfer(), 1, 1));
    });
}

#[test]
fn leaving_safe_mode_does_not_disable_a_surgical_pause() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        assert_ok!(TxPause::pause(RuntimeOrigin::root(), transfer_name()));
        assert_ok!(SafeMode::force_exit(RuntimeOrigin::root()));
        assert_eq!(
            Executive::apply_extrinsic(signed(transfer(), 1, 0)),
            Ok(Err(frame_system::Error::<Runtime>::CallFiltered.into()))
        );
    });
}

#[test]
fn over_cap_timestamp_inherent_still_applies_through_executive() {
    externalities().execute_with(|| {
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        let legacy: pallet_tx_pause::RuntimeCallNameOf<Runtime> = (
            b"Timestamp".to_vec().try_into().unwrap(),
            b"set".to_vec().try_into().unwrap(),
        );
        pallet_tx_pause::PausedCalls::<Runtime>::insert(legacy, ());
        pallet_balances::TotalIssuance::<Runtime>::put(SUPPLY_CAP.saturating_add(1));
        apply_ok(timestamp());
        assert_eq!(crate::Timestamp::get(), crate::MILLISECS_PER_BLOCK);
    });
}

#[test]
fn over_cap_sudo_recovery_remains_callable_during_safe_mode() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        pallet_balances::TotalIssuance::<Runtime>::put(
            SUPPLY_CAP.saturating_add(CMN.saturating_mul(1_000)),
        );
        let call = RuntimeCall::Sudo(pallet_sudo::Call::sudo {
            call: Box::new(RuntimeCall::Balances(
                pallet_balances::Call::force_adjust_total_issuance {
                    direction: pallet_balances::AdjustmentDirection::Decrease,
                    delta: CMN.saturating_mul(1_000),
                },
            )),
        });
        apply_ok(signed(call, 1, 0));
        assert!(Balances::total_issuance() <= SUPPLY_CAP);
    });
}

#[test]
fn emergency_controls_inherents_and_economic_liveness_are_unpausable() {
    externalities().execute_with(|| {
        for (pallet, call) in [
            ("Timestamp", "set"),
            ("System", "remark"),
            ("Sudo", "sudo"),
            ("SafeMode", "force_exit"),
            ("TxPause", "unpause"),
            ("Emissions", "settle_era"),
            ("Emissions", "claim"),
            ("Emissions", "batch_claim"),
            ("Orchestrator", "claim_orchestrator"),
            ("NominationPools", "claim_payout"),
            ("NominationPools", "claim_payout_other"),
            ("NominationPools", "claim_commission"),
            ("Staking", "payout_stakers"),
            ("Staking", "payout_stakers_by_page"),
        ] {
            let name = (
                pallet.as_bytes().to_vec().try_into().unwrap(),
                call.as_bytes().to_vec().try_into().unwrap(),
            );
            assert_eq!(
                TxPause::pause(RuntimeOrigin::root(), name),
                Err(pallet_tx_pause::Error::<Runtime>::Unpausable.into()),
                "{pallet}.{call} must remain available"
            );
        }
    });
}

/// A genuine bonded ledger and a historical era reward, without new inflation.
fn historical_reward(pot: Balance) {
    let stash = account(2);
    let stake = CMN.saturating_mul(100);
    assert_ok!(Staking::bond(
        RuntimeOrigin::signed(stash.clone()),
        stake,
        pallet_staking::RewardDestination::Stash,
    ));
    pallet_staking::CurrentEra::<Runtime>::put(1);
    pallet_staking::ErasValidatorReward::<Runtime>::insert(0, pot);
    pallet_staking::ErasRewardPoints::<Runtime>::insert(
        0,
        pallet_staking::EraRewardPoints {
            total: 1,
            individual: [(stash.clone(), 1)].into_iter().collect(),
        },
    );
    pallet_staking::EraInfo::<Runtime>::set_exposure(
        0,
        &stash,
        pallet_staking::Exposure {
            total: stake,
            own: stake,
            others: vec![],
        },
    );
}

fn payout(paged: bool) -> RuntimeCall {
    if paged {
        RuntimeCall::Staking(pallet_staking::Call::payout_stakers_by_page {
            validator_stash: account(2),
            era: 0,
            page: 0,
        })
    } else {
        RuntimeCall::Staking(pallet_staking::Call::payout_stakers {
            validator_stash: account(2),
            era: 0,
        })
    }
}

/// Refusal must precede claim markers, staking ledger updates and any deposit.
fn legacy_reward_respects_cap(paged: bool) {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        historical_reward(CMN);
        pallet_balances::TotalIssuance::<Runtime>::put(SUPPLY_CAP);
        let stash = account(2);
        let balance = Balances::free_balance(&stash);
        let ledger = pallet_staking::Ledger::<Runtime>::get(&stash).encode();
        let held = Balances::total_balance_on_hold(&stash);
        assert_eq!(
            Executive::apply_extrinsic(signed(payout(paged), 1, 0)),
            Ok(Err(frame_system::Error::<Runtime>::CallFiltered.into()))
        );
        assert!(pallet_staking::ClaimedRewards::<Runtime>::get(0, &stash).is_empty());
        assert_eq!(Balances::free_balance(&stash), balance);
        assert_eq!(
            pallet_staking::Ledger::<Runtime>::get(&stash).encode(),
            ledger
        );
        assert_eq!(Balances::total_balance_on_hold(&stash), held);
    });
    externalities().execute_with(|| {
        apply_ok(timestamp());
        historical_reward(CMN);
        pallet_balances::TotalIssuance::<Runtime>::put(
            SUPPLY_CAP.saturating_sub(CMN.saturating_mul(2)),
        );
        let stash = account(2);
        let balance = Balances::free_balance(&stash);
        apply_ok(signed(payout(paged), 1, 0));
        assert_eq!(Balances::free_balance(&stash), balance.saturating_add(CMN));
        assert!(pallet_staking::ClaimedRewards::<Runtime>::get(0, &stash).contains(&0));
        assert!(Balances::total_issuance() <= SUPPLY_CAP);
    });
}

#[test]
fn legacy_staking_payout_checks_cap_before_claiming() {
    legacy_reward_respects_cap(false);
}

#[test]
fn legacy_paged_staking_payout_checks_cap_before_claiming() {
    legacy_reward_respects_cap(true);
}

/// Nearest rounding can make a page pay more than its nominal era pot.
fn rounding_reward() {
    historical_reward(2);
    for n in [3, 4] {
        pallet_staking::Payee::<Runtime>::insert(
            account(n),
            pallet_staking::RewardDestination::Stash,
        );
    }
    pallet_staking::EraInfo::<Runtime>::set_exposure(
        0,
        &account(2),
        pallet_staking::Exposure {
            total: 3,
            own: 1,
            others: vec![
                pallet_staking::IndividualExposure {
                    who: account(3),
                    value: 1,
                },
                pallet_staking::IndividualExposure {
                    who: account(4),
                    value: 1,
                },
            ],
        },
    );
}

#[test]
fn pinned_sdk_can_round_a_two_planck_pot_up_to_three() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        rounding_reward();
        let balances: Vec<_> = (2..=4)
            .map(|n| Balances::free_balance(account(n)))
            .collect();
        assert_ok!(Staking::payout_stakers(
            RuntimeOrigin::signed(account(1)),
            account(2),
            0
        ));
        let minted = (2..=4).zip(balances).fold(0u128, |sum, (n, before)| {
            sum.saturating_add(Balances::free_balance(account(n)).saturating_sub(before))
        });
        assert_eq!(minted, 3);
    });
}

#[test]
fn historical_reward_admission_accounts_for_rounding() {
    for paged in [false, true] {
        externalities().execute_with(|| {
            apply_ok(timestamp());
            rounding_reward();
            pallet_balances::TotalIssuance::<Runtime>::put(SUPPLY_CAP.saturating_sub(2));
            assert_eq!(
                Executive::apply_extrinsic(signed(payout(paged), 1, 0)),
                Ok(Err(frame_system::Error::<Runtime>::CallFiltered.into()))
            );
            assert!(pallet_staking::ClaimedRewards::<Runtime>::get(0, account(2)).is_empty());
        });
    }
}

#[test]
fn zero_reward_does_not_require_mint_headroom() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        historical_reward(0);
        pallet_balances::TotalIssuance::<Runtime>::put(
            SUPPLY_CAP.saturating_add(CMN.saturating_mul(1_000)),
        );
        let before = Balances::free_balance(account(2));
        apply_ok(signed(payout(false), 1, 0));
        assert_eq!(Balances::free_balance(account(2)), before);
    });
}

#[test]
fn over_cap_nonminting_transfer_remains_live() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        pallet_balances::TotalIssuance::<Runtime>::put(
            SUPPLY_CAP.saturating_add(CMN.saturating_mul(1_000)),
        );
        let before = Balances::free_balance(account(2));
        apply_ok(signed(transfer(), 1, 0));
        assert_eq!(
            Balances::free_balance(account(2)),
            before.saturating_add(CMN)
        );
    });
}

#[test]
fn ordinary_utility_batch_cannot_bypass_a_paused_inner_call() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(TxPause::pause(RuntimeOrigin::root(), transfer_name()));
        let before = Balances::free_balance(account(2));
        let batch = RuntimeCall::Utility(pallet_utility::Call::batch {
            calls: vec![transfer()],
        });
        apply_ok(signed(batch, 1, 0));
        assert_eq!(Balances::free_balance(account(2)), before);
        assert!(System::events().iter().any(|record| matches!(
            &record.event,
            RuntimeEvent::Utility(pallet_utility::Event::BatchInterrupted { index: 0, error })
                if *error == frame_system::Error::<Runtime>::CallFiltered.into()
        )));
    });
}

#[test]
fn protected_emissions_batch_keeps_its_real_mint_clamp() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        for n in [2, 3] {
            assert_ok!(crate::Agents::register(
                RuntimeOrigin::signed(account(n)),
                crate::AgentsMinStake::get(),
            ));
        }
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        pallet_emissions::AccRewardPerStake::<Runtime>::put(
            pallet_emissions::ACC_SCALE.saturating_mul(10),
        );
        for n in [2, 3] {
            pallet_emissions::AgentWeightSnapshot::<Runtime>::insert(account(n), 1);
        }
        pallet_balances::TotalIssuance::<Runtime>::put(SUPPLY_CAP.saturating_sub(5));
        let first = Balances::free_balance(account(2));
        let second = Balances::free_balance(account(3));
        let call = RuntimeCall::Emissions(pallet_emissions::Call::batch_claim {
            agents: vec![account(2), account(3)],
        });
        apply_ok(signed(call, 1, 0));
        assert_eq!(Balances::free_balance(account(2)), first.saturating_add(5));
        assert_eq!(Balances::free_balance(account(3)), second);
        assert!(Balances::total_issuance() <= SUPPLY_CAP);
    });
}

#[test]
fn protected_orchestrator_claim_keeps_its_real_mint_clamp() {
    externalities().execute_with(|| {
        apply_ok(timestamp());
        assert_ok!(SafeMode::force_enter(RuntimeOrigin::root()));
        pallet_orchestrator::OrchestratorGlobalAcc::<Runtime>::put(
            pallet_orchestrator::ACC_SCALE.saturating_mul(10),
        );
        pallet_orchestrator::OrchestratorWeightSnapshot::<Runtime>::insert(account(2), 1);
        pallet_balances::TotalIssuance::<Runtime>::put(SUPPLY_CAP.saturating_sub(5));
        let call = RuntimeCall::Orchestrator(pallet_orchestrator::Call::claim_orchestrator {});
        apply_ok(signed(call, 2, 0));
        assert!(System::events().iter().any(|record| matches!(
            &record.event,
            RuntimeEvent::Orchestrator(pallet_orchestrator::Event::OrchestratorRewardClaimed {
                amount: 5,
                ..
            })
        )));
        assert!(Balances::total_issuance() <= SUPPLY_CAP);
    });
}
