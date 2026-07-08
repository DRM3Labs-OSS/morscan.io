# MorScan roadmap

Numbered, self-contained specs for planned work. Each one is short enough to
read in a sitting and says what it is, why it matters, the on-chain structure it
touches, the phases, and a rough effort.

Specs land here as they are opened. Product and operator plans are worked
elsewhere and show up here as specs once they are ready to build in the open.

## What we have built, and where it can go next

MorScan is the Morpheus explorer. Today it indexes one network: the Morpheus
compute, builder, and token contracts on Base. That is the thing that exists and
runs at [morscan.io](https://morscan.io).

The engine underneath it, though, was written to not be welded to that one
deployment. The self-healing sync loop, the D1 projection, the provenance
signing, the wallet-key auth and metering, and the REST / OpenAPI / agent-ready
surfaces do not assume any particular contract; they take addresses, events, and
decoders as inputs. So the same engine can be pointed at another Morpheus
contract without a rewrite. We have not proven that across many protocols yet,
but the seams are there on purpose, and these specs are where we plan the work to
exercise them.

The thinnest first step is any Morpheus builder subnet, because it lives on a
contract MorScan already indexes. Surfacing a new subnet can be as small as a
spec, a labeled view over data already in D1, and a dashboard card.

## Open specs

- [`0001-mordiem.md`](0001-mordiem.md) - surface Mordiem, a Morpheus
  builder-subnet operator, as the first labeled subnet view. Mostly reads data
  MorScan already indexes.
