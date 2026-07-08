# Track the compute provider pool

**Status:** Proposed
**Effort:** Phase 1 is investigation (chain + ABI mapping, no code shipped).
Phases 2 and 3 are a normal adapter build on the existing engine.

## The gap

The Morpheus compute provider pool exists on-chain, and MorScan indexes
*around* it: providers, their bids, and the sessions that pay them. What it
does not do is track the pool itself. Its balance, the emissions flowing
through it to providers, the claims providers make from it, and the historical
flow of MOR in and out are all invisible to MorScan today.

The visible target already exists on the site. The `/pools` page's pool cards
(Compute Providers, read from the Diamond; Builder Subnets, read from the
builder contract) render a Staked figure today and nothing else: their
"Daily Emissions" and "APR" columns are empty. This spec's deliverable is
literally filling those columns with indexed truth.

## What tracking it adds

- **A pool surface:** the pool's balance plus its inflow and outflow over
  time, as a queryable series rather than a single point-in-time read.
- **Per-provider claim history:** each provider's claims and rewards from the
  compute pool, joined to the provider identity MorScan already has.
- **Derived economics:** what the network actually pays providers per day.
  Today that number can only be inferred indirectly from session stakes; with
  pool flows indexed it becomes a direct, receipt-signed figure, and the empty
  Daily Emissions and APR columns on `/pools` become honest numbers.

## Scope

The two pools MorScan already surfaces on `/pools`: Compute Providers and
Builder Subnets. The page already footnotes honestly that the Capital, Code,
and Protection pools are not indexed and defers to the Morpheus dashboard for
those; they stay out of scope here.

## Phases

### Phase 1: map the contract surface honestly

Identify the exact Diamond facets and events (and any separate pool contract)
that move MOR into and out of the compute pool. This spec deliberately does
not guess selectors or event signatures. Phase 1 derives them from the chain
and the published ABI, the same way `tools/verify-abi.sh` grounded the bid
events before they were indexed.

Phase 1's honest open question is *where the pool lives*. Morpheus MOR
emissions originate in the Ethereum L1 distribution contract and reach Base
via bridge and claim flows, so the mapping must determine which chain each
flow lives on: the L1 emission schedule versus the Base-side claim and
distribution events. Part of the answer is stating plainly what a Base-only
indexer can see on its own and what would require an L1 read; the phase ends
with that boundary written down, not assumed.

### Phase 2: index the flows

Index the mapped events into D1 as day-partitioned aggregates, per the
existing cost rules (no per-request chain reads, no unbounded scans; the sync
loop decodes events into day rows the way every other adapter does).

### Phase 3: surface it

- API endpoints for pool balance/flow series and per-provider claim history.
- A pool card on the analytics page, and real values in the `/pools` columns
  that are empty today.
- Per-provider claim history on the provider detail page.

## Chassis fit

This is exactly the adapter pattern the engine was built for: new events, new
decoders, and new cards composed onto the existing sync loop, D1 projection,
provenance signing, and API surfaces. No new architecture is proposed here.
