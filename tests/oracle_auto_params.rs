//! Cross-pallet coverage for F14: the oracle must consume the live auto-param.

use crate::common::{new_test_ext, TestRuntime, ALICE, BOB, CMN};
use pallet_auto_params::pallet::EraMetrics;

#[test]
fn oracle_participation_rule_changes_the_next_dispute_quorum() {
    new_test_ext().execute_with(|| {
        assert_eq!(
            pallet_auto_params::MinScoreEligibleResponses::<TestRuntime>::get(),
            3
        );

        pallet_auto_params::Pallet::<TestRuntime>::run_era_rules(EraMetrics {
            era_finalized_questions: 10,
            era_total_questions: 10,
            ..Default::default()
        });

        let adjusted = pallet_auto_params::MinScoreEligibleResponses::<TestRuntime>::get();
        assert_eq!(adjusted, 4);

        let question = pallet_oracle::Pallet::<TestRuntime>::post_dispute_question_internal(
            &ALICE, &BOB, 1, CMN, 100, None,
        )
        .expect("funded buyer can post a dispute question");
        let request = pallet_oracle::OracleRequests::<TestRuntime>::get(question)
            .expect("dispute question is stored");

        assert_eq!(request.min_responses, adjusted);
    });
}
