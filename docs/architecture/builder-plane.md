# Builder Staking Plane (as-built)

> The Builder economic plane is **shipped** (v1.31-1.32). MorScan indexes the Morpheus BuildersV4 staking contract alongside the Compute plane. This doc is the as-built contract reference and shipped surface. Genuinely-unbuilt route ideas remain the "My Stakes" wallet page, the cross-plane wallet portfolio view, and FeeConfig decoding.

## What it is

A second economic plane alongside Compute. Compute is the Diamond contract's SessionRouter (lock MOR per-session for direct P2P inference). Builder is a long-term staking contract where MOR holders deposit into builder subnets to earn a share of daily MOR emissions.

| Internal ID | User-Facing Name | Contract |
|-------------|-----------------|----------|
| `compute` | Compute | Diamond (SessionRouter) |
| `builder` | Builder | BuildersV4 ERC1967 proxy |

## Contract reference (BuildersV4, Base)

- **Proxy:** `0x42BB446eAE6dca7723a9eBdb81EA88aFe77eF4B9`
- **Implementation:** `0x18faef315b40a6d9cf49628f1133b1aa507513b0` (Solidity 0.8.20, v4)
- **Deposit token:** MOR `0x7431aDa8a591C955a994a21710752EF9b882b8e3` (same as Compute)

### Related addresses (read from contract 2026-03-31)

| Address | Role |
|---------|------|
| `0x845fbb4b3e2207bf03087b8b94d2430ab11088ee` | FeeConfig |
| `0x9eba628581896ce086cb8f1a513ea6097a8fc561` | Treasury |
| `0xdc99a8596e395e52aba2bd08c623e1e428dc3980` | RewardPool |
| `0x1fe04bc15cf2c5a2d41a0b3a96725596676eba1e` | Owner |

### Event topic hashes (verified)

| Topic Hash | Event |
|------------|-------|
| `0x6c7131e79092f16af04daf787c07a4dc80e7ae1a95dbe1cc1a310cfe1619d2db` | `UserDeposited(bytes32,address,uint256)` |
| `0x91ce5144c91c77840ff78678c0787f033a9f2209ab6a26552adb61a542da4a0d` | `UserWithdrawn(bytes32,address,uint256)` |
| `0x58d15e553aa98ead90f5b344d27c2f59995b8447dadb1662db257cd54c803f00` | `AdminClaimed(bytes32,address,uint256)` |
| `0xfc07de8ee911254a9185d74d8ab20269af3f3b3fe9743d1c225ee77570076742` | `SubnetCreated(bytes32,(string,address,address,uint256,uint256))` |
| `0xb402427f9b01bc42bf0a4aea082dc07170860b80964a12318abf7e480a0a4ee0` | `SubnetEdited(bytes32,(string,address,address,uint256,uint256))` |
| `0x95874b79f55b24ac8b16d9b0b27e533619f07af0298c634d63357afdbf78c30a` | `SubnetMetadataEdited(bytes32,(string,string,string[]))` |
| `0x2b8c2cd90c9e1dd66b27c2ad1828da3954f9f616cb655dc4b214671e1acb9ac5` | `FeePaid(address,bytes32,uint256,address)` |

### Key read selectors

`allSubnetsData()` (`0x2b929f36`), `allSubnetsDataV4()` (`0x9155756f`), `subnets(bytes32)` (`0x02e30f9a`), `subnetsData(bytes32)` (`0xfc601bd7`), `usersData(address,bytes32)` (`0x996cb7c3`), `getCurrentSubnetsRewards()` (`0x29c1746c`), `getSubnetId(string)` (`0xe1324916`), `minimalWithdrawLockPeriod()` (`0xc7a74add`). Full selector tables (including write/admin functions) are in the spec.

### On-chain data model

- **Subnet** (`subnets`): `name`, `admin`, `claimAdmin`, `minimalDeposit`, `withdrawLockPeriodAfterDeposit`.
- **SubnetData** (`subnetsData`): `rate`, `pendingRewards`, `deposited`.
- **UserData** (`usersData`): `lastDeposit`, `deposited`. No auto-unlock; stake stays indefinitely, the lock period is just the minimum before `withdraw()` is allowed.
- **Global** (`allSubnetsData` + `allSubnetsDataV4`): `rate`, `totalDeposited`, `undistributedRewards`, `distributedRewards`, `claimedRewards`, `lastUpdate`.

## D1 tables

`builder_subnets`, `builder_stakes`, `builder_events`, `builder_sync_state`. When the optional BigQuery dual-write is enabled (off by default; see [`bigquery-dual-write.md`](bigquery-dual-write.md)), `builder_subnets`, `builder_stakes`, and `builder_events` are also dual-written to the BigQuery archive.

## Sync

Builder event sync (`src/sync/builder.ts`) runs every 6th SyncCoordinator tick (~30s) via `eth_getLogs` against the BuildersV4 proxy for the deposit/withdraw/claim/subnet events, with an independent cursor in `builder_sync_state`. Subnet discovery is event-based (`SubnetCreated`) with RPC fallback across four endpoints, and collects all upserts before any DELETE so a failed RPC never wipes the table. Builder discovery/refresh logic lives in `src/sync/builder-discovery.ts` and `src/sync/builder-refresh.ts`; `src/sync/builder.ts` is the orchestrator.

## Shipped API

All under `/mor/v1/builder/`, same auth model as the rest of the API:

| Endpoint | Description |
|----------|-------------|
| `GET /mor/v1/builder/subnets` | All subnets: name, admin, totalDeposited, reward rate, staker count |
| `GET /mor/v1/builder/subnets/:subnetId` | Subnet detail: stakes, top depositors, reward history |
| `GET /mor/v1/builder/stakes/:wallet` | A wallet's subnet positions, amounts, unlock times |
| `GET /mor/v1/builder/stats` | Global: total staked, subnet count, daily emissions, APR, claimed/unclaimed |
| `GET /mor/v1/builder/events` | Recent deposit/withdraw/claim events (paginated) |
| `GET /mor/v1/builder/all` | Fatboy blob for the builder plane (separate from Compute fatboy) |

## Shipped UI

`/builder/subnets` (leaderboard), `/builder/subnet/:id` (subnet detail), `/builder/calculator` (emissions/yield calculator), `/builder/api` (playground). The Builder tab sits alongside Compute in the top-level nav.

## Still unbuilt (in the spec)

- A per-wallet "My Stakes" builder page (`/builder/wallet/:wallet`).
- A cross-plane wallet portfolio view that folds builder positions into `/mor/v1/wallet/:wallet`.
- FeeConfig ABI decoding for exact protocol-fee percentages.
