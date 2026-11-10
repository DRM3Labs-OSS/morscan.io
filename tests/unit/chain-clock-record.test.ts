import { describe, expect, it } from "vitest";
import { readBlockTimeMs, recordHead } from "../../src/sync/chain-clock";

/** Minimal sync_state stand-in: the two statement shapes the clock issues. */
function fakeDb() {
	const rows = new Map<string, string>();
	const stmt = (sql: string, args: unknown[] = []) => ({
		bind: (...a: unknown[]) => stmt(sql, a),
		first: async () => {
			const v = rows.get(String(args[0]));
			return v === undefined ? null : { value: v };
		},
		run: async () => {
			if (!sql.startsWith("INSERT OR REPLACE INTO sync_state")) throw new Error(sql);
			rows.set(String(args[0]), String(args[1]));
			return { success: true };
		},
	});
	const db = {
		prepare: (sql: string) => stmt(sql),
		batch: async (s: Array<{ run: () => Promise<unknown> }>) => {
			for (const x of s) await x.run();
			return [];
		},
	};
	return { db: db as unknown as D1Database, rows };
}

describe("recordHead", () => {
	it("anchors, then stores a measurement once 60s of chain time has passed", async () => {
		const { db, rows } = fakeDb();
		expect(await recordHead(db, { block: 1000, timestamp: 0 })).toBe(200);
		expect(rows.get("head_anchor")).toBe("1000:0");
		expect(await recordHead(db, { block: 1100, timestamp: 20 })).toBe(200);
		expect(rows.has("block_time_ms")).toBe(false);
		expect(await recordHead(db, { block: 1040, timestamp: 80 })).toBe(2000);
		expect(rows.get("block_time_ms")).toBe("2000");
		expect(rows.get("head_anchor")).toBe("1040:80");
		expect(await readBlockTimeMs(db)).toBe(2000);
	});
});
