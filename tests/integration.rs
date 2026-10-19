//! # Scalar Commons Integration Tests
//!
//! These tests run the full runtime (all 33 pallets) in a test environment.
//! Unlike unit tests which test one pallet in isolation, these tests validate
//! cross-pallet flows that are impossible to test in isolation.
//!
//! ## Running
//! ```bash
//! cargo test --test integration
//! ```
//!
//! ## Key flows tested
//! 1. `era_cycle_full` — register agents → work → era drain → claim
//! 2. `dispute_oracle_settlement` — escrow dispute → oracle vote → settlement
//! 3. `ring_detection_auto_response` — ring farming → auto-param fee increase
//! 4. `rank_promotion_chain` — full rank progression 0→1→2→3
//! 5. `supply_cap_enforcement` — emissions stop exactly at 100B CMN
//! 6. `orchestrator_aggregation` — sub-agents → orchestrator volume → claim
//! 7. `emission_volume_cap` — governance alpha → settle_era → the D7 emission bound
//! 8. `messaging_flow` — messaging keys → Offer/Accept → escrow commits to the accepted hash

#![cfg(test)]

mod common;
mod dispute_flow;
mod emission_volume_cap;
mod era_cycle;
mod gov_credit;
mod messaging_flow;
mod orchestrator_flow;
mod rank_promotion;
mod ring_detection;
mod supply_cap;
