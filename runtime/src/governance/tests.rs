//! Regression coverage for the real runtime's Technical Council permission boundary.

use crate::{
    AccountId, Balances, OriginCaller, Preimage, RankedCollective, RankedPolls, Referenda, Runtime,
    RuntimeCall, RuntimeOrigin, System, CMN,
};
use frame_support::{
    assert_noop, assert_ok,
    traits::{schedule::DispatchTime, StorePreimage, VoteTally},
};
use pallet_referenda::{ReferendumInfo, TracksInfo};
use sp_runtime::{BuildStorage, DispatchError, Perbill};

type RankedInstance = pallet_referenda::Instance2;
type RankedTracks = <Runtime as pallet_referenda::Config<RankedInstance>>::Tracks;

/// Keep the electorate independent of balances and agent-promotion shortcuts.
fn account(n: u8) -> AccountId {
    AccountId::new([n; 32])
}

/// Fund both a council member and an unrelated proposer at the real Balance width.
fn externalities() -> sp_io::TestExternalities {
    let mut storage = frame_system::GenesisConfig::<Runtime>::default()
        .build_storage()
        .unwrap();
    pallet_balances::GenesisConfig::<Runtime> {
        balances: vec![
            (account(1), CMN.saturating_mul(100_000)),
            (account(2), CMN.saturating_mul(100_000)),
        ],
        dev_accounts: None,
    }
    .assimilate_storage(&mut storage)
    .unwrap();
    let mut ext: sp_io::TestExternalities = storage.into();
    ext.execute_with(|| System::set_block_number(1));
    ext
}

/// Set up a genuine rank-2 member without weakening the production Config.
fn add_rank_two(n: u8) {
    assert_ok!(RankedCollective::do_add_member(account(n), true));
    assert_ok!(RankedCollective::do_promote_member(account(n), None, true));
    assert_ok!(RankedCollective::do_promote_member(account(n), None, true));
}

/// The proposed execution privilege, distinct from the signed submitting account.
fn root_origin() -> Box<OriginCaller> {
    Box::new(frame_system::RawOrigin::<AccountId>::Root.into())
}

/// Even a harmless payload must not let the ranked electorate obtain Root authority.
fn proposal() -> pallet_referenda::BoundedCallOf<Runtime, RankedInstance> {
    Preimage::bound(RuntimeCall::System(frame_system::Call::remark {
        remark: vec![],
    }))
    .unwrap()
}

#[test]
fn ranked_tracks_cannot_route_root() {
    assert!(RankedTracks::track_for(&root_origin()).is_err());
}

#[test]
fn ordinary_account_cannot_submit_ranked_root_proposal() {
    externalities().execute_with(|| {
        let proposal = proposal();
        assert_noop!(
            RankedPolls::submit(
                RuntimeOrigin::signed(account(2)),
                root_origin(),
                proposal,
                DispatchTime::After(1),
            ),
            DispatchError::BadOrigin
        );
    });
}

#[test]
fn ranked_member_cannot_submit_ranked_root_proposal() {
    externalities().execute_with(|| {
        add_rank_two(1);
        let proposal = proposal();
        assert_noop!(
            RankedPolls::submit(
                RuntimeOrigin::signed(account(1)),
                root_origin(),
                proposal,
                DispatchTime::After(1),
            ),
            DispatchError::BadOrigin
        );
    });
}

#[test]
fn one_rank_two_member_cannot_approve_an_ordinary_accounts_root_proposal() {
    externalities().execute_with(|| {
        add_rank_two(1);
        let submitted = RankedPolls::submit(
            RuntimeOrigin::signed(account(2)),
            root_origin(),
            proposal(),
            DispatchTime::After(1),
        );
        if let Err(error) = submitted {
            assert_eq!(error, DispatchError::BadOrigin);
            return;
        }
        assert_ok!(RankedPolls::place_decision_deposit(
            RuntimeOrigin::signed(account(2)),
            0,
        ));
        System::set_block_number(1 + 8 * 3_600);
        assert_ok!(RankedPolls::nudge_referendum(RuntimeOrigin::root(), 0));
        assert_ok!(RankedCollective::vote(
            RuntimeOrigin::signed(account(1)),
            0,
            true
        ));
        System::set_block_number(2 + 16 * 3_600);
        assert_ok!(RankedPolls::nudge_referendum(RuntimeOrigin::root(), 0));
        let outcome = pallet_referenda::ReferendumInfoFor::<Runtime, RankedInstance>::get(0);
        assert!(
            !matches!(outcome, Some(ReferendumInfo::Approved(..))),
            "one rank-2 member approved a Root proposal from an unrelated account"
        );
    });
}

#[test]
fn ranked_support_uses_eligible_headcount_at_the_pinned_sdk() {
    externalities().execute_with(|| {
        add_rank_two(1);
        add_rank_two(2);
        assert_ok!(RankedCollective::do_add_member(account(3), true));
        let tally = pallet_ranked_collective::TallyOf::<Runtime>::from_parts(1, 1, 0);
        // One aye among two rank-2 members is 50%; the rank-0 member is ineligible.
        assert_eq!(tally.support(2), Perbill::from_percent(50));
    });
}

#[test]
fn stake_referenda_still_accept_signed_root_proposals() {
    externalities().execute_with(|| {
        assert_ok!(Referenda::submit(
            RuntimeOrigin::signed(account(2)),
            root_origin(),
            proposal(),
            DispatchTime::After(1),
        ));
        assert_eq!(pallet_referenda::ReferendumCount::<Runtime>::get(), 1);
        assert_eq!(
            Balances::reserved_balance(account(2)),
            crate::SubmissionDeposit::get()
        );
    });
}
