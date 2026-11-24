/**
 * An in-memory CALL_METER namespace for unit tests: each object name gets a
 * real CallMeter instance over a Map-backed storage, so a test exercises the
 * production counter. `fail` makes every call throw (an unreachable object).
 */

import { CallMeter } from "../../src/durable/CallMeter";

export function fakeStorage(): {
	map: Map<string, unknown>;
	state: DurableObjectState;
} {
	const map = new Map<string, unknown>();
	const state = {
		storage: {
			get: async (k: string) => map.get(k),
			put: async (k: string, v: unknown) => {
				map.set(k, v);
			},
		},
	} as unknown as DurableObjectState;
	return { map, state };
}

export function fakeMeter(opts: { fail?: boolean } = {}) {
	const objects = new Map<string, CallMeter>();
	const calls: string[] = [];
	const ns = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: async (url: string, init?: RequestInit) => {
				calls.push(id);
				if (opts.fail) throw new Error("meter unreachable");
				let o = objects.get(id);
				if (!o) {
					o = new CallMeter(fakeStorage().state, {});
					objects.set(id, o);
				}
				return o.fetch(new Request(url, init));
			},
		}),
	};
	return { ns: ns as unknown as DurableObjectNamespace, objects, calls };
}
