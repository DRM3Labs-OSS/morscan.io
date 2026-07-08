/**
 * Local health-contract - the canonical, strongly-typed shape of this service's
 * GET /health response.
 *
 * Originally `@drm3/health-contract`, a shared DRM3 package pulled from a private
 * release URL. This OSS build vendors a self-contained, dependency-free copy of
 * just the two functions MorScan uses (`buildHealth` for the producer, plus
 * `validateHealth` for the conformance test) so the repo has no dependency on
 * DRM3 release infrastructure and no transitive `zod` requirement.
 *
 * `buildHealth()` throws if the metrics don't match the SKU's contract - a
 * product literally cannot ship a drifted shape. `validateHealth()` is the
 * consumer-side mirror used by the conformance test.
 *
 * Field naming is camelCase, canonical; snake_case is not part of the contract.
 */

export type HealthStatus = "ok" | "degraded" | "down" | "error" | "maintenance";

const HEALTH_STATUSES: readonly HealthStatus[] = [
	"ok",
	"degraded",
	"down",
	"error",
	"maintenance",
];

/** A metric field's expected runtime type. */
type MetricType = "number" | "string" | "boolean" | "object";

/**
 * Per-SKU metric contracts - the fields the status page displays. Metrics may
 * sit at the top level OR inside `extended`; validateHealth() checks both.
 * A SKU absent here is base-validated only.
 */
const SKU_METRICS: Record<string, Record<string, MetricType>> = {
	morscan: {
		syncedBlock: "number",
		blocksBehind: "number",
		providers: "number",
		activeSessions: "number",
		stakingFactor: "number",
	},
};

function typeOfValue(v: unknown): MetricType | "unknown" {
	if (typeof v === "number") return "number";
	if (typeof v === "string") return "string";
	if (typeof v === "boolean") return "boolean";
	if (v !== null && typeof v === "object") return "object";
	return "unknown";
}

/** Validate a metrics bag against a SKU's contract. Returns an error string or null. */
function checkMetrics(
	schema: Record<string, MetricType>,
	metrics: Record<string, unknown>,
): string | null {
	const issues: string[] = [];
	for (const [field, expected] of Object.entries(schema)) {
		const actual = typeOfValue(metrics[field]);
		if (actual !== expected) {
			issues.push(`${field}: expected ${expected}, got ${actual}`);
		}
	}
	return issues.length ? issues.join("; ") : null;
}

export interface BaseHealth {
	status: HealthStatus;
	sku: string;
	product?: string;
	version?: string;
	timestamp?: string;
	extended?: Record<string, unknown>;
}

export interface HealthValidation {
	ok: boolean;
	base?: BaseHealth;
	/** Canonical, typed metrics for the SKU (empty for base-only SKUs). */
	metrics: Record<string, unknown>;
	/** Human-readable, field-specific reason when ok === false. */
	error?: string;
}

/**
 * CONSUMER side. Validate a fetched /health body against the contract for
 * `sku`. Metrics are read from the top level first, then `extended`.
 */
export function validateHealth(sku: string, body: unknown): HealthValidation {
	if (body === null || typeof body !== "object") {
		return { ok: false, metrics: {}, error: "base envelope invalid - not an object" };
	}
	const obj = body as Record<string, unknown>;

	if (!HEALTH_STATUSES.includes(obj.status as HealthStatus)) {
		return {
			ok: false,
			metrics: {},
			error: `base envelope invalid - status: invalid value "${String(obj.status)}"`,
		};
	}
	if (typeof obj.sku !== "string" || obj.sku.length === 0) {
		return {
			ok: false,
			metrics: {},
			error: "base envelope invalid - sku: required non-empty string",
		};
	}

	const base: BaseHealth = {
		status: obj.status as HealthStatus,
		sku: obj.sku,
		product: typeof obj.product === "string" ? obj.product : undefined,
		version: typeof obj.version === "string" ? obj.version : undefined,
		timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
		extended:
			obj.extended !== null && typeof obj.extended === "object"
				? (obj.extended as Record<string, unknown>)
				: undefined,
	};

	const schema = SKU_METRICS[sku];
	if (!schema) return { ok: true, base, metrics: {} };

	const ext = base.extended ?? {};
	const candidate: Record<string, unknown> = {};
	for (const key of Object.keys(schema)) {
		candidate[key] = obj[key] !== undefined ? obj[key] : ext[key];
	}
	const issues = checkMetrics(schema, candidate);
	if (issues) {
		return { ok: false, base, metrics: {}, error: `metrics - ${issues}` };
	}
	return { ok: true, base, metrics: candidate };
}

export interface BuildHealthInput {
	sku: string;
	status: HealthStatus;
	product?: string;
	version?: string;
	/** The SKU's canonical metrics. Validated against SKU_METRICS - throws on drift. */
	metrics?: Record<string, unknown>;
	/** Extra display detail. Merged under `extended` alongside the metrics. */
	extended?: Record<string, unknown>;
	/** ISO timestamp; defaults to now. */
	timestamp?: string;
}

/**
 * PRODUCER side. Build a contract-valid /health body. Throws (loudly, in the
 * producer's own tests/deploy) if `metrics` don't match the SKU's schema - so a
 * product cannot ship a drifted shape. Emits the canonical metrics at the top
 * level AND inside `extended` for display.
 */
export function buildHealth(input: BuildHealthInput): Record<string, unknown> {
	const schema = SKU_METRICS[input.sku];
	const metrics = input.metrics ?? {};
	if (schema) {
		const issues = checkMetrics(schema, metrics);
		if (issues) {
			throw new Error(`buildHealth: metrics drift for sku "${input.sku}" - ${issues}`);
		}
	}
	return {
		status: input.status,
		sku: input.sku,
		...(input.product ? { product: input.product } : {}),
		...(input.version ? { version: input.version } : {}),
		timestamp: input.timestamp ?? new Date().toISOString(),
		...metrics,
		extended: { ...metrics, ...(input.extended ?? {}) },
	};
}
