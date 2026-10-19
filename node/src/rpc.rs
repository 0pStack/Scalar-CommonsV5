//! Scalar Commons node RPC extensions.
//!
//! Ported from `substrate/bin/node/rpc/src/lib.rs` at tag
//! `polkadot-stable2503` (the reference keeps this in its own `node-rpc`
//! crate; a single module is enough here).
//!
//! Kept: `system` (account nonce / pending extrinsics — what any signer needs),
//! `payment` (fee estimation), `babe` and `grandpa`.
//!
//! Omitted because the runtime has no corresponding pallet or API:
//! `mmr` (`MmrRuntimeApi`), `beefy`, `statement`, `mixnet`. Also omitted:
//! `state_trie_migration` and `dev`, which are diagnostics, not chain
//! function, and each drags in another crate.
//!
//! `sync_state` is omitted for a different reason, and it is worth being
//! precise about it because it was tried and reverted. `SyncState::new`
//! requires the chain spec to carry a `lightSyncState` extension; the
//! reference node's `ChainSpec` declares an `Extensions` struct holding one,
//! ours is a plain `sc_service::GenericChainSpec` with `NoExtension`. Wired
//! in regardless, every startup died before the first block:
//!
//! ```text
//! Essential task `babe-worker` failed. Shutting down service.
//! Error: Service(Application(LightSyncStateExtensionNotFound))
//! ```
//!
//! The fix is to adapt the node to the chain spec, not the reverse. The cost
//! is that this node cannot *serve* warp-sync snapshots to others; it can
//! still warp-sync itself, since the GRANDPA warp proof provider is wired in
//! `service.rs`.
//!
//! The four custom `ScalarCommonsApi` methods (`get_agent_info`,
//! `get_era_metrics`, `get_oracle_score`, `get_pending_emissions`) are
//! implemented in the runtime and exported by the WASM blob, but they are NOT
//! surfaced as JSON-RPC here — that is explicitly out of scope for Round 4.
//! They remain reachable via `state_call`.

use std::sync::Arc;

use jsonrpsee::RpcModule;
use sc_client_api::AuxStore;
use sc_consensus_babe::BabeWorkerHandle;
use sc_consensus_grandpa::{
    FinalityProofProvider, GrandpaJustificationStream, SharedAuthoritySet, SharedVoterState,
};
pub use sc_rpc::SubscriptionTaskExecutor;
use sc_transaction_pool_api::TransactionPool;
use scalar_commons_runtime::{
    opaque::Block, AccountId, Balance, BlockNumber, Hash, Index as Nonce,
};
use sp_api::ProvideRuntimeApi;
use sp_block_builder::BlockBuilder;
use sp_blockchain::{Error as BlockChainError, HeaderBackend, HeaderMetadata};
use sp_consensus::SelectChain;
use sp_consensus_babe::BabeApi;
use sp_keystore::KeystorePtr;

/// Extra dependencies for BABE.
pub struct BabeDeps {
    /// A handle to the BABE worker for issuing requests.
    pub babe_worker_handle: BabeWorkerHandle<Block>,
    /// The keystore that manages the keys of the node.
    pub keystore: KeystorePtr,
}

/// Extra dependencies for GRANDPA.
pub struct GrandpaDeps<B> {
    /// Voting round info.
    pub shared_voter_state: SharedVoterState,
    /// Authority set info.
    pub shared_authority_set: SharedAuthoritySet<Hash, BlockNumber>,
    /// Receives notifications about justification events from Grandpa.
    pub justification_stream: GrandpaJustificationStream<Block>,
    /// Executor to drive the subscription manager in the Grandpa RPC handler.
    pub subscription_executor: SubscriptionTaskExecutor,
    /// Finality proof provider.
    pub finality_provider: Arc<FinalityProofProvider<B, Block>>,
}

/// Full client dependencies.
pub struct FullDeps<C, P, SC, B> {
    /// The client instance to use.
    pub client: Arc<C>,
    /// Transaction pool instance.
    pub pool: Arc<P>,
    /// The SelectChain Strategy.
    ///
    /// The reference also carries a `chain_spec` here, used only to construct
    /// the `sync_state` RPC. That RPC is omitted (see the module docs), so the
    /// field is omitted with it rather than left to rot.
    pub select_chain: SC,
    /// BABE specific dependencies.
    pub babe: BabeDeps,
    /// GRANDPA specific dependencies.
    pub grandpa: GrandpaDeps<B>,
}

/// Instantiate all Full RPC extensions.
pub fn create_full<C, P, SC, B>(
    FullDeps {
        client,
        pool,
        select_chain,
        babe,
        grandpa,
    }: FullDeps<C, P, SC, B>,
) -> Result<RpcModule<()>, Box<dyn std::error::Error + Send + Sync>>
where
    C: ProvideRuntimeApi<Block>
        + sc_client_api::BlockBackend<Block>
        + HeaderBackend<Block>
        + AuxStore
        + HeaderMetadata<Block, Error = BlockChainError>
        + Sync
        + Send
        + 'static,
    C::Api: substrate_frame_rpc_system::AccountNonceApi<Block, AccountId, Nonce>,
    C::Api: pallet_transaction_payment_rpc::TransactionPaymentRuntimeApi<Block, Balance>,
    C::Api: BabeApi<Block>,
    C::Api: BlockBuilder<Block>,
    P: TransactionPool + 'static,
    SC: SelectChain<Block> + 'static,
    B: sc_client_api::Backend<Block> + Send + Sync + 'static,
    B::State: sc_client_api::backend::StateBackend<sp_runtime::traits::HashingFor<Block>>,
{
    use pallet_transaction_payment_rpc::{TransactionPayment, TransactionPaymentApiServer};
    use sc_consensus_babe_rpc::{Babe, BabeApiServer};
    use sc_consensus_grandpa_rpc::{Grandpa, GrandpaApiServer};
    use substrate_frame_rpc_system::{System, SystemApiServer};

    let mut io = RpcModule::new(());

    let BabeDeps {
        keystore,
        babe_worker_handle,
    } = babe;
    let GrandpaDeps {
        shared_voter_state,
        shared_authority_set,
        justification_stream,
        subscription_executor,
        finality_provider,
    } = grandpa;

    io.merge(System::new(client.clone(), pool).into_rpc())?;
    io.merge(TransactionPayment::new(client.clone()).into_rpc())?;
    io.merge(Babe::new(client, babe_worker_handle, keystore, select_chain).into_rpc())?;
    io.merge(
        Grandpa::new(
            subscription_executor,
            shared_authority_set,
            shared_voter_state,
            justification_stream,
            finality_provider,
        )
        .into_rpc(),
    )?;

    Ok(io)
}
