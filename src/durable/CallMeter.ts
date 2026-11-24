/**
 * CallMeter - an exact counter for a door that shares the one database.
 *
 * The Workers rate-limiting bindings count per machine, and a per-isolate Map
 * or a KV read-modify-write is not a count at all under concurrency. A door
 * that strangers can make expensive (an uncached page render, a sessions page
 * miss, a usage-log row, a stored receipt, a launch-list signup) is therefore
 * counted here: one object per counting key (src/utils/call-meter.ts picks the
 * object), single-threaded, so a take is exact.
 *
 * POST /take {key, n, windows: [[limit, seconds], ...]} answers
 * {ok, retry}: ok only when every window has room for n more, and then n is
 * added to every window (all or nothing). A window is aligned to the epoch, so
 * an 86400-second window is the UTC day. Windows of an hour or more are written
 * to storage (every 25 takes of one, or at once for a take of more than one),
 * so a day count survives the object being moved; a minute window lives in
 * memory, where losing it costs at most one minute of count.
 *
 * Nothing here reads or writes D1, and nothing here runs an alarm.
 */

interface Counter {
	w: number; // window index (floor(now / seconds))
	c: number; // count in that window
	dirty: number; // takes since the last storage write
}

const MAX_WINDOWS = 4;
const MAX_WINDOW_S = 31 * 86400;
const PERSIST_FROM_S = 3600;
const PERSIST_EVERY = 25;

function bad(msg: string): Response {
	return new Response(JSON.stringify({ error: msg }), { status: 400 });
}

export class CallMeter implements DurableObject {
	private state: DurableObjectState;
	private counters = new Map<string, Counter>();

	constructor(state: DurableObjectState, _env: unknown) {
		this.state = state;
	}

	private async load(id: string, seconds: number, w: number): Promise<Counter> {
		const have = this.counters.get(id);
		if (have && have.w === w) return have;
		let c: Counter = { w, c: 0, dirty: 0 };
		if (seconds >= PERSIST_FROM_S) {
			const stored = await this.state.storage.get<{ w: number; c: number }>(id);
			if (stored && stored.w === w) c = { w, c: stored.c, dirty: 0 };
		}
		this.counters.set(id, c);
		return c;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return bad("POST /take");
		let body: { key?: unknown; n?: unknown; windows?: unknown };
		try {
			body = await request.json();
		} catch {
			return bad("body is not JSON");
		}
		const key = typeof body.key === "string" ? body.key.slice(0, 200) : "";
		const n = Number(body.n ?? 1);
		const windows = Array.isArray(body.windows) ? body.windows.slice(0, MAX_WINDOWS) : [];
		if (!key || !Number.isInteger(n) || n < 1 || n > 1e9 || !windows.length) {
			return bad("expected {key, n, windows}");
		}
		const nowS = Date.now() / 1000;
		const rows: Array<{ id: string; seconds: number; limit: number; c: Counter }> = [];
		for (const w of windows) {
			const [limit, seconds] = Array.isArray(w) ? w.map(Number) : [];
			if (!Number.isInteger(limit) || limit < 0) return bad("limit");
			if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WINDOW_S)
				return bad("window");
			const id = `${key}|${seconds}`;
			const idx = Math.floor(nowS / seconds);
			rows.push({ id, seconds, limit, c: await this.load(id, seconds, idx) });
		}
		let retry = 0;
		for (const r of rows) {
			if (r.c.c + n > r.limit) {
				retry = Math.max(retry, Math.ceil((r.c.w + 1) * r.seconds - nowS));
			}
		}
		if (retry > 0) return Response.json({ ok: false, retry });
		for (const r of rows) {
			r.c.c += n;
			if (r.seconds < PERSIST_FROM_S) continue;
			r.c.dirty++;
			if (n > 1 || r.c.dirty >= PERSIST_EVERY) {
				r.c.dirty = 0;
				await this.state.storage.put(r.id, { w: r.c.w, c: r.c.c });
			}
		}
		return Response.json({ ok: true, retry: 0 });
	}
}
