#!/usr/bin/env bash
# key-owners.sh - list morscan API key owners and whether each is a MorScan
# builder-subnet staker (with stake amount and lockup unlock date).
#
# Usage:
#   ./scripts/key-owners.sh            # pretty table
#   ./scripts/key-owners.sh --csv      # CSV to stdout
#   ./scripts/key-owners.sh --stakers  # only wallets that are stakers
#
# Reads the remote morscan D1 via wrangler (needs wrangler.deploy.toml + CF auth).
set -euo pipefail
cd "$(dirname "$0")/.."

# Canonical MorScan builder subnet (must match src/utils/stake-tier.ts MORSCAN_SUBNET_ID).
SUBNET="0xe100f9d7c463008e46887113fa14bc0ba9caaf90d4465835795f53ebe5056059"

MODE="table"
case "${1:-}" in
  --csv) MODE="csv" ;;
  --stakers) MODE="stakers" ;;
esac

SQL="SELECT substr(k.id,8) AS wallet, k.name, k.rate_limit AS burst, k.daily_cap, k.monthly_cap, k.created_at, k.last_used_at, bs.deposited, bs.unlock_at FROM api_keys k LEFT JOIN builder_stakes bs ON bs.wallet = substr(k.id,8) AND bs.subnet_id = '${SUBNET}' WHERE k.id LIKE 'wallet:%' ORDER BY (bs.deposited IS NOT NULL) DESC, CAST(COALESCE(bs.deposited,'0') AS REAL) DESC, k.created_at DESC"

npx wrangler d1 execute morscan --remote --config wrangler.deploy.toml --json --command "$SQL" 2>/dev/null \
  | python3 "$(dirname "$0")/key-owners.py" "$MODE"
