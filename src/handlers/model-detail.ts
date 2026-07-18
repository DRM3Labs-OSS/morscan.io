/**
 * Model Detail Handler
 *
 * GET /mor/v1/models/:id/detail - one model's full marketplace picture:
 * identity (name, description, tags), the current asks (active bids with
 * providers), demand (sessions, distinct consumers, daily series), and
 * per-provider reputation on this model. The demand-side mirror of the
 * provider detail endpoint.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse } from "../utils/provenance";
import {
	getModelDetailById,
	getModelActiveBidsWithProviders,
	getModelsIdNameCreated,
	getActiveBidCountsByModelIds,
	getNetworkEconomics,
} from "../db/explorer-market";
import {
	getModelSessionSummary,
	getRecentModelSessions,
	getModelBidSessionCounts,
	getModelProviderStats,
	getModelDailySessions,
	getSessionAggByModelIds,
	getFamilySessionTotals,
} from "../db/explorer-sessions";

const num = (v: unknown): number => Number(v) || 0;

// Org prefixes that lead marketplace names ("moonshotai/kimi-k3",
// "Google Gemma 4 31B"). They are dropped before picking the family token so
// vendor-prefixed and bare listings of the same family group together.
const ORG_TOKENS = new Set([
	"google",
	"meta",
	"openai",
	"moonshotai",
	"tencent",
	"nvidia",
	"xai",
	"alibaba",
	"bytedance",
	"microsoft",
	"mistralai",
	"deepseek-ai",
	"anthropic",
]);

/** Normalize a marketplace model name to a family key: first meaningful token,
 * version digits stripped ("Kimi K3" / "moonshotai/kimi-k3" / "Kimi-K2.5" all
 * map to "kimi"; "GLM 5.1" / "glm-4.7-flash:web" both map to "glm"). A
 * heuristic over free-form on-chain names, so it aims for useful, not perfect. */
export function modelFamilyKey(name: string | null | undefined): string | null {
	if (!name) return null;
	const tokens = String(name)
		.toLowerCase()
		.split(/[\s/_\-:.,()]+/)
		.filter(Boolean);
	for (const t of tokens) {
		if (ORG_TOKENS.has(t)) continue;
		if (/^\d/.test(t)) continue;
		const base = t.replace(/[\d.]+$/, "");
		if (base.length >= 1) return base;
	}
	return null;
}

const TEE_RE = /(^|[^a-z])tee([^a-z]|$)/i;
const WEB_RE = /:web$/i;

