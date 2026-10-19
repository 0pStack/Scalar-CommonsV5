//! Integration test: escrow dispute → oracle consensus → settlement

use super::common;
use common::*;
use frame_support::assert_ok;

#[test]
fn dispute_provider_wins() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE); // buyer
        register(BOB, FULL_STAKE); // provider
        register(CAROL, FULL_STAKE); // oracle agent 1
        register(DAVE, FULL_STAKE); // oracle agent 2
        register(EVE, FULL_STAKE); // oracle agent 3

        let task_amount = 10_000 * CMN;
        let deliver_by = frame_system::Pallet::<TestRuntime>::block_number() + 500;

        // Create agreement
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            task_amount,
            [1u8; 32],
            deliver_by,
            None
        ));

        // Provider consents (#180), then delivers
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        go_to_block(10);
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));

        // Buyer disputes
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));

        // Agreement should now be Disputed
        let agreements = pallet_escrow::Agreements::<TestRuntime>::get(ALICE, BOB);
        assert_eq!(agreements.len(), 1);
        assert_eq!(
            agreements[0].status,
            pallet_escrow::AgreementStatus::Disputed
        );

        // Oracle question created — find its request_id
        let dispute_to_agreement = pallet_escrow::DisputeToAgreement::<TestRuntime>::iter().next();
        assert!(
            dispute_to_agreement.is_some(),
            "DisputeToAgreement entry should exist"
        );
        let (request_id, _) = dispute_to_agreement.unwrap();

        // Provider wins preimage
        let winner_hash: [u8; 32] = sp_io::hashing::blake2_256(b"scalar:dispute:provider_wins");

        // Oracle agents vote provider wins (majority)
        assert_ok!(pallet_oracle::Pallet::<TestRuntime>::submit_response(
            RuntimeOrigin::signed(CAROL),
            request_id,
            winner_hash,
            0
        ));
        assert_ok!(pallet_oracle::Pallet::<TestRuntime>::submit_response(
            RuntimeOrigin::signed(DAVE),
            request_id,
            winner_hash,
            0
        ));
        assert_ok!(pallet_oracle::Pallet::<TestRuntime>::submit_response(
            RuntimeOrigin::signed(EVE),
            request_id,
            [99u8; 32],
            0 // disagrees
        ));

        // Advance past challenge window
        let req = pallet_oracle::OracleRequests::<TestRuntime>::get(request_id).unwrap();
        go_to_block(req.response_deadline + req.challenge_window + 1);

        let bob_bal_before = pallet_balances::Pallet::<TestRuntime>::free_balance(BOB);

        // Finalise oracle request — triggers DisputeCallback → escrow settlement
        assert_ok!(pallet_oracle::Pallet::<TestRuntime>::finalise_request(
            RuntimeOrigin::signed(CAROL),
            request_id
        ));

        // Provider (BOB) should receive payment
        let bob_bal_after = pallet_balances::Pallet::<TestRuntime>::free_balance(BOB);
        assert!(
            bob_bal_after > bob_bal_before,
            "Provider should receive payment on win"
        );

        // Agreement removed
        let agreements_post = pallet_escrow::Agreements::<TestRuntime>::get(ALICE, BOB);
        assert!(
            agreements_post.is_empty(),
            "Agreement should be removed after settlement"
        );

        // Oracle scores updated (CAROL + DAVE voted correctly)
        let carol_score = pallet_oracle::OracleScore::<TestRuntime>::get(CAROL, 0);
        let dave_score = pallet_oracle::OracleScore::<TestRuntime>::get(DAVE, 0);
        let eve_score = pallet_oracle::OracleScore::<TestRuntime>::get(EVE, 0);
        assert!(
            carol_score > eve_score,
            "Correct voters should outscore incorrect"
        );
        assert_eq!(
            dave_score, carol_score,
            "Both correct voters should have same score"
        );
    });
}

#[test]
fn dispute_buyer_wins() {
    new_test_ext().execute_with(|| {
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        register(CAROL, FULL_STAKE);
        register(DAVE, FULL_STAKE);
        register(EVE, FULL_STAKE);

        let task_amount = 5_000 * CMN;
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            task_amount,
            [1u8; 32],
            frame_system::Pallet::<TestRuntime>::block_number() + 200,
            None
        ));
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::accept_agreement(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0
        ));
        go_to_block(10);
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::record_delivery(
            RuntimeOrigin::signed(BOB),
            ALICE,
            0,
            [2u8; 32]
        ));
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::dispute_delivery(
            RuntimeOrigin::signed(ALICE),
            BOB,
            0
        ));

        let (request_id, _) = pallet_escrow::DisputeToAgreement::<TestRuntime>::iter()
            .next()
            .unwrap();

        // Buyer wins vote (all 3 oracle agents agree buyer wins)
        let buyer_wins: [u8; 32] = [0u8; 32]; // non-provider-wins = buyer wins
        for agent in [CAROL, DAVE, EVE] {
            assert_ok!(pallet_oracle::Pallet::<TestRuntime>::submit_response(
                RuntimeOrigin::signed(agent),
                request_id,
                buyer_wins,
                0
            ));
        }

        let req = pallet_oracle::OracleRequests::<TestRuntime>::get(request_id).unwrap();
        go_to_block(req.response_deadline + req.challenge_window + 1);

        let alice_bal_before = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);

        assert_ok!(pallet_oracle::Pallet::<TestRuntime>::finalise_request(
            RuntimeOrigin::signed(CAROL),
            request_id
        ));

        let alice_bal_after = pallet_balances::Pallet::<TestRuntime>::free_balance(ALICE);
        assert!(
            alice_bal_after > alice_bal_before,
            "Buyer should get refund on win"
        );
    });
}
