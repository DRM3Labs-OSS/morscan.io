/**
 * Shared RPC helpers for sync modules
 *
 * Kept for builder sync and rpc-fallback. Block-receipt projector
 * (sync.ts) does not use these - it calls Alchemy directly.
 */

import type { Env } from "../types";
import { RPC_ENDPOINTS } from "./parsers";

const RPC_TIMEOUT = 10000;

export interface EventLog {
	address: string;
	topics: string[];
	data: string;
	blockNumber: string;
	transactionHash: string;
	/** Hex log position within the block (always present in eth_getLogs results). */
	logIndex: string;
}

export async function findWorkingRpc(env: Env): Promise<string | null> {
	const endpoints = [env.RPC_URL, ...RPC_ENDPOINTS];
	for (const rpc of endpoints) {
		try {
			const resp = await fetch(rpc, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					method: "eth_blockNumber",
					id: 1,
					params: [],
				}),
				signal: AbortSignal.timeout(RPC_TIMEOUT),
			});
			const data = (await resp.json()) as Record<string, unknown>;
			if (data.result) return rpc;
		} catch {
			/* try next */
		}
	}
	return null;
}

export class RpcError extends Error {
	constructor(
		message: string,
		public readonly code?: number,
	) {
		super(message);
		this.name = "RpcError";
	}
}

export async function getLogsFromRpc(
	rpc: string,
	contractAddress: string,
	topic: string,
	fromBlock: number,
	toBlock: number,
): Promise<EventLog[]> {
	const resp = await fetch(rpc, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "eth_getLogs",
			id: 1,
			params: [
				{
					address: contractAddress,
					topics: [topic],
					fromBlock: `0x${fromBlock.toString(16)}`,
					toBlock: `0x${toBlock.toString(16)}`,
				},
			],
		}),
		signal: AbortSignal.timeout(RPC_TIMEOUT),
	});
	const data = (await resp.json()) as Record<string, unknown>;
	if (data.error) {
		const err = data.error as Record<string, unknown>;
		throw new RpcError(`${err.message || "RPC error"}`, err.code as number | undefined);
	}
	return (data.result as EventLog[]) || [];
}
