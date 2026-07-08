# Contracts - the on-chain surface MorScan indexes

As-built reference for the third-party contracts MorScan integrates with on Base
mainnet: the addresses, the event topics and function selectors the indexer
depends on, where those signatures come from, how DiamondCut upgrades are
monitored, and how to re-verify or update everything after an upgrade.

MorScan **does not deploy any contracts.** It indexes third-party Morpheus
contracts and records here exactly which signatures it derives from them.

Run `./tools/verify-abi.sh` (requires foundry's `cast`) to recompute every
selector and topic below and diff it against the constants in the code.

## Contracts indexed

| Contract | Address (Base mainnet) | Source |
|----------|------------------------|--------|
| Morpheus Diamond (Marketplace + SessionRouter facets) | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` | `MorpheusAIs/Morpheus-Lumerin-Node`, `smart-contracts/contracts/diamond/`, pinned at commit `4c42883e` (2026-04-25) |
| MOR token (ERC-20) | `0x7431aDa8a591C955a994a21710752EF9b882b8e3` | Standard ERC-20 |
| Builders (subnet staking, BuildersV4, separate contract) | `0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9` | Morpheus Builders contract |

## Event topics (`EVENTS` in `src/types.ts`)

Topic = keccak256 of the canonical event signature.

| Constant | Canonical signature | Verified |
|----------|--------------------|----------|
| `SESSION_OPENED` | `SessionOpened(address,bytes32,address)` | keccak re-derived; observed in live Diamond logs |
| `SESSION_CLOSED` | `SessionClosed(address,bytes32,address)` | keccak re-derived; observed in live Diamond logs |
| `BID_POSTED` | `MarketplaceBidPosted(address,bytes32,uint256)` | keccak re-derived from `IMarketplace.sol` at the pinned commit; matched against an on-chain bid tx |
| `BID_RETRACTED` | `MarketplaceBidDeleted(address,bytes32,uint256)` | keccak re-derived from `IMarketplace.sol` at the pinned commit |
| `ERC721_TRANSFER` | `Transfer(address,address,uint256)` | Standard ERC-20 Transfer topic (used for MOR holder tracking) |
| `DIAMOND_CUT` | `DiamondCut((address,uint8,bytes4[])[],address,bytes)` | EIP-2535 standard |
| `BUILDER_USER_DEPOSITED` | `UserDeposited(bytes32,address,uint256)` | keccak re-derived; observed in live Builders logs |
| `BUILDER_USER_WITHDRAWN` | `UserWithdrawn(bytes32,address,uint256)` | keccak re-derived |
| `BUILDER_ADMIN_CLAIMED` | `AdminClaimed(bytes32,address,uint256)` | keccak re-derived; observed in live Builders logs |
| `BUILDER_SUBNET_CREATED` | takes the subnet struct; signature not re-derived | observed value, in use by the live indexer |
| `BUILDER_SUBNET_EDITED` | takes the subnet struct; signature not re-derived | observed value, in use by the live indexer |
| `BUILDER_FEE_PAID` | signature not re-derived | observed value, in use by the live indexer |

The Marketplace bid events carry no bid id. Bids are keyed by
`(provider, modelId, nonce)`; the indexer resolves the id with `getBidId`.

## Function selectors (`SELECTORS` in `src/sync/parsers-rpc.ts`, re-exported via the `src/sync/parsers.ts` barrel)

Selector = first 4 bytes of keccak256 of the function signature. List getters
take pagination args (`offset, limit`); the economics getters take `uint128`
pool indexes.

| Constant | Signature | Selector | Used for |
|----------|-----------|----------|----------|
| `getActiveProviders` | `getActiveProviders(uint256,uint256)` | `0xd5472642` | provider discovery |
| `getProvider` | `getProvider(address)` | `0x55f21eb7` | provider detail |
| `getProviderActiveBids` | `getProviderActiveBids(address,uint256,uint256)` | `0xaf5b77ca` | bid discovery |
| `getBid` | `getBid(bytes32)` | `0x91704e1e` | enrich bids, resolve provider/model |
| `getBidId` | `getBidId(address,bytes32,uint256)` | `0x747ddd5b` | resolve the id for a `(provider, modelId, nonce)` bid |
| `getProviderSessions` | `getProviderSessions(address,uint256,uint256)` | `0x87bced7d` | session lookup |
| `getSession` | `getSession(bytes32)` | `0x39b240bd` | enrich opened sessions |
| `getModel` | `getModel(bytes32)` | `0x21e7c498` | model name registry |
| `getComputeBalance` | `getComputeBalance(uint128)` | `0x61ce471a` | economics |
| `totalMORSupply` | `totalMORSupply(uint128)` | `0x6d0cfe5a` | economics |
| `getTodaysBudget` | `getTodaysBudget(uint128)` | `0x40005965` | economics |

## Session close handling

- `SessionClosed` events land via the forward-only `eth_getLogs` event projector
  (see [`sync.md`](sync.md)). MorScan marks `closed_at` and `is_active = 0`.
- A consumer client closes a session by calling `closeSession` on the Diamond.
  Calling it on an already-closed session returns gracefully (no revert in
  current contract behavior).
- If a `SessionClosed` event is missed (for example during an RPC outage), a
  session can appear open in the index while closed on-chain. The canonical
  accounting module (see [`canonical-accounting.md`](canonical-accounting.md))
  adds a strict session state machine and a four-bucket invariant so the live
  wallet view and the claimable list cannot disagree.
- `SessionOpened` events with missing fields are null-guarded on insert so a
  single bad field cannot silently drop an event.
- All currently indexed sessions carry `pricePerSecond = 0`; the full stake
  returns on close.
- The tested close path requires a provider-signed `session.report`.

## DiamondCut monitoring

MorScan monitors `DiamondCut` events (EIP-2535 facet upgrades) on the Diamond
in real time. Upgrades are detected within one sync tick (about 5 seconds),
logged, and stored in the `diamond_upgrades` D1 table.

**Event topic:** `0x8faa70878671ccd212d20771b795c50af8fd3ff6cf27f4bde57e5d4de0aeb673`
**Signature:** `DiamondCut((address,uint8,bytes4[])[],address,bytes)`

**Captured per upgrade:**
- Block number and timestamp
- Transaction hash and log index
- Number of facets changed (`facet_count`)
- `facet_changes` JSON column: the per-facet breakdown decoded by
  `parseDiamondCutData()` in `src/sync/compute-stats.ts` (dependency-free ABI
  decoder), an array of `{facet, action: 'add'|'replace'|'remove', selectors:
  string[]}`. Verified against the real cut in tx
  `0xd4b084132115725747b75b9b48994d8809e823571ed4c782274e0ad321564114` (block
  39593263: 7 facet cuts, 73 selectors). On a malformed payload it returns `[]`
  (upgrade still detected and counted, breakdown empty).

**Where it surfaces:**
- `⚠ DIAMOND UPGRADE(S)` marker in the SyncCoordinator tick log
- `/health`: `diamond.upgrades.totalSeen` and `diamond.upgrades.last`
- `diamond_upgrades` D1 table for historical queries (also exposed at
  `GET /mor/v1/upgrades`)

## How to update after a DiamondCut

The Diamond can replace facets at any time (EIP-2535). When one fires:

1. The sync tick log shows a `DIAMOND UPGRADE(S)` marker and the row is written
   to `diamond_upgrades`; `/health` shows `diamond.upgrades.last`.
2. Read `facet_changes` in the `diamond_upgrades` row (decoded facet address,
   add/replace/remove action, and selectors per cut); cross-check the upgrade tx
   on BaseScan if anything looks off.
3. Check the changed selectors against the known set (`SELECTORS` in
   `src/sync/parsers-rpc.ts`). If any selector or event the indexer depends on
   was replaced or removed, sync may break: find the new facet source (BaseScan
   or the upstream repo), update `SELECTORS` and `EVENTS` in `src/types.ts`,
   update the pin and tables above, and run `./tools/verify-abi.sh`.
4. If nothing the indexer depends on changed, no action is needed.

## Verifying

Recompute a selector against the ABI:

```bash
cast sig "getSession(bytes32)"  # should return 0x39b240bd
cast sig "getBid(bytes32)"      # should return 0x91704e1e
```

Check for historical DiamondCut events on the contract:

```bash
cast logs --from-block 1 --address 0x6aBE1d282f72B474E54527D93b979A4f64d3030a 0x8faa70878671ccd212d20771b795c50af8fd3ff6cf27f4bde57e5d4de0aeb673 --rpc-url <base-rpc-url>
```

Query the indexed upgrade history:

```bash
npx wrangler d1 execute morscan --remote --command="SELECT * FROM diamond_upgrades ORDER BY block_number DESC LIMIT 10;"
```

## Caveats

- Close-path edge cases (disputed sessions, provider-initiated closes, sessions
  with non-zero `pricePerSecond`) are not exhaustively covered by the indexer's
  tested surface.
- The `closeoutType` field exists in session data; its effect on close semantics
  is not documented here.
- `getModel` works, but model name availability is inconsistent (some models
  return empty names).
