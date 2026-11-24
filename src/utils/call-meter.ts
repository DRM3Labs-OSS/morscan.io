/**
 * Global ceilings, counted exactly (the CallMeter Durable Object).
 *
 * `meterTake` asks the counting object for `key` whether n more uses fit in
 * every window, and counts them when they do. It answers null when the
 * CALL_METER binding is absent or the object did not answer in time; the
 * caller picks the direction:
 *   - a limiter on the availability path (a page render, a read) FAILS OPEN
 *     (`allowedOpen`): a broken meter must not take the site down;
 *   - a write a stranger can cause (a log row, a stored receipt, a signup)
 *     FAILS CLOSED when the meter is configured but broken
 *     (`allowedClosed`), and runs unmetered only on a build with no meter.
 *
 * Only paths that already pay a database round trip (a cache miss, a write
 * done off the response path) call this, so a request served from a cache
 * never waits on the meter.
 *
 * `shards` spreads a hot key over that many objects, each holding its share
 * of every limit (floor), so the total admitted never exceeds the limit.
 */

import type { Env } from "../types";

export interface MeterVerdict {
	ok: boolean;
	/** Seconds until the refusing window rolls over (0 when ok). */
	retry: number;
}

/** [limit, window seconds]. 60 = per minute, 86400 = per UTC day. */
export type MeterWindow = [number, number];

const METER_TIMEOUT_MS = 1500;

export async function meterTake(
	env: Pick<Env, "CALL_METER">,
	key: string,
	windows: MeterWindow[],
	opts: { n?: number; shards?: number } = {},
): Promise<MeterVerdict | null> {
	const ns = env.CALL_METER;
	if (!ns) return null;
	const shards = Math.max(1, Math.floor(opts.shards || 1));
	const shard = shards > 1 ? Math.floor(Math.random() * shards) : 0;
	const name = shards > 1 ? `${key}#${shard}` : key;
	const per: MeterWindow[] = windows.map(([limit, s]) => [Math.floor(limit / shards), s]);
	try {
		const stub = ns.get(ns.idFromName(name));
		const resp = await stub.fetch("https://call-meter/take", {
			method: "POST",
			body: JSON.stringify({ key: name, n: opts.n ?? 1, windows: per }),
			signal: AbortSignal.timeout(METER_TIMEOUT_MS),
		});
		if (!resp.ok) return null;
		const j = (await resp.json()) as { ok?: unknown; retry?: unknown };
		return { ok: j.ok === true, retry: Math.max(0, Number(j.retry) || 0) };
	} catch {
		return null;
	}
}

/** Availability direction: no answer lets the request through. */
export function allowedOpen(v: MeterVerdict | null): boolean {
	return v === null || v.ok;
}

/**
 * Write direction: no answer refuses the write when a meter is configured
 * (it is broken or overloaded), and allows it on a build without one.
 */
export function allowedClosed(
	env: Pick<Env, "CALL_METER">,
	v: MeterVerdict | null,
): boolean {
	if (v === null) return !env.CALL_METER;
	return v.ok;
}
