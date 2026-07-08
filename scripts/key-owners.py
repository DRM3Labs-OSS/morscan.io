#!/usr/bin/env python3
# Formatter for key-owners.sh. Reads wrangler d1 --json from stdin, prints a
# roster of morscan key owners with staker status. Arg 1: table|csv|stakers.
import json, sys
from datetime import datetime, timezone

mode = sys.argv[1] if len(sys.argv) > 1 else "table"
rows = json.load(sys.stdin)[0]["results"]


def mor(x):
    if x in (None, "", "0"):
        return 0.0
    try:
        return float(x) / 1e18
    except Exception:
        return 0.0


def dt(ts):
    if not ts:
        return "-"
    try:
        n = float(ts)
        if n > 1e12:  # stored in milliseconds (e.g. last_used_at = Date.now())
            n /= 1000
        return datetime.fromtimestamp(int(n), timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return str(ts)[:10]


def short(a):
    return a[:6] + ".." + a[-4:] if a and len(a) > 12 else (a or "-")


recs = []
for r in rows:
    st = mor(r.get("deposited"))
    recs.append({
        "wallet": r.get("wallet", ""), "name": r.get("name") or "-",
        "burst": r.get("burst"), "daily": r.get("daily_cap"), "monthly": r.get("monthly_cap"),
        "staker": st > 0, "stake_mor": st, "unlock": dt(r.get("unlock_at")),
        "created": dt(r.get("created_at")), "last_used": dt(r.get("last_used_at")),
    })

if mode == "stakers":
    recs = [r for r in recs if r["staker"]]

if mode == "csv":
    print("wallet,name,burst_per_min,daily_cap,monthly_cap,staker,stake_mor,unlock,created,last_used")
    for r in recs:
        print("%s,%s,%s,%s,%s,%s,%.4f,%s,%s,%s" % (
            r["wallet"], r["name"], r["burst"], r["daily"], r["monthly"],
            r["staker"], r["stake_mor"], r["unlock"], r["created"], r["last_used"]))
    sys.exit(0)

stakers = sum(1 for r in recs if r["staker"])
print("\n  morscan key owners: %d  |  subnet stakers: %d  |  non-stakers: %d\n" % (
    len(recs), stakers, len(recs) - stakers))
hdr = "  %-14s %-12s %6s %9s  %-7s %12s %-11s %-11s %-11s" % (
    "WALLET", "NAME", "BURST", "MONTHLY", "STAKER", "STAKE MOR", "UNLOCK", "CREATED", "LAST USED")
print(hdr)
print("  " + "-" * 108)
for r in recs:
    tag = "YES" if r["staker"] else "no"
    stake = ("%0.2f" % r["stake_mor"]) if r["staker"] else "-"
    unlock = r["unlock"] if r["staker"] else "-"
    print("  %-14s %-12s %6s %9s  %-7s %12s %-11s %-11s %-11s" % (
        short(r["wallet"]), r["name"][:12], r["burst"], r["monthly"],
        tag, stake, unlock, r["created"], r["last_used"]))
print()
