//! Integration test (spec 309): agents negotiate over pallet-messages, then commit the accepted
//! terms to escrow. Also checks that messaging feeds nothing into the economic machinery.

use super::common;
use common::*;
use frame_support::{assert_noop, assert_ok};
use pallet_messages::pallet::{MessageKind, Payload};

fn payload(bytes: &[u8]) -> Payload {
    bytes.to_vec().try_into().expect("within 2 KiB")
}

#[test]
fn negotiate_over_messages_then_commit_accepted_hash_to_escrow() {
    new_test_ext().execute_with(|| {
        go_to_block(1);
        register(ALICE, FULL_STAKE); // buyer
        register(BOB, FULL_STAKE); // provider

        // Both publish messaging keys.
        assert_ok!(pallet_agents::Pallet::<TestRuntime>::set_messaging_key(
            RuntimeOrigin::signed(ALICE),
            [0xA1; 32]
        ));
        assert_ok!(pallet_agents::Pallet::<TestRuntime>::set_messaging_key(
            RuntimeOrigin::signed(BOB),
            [0xB2; 32]
        ));

        let terms = b"report #7 for 100 CMN, deliver within 200 blocks";
        let terms_hash = sp_io::hashing::blake2_256(terms);
        let issuance = pallet_balances::Pallet::<TestRuntime>::total_issuance();

        // Provider offers, buyer accepts the same hash.
        assert_ok!(pallet_messages::Pallet::<TestRuntime>::send(
            RuntimeOrigin::signed(BOB),
            ALICE,
            MessageKind::Offer,
            None,
            Some(terms_hash),
            payload(terms),
        ));
        assert_ok!(pallet_messages::Pallet::<TestRuntime>::send(
            RuntimeOrigin::signed(ALICE),
            BOB,
            MessageKind::Accept,
            Some((BOB, 0)),
            Some(terms_hash),
            payload(&[]),
        ));

        // Exactly the two message fees were burned.
        let burned = issuance - pallet_balances::Pallet::<TestRuntime>::total_issuance();
        let expected =
            MESSAGE_BASE_FEE + MESSAGE_PER_BYTE_FEE * terms.len() as u64 + MESSAGE_BASE_FEE;
        assert_eq!(burned, expected);

        // Escrow commits to the accepted hash.
        assert_ok!(pallet_escrow::Pallet::<TestRuntime>::create_agreement(
            RuntimeOrigin::signed(ALICE),
            BOB,
            100 * CMN,
            terms_hash,
            frame_system::Pallet::<TestRuntime>::block_number() + 200,
            None,
        ));
        let agreement = &pallet_escrow::Agreements::<TestRuntime>::get(ALICE, BOB)[0];
        assert_eq!(agreement.deliverable_hash, terms_hash);

        // Delivery notice referencing the agreement.
        assert_ok!(pallet_messages::Pallet::<TestRuntime>::send(
            RuntimeOrigin::signed(BOB),
            ALICE,
            MessageKind::DeliveryNotice,
            Some((ALICE, 0)),
            Some([0x77; 32]),
            payload(&[]),
        ));
        assert_eq!(pallet_messages::NextNonce::<TestRuntime>::get(BOB), 2);
        assert_eq!(pallet_messages::NextNonce::<TestRuntime>::get(ALICE), 1);
    });
}

#[test]
fn messages_add_no_escrow_volume_or_completions() {
    new_test_ext().execute_with(|| {
        go_to_block(1);
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        let era = pallet_agents::EraNumber::<TestRuntime>::get();

        for block in 2..6u64 {
            go_to_block(block);
            for _ in 0..4 {
                assert_ok!(pallet_messages::Pallet::<TestRuntime>::send(
                    RuntimeOrigin::signed(ALICE),
                    BOB,
                    MessageKind::Offer,
                    None,
                    None,
                    payload(&[0u8; 512]),
                ));
            }
        }

        // Sixteen messages; nothing that sizes or weights emissions moved.
        assert_eq!(
            pallet_agents::EraEscrowVolume::<TestRuntime>::get(BOB),
            0,
            "messages are not escrow volume"
        );
        assert_eq!(
            pallet_agents::CompletedAgreements::<TestRuntime>::get(BOB),
            0
        );
        assert_eq!(pallet_agents::EraNumber::<TestRuntime>::get(), era);
    });
}

#[test]
fn unstaked_agent_loses_key_and_can_no_longer_send_or_receive() {
    new_test_ext().execute_with(|| {
        go_to_block(1);
        register(ALICE, FULL_STAKE);
        register(BOB, FULL_STAKE);
        assert_ok!(pallet_agents::Pallet::<TestRuntime>::set_messaging_key(
            RuntimeOrigin::signed(BOB),
            [0xB2; 32]
        ));
        assert_ok!(pallet_agents::Pallet::<TestRuntime>::request_unstake(
            RuntimeOrigin::signed(BOB)
        ));
        advance_blocks(101); // UnstakeCooldown = 100 in this harness
        assert_ok!(pallet_agents::Pallet::<TestRuntime>::complete_unstake(
            RuntimeOrigin::signed(BOB)
        ));

        assert_eq!(pallet_agents::MessagingKey::<TestRuntime>::get(BOB), None);
        assert_noop!(
            pallet_messages::Pallet::<TestRuntime>::send(
                RuntimeOrigin::signed(ALICE),
                BOB,
                MessageKind::Offer,
                None,
                None,
                payload(&[]),
            ),
            pallet_messages::Error::<TestRuntime>::RecipientNotRegistered
        );
        assert_noop!(
            pallet_messages::Pallet::<TestRuntime>::send(
                RuntimeOrigin::signed(BOB),
                ALICE,
                MessageKind::Offer,
                None,
                None,
                payload(&[]),
            ),
            pallet_messages::Error::<TestRuntime>::NotRegistered
        );
    });
}
