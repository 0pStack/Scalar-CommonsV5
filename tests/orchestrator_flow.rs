//! Integration test: orchestrator sub-agent coordination and emission flow

use super::common;
use common::*;
use frame_support::assert_ok;

#[test]
fn orchestrator_accumulates_sub_agent_volume() {
    new_test_ext().execute_with(|| {
        // FRANK is the orchestrator; ALICE, BOB are sub-agents; CAROL, DAVE are buyers
        register(FRANK, FULL_STAKE); // orchestrator
        register(ALICE, FULL_STAKE); // sub-agent 1
        register(BOB, FULL_STAKE); // sub-agent 2
        register(CAROL, FULL_STAKE); // buyer (not sub-agent)
        register(DAVE, FULL_STAKE); // buyer

        // Register FRANK as orchestrator (bypass rank check with direct storage insert)
        pallet_orchestrator::OrchestratorRegistration::<TestRuntime>::insert(
            FRANK,
            pallet_orchestrator::OrchestratorRecord::<TestRuntime> {
                max_sub_agents: 10,
                fee_bps: 200,
                registered_at: frame_system::Pallet::<TestRuntime>::block_number(),
                active_sub_count: 0,
            },
        );
        pallet_orchestrator::OrchestratorRewardDebt::<TestRuntime>::insert(FRANK, 0u128);

        // Link ALICE and BOB to FRANK as sub-agents
        let expiry = frame_system::Pallet::<TestRuntime>::block_number() + 100;
        pallet_orchestrator::PendingLinkProposals::<TestRuntime>::insert(FRANK, ALICE, expiry);
        pallet_orchestrator::PendingLinkProposals::<TestRuntime>::insert(FRANK, BOB, expiry);

        assert_ok!(
            pallet_orchestrator::Pallet::<TestRuntime>::accept_orchestrator_link(
                RuntimeOrigin::signed(ALICE),
                FRANK
            )
        );
        assert_ok!(
            pallet_orchestrator::Pallet::<TestRuntime>::accept_orchestrator_link(
                RuntimeOrigin::signed(BOB),
                FRANK
            )
        );

        // Verify links established
        assert_eq!(
            pallet_orchestrator::SubAgentToOrchestrator::<TestRuntime>::get(ALICE),
            Some(FRANK)
        );
        assert_eq!(
            pallet_orchestrator::SubAgentToOrchestrator::<TestRuntime>::get(BOB),
            Some(FRANK)
        );

        // Sub-agents complete escrows — volume should credit to orchestrator
        let vol_before = pallet_orchestrator::EraOrchestratorVolume::<TestRuntime>::get(FRANK);

        complete_escrow(CAROL, ALICE, 5_000 * CMN, 50);
        complete_escrow(DAVE, BOB, 4_000 * CMN, 50);

        let vol_after = pallet_orchestrator::EraOrchestratorVolume::<TestRuntime>::get(FRANK);
        assert!(
            vol_after > vol_before,
            "Orchestrator volume should accumulate from sub-agent completions"
        );
        println!("Orchestrator volume: before={vol_before} after={vol_after}");
    });
}

#[test]
fn orchestrator_proposal_expiry_enforced() {
    new_test_ext().execute_with(|| {
        register(FRANK, FULL_STAKE);
        register(ALICE, FULL_STAKE);

        pallet_orchestrator::OrchestratorRegistration::<TestRuntime>::insert(
            FRANK,
            pallet_orchestrator::OrchestratorRecord::<TestRuntime> {
                max_sub_agents: 5,
                fee_bps: 100,
                registered_at: 0,
                active_sub_count: 0,
            },
        );

        // Propose link
        assert_ok!(
            pallet_orchestrator::Pallet::<TestRuntime>::propose_sub_agent_link(
                RuntimeOrigin::signed(FRANK),
                ALICE
            )
        );

        // Advance past LinkApprovalWindow (100 blocks in test config)
        go_to_block(200);

        // Accept should fail — proposal expired
        use frame_support::assert_noop;
        assert_noop!(
            pallet_orchestrator::Pallet::<TestRuntime>::accept_orchestrator_link(
                RuntimeOrigin::signed(ALICE),
                FRANK
            ),
            pallet_orchestrator::Error::<TestRuntime>::ProposalExpired
        );
    });
}

#[test]
fn sub_agent_single_orchestrator_limit() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE); // orchestrator 1
        register(CAROL, FULL_STAKE); // orchestrator 2

        for orch in [BOB, CAROL] {
            pallet_orchestrator::OrchestratorRegistration::<TestRuntime>::insert(
                orch,
                pallet_orchestrator::OrchestratorRecord::<TestRuntime> {
                    max_sub_agents: 5,
                    fee_bps: 100,
                    registered_at: 0,
                    active_sub_count: 0,
                },
            );
        }

        // Link to BOB
        let expiry = frame_system::Pallet::<TestRuntime>::block_number() + 100;
        pallet_orchestrator::PendingLinkProposals::<TestRuntime>::insert(BOB, ALICE, expiry);
        assert_ok!(
            pallet_orchestrator::Pallet::<TestRuntime>::accept_orchestrator_link(
                RuntimeOrigin::signed(ALICE),
                BOB
            )
        );

        // Try to also link to CAROL — should fail
        pallet_orchestrator::PendingLinkProposals::<TestRuntime>::insert(CAROL, ALICE, expiry);
        use frame_support::assert_noop;
        assert_noop!(
            pallet_orchestrator::Pallet::<TestRuntime>::accept_orchestrator_link(
                RuntimeOrigin::signed(ALICE),
                CAROL
            ),
            pallet_orchestrator::Error::<TestRuntime>::AlreadyLinked
        );
    });
}