export async function handleModelDetail(
	env: Env,
	modelId: string,
	headers: Record<string, string>,
) {
	const id = modelId.toLowerCase();
	const now = Math.floor(Date.now() / 1000);

	const model = await getModelDetailById(env.DB, id);
	if (!model) {
		return new Response(JSON.stringify({ error: "Model not found" }), {
			status: 404,
			headers,
		});
	}

	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const [
		activeBids,
		sessionSummary,
		recentSessions,
		bidSessionCounts,
		providerStats,
		dailySessions,
		economicsRow,
		allModels,
	] = await Promise.all([
		getModelActiveBidsWithProviders(env.DB, id),
		getModelSessionSummary(env.DB, now, id),
		getRecentModelSessions(env.DB, id),
		getModelBidSessionCounts(env.DB, id),
		getModelProviderStats(env.DB, id),
		getModelDailySessions(env.DB, id, now - 30 * 86400),
		getNetworkEconomics(env.DB),
		getModelsIdNameCreated(env.DB),
	]);

	// The family: every registration whose name normalizes to the same key.
	// The current model always belongs, even when its own name is unset.
	const famKey = modelFamilyKey(model.name as string);
	const familyRows = famKey
		? allModels.filter(
				(m) => m.model_id === id || modelFamilyKey(m.name as string) === famKey,
			)
		: allModels.filter((m) => m.model_id === id);
	const familyIds = familyRows.map((m) => m.model_id as string);
	const [familyAgg, familyTotals, familyBids] = await Promise.all([
		getSessionAggByModelIds(env.DB, familyIds),
		getFamilySessionTotals(env.DB, familyIds),
		getActiveBidCountsByModelIds(env.DB, familyIds),
	]);
	const aggById: Record<string, Record<string, unknown>> = {};
	for (const r of familyAgg) aggById[r.model_id as string] = r;
	const bidsById: Record<string, Record<string, unknown>> = {};
	for (const r of familyBids) bidsById[r.model_id as string] = r;

	const familyVariants = familyRows
		.map((m) => {
			const agg = aggById[m.model_id as string] || {};
			const bc = bidsById[m.model_id as string] || {};
			const vname = (m.name as string) || "";
			return {
				modelId: m.model_id,
				name: vname || null,
				createdAt: m.created_at,
				totalSessions: num(agg.total_sessions),
				stakeMor: (num(agg.total_stake_wei) / 1e18).toFixed(2),
				providerCount: num(agg.provider_count),
				activeBids: num(bc.bid_count),
				tee: TEE_RE.test(vname),
				web: WEB_RE.test(vname),
				isCurrent: m.model_id === id,
			};
		})
		// Busiest first, then newest; the current registration is highlighted
		// client-side wherever it sorts.
		.sort(
			(a, b) => b.totalSessions - a.totalSessions || num(b.createdAt) - num(a.createdAt),
		);
	const familyFirstSeen = familyRows.length
		? Math.min(...familyRows.map((m) => num(m.created_at) || now))
		: null;
	const ft = (familyTotals || {}) as Record<string, unknown>;

	const stakingFactor =
		((economicsRow as Record<string, unknown>)?.staking_factor as number) || 0.00315;

	// Per-bid session count lookup (demand per ask)
	const bidSessions: Record<string, Record<string, unknown>> = {};
	for (const r of bidSessionCounts) bidSessions[r.bid_id as string] = r;

	// Active asks, cheapest first (the db query pre-sorts on price)
	const bids = activeBids.map((b: Record<string, unknown>) => {
		const pricePerSec = BigInt((b.price_per_second as string) || "0");
		const morPerHour = (Number(pricePerSec) * 3600) / 1e18;
		const pricePerDay = morPerHour * 24;
		const hourlyStake =
			stakingFactor > 0 && morPerHour > 0 ? Math.ceil(morPerHour / stakingFactor) : 0;
		const bs = bidSessions[b.bid_id as string] || {};
		return {
			bidId: b.bid_id,
			provider: b.provider,
			providerEndpoint: b.provider_endpoint || null,
			pricePerSecond: pricePerSec.toString(),
			priceMorPerHour: morPerHour.toFixed(6),
			priceMorPerDay: pricePerDay.toFixed(6),
			hourlyStake,
			totalSessions: bs.total_count || 0,
			activeSessions: bs.active_count || 0,
			createdAt: b.created_at,
		};
	});

	// Ask spread across active bids (wei/sec as numbers; fine at display precision)
	const askWei = activeBids
		.map((b) => Number((b.price_per_second as string) || "0"))
		.filter((n) => n > 0)
		.sort((a, b) => a - b);
	const medianWei = askWei.length
		? askWei.length % 2
			? askWei[(askWei.length - 1) / 2]
			: (askWei[askWei.length / 2 - 1] + askWei[askWei.length / 2]) / 2
		: 0;

	// Per-provider reputation on this model
	const providers = providerStats.map((r: Record<string, unknown>) => ({
		provider: r.provider,
		endpoint: r.provider_endpoint || null,
		totalSessions: r.total_sessions,
		successCount: r.success_count,
		disputeCount: r.dispute_count,
		earlyTerminationCount: r.early_termination_count,
		avgDurationSecs: r.avg_duration_secs,
		successRate:
			num(r.total_sessions) > 0
				? ((num(r.success_count) / num(r.total_sessions)) * 100).toFixed(1)
				: null,
	}));

	const sessions = recentSessions.map((s: Record<string, unknown>) => ({
		id: s.id,
		user: s.user_address,
		provider: s.provider,
		providerEndpoint: s.provider_endpoint || null,
		stakeMor: (Number(BigInt((s.stake as string) || "0")) / 1e18).toFixed(4),
		openedAt: s.opened_at,
		endsAt: s.ends_at,
		closedAt: s.closed_at,
		isActive: s.is_active === 1,
		closeoutType: s.closeout_type,
	}));

	const ss = (sessionSummary || {}) as Record<string, unknown>;
	const totalSessions = num(ss.total_sessions);
	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		model: {
			modelId: id,
			name: model.name || null,
			description: model.description || null,
			tags: model.tags ? (model.tags as string).split(",").filter(Boolean) : [],
			createdAt: model.created_at,
		},
		summary: {
			activeBids: bids.length,
			providers: new Set(activeBids.map((b) => b.provider as string)).size,
			totalSessions,
			activeSessions: num(ss.active_sessions),
			successSessions: num(ss.success_sessions),
			disputedSessions: num(ss.disputed_sessions),
			uniqueUsers: num(ss.unique_users),
			totalStakeMor: (num(ss.total_stake_wei) / 1e18).toFixed(4),
			avgDurationMin: ss.avg_duration_secs
				? Math.round(num(ss.avg_duration_secs) / 60)
				: null,
			firstSession: ss.first_session || null,
			lastSession: ss.last_session || null,
			minAskMorPerHour: askWei.length ? ((askWei[0] * 3600) / 1e18).toFixed(6) : null,
			medianAskMorPerHour: medianWei ? ((medianWei * 3600) / 1e18).toFixed(6) : null,
			stakingFactor,
		},
		bids,
		providers,
		recentSessions: sessions,
		dailySessions: dailySessions.map((d: Record<string, unknown>) => ({
			day: d.day,
			sessions: d.sessions,
		})),
		family: {
			key: famKey,
			firstSeen: familyFirstSeen,
			teeAvailable: familyVariants.some((v) => v.tee),
			webAvailable: familyVariants.some((v) => v.web),
			variantCount: familyVariants.length,
			totals: {
				totalSessions: num(ft.total_sessions),
				totalStakeMor: (num(ft.total_stake_wei) / 1e18).toFixed(2),
				providerCount: num(ft.provider_count),
				uniqueUsers: num(ft.unique_users),
				firstSession: ft.first_session || null,
				lastSession: ft.last_session || null,
			},
			variants: familyVariants,
		},
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		const receipt = await signResponse(
			"blockchain.model_detail",
			{ endpoint: `/mor/v1/models/${id}/detail`, syncedBlock: lastBlock },
			{ activeBids: bids.length, totalSessions, activeSessions: num(ss.active_sessions) },
			mnemonic,
			env.DB,
			responseData,
		);
		if (receipt) responseData._provenance = JSON.parse(receipt);
	}

	return new Response(JSON.stringify(responseData), { headers });
}
