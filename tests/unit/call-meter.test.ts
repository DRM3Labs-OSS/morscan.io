/**
 * The exact global ceilings (src/durable/CallMeter.ts, src/utils/call-meter.ts).
 *
 * Contract under test:
 *  - a take fits or is refused whole: every window must have room, and a
 *    refused take counts in no window;
 *  - a refusal names the seconds until the refusing window rolls over;
 *  - a day window survives the object being rebuilt from storage;
 *  - meterTake answers null without the binding or when the object fails, and
 *    the caller picks the direction: allowedOpen lets it through,
 *    allowedClosed refuses it when a meter is configured;
 *  - shards split every limit, so the total admitted never exceeds it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallMeter } from "../../src/durable/CallMeter";
import { allowedClosed, allowedOpen, meterTake } from "../../src/utils/call-meter";
import { fakeMeter, fakeStorage } from "./_fake-meter";

async function take(
	m: CallMeter,
	windows: Array<[number, number]>,
	n = 1,
): Promise<{ ok: boolean; retry: number }> {
	const r = await m.fetch(
		new Request("https://call-meter/take", {
			method: "POST",
			body: JSON.stringify({ key: "k", n, windows }),
		}),
	);
	expect(r.status).toBe(200);
	return r.json();
}

// Mid-minute, mid-day: no window rolls over inside a test.
const NOW = Date.UTC(2026, 10, 24, 12, 0, 30);
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("CallMeter", () => {
	it("admits up to the limit, then refuses with the seconds left in the window", async () => {
		const m = new CallMeter(fakeStorage().state, {});
		for (let i = 0; i < 3; i++) expect((await take(m, [[3, 60]])).ok).toBe(true);
		const no = await take(m, [[3, 60]]);
		expect(no.ok).toBe(false);
		expect(no.retry).toBeGreaterThan(0);
		expect(no.retry).toBeLessThanOrEqual(60);
	});

	it("is all or nothing across windows: a full day window counts nothing in the minute", async () => {
		const m = new CallMeter(fakeStorage().state, {});
		expect((await take(m, [[10, 60], [1, 86400]])).ok).toBe(true);
		// The day is full: refused, and the minute window must not move.
		expect((await take(m, [[10, 60], [1, 86400]])).ok).toBe(false);
		for (let i = 0; i < 9; i++) expect((await take(m, [[10, 60]])).ok).toBe(true);
		expect((await take(m, [[10, 60]])).ok).toBe(false);
	});

	it("counts n at once and refuses a take that does not fit whole", async () => {
		const m = new CallMeter(fakeStorage().state, {});
		expect((await take(m, [[10_000, 86400]], 6_000)).ok).toBe(true);
		expect((await take(m, [[10_000, 86400]], 5_000)).ok).toBe(false);
		expect((await take(m, [[10_000, 86400]], 4_000)).ok).toBe(true);
	});

	it("a day window survives the object being rebuilt from its storage", async () => {
		const st = fakeStorage();
		const a = new CallMeter(st.state, {});
		expect((await take(a, [[5_000, 86400]], 5_000)).ok).toBe(true);
		const b = new CallMeter(st.state, {});
		expect((await take(b, [[5_000, 86400]], 1)).ok).toBe(false);
	});

	it("refuses a malformed body with a 400 and counts nothing", async () => {
		const m = new CallMeter(fakeStorage().state, {});
		for (const body of ["nope", "{}", '{"key":"k","windows":[[1,0]]}', '{"key":"k","n":0,"windows":[[1,60]]}']) {
			const r = await m.fetch(new Request("https://call-meter/take", { method: "POST", body }));
			expect(r.status).toBe(400);
		}
		expect((await take(m, [[1, 60]])).ok).toBe(true);
	});
});

describe("meterTake", () => {
	it("answers null without a binding; both directions then allow", async () => {
		const v = await meterTake({}, "x", [[1, 60]]);
		expect(v).toBeNull();
		expect(allowedOpen(v)).toBe(true);
		expect(allowedClosed({}, v)).toBe(true);
	});

	it("an unreachable meter: open lets it through, closed refuses the write", async () => {
		const { ns } = fakeMeter({ fail: true });
		const env = { CALL_METER: ns };
		const v = await meterTake(env, "x", [[1, 60]]);
		expect(v).toBeNull();
		expect(allowedOpen(v)).toBe(true);
		expect(allowedClosed(env, v)).toBe(false);
	});

	it("counts exactly through the binding and refuses past the limit", async () => {
		const { ns } = fakeMeter();
		const env = { CALL_METER: ns };
		expect((await meterTake(env, "door", [[2, 60]]))?.ok).toBe(true);
		expect((await meterTake(env, "door", [[2, 60]]))?.ok).toBe(true);
		const no = await meterTake(env, "door", [[2, 60]]);
		expect(no?.ok).toBe(false);
		expect(allowedOpen(no)).toBe(false);
		expect(allowedClosed(env, no)).toBe(false);
	});

	it("shards split the limit, so the total never exceeds it", async () => {
		const { ns, objects } = fakeMeter();
		const env = { CALL_METER: ns };
		let admitted = 0;
		for (let i = 0; i < 200; i++) {
			if ((await meterTake(env, "hot", [[40, 60]], { shards: 4 }))?.ok) admitted++;
		}
		expect(admitted).toBeLessThanOrEqual(40);
		expect([...objects.keys()].every((k) => /^hot#[0-3]$/.test(k))).toBe(true);
	});
});
