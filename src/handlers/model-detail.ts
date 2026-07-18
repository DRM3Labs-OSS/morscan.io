/**
 * Model Detail Handler
 *
 * GET /mor/v1/models/:id/detail - the canonical-model page. A model like
 * "Kimi K3" can be registered on chain many times, under many spellings
 * ("Kimi K3", "moonshotai/kimi-k3", a ":web" variant), by any number of
 * providers. The page anchors on the CANONICAL MODEL: every listing whose
 * normalized name matches is aggregated - providers offering it, sessions,
 * stake, asks - with each on-chain listing itemized below, and ":web"/":tee"
 * variants folded in as capability badges rather than separate models.
 *
 * Grouping is a name heuristic with a curated override: models.canonical
 * (display name, admin-set) wins over the normalized on-chain name, and
 * models.family wins over the derived family token.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { getSyncState, buildMeta } from "../utils/rpc";
import { signResponse } from "../utils/provenance";
import {
	getModelDetailById,
	getModelsIdNameCreated,
	getActiveBidsWithProvidersByModelIds,
	getActiveBidCountsByModelIds,
	getNetworkEconomics,
} from "../db/explorer-market";
import {
	getSessionSummaryByModelIds,
	getRecentSessionsByModelIds,
	getBidSessionCountsByModelIds,
	getProviderStatsByModelIds,
	getDailySessionsByModelIds,
	getProviderUnionCountByModelIds,
	getSessionAggByModelIds,
} from "../db/explorer-sessions";

const num = (v: unknown): number => Number(v) || 0;

// Org prefixes that lead marketplace names ("moonshotai/kimi-k3",
// "Google Gemma 4 31B"). They are dropped before normalizing so vendor-
// prefixed and bare listings of the same model group together.
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

const TEE_RE = /(^|[^a-z])tee([^a-z]|$)/i;
const WEB_RE = /:web$/i;

/** Peel capability suffixes (":web", ":tee", stacked in any order) off a
 * listing name. The capabilities become badges; the base names the model. */
export function stripListingFlags(name: string): {
	base: string;
	web: boolean;
	tee: boolean;
} {
	let base = String(name || "").trim();
	let web = false;
	let tee = false;
	for (;;) {
		if (/:web$/i.test(base)) {
			web = true;
			base = base.replace(/:web$/i, "").trim();
			continue;
		}
		if (/:tee$/i.test(base)) {
			tee = true;
			base = base.replace(/:tee$/i, "").trim();
			continue;
		}
		break;
	}
	// A "tee" embedded elsewhere ("gpt-oss:120B:tee" handled above; "qwq-32b:tee"
	// too) - the token test catches remaining spellings without eating words.
	if (!tee && TEE_RE.test(name || "")) tee = true;
	return { base, web, tee };
}

/** Normalize a listing name to its canonical-model key. "Kimi K3",
 * "moonshotai/kimi-k3", "Kimi-K3" and "kimi-k3:web" all map to the same key;
 * version digits stay significant ("kimi k2.5" != "kimi k3"). A heuristic
 * over free-form on-chain names - useful, not perfect; models.canonical
 * curates the exceptions. */
export function canonicalModelKey(name: string | null | undefined): string | null {
	if (!name) return null;
	const { base } = stripListingFlags(String(name));
	// Drop huggingface-style org prefixes ("org/model").
	const afterSlash = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
	const tokens = afterSlash
		.toLowerCase()
		.split(/[\s_\-()]+/)
		.filter(Boolean)
		.filter((t, i) => !(i === 0 && ORG_TOKENS.has(t)));
	if (!tokens.length) return null;
	// Split alpha-digit boundaries so "qwen3.6" and "qwen 3.6" agree.
	const norm = tokens
		.map((t) =>
			t
				.replace(/([a-z])(\d)/g, "$1 $2")
				.replace(/(\d)([a-z])/g, "$1 $2")
				.trim(),
		)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return norm || null;
}

/** First meaningful token of the canonical key = the model family
 * ("kimi k3" -> "kimi", "glm 4.7 flash" -> "glm"). */
