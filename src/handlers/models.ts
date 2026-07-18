/**
 * Model Name Handler
 *
 * Cache and serve human-readable model names for model IDs.
 * Model IDs are bytes32 hashes; names need to be stored separately.
 */

import type { Env } from "../types";
import { signingMnemonic } from "../config";
import { signResponse, signBatchResponse } from "../utils/provenance";
import {
	getModelsOrderedByName,
	getModelById,
	upsertModel,
	getModelIdNames,
} from "../db/explorer-market";

// Get all model names
export async function handleGetModels(env: Env, headers: Record<string, string>) {
	const models = await getModelsOrderedByName(env.DB);

	const rows: Record<string, unknown>[] = models.map((m: Record<string, unknown>) => ({
		modelId: m.model_id,
		name: m.name,
		description: m.description,
	}));

	const responseData: Record<string, unknown> = {
		count: rows.length,
		models: rows,
	};

	const mnemonic = signingMnemonic(env);
	if (mnemonic) {
		// Row-level provenance: sign each model individually with Merkle root
		const batch = signBatchResponse("blockchain.models", rows, mnemonic);
		if (batch) {
			for (let i = 0; i < rows.length; i++) {
				rows[i]._receipt = batch.receiptIds[i];
			}
			responseData._provenance = {
				service: "morscan",
				producer: "morscan/models",
				receipt_count: batch.receiptIds.length,
				merkle_root: batch.merkleRoot,
			};
		}

		// Aggregate receipt for backward compat
		const aggregateReceipt = await signResponse(
			"blockchain.models",
			{ endpoint: "/mor/v1/models" },
			{ count: rows.length },
			mnemonic,
			env.DB,
			responseData,
		);
		if (aggregateReceipt) {
			responseData._provenance_aggregate = JSON.parse(aggregateReceipt);
		}
	}

	return new Response(JSON.stringify(responseData), { headers });
}

// Get name for a specific model ID
export async function handleGetModelName(
	env: Env,
	modelId: string,
	headers: Record<string, string>,
) {
	const result = await getModelById(env.DB, modelId.toLowerCase());

	if (result) {
		return new Response(
			JSON.stringify({
				modelId,
				name: result.name,
				description: result.description,
			}),
			{ headers },
		);
	}

	return new Response(
		JSON.stringify({
			modelId,
			name: null,
			error: "Model name not found",
		}),
		{ headers, status: 404 },
	);
}

// Set model name (POST). Optional curation: `family` pins the family group,
// `canonical` pins the canonical model name a listing belongs to (both
// override the name heuristics on the model detail page).
export async function handleSetModelName(
	env: Env,
	modelId: string,
	name: string,
	description: string | null,
	headers: Record<string, string>,
	family: string | null = null,
	canonical: string | null = null,
) {
	const now = Math.floor(Date.now() / 1000);

	await upsertModel(
		env.DB,
		modelId.toLowerCase(),
		name,
		description || "",
		now,
		family,
		canonical,
	);

	return new Response(
		JSON.stringify({
			success: true,
			modelId: modelId.toLowerCase(),
			name,
			description,
			family,
			canonical,
		}),
		{ headers },
	);
}

// Get model names as a lookup map (for UI)
export async function handleModelLookup(env: Env, headers: Record<string, string>) {
	const models = await getModelIdNames(env.DB);

	const lookup: Record<string, string> = {};
	for (const m of models) {
		lookup[(m as Record<string, string>).model_id] = (m as Record<string, string>).name;
	}

	return new Response(JSON.stringify(lookup), { headers });
}
