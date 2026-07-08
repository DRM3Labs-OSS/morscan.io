#!/usr/bin/env bash
# Recompute every event topic and function selector the indexer depends on
# and compare against the constants in src/. Requires foundry's `cast`.
#
#   ./tools/verify-abi.sh
#
# Exits nonzero on any mismatch. See docs/architecture/abi-provenance.md for
# where each signature comes from.
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

check() { # check <kind> <name> <signature> <file>
  local kind="$1" name="$2" sig="$3" file="$4"
  local expected actual
  expected=$(grep -o "${name}: '0x[0-9a-f]*'" "$file" | grep -o "0x[0-9a-f]*")
  if [ "$kind" = "topic" ]; then
    actual=$(cast keccak "$sig")
  else
    actual=$(cast sig "$sig")
  fi
  if [ "$expected" = "$actual" ]; then
    printf 'ok   %-24s %s\n' "$name" "$sig"
  else
    printf 'FAIL %-24s %s\n     code %s\n     real %s\n' "$name" "$sig" "$expected" "$actual"
    FAIL=1
  fi
}

T=src/types.ts
S=src/sync/parsers-rpc.ts

echo "== Event topics (keccak256 of canonical signature) =="
# Morpheus Diamond (SessionRouter + Marketplace facets)
check topic SESSION_OPENED  'SessionOpened(address,bytes32,address)' $T
check topic SESSION_CLOSED  'SessionClosed(address,bytes32,address)' $T
check topic BID_POSTED      'MarketplaceBidPosted(address,bytes32,uint256)' $T
check topic BID_RETRACTED   'MarketplaceBidDeleted(address,bytes32,uint256)' $T
check topic DIAMOND_CUT     'DiamondCut((address,uint8,bytes4[])[],address,bytes)' $T
# MOR ERC-20
check topic ERC721_TRANSFER 'Transfer(address,address,uint256)' $T
# Builders contract
check topic BUILDER_USER_DEPOSITED 'UserDeposited(bytes32,address,uint256)' $T
check topic BUILDER_USER_WITHDRAWN 'UserWithdrawn(bytes32,address,uint256)' $T
check topic BUILDER_ADMIN_CLAIMED  'AdminClaimed(bytes32,address,uint256)'  $T
# BUILDER_SUBNET_CREATED / BUILDER_SUBNET_EDITED / BUILDER_FEE_PAID take the
# subnet struct as an argument; their canonical signatures have not been
# re-derived from source. Values in src/types.ts are as observed in use.

echo "== Function selectors (first 4 bytes of keccak256) =="
check sig getActiveProviders     'getActiveProviders(uint256,uint256)' $S
check sig getProvider            'getProvider(address)' $S
check sig getProviderActiveBids  'getProviderActiveBids(address,uint256,uint256)' $S
check sig getBid                 'getBid(bytes32)' $S
check sig getBidId               'getBidId(address,bytes32,uint256)' $S
check sig getProviderSessions    'getProviderSessions(address,uint256,uint256)' $S
check sig getSession             'getSession(bytes32)' $S
check sig getModel               'getModel(bytes32)' $S
check sig getComputeBalance      'getComputeBalance(uint128)' $S
check sig totalMORSupply         'totalMORSupply(uint128)' $S
check sig getTodaysBudget        'getTodaysBudget(uint128)' $S

exit $FAIL
