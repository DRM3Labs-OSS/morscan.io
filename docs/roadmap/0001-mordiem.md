# 0001 - Mordiem

**Status:** open
**Effort:** Part 1 is small (surfacing, no new indexing). Part 2 is an open
question that may add a small adapter.

## What Mordiem is

Mordiem is a Morpheus builder-subnet operator on Base. Its operator and staking
wallet is:

```
0xC647d4080549603F8C779b9Dd28E53C62300aeA2
```

It stakes MOR into Morpheus Builders V4 subnets - the same builder contract
MorScan already indexes (`BUILDER_CONTRACT` in `wrangler.toml`) - and turns the
resulting yield into Venice-backed inference that its users spend against.

For MorScan, the useful fact is narrow and concrete: Mordiem is a staker on a
subnet we are already watching. Everything we would show for it in Part 1 is data
that is already in D1.

## Why this is the first example

This spec is the thinnest case of pointing the engine at a new subnet. We are not
adding a new contract, a new decoder, or a new sync path. We are reading rows we
already have and labeling them. If we cannot do this cleanly, the larger
"point MorScan at another Morpheus contract" idea is not ready; if we can, it is
the first real evidence for it.

## Part 1 - a labeled Mordiem view (nearly free)

Show Mordiem as a named subnet: its subnet(s), staker count, MOR staked, and
rewards. All of this is already indexed.

### Finding the subnet

Derive the subnet id(s) as the builder pool(s) whose admin is the Mordiem
operator wallet. Two equivalent ways:

- **From D1 (preferred, no chain calls):** the `builder_subnets` table already
  stores an `admin` column per pool. Query:

  ```sql
  SELECT subnet_id, name, total_deposited, pending_rewards, staker_count
  FROM builder_subnets
  WHERE admin = '0xc647d4080549603f8c779b9dd28e53c62300aea2';
  ```

  (Compare addresses lowercased; MorScan stores them normalized.)

- **From chain (to confirm or bootstrap):** `eth_getLogs` on the subnet-created
  event of `BUILDER_CONTRACT`, filtered to the admin topic for the operator
  wallet. This is only needed to sanity-check the D1 answer or if you are
  indexing a different builder deployment.

If the operator runs more than one pool, all of them belong to the view.

### What the view renders

| Field | Source (already indexed) |
|-------|--------------------------|
| Subnet name / id | `builder_subnets.name` / `subnet_id` |
| MOR staked | `builder_subnets.total_deposited` |
| Rewards | `builder_subnets.pending_rewards` |
| Staker count | `builder_subnets.staker_count` |
| Individual stakers | `builder_stakes WHERE subnet_id = ...` |

### Work

- A view (a labeled query over `builder_subnets` / `builder_stakes`), a dashboard
  card, and a short about-line explaining what Mordiem is.
- Optionally a `/mor/v1` alias endpoint so agents can pull the Mordiem view by
  name instead of by raw subnet id.

No schema change, no new sync, no new decoders. This is surfacing, not scanning.

## Part 2 - a possible Mordiem-specific contract (open question)

Mordiem has an off-chain product surface (a card / credit feature for buying
inference). The open question is whether any of that settles **on-chain** beyond
the Builders/MOR staking we already index - for example a payment or credit
contract on Base.

- **If it is off-chain** (e.g. Stripe, or an internal ledger): there is nothing
  for MorScan to index. Part 1 is the whole integration.
- **If there is an on-chain contract:** that is a small additional adapter - its
  address and events go into the sync loop the same way the existing planes do,
  with a table and a decoder. Scope it only once such a contract is confirmed.

This is flagged as an open question on purpose. Do not build Part 2 speculatively;
confirm the on-chain vs off-chain answer first, then size it.

## Phases

1. **Confirm the subnet.** Run the D1 query above; verify the admin match against
   chain. Write down the subnet id(s). (Small.)
2. **Ship the labeled view.** View + dashboard card + about-line, optionally the
   named alias endpoint. (Small.)
3. **Resolve the Part 2 question.** Determine whether Mordiem settles anything
   on-chain beyond staking. If yes, open a follow-up spec for the adapter; if no,
   close this out. (Investigation first, then sized.)
