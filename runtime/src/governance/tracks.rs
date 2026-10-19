//! Referenda track configuration for Scalar Commons V4.
//!
//! Track 0: Agents (fast) — 24h decision, ranked-collective electorate
//! Track 1: Network       — 7-day decision, majority stake
//! Track 2: Root          — 20-day decision, super-majority
//!
//! Support floors are absolute parts, chosen to be reachable at launch. They
//! are expressed below in `Perbill` (parts per billion) because `Curve` moved
//! from `Permill` to `Perbill` at this SDK tag; the ppm figures quoted here are
//! unchanged, each written as `from_parts(ppm * 1_000)`:
//!   Track 0: 2 ppm  = 0.0002% = ~36K CMN  (founders + validators from day 1)
//!   Track 1: 100 ppm = 0.01%  = ~1.8M CMN  (validators accumulate in ~2 days)
//!   Track 2: 1000 ppm = 0.1%  = ~18M CMN   (validators accumulate in ~15 days)
//!
//! This ensures governance is operational before sudo is removed on day 14.
//!
//! ## stable2503 port note
//!
//! `pallet_referenda::TracksInfo` changed shape at this tag. Three things moved,
//! and none of the track *parameters* below were altered by the port:
//!
//! 1. `tracks()` returned `&'static [(Id, TrackInfo)]`; it now returns
//!    `impl Iterator<Item = Cow<'static, Track<Id, Balance, Moment>>>`, where
//!    `Track { id, info }` replaces the bare tuple.
//! 2. The trait's first generic is `Balance`, not `RuntimeCall`. The previous
//!    `TracksInfo<crate::RuntimeCall, _>` could never have satisfied
//!    `pallet_referenda::Config`, which bounds `Tracks: TracksInfo<BalanceOf, _>`.
//! 3. `track_for` changed meaning entirely — see the note on it below.

use pallet_referenda::{Curve, Track, TrackInfo};
use sp_arithmetic::Perbill;
use sp_runtime::str_array as s;
use sp_std::borrow::Cow;

const ERA_BLOCKS: u32 = 3_600; // 6-hour era

pub struct TracksInfo;

const TRACKS_DATA: [Track<u16, crate::Balance, crate::BlockNumber>; 3] = [
    // ── Track 0: Agents (fast parameter changes via ranked-collective) ──
    Track {
        id: 0,
        info: TrackInfo {
            name: s("agents"),
            max_deciding: 10,
            decision_deposit: 500 * crate::CMN,
            prepare_period: ERA_BLOCKS,       // 6h
            decision_period: 4 * ERA_BLOCKS,  // 24h
            confirm_period: ERA_BLOCKS,       // 6h confirmation
            min_enactment_period: ERA_BLOCKS, // 6h minimum
            min_approval: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_percent(50),
                ceil: Perbill::from_percent(80),
            },
            // 2 ppm = ~36K CMN. Reachable if any founder participates.
            min_support: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_parts(2_000), // ~36K CMN at genesis
                ceil: Perbill::from_percent(10),
            },
        },
    },
    // ── Track 1: Network (general governance, parameters, treasury) ───
    Track {
        id: 1,
        info: TrackInfo {
            name: s("network"),
            max_deciding: 5,
            decision_deposit: 5_000 * crate::CMN,
            prepare_period: 2 * ERA_BLOCKS,       // 12h
            decision_period: 28 * ERA_BLOCKS,     // 7 days
            confirm_period: 4 * ERA_BLOCKS,       // 24h
            min_enactment_period: 4 * ERA_BLOCKS, // 24h
            min_approval: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_percent(50),
                ceil: Perbill::from_percent(67),
            },
            // 100 ppm = ~1.8M CMN. Validators accumulate in ~2 days.
            min_support: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_parts(100_000), // ~1.8M CMN at genesis
                ceil: Perbill::from_percent(25),
            },
        },
    },
    // ── Track 2: Root (runtime upgrades, sudo removal) ───────────────
    Track {
        id: 2,
        info: TrackInfo {
            name: s("root"),
            max_deciding: 2,
            decision_deposit: 50_000 * crate::CMN,
            prepare_period: 8 * ERA_BLOCKS,       // 2 days
            decision_period: 80 * ERA_BLOCKS,     // 20 days
            confirm_period: 8 * ERA_BLOCKS,       // 2 days
            min_enactment_period: 8 * ERA_BLOCKS, // 2 days
            min_approval: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_percent(75),
                ceil: Perbill::from_percent(100),
            },
            // 1000 ppm = ~18M CMN. Validators accumulate in ~15 days.
            // Ensures sudo removal referendum (day 14) can pass with
            // validator emissions + any founder participation.
            min_support: Curve::LinearDecreasing {
                length: Perbill::from_percent(100),
                floor: Perbill::from_parts(1_000_000), // ~18M CMN at genesis
                ceil: Perbill::from_percent(50),
            },
        },
    },
];

impl pallet_referenda::TracksInfo<crate::Balance, crate::BlockNumber> for TracksInfo {
    type Id = u16;
    type RuntimeOrigin =
        <crate::RuntimeOrigin as frame_support::traits::OriginTrait>::PalletsOrigin;

    fn tracks(
    ) -> impl Iterator<Item = Cow<'static, Track<Self::Id, crate::Balance, crate::BlockNumber>>>
    {
        TRACKS_DATA.iter().map(Cow::Borrowed)
    }

    /// Map a dispatch origin to the track that governs it.
    ///
    /// NOTE — this is not the same function it replaces. The previous
    /// `track_for(&Id) -> Option<&TrackInfo>` was an id lookup; the trait now
    /// asks the opposite question, routing an *origin* to a track id. There was
    /// therefore no prior origin→track mapping in this runtime to preserve, and
    /// this is the first one.
    ///
    /// Only `Root` is routable today, and it routes to track 2 ("root"), which
    /// is the track whose documented purpose is runtime upgrades and sudo
    /// removal. Tracks 0 ("agents") and 1 ("network") describe distinct
    /// electorates but have no dispatch origin to select them: this runtime has
    /// no custom-origin enum. `governance::origins` defines only `EnsureOrigin`
    /// type aliases (`AgentsCollectiveOrigin`, `GeneralAdminOrigin`), which gate
    /// *who may call*; they are not `RuntimeOrigin` variants and cannot be
    /// matched here.
    ///
    /// Reaching tracks 0 and 1 requires a `pallet_custom_origins`-style origin
    /// enum, as Polkadot's own runtimes use. That is a governance-surface
    /// addition, not a port, so it is reported rather than invented here — see
    /// ROUND3.md. Until then those tracks are configured but unreachable, which
    /// is the honest state of the original design.
    fn track_for(origin: &Self::RuntimeOrigin) -> Result<Self::Id, ()> {
        match frame_system::RawOrigin::try_from(origin.clone()) {
            Ok(frame_system::RawOrigin::Root) => Ok(2),
            _ => Err(()),
        }
    }
}
