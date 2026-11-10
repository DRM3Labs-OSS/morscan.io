import { describe, expect, it } from "vitest";
import { classifyHealth, type HealthInputs } from "../../src/handlers/health-status";

const base: HealthInputs = {
	syncError: false,
	blockTimeMs: 200,
	lastSyncAgeSeconds: 10,
	blocksBehind: 5,
	builderBlocksBehind: 20,
	cursorBlocksBehind: 5,
};
const run = (o: Partial<HealthInputs>) => classifyHealth({ ...base, ...o });

describe("classifyHealth - lag judged in seconds, not blocks", () => {
	it("REGRESSION 2026-11-10: 182 blocks at 200ms (~36s) is healthy, not degraded", () => {
		const v = run({ blocksBehind: 182, builderBlocksBehind: 196 });
		expect(v.lagSeconds).toBe(36);
		expect(v.status).toBe("ok");
		expect(v.builderStatus).toBe("ok");
	});

	it("the same rules hold at the old 2s cadence", () => {
		expect(run({ blockTimeMs: 2000, blocksBehind: 49 }).status).toBe("ok");
		expect(run({ blockTimeMs: 2000, blocksBehind: 50 }).status).toBe("degraded");
		expect(run({ blockTimeMs: 2000, blocksBehind: 500 }).status).toBe("error");
	});

	it("degraded at 100s of lag, error at 1000s", () => {
		expect(run({ blocksBehind: 495 }).status).toBe("ok");
		expect(run({ blocksBehind: 500 }).status).toBe("degraded");
		expect(run({ blocksBehind: 5000 }).status).toBe("error");
	});

	it("builder: degraded at 200s, error at 1000s", () => {
		expect(run({ builderBlocksBehind: 995 }).builderStatus).toBe("ok");
		expect(run({ builderBlocksBehind: 1000 }).status).toBe("degraded");
		expect(run({ builderBlocksBehind: 5000 }).status).toBe("error");
		expect(run({ builderBlocksBehind: null }).builderStatus).toBe(null);
	});

	it("a dead sync is caught by wall-clock age even with a zero gap", () => {
		expect(run({ blocksBehind: 0, lastSyncAgeSeconds: 121 }).status).toBe("degraded");
		expect(run({ blocksBehind: 0, lastSyncAgeSeconds: 301 }).status).toBe("error");
		expect(run({ lastSyncAgeSeconds: null }).status).toBe("error");
	});

	it("event cursor stuck: stale tick AND over 60s of cursor lag", () => {
		expect(run({ lastSyncAgeSeconds: 130, cursorBlocksBehind: 310 }).eventCursorStuck).toBe(
			true,
		);
		expect(run({ lastSyncAgeSeconds: 130, cursorBlocksBehind: 299 }).eventCursorStuck).toBe(
			false,
		);
		expect(run({ lastSyncAgeSeconds: 10, cursorBlocksBehind: 5000 }).eventCursorStuck).toBe(
			false,
		);
	});

	it("a read failure is an error", () => {
		expect(run({ syncError: true }).status).toBe("error");
	});
});
