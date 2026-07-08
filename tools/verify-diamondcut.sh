#!/usr/bin/env bash
# Run parseDiamondCutData() against the real DiamondCut log(s) on the Morpheus
# Diamond (Base) and compare the decode against foundry's ABI decoder.
# Requires foundry's `cast` plus node + esbuild (repo devDependency).
#
#   ./tools/verify-diamondcut.sh
#
# Exits nonzero if the hand-rolled decode disagrees with cast, or if no
# DiamondCut log is found on-chain.
set -euo pipefail
cd "$(dirname "$0")/.."

DIAMOND=0x6aBE1d282f72B474E54527D93b979A4f64d3030a
TOPIC=0x8faa70878671ccd212d20771b795c50af8fd3ff6cf27f4bde57e5d4de0aeb673
LOGS_API="https://base.blockscout.com/api?module=logs&action=getLogs&address=${DIAMOND}&topic0=${TOPIC}&fromBlock=0&toBlock=latest"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -s "$LOGS_API" > "$TMP/logs.json"
npx esbuild src/sync/compute-stats.ts --format=esm --outfile="$TMP/compute-stats.mjs" --log-level=silent

node - "$TMP" <<'EOF'
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const tmp = process.argv[2];

async function main() {
  const { parseDiamondCutData } = await import(`${tmp}/compute-stats.mjs`);
  const logs = JSON.parse(readFileSync(`${tmp}/logs.json`, 'utf8')).result;
  if (!Array.isArray(logs) || logs.length === 0) {
    console.error('FAIL no DiamondCut logs returned by Blockscout');
    process.exit(1);
  }
  let fail = 0;
  for (const log of logs) {
    const ours = parseDiamondCutData(log.data);
    // cast prints the tuple array on line 1, init address line 2, calldata line 3
    const castLine = execFileSync('cast', [
      'abi-decode', '--input', 'cut((address,uint8,bytes4[])[],address,bytes)', log.data,
    ], { encoding: 'utf8' }).split('\n')[0];
    const cuts = castLine === '[]' ? [] : castLine.slice(2, -2).split('), (');
    const actions = ['add', 'replace', 'remove'];
    const theirs = cuts.map((c) => {
      const [addr, act] = c.split(', ');
      const selectors = c.match(/\[(.*)\]/)?.[1].split(', ').filter(Boolean) ?? [];
      return { facet: addr.toLowerCase(), action: actions[Number(act)], selectors };
    });
    const match = JSON.stringify(ours) === JSON.stringify(theirs);
    const tx = log.transactionHash;
    const block = parseInt(log.blockNumber, 16);
    if (match) {
      console.log(`ok   block=${block} tx=${tx} cuts=${ours.length} selectors=${ours.reduce((a, c) => a + c.selectors.length, 0)}`);
    } else {
      console.error(`FAIL block=${block} tx=${tx}`);
      console.error('ours:', JSON.stringify(ours));
      console.error('cast:', JSON.stringify(theirs));
      fail = 1;
    }
  }
  process.exit(fail);
}
main();
EOF