export function modelFamilyKey(name: string | null | undefined): string | null {
	const key = canonicalModelKey(name);
	if (!key) return null;
	for (const t of key.split(" ")) {
		if (/^\d/.test(t)) continue;
		const basePart = t.replace(/[\d.]+$/, "");
		if (basePart.length >= 1) return basePart;
	}
	return null;
}

interface ModelRow {
	model_id: string;
	name: string | null;
	family: string | null;
	canonical: string | null;
	description?: string | null;
	created_at: number | null;
	[key: string]: unknown;
}

const effectiveCanonicalKey = (m: ModelRow): string | null =>
	canonicalModelKey(m.canonical || m.name);
const effectiveFamilyKey = (m: ModelRow): string | null =>
	(m.family as string) || modelFamilyKey(m.canonical || m.name);

/** Pick the display name for a canonical group: curated name first, then the
 * cleanest raw base name (no org slash, has spaces/capitals). Deterministic
 * (ties: earliest listing, then shortest, then lexicographic) so the derived
 * slug URL and the rendered page always agree. */
function displayNameFor(rows: ModelRow[]): string | null {
	for (const r of rows) if (r.canonical) return r.canonical;
	let best: { name: string; score: number; created: number } | null = null;
	for (const r of rows) {
		if (!r.name) continue;
		const { base } = stripListingFlags(r.name);
		if (!base) continue;
		let score = 0;
		if (!base.includes("/")) score += 4;
		if (base.includes(" ")) score += 2;
		if (/[A-Z]/.test(base)) score += 1;
		const created = Number(r.created_at) || 0;
		const wins =
			!best ||
			score > best.score ||
			(score === best.score &&
				(created < best.created ||
					(created === best.created &&
						(base.length < best.name.length ||
							(base.length === best.name.length && base < best.name)))));
		if (wins) best = { name: base, score, created };
	}
	return best ? best.name : null;
}

/** URL slug for a canonical model name: "Kimi K3" -> "kimi-k3". Dots stay
 * ("GLM 4.7" -> "glm-4.7"); everything else non-alphanumeric collapses to
 * a hyphen. */
export function modelSlug(name: string | null | undefined): string | null {
	if (!name) return null;
	const slug = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.replace(/-{2,}/g, "-");
	if (!slug || /^0x[0-9a-f]{64}$/.test(slug)) return null;
	return slug.slice(0, 80);
}

/** Group every named model by canonical key -> {slug -> owning group}. On a
 * slug collision the group listed first on chain owns the URL; the others
 * stay reachable through their listing-id URLs. */
function buildSlugMap(allModels: ModelRow[]): Map<string, ModelRow[]> {
	const groups = new Map<string, ModelRow[]>();
	for (const m of allModels) {
		const k = effectiveCanonicalKey(m);
		if (!k) continue;
		const arr = groups.get(k);
		if (arr) arr.push(m);
		else groups.set(k, [m]);
	}
	const bySlug = new Map<string, ModelRow[]>();
	for (const rows of groups.values()) {
		const slug = modelSlug(displayNameFor(rows));
		if (!slug) continue;
		const existing = bySlug.get(slug);
		if (!existing) {
			bySlug.set(slug, rows);
			continue;
		}
		const firstSeen = (rs: ModelRow[]) =>
			Math.min(...rs.map((r) => Number(r.created_at) || Number.MAX_SAFE_INTEGER));
		if (firstSeen(rows) < firstSeen(existing)) bySlug.set(slug, rows);
	}
	return bySlug;
}

/** Every canonical-model slug (sitemap + discovery), sorted. */
export async function listModelSlugs(env: Env): Promise<string[]> {
	const allModels = (await getModelsIdNameCreated(env.DB)) as unknown as ModelRow[];
	return [...buildSlugMap(allModels).keys()].sort();
}

/** Resolve a canonical-model slug to one member listing id (the page then
 * aggregates the whole group), or null when no group owns the slug. */
