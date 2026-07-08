# Canonical Session Accounting

> **Data-completeness caveat:** most sessions classified `closed` do not carry a
> `close_tx_hash`. Close *counts* derived from `closed_at` / `is_active` are
> sound (a reconciliation sweep can set `closed_at` without observing the close
> transaction), but any analysis that depends on close *transactions* (gas,
> close-type attribution, per-tx forensics) will substantially undercount.
> Carry this caveat wherever close-derived numbers are presented.

## Module

`src/accounting.ts` is the single source of truth for session classification and wallet MOR buckets. Every handler that needs accounting reads from `buildWalletAccounting()`.

## Session State Machine

Every session row is classified into exactly one state:

`classifySession()` in `src/accounting.ts` returns exactly one of:

| State | Condition (in code) |
|-------|---------------------|
| `closed` | `is_active=0` and `closed_at>0` and `provider_withdrawn != '1'` |
| `hold_withdrawable` | `is_active=0` and `closed_at>0` and `provider_withdrawn='1'` |
| `expired_open` | `is_active=1` and `ends_at>0` and `ends_at < now` (reclaimable) |
| `active_open` | `is_active=1` (and not expired) |
| `unknown_partial` | `is_active=0` and `closed_at=0` (state indeterminate) |

`hold_locked` exists in the `SessionState` type union and the `counts` object
(always `0`), but `classifySession()` never returns it.

## Four-Bucket Invariant

For any wallet at a specific block:

```
wallet + staked + reclaimable + locked = total
```

| Bucket | Source | Sessions in this bucket |
|--------|--------|------------------------|
| `wallet` | Live RPC `balanceOf` (MOR ERC-20) | None (free balance) |
| `staked` | Sum of `active_open` session stakes | Active, not expired |
| `reclaimable` | Sum of `expired_open` session stakes | Expired, still open on-chain |
| `locked` | Sum of `unknown_partial` stakes | State uncertain |
| `total` | `wallet + staked + reclaimable + locked` | Derived |

## Canonical Object Shape

```typescript
interface WalletAccounting {
  wallet: string;
  // Each MOR bucket is emitted both human-readable and as wei:
  wallet_mor: string;       wallet_mor_wei: string;
  staked_mor: string;       staked_mor_wei: string;
  reclaimable_mor: string;  reclaimable_mor_wei: string;
  locked_mor: string;       locked_mor_wei: string;
  total_mor: string;        total_mor_wei: string;
  eth_balance: string;      eth_balance_wei: string;
  stakes_on_hold: { available: string; available_wei: string; on_hold: string; on_hold_wei: string };
  sessions: ClassifiedSession[];
  counts: { active_open, expired_open, closed, hold_locked, hold_withdrawable, unknown_partial, total };
  as_of_block: number;
  partial: boolean;
  partial_reason: string | null;
}
```

## Partial Flag

`partial: true` means MorScan cannot prove the accounting is complete. Causes:
- Sessions classified as `unknown_partial` (state indeterminate)
- Sync cursor stuck (projector not advancing)

Consumers should treat `partial: true` as "stale, verify on-chain."

## API Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /mor/v1/wallet/:addr` | Full wallet detail with `accounting` object |
| `GET /mor/v1/wallet/:addr/audit` | Plaintext audit: buckets, invariant check, contributing sessions |

All accounting surfaces (wallet detail, session analytics, network-wide totals) read from or are consistent with this module; there is no second classification path.

## Health Signal

`/health` returns:
- `accounting_signal: consistent | partial` (cursor-liveness proxy)
- `claimable_list_consistent: true | false` (legacy, kept for backward compat)

Neither field proves full accounting correctness. The audit endpoint is the definitive check.

## Verifying a wallet

The `GET /mor/v1/wallet/:addr/audit` endpoint returns the four-bucket
breakdown for any wallet. The invariant must always hold:

```
wallet + staked + reclaimable + locked == total
```

If you operate a consumer client that tracks its own balances, reconciling its
free balance and expired-session list against this audit endpoint is the
definitive correctness check: the two should agree exactly.