export async function resolveModelSlug(env: Env, slug: string): Promise<string | null> {
	const allModels = (await getModelsIdNameCreated(env.DB)) as unknown as ModelRow[];
	const rows = buildSlugMap(allModels).get(slug.toLowerCase());
	if (!rows || !rows.length) return null;
	const lead = [...rows].sort(
		(a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0),
	)[0];
	return lead.model_id;
}

export async function handleModelDetail(
	env: Env,
	modelId: string,
	headers: Record<string, string>,
) {
	const id = modelId.toLowerCase();
	const now = Math.floor(Date.now() / 1000);

	const model = (await getModelDetailById(env.DB, id)) as ModelRow | null;
	if (!model) {
		return new Response(JSON.stringify({ error: "Model not found" }), {
			status: 404,
			headers,
		});
	}

	const { lastBlock, currentBlock, startBlock, lastSyncTs } = await getSyncState(env);
	const allModels = (await getModelsIdNameCreated(env.DB)) as unknown as ModelRow[];

	// ── The canonical group: every listing of this model ──
	const targetKey = effectiveCanonicalKey(model);
	const members = targetKey
		? allModels.filter((m) => m.model_id === id || effectiveCanonicalKey(m) === targetKey)
		: [{ ...model, model_id: id }];
	if (!members.some((m) => m.model_id === id)) members.push({ ...model, model_id: id });
	const memberIds = members.map((m) => m.model_id);
	const flagsById: Record<string, { web: boolean; tee: boolean }> = {};
	for (const m of members) flagsById[m.model_id] = stripListingFlags(m.name || "");

	// ── The family: every canonical model sharing the family token ──
	const famKey = effectiveFamilyKey(model);
	const famRows = famKey
		? allModels.filter((m) => effectiveFamilyKey(m) === famKey)
		: members;
	const famIds = famRows.map((m) => m.model_id);

	const [
		activeBids,
		groupSummary,
		recentSessions,
		bidSessionCounts,
		providerStats,
		dailySessions,
		perListingAgg,
		perListingBids,
		providersOffering,
		economicsRow,
		famAgg,
		famBidCounts,
		famSummary,
		famProvidersUnion,
	] = await Promise.all([
		getActiveBidsWithProvidersByModelIds(env.DB, memberIds),
		getSessionSummaryByModelIds(env.DB, now, memberIds),
		getRecentSessionsByModelIds(env.DB, memberIds),
		getBidSessionCountsByModelIds(env.DB, memberIds),
		getProviderStatsByModelIds(env.DB, memberIds),
		getDailySessionsByModelIds(env.DB, memberIds, now - 30 * 86400),
		getSessionAggByModelIds(env.DB, memberIds),
		getActiveBidCountsByModelIds(env.DB, memberIds),
		getProviderUnionCountByModelIds(env.DB, memberIds),
		getNetworkEconomics(env.DB),
		getSessionAggByModelIds(env.DB, famIds),
		getActiveBidCountsByModelIds(env.DB, famIds),
		getSessionSummaryByModelIds(env.DB, now, famIds),
		getProviderUnionCountByModelIds(env.DB, famIds),
	]);

	const stakingFactor =
		((economicsRow as Record<string, unknown>)?.staking_factor as number) || 0.00315;

	const aggById: Record<string, Record<string, unknown>> = {};
	for (const r of perListingAgg) aggById[r.model_id as string] = r;
	const listingBidsById: Record<string, Record<string, unknown>> = {};
	for (const r of perListingBids) listingBidsById[r.model_id as string] = r;
	const sessionsById: Record<string, number> = {};
	for (const r of perListingAgg)
		sessionsById[r.model_id as string] = num(r.total_sessions);

	const canonicalName = displayNameFor(members) || `${id.slice(0, 10)}...${id.slice(-4)}`;
	// The pretty URL: this group's slug, when it owns it (collisions keep the
	// first-listed group; losers stay on their listing-id URLs).
	const slugMap = buildSlugMap(allModels);
	const groupSlug = modelSlug(displayNameFor(members));
	const slugOwner = groupSlug ? slugMap.get(groupSlug) : undefined;
	const ownedSlug =
		groupSlug && slugOwner && effectiveCanonicalKey(slugOwner[0]) === targetKey
			? groupSlug
			: null;
	const slugFor = (rows: ModelRow[]): string | null => {
		const sl = modelSlug(displayNameFor(rows));
		if (!sl) return null;
		const owner = slugMap.get(sl);
		return owner &&
			owner.length &&
			effectiveCanonicalKey(owner[0]) === effectiveCanonicalKey(rows[0])
			? sl
			: null;
	};
	const groupWeb = members.some((m) => flagsById[m.model_id]?.web);
	const groupTee = members.some((m) => flagsById[m.model_id]?.tee);
	const firstListed = members.length
		? Math.min(...members.map((m) => num(m.created_at) || now))
		: null;
	// The lead listing (busiest, tie newest) is the group's canonical URL.
	const leadListing = [...members].sort(
		(a, b) =>
			(sessionsById[b.model_id] || 0) - (sessionsById[a.model_id] || 0) ||
			num(b.created_at) - num(a.created_at),
	)[0];
	// Description: the requested listing's, else the first member that has one.
	let description = (model as Record<string, unknown>).description || null;
	if (!description) {
		for (const m of members) {
			const d = (m as Record<string, unknown>).description;
			if (d) {
				description = d;
				break;
			}
		}
	}

	// Per-bid session count lookup (demand per ask)
	const bidSessions: Record<string, Record<string, unknown>> = {};
	for (const r of bidSessionCounts) bidSessions[r.bid_id as string] = r;

	// Active asks across every listing of the model, cheapest first
	const bids = activeBids.map((b: Record<string, unknown>) => {
		const pricePerSec = BigInt((b.price_per_second as string) || "0");
		const morPerHour = (Number(pricePerSec) * 3600) / 1e18;
		const pricePerDay = morPerHour * 24;
		const hourlyStake =
			stakingFactor > 0 && morPerHour > 0 ? Math.ceil(morPerHour / stakingFactor) : 0;
		const bs = bidSessions[b.bid_id as string] || {};
		const flags = flagsById[b.model_id as string] || { web: false, tee: false };
		return {
			bidId: b.bid_id,
			provider: b.provider,
			providerEndpoint: b.provider_endpoint || null,
			listingId: b.model_id,
			web: flags.web,
			tee: flags.tee,
			pricePerSecond: pricePerSec.toString(),
			priceMorPerHour: morPerHour.toFixed(6),
			priceMorPerDay: pricePerDay.toFixed(6),
			hourlyStake,
			totalSessions: bs.total_count || 0,
			activeSessions: bs.active_count || 0,
			createdAt: b.created_at,
		};
	});

	// Ask spread across the group's active bids
	const askWei = activeBids
		.map((b) => Number((b.price_per_second as string) || "0"))
		.filter((n) => n > 0)
		.sort((a, b) => a - b);
	const medianWei = askWei.length
		? askWei.length % 2
			? askWei[(askWei.length - 1) / 2]
			: (askWei[askWei.length / 2 - 1] + askWei[askWei.length / 2]) / 2
		: 0;

	// Providers offering this model (aggregated across its listings)
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
		listingId: s.model_id,
		stakeMor: (Number(BigInt((s.stake as string) || "0")) / 1e18).toFixed(4),
		openedAt: s.opened_at,
		endsAt: s.ends_at,
		closedAt: s.closed_at,
		isActive: s.is_active === 1,
		closeoutType: s.closeout_type,
	}));

	// The on-chain listings behind this model
	const listings = members
		.map((m) => {
			const agg = aggById[m.model_id] || {};
			const bc = listingBidsById[m.model_id] || {};
			const flags = flagsById[m.model_id] || { web: false, tee: false };
			return {
				modelId: m.model_id,
				name: m.name || null,
				createdAt: m.created_at,
				totalSessions: num(agg.total_sessions),
				stakeMor: (num(agg.total_stake_wei) / 1e18).toFixed(2),
				activeBids: num(bc.bid_count),
				web: flags.web,
				tee: flags.tee,
				isRequested: m.model_id === id,
			};
		})
		.sort(
			(a, b) => b.totalSessions - a.totalSessions || num(b.createdAt) - num(a.createdAt),
		);

	// ── The family, collapsed to canonical models ──
	const famAggById: Record<string, Record<string, unknown>> = {};
	for (const r of famAgg) famAggById[r.model_id as string] = r;
	const famBidsById: Record<string, Record<string, unknown>> = {};
	for (const r of famBidCounts) famBidsById[r.model_id as string] = r;
	const famSessionsById: Record<string, number> = {};
	for (const r of famAgg) famSessionsById[r.model_id as string] = num(r.total_sessions);

	const groups = new Map<string, ModelRow[]>();
	for (const m of famRows) {
		const k = effectiveCanonicalKey(m) || m.model_id;
		const arr = groups.get(k);
		if (arr) arr.push(m);
		else groups.set(k, [m]);
	}
	const familyModels = [...groups.entries()]
		.map(([key, rows]) => {
			let sessionsTotal = 0;
			let stakeWei = 0;
			let bidsTotal = 0;
			let web = false;
			let tee = false;
			let first: number | null = null;
			for (const r of rows) {
				const agg = famAggById[r.model_id] || {};
				sessionsTotal += num(agg.total_sessions);
				stakeWei += num(agg.total_stake_wei);
				bidsTotal += num(famBidsById[r.model_id]?.bid_count);
				const flags = stripListingFlags(r.name || "");
				web = web || flags.web;
				tee = tee || flags.tee;
				const c = num(r.created_at);
				if (c && (first === null || c < first)) first = c;
			}
			const lead = [...rows].sort(
				(a, b) =>
					(famSessionsById[b.model_id] || 0) - (famSessionsById[a.model_id] || 0) ||
					num(b.created_at) - num(a.created_at),
			)[0];
			return {
				key,
				name: displayNameFor(rows) || key,
				slug: slugFor(rows),
				leadModelId: lead.model_id,
				listings: rows.length,
				firstSeen: first,
				totalSessions: sessionsTotal,
				stakeMor: (stakeWei / 1e18).toFixed(2),
				activeBids: bidsTotal,
				web,
				tee,
				isCurrent: key === (targetKey || id),
			};
		})
		.sort(
			(a, b) => b.totalSessions - a.totalSessions || num(b.firstSeen) - num(a.firstSeen),
		);

	const familyFirstSeen = famRows.length
		? Math.min(...famRows.map((m) => num(m.created_at) || now))
		: null;
	const fs = (famSummary || {}) as Record<string, unknown>;

	const ss = (groupSummary || {}) as Record<string, unknown>;
	const totalSessions = num(ss.total_sessions);
	const responseData: Record<string, unknown> = {
		...buildMeta(lastBlock, currentBlock, startBlock, lastSyncTs),
		model: {
			modelId: id,
			name: canonicalName,
			canonicalKey: targetKey,
			curated: Boolean(model.canonical),
			description,
			tags: (model as Record<string, unknown>).tags
				? String((model as Record<string, unknown>).tags)
						.split(",")
						.filter(Boolean)
				: [],
			firstListed,
			listingCount: members.length,
			leadModelId: leadListing?.model_id || id,
			slug: ownedSlug,
			web: groupWeb,
			tee: groupTee,
		},
		summary: {
			providers: providersOffering,
			biddingProviders: new Set(activeBids.map((b) => b.provider as string)).size,
			activeBids: bids.length,
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
		listings,
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
			teeAvailable: familyModels.some((v) => v.tee),
			webAvailable: familyModels.some((v) => v.web),
			modelCount: familyModels.length,
			listingCount: famRows.length,
			totals: {
				totalSessions: num(fs.total_sessions),
				totalStakeMor: (num(fs.total_stake_wei) / 1e18).toFixed(2),
				providerCount: famProvidersUnion,
				uniqueUsers: num(fs.unique_users),
				firstSession: fs.first_session || null,
				lastSession: fs.last_session || null,
			},
			models: familyModels,
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
